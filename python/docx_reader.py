"""Read the text of a Word .docx, keeping the layout a form is built from.

A supplier form in Word is typed text in a fixed layout, so it is read here
directly - no model involved. The file is opened straight from its XML with
the standard library rather than through python-docx: forms are built out of
exactly the parts python-docx skips (content controls, legacy form fields,
checkboxes, text boxes), and a value that silently goes missing here looks,
on the review screen, like a field the supplier left blank.

The result is a list of rows in reading order. A table row is its cells; a
paragraph outside a table is a row of one cell. A ticked checkbox reads [X]
and an unticked one [ ]. Page headers and footers are left out: on a form
handed out by the buyer they carry the buyer's own address and phone number,
which would read as the supplier's.

Elements are matched on local name, ignoring namespaces, so a document saved
as "Strict Open XML" reads the same as an ordinary one.
"""
from __future__ import annotations

import io
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass

# No XML part of a supplier form comes anywhere near this; refusing larger ones
# keeps a zip bomb from being inflated into memory.
MAX_PART_BYTES = 50 * 1024 * 1024

# Containers that only wrap content: tracked insertions, custom XML, smart
# tags. Their children are read as if the wrapper were not there.
_WRAPPERS = {"customXml", "smartTag", "ins", "moveTo"}

# Text that is in the file but not on the page: tracked deletions, the source
# side of a tracked move, and field codes (the field's result is read instead).
_HIDDEN = {"del", "delText", "moveFrom", "instrText", "fldData"}

# Checkbox glyphs from the symbol fonts Word offers in Insert > Symbol, by
# character code. Anything else from these fonts is decoration.
_SYMBOLS = {
    "wingdings": {0xA8: "[ ]", 0x6F: "[ ]", 0x71: "[ ]",
                  0xFE: "[X]", 0xFD: "[X]", 0x78: "[X]"},
    "wingdings 2": {0xA3: "[ ]", 0x2A: "[ ]", 0x52: "[X]", 0x53: "[X]", 0x54: "[X]"},
}


@dataclass
class DocxContent:
    rows: list[list[str]]
    # Counted so a document that is only a pasted scan can be told apart from
    # one with nothing in it; pictures are not read.
    pictures: int


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _first(el, name: str):
    if el is None:
        return None
    return next((c for c in el if _local(c.tag) == name), None)


def _attr(el, name: str) -> str | None:
    for key, value in el.attrib.items():
        if key == name or key.endswith("}" + name):
            return value
    return None


def _on(el) -> bool:
    """An on/off property: present with no value, or with a true value."""
    if el is None:
        return False
    val = _attr(el, "val")
    return val is None or val.strip().lower() in ("1", "true", "on")


def _placeholder(sdt) -> bool:
    """A content control still showing Word's "Click or tap here to enter
    text." prompt: nothing was filled in."""
    return _first(_first(sdt, "sdtPr"), "showingPlcHdr") is not None


def _symbol(sym) -> str:
    font = (_attr(sym, "font") or "").strip().lower()
    try:
        code = int(_attr(sym, "char") or "", 16) & 0xFF
    except ValueError:
        return ""
    return _SYMBOLS.get(font, {}).get(code, "")


def _form_field(fld) -> str:
    """A legacy form field's visible value, where it is not in the text runs.

    Text form fields keep what was typed in ordinary runs, which are read
    anyway. Checkboxes and drop-downs keep their state only here."""
    if _attr(fld, "fldCharType") != "begin":
        return ""
    data = _first(fld, "ffData")
    box = _first(data, "checkBox")
    if box is not None:
        state = _first(box, "checked")
        if state is None:
            state = _first(box, "default")
        return "[X]" if _on(state) else "[ ]"
    dropdown = _first(data, "ddList")
    if dropdown is not None:
        entries = [_attr(e, "val") or "" for e in dropdown if _local(e.tag) == "listEntry"]
        chosen = _first(dropdown, "result")
        if chosen is None:
            chosen = _first(dropdown, "default")
        try:
            index = int(_attr(chosen, "val") or 0) if chosen is not None else 0
        except ValueError:
            index = 0
        return entries[index] if 0 <= index < len(entries) else ""
    return ""


def _children(el, name: str, control=None):
    """(child, content control around it) for the children called `name`,
    looking through wrappers and content controls - a table row or cell can
    sit inside either. Word wraps the whole cell in the control when one is
    inserted into an empty cell."""
    for child in el:
        n = _local(child.tag)
        if n == name:
            yield child, control
        elif n == "sdt":
            content = _first(child, "sdtContent")
            if content is not None:
                yield from _children(content, name, child)
        elif n in _WRAPPERS:
            yield from _children(child, name, control)


class _Reader:
    def __init__(self):
        self.pictures = 0

    def blocks(self, container, line, rows: list[list[str]]) -> None:
        """Read block content: each paragraph's text is passed to `line`, each
        table's rows are appended to `rows`."""
        for child in container:
            name = _local(child.tag)
            if name == "p":
                parts: list[str] = []
                boxes: list = []
                self.inline(child, parts, boxes)
                line("".join(parts))
                for box in boxes:
                    self.blocks(box, line, rows)
            elif name == "tbl":
                self.table(child, rows)
            elif name == "sdt":
                content = _first(child, "sdtContent")
                if content is not None and not _placeholder(child):
                    self.blocks(content, line, rows)
            elif name == "AlternateContent":
                # The same content twice, for newer and older Word; read one.
                branch = next(iter(child), None)
                if branch is not None:
                    self.blocks(branch, line, rows)
            elif name in _WRAPPERS:
                self.blocks(child, line, rows)

    def table(self, tbl, rows: list[list[str]]) -> None:
        for row, _ in _children(tbl, "tr"):
            cells: list[str] = []
            nested: list[list[str]] = []
            for cell, control in _children(row, "tc"):
                lines: list[str] = []
                if control is None or not _placeholder(control):
                    self.blocks(cell, lines.append, nested)
                cells.append("\n".join(t.strip() for t in lines if t.strip()))
            rows.append(cells)
            # A table inside a cell: its rows follow the row that holds it.
            rows.extend(nested)

    def inline(self, el, parts: list[str], boxes: list) -> None:
        """Collect a paragraph's text into `parts`. Text boxes anchored in it
        hold whole paragraphs of their own and are handed back in `boxes`."""
        for child in el:
            name = _local(child.tag)
            if name == "t":
                parts.append(child.text or "")
            elif name in ("tab", "ptab"):
                parts.append("\t")
            elif name in ("br", "cr"):
                parts.append("\n")
            elif name == "noBreakHyphen":
                parts.append("-")
            elif name == "sym":
                parts.append(_symbol(child))
            elif name == "fldChar":
                parts.append(_form_field(child))
            elif name == "sdt":
                box = _first(_first(child, "sdtPr"), "checkbox")
                if box is not None:
                    # The state, not the glyph shown for it - the glyph is
                    # configurable per control.
                    parts.append("[X]" if _on(_first(box, "checked")) else "[ ]")
                elif not _placeholder(child):
                    content = _first(child, "sdtContent")
                    if content is not None:
                        self.inline(content, parts, boxes)
            elif name == "AlternateContent":
                branch = next(iter(child), None)
                if branch is not None:
                    self.inline(branch, parts, boxes)
            elif name == "txbxContent":
                boxes.append(child)
            elif name in ("blip", "imagedata"):
                self.pictures += 1
            elif name in _HIDDEN or name.endswith("Pr"):
                # *Pr are formatting properties; pPr even holds tab stops that
                # would otherwise read as tabs.
                continue
            else:
                self.inline(child, parts, boxes)


def _xml(zf: zipfile.ZipFile, name: str):
    try:
        info = zf.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_PART_BYTES:
        raise ValueError("The Word document is too large to be a supplier form")
    raw = zf.read(name)
    # OOXML never declares a DTD; one here is an attempt to expand entities.
    if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
        raise ValueError("The Word document contains XML that is not allowed")
    try:
        return ET.fromstring(raw)
    except ET.ParseError:
        raise ValueError("The Word document is damaged and cannot be read")


def _main_part(zf: zipfile.ZipFile) -> str:
    root = _xml(zf, "_rels/.rels")
    for rel in root if root is not None else []:
        if (rel.get("Type") or "").endswith("/officeDocument") and rel.get("Target"):
            return rel.get("Target").lstrip("/")
    return "word/document.xml"


def read_docx(data: bytes) -> DocxContent:
    """The rows of a .docx in reading order. Raises ValueError with a message
    fit for the operator when the file cannot be read as one."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError("That file is not a readable Word .docx document")
    with zf:
        root = _xml(zf, _main_part(zf))
    # .xlsx and .pptx are the same kind of zip; only a Word document has a
    # <document> at its centre.
    if root is None or _local(root.tag) != "document":
        raise ValueError("That file is not a Word .docx document")

    reader = _Reader()
    rows: list[list[str]] = []

    def line(text: str) -> None:
        # A line break inside a paragraph starts a new row, so "Label:" and
        # its value on the next line are read the same as two paragraphs.
        rows.extend([part] for part in text.split("\n"))

    body = _first(root, "body")
    if body is not None:
        reader.blocks(body, line, rows)

    rows = [[cell.strip() for cell in row] for row in rows]
    return DocxContent(rows=[row for row in rows if any(row)], pictures=reader.pictures)
