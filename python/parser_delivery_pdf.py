"""Read a supplier's PDF invoice into the same DeliveryOrder/DeliveryLine
objects the JSON parsers produce, so everything downstream — catalogue
matching, grower resolution, the DFG BatchV1 payload — runs unchanged.

A PDF invoice is a printed table, and every supplier prints a different one.
Writing a parser per supplier does not scale past a handful, so the mechanics
live here once and each supplier is described by a LayoutSpec in
pdf_layouts.py: which table is the product grid, which column holds what, how
the product cell splits into a variety, and where the header fields are
printed. Adding a supplier means filling in that description, not writing
code.

Everything genuinely common is handled here:

  • finding the product grid by its header, and following it across pages
  • repairing words a narrow column wrapped mid-way ("ALSTROEMERI" + "A")
  • the header's label/value box, which the page text scrambles into a block
    of labels followed by a block of values
  • expanding a block of N identical boxes back into N boxes, refusing to
    guess when the printed quantities do not divide between them
  • merging a product printed twice inside one box
  • checking the result against the totals the invoice prints for itself
  • (the "boxes" model, 2026-09-28) box counts, box numbers and ranges;
    mix boxes as MB1…MBn; decimal commas; a length per column; grids read
    off the page text; hidden white text, cells overflowing their
    neighbours and too-tight letter spacing, each where a template needs it

What a PDF cannot give, and a supplier's JSON can:
  • nu_box_weight — the real weight of a box. Qualisa's JSON carries 1.5 kg;
    no printed invoice states it, so lines parsed from PDF send 0.
  • nu_weight — per-stem weight.
  • nm_location per line — the farm a product came from. Some invoices print a
    warehouse summary, which is read when it names a single warehouse.
    Otherwise this is lost, which changes the outcome only for the
    Pomarosa/Tessa network, where the grower is resolved from nm_location
    rather than from the company name.
  • box identity — an invoice that groups identical boxes into one block
    cannot say which box was which, so MB1…MBn are rebuilt in a different
    order than the JSON assigns them. Same count, same contents.

Only four header fields decide what FreshPortal receives — tx_company,
id_invoice, dt_invoice and dt_fly (see dfg_api_client.build_batch_payload).
A spec must supply those. nm_ship, nm_cargo and the two waybills are carried
for the import log and the legacy batch form, which treat them as optional,
so a spec may leave them out rather than guess.
"""
from __future__ import annotations

import dataclasses
import io
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from parser_delivery import (
    DeliveryLine,
    DeliveryOrder,
    _enrich_variety,
    _normalise_box,
    _normalise_date,
    _parse_date_iso,
    guess_box,
)

log = logging.getLogger(__name__)


class PdfParseError(ValueError):
    """The PDF could not be read as a delivery invoice."""


class PdfChecksumError(PdfParseError):
    """Parsed lines do not add up to the totals the invoice prints."""


class PdfUnknownLayoutError(PdfParseError):
    """No layout, in code or drafted and stored, reads this supplier's invoice:
    none finds it, or the one that finds it cannot read it - the supplier
    changed its printout, say - and `layout` names that one. Either way the
    delivery screen saves the invoice for IT and offers to have a layout
    drafted (pdf_layout_ai; user, 2026-09-30)."""

    def __init__(self, message: str, layout: str | None = None):
        super().__init__(message)
        self.layout = layout


# A PDF with no text layer is a scan. Nothing can be parsed out of it without
# OCR, so it is refused with an explanation instead of yielding an empty order.
_MIN_TEXT_CHARS = 40


# ---------------------------------------------------------------------------
# The document
# ---------------------------------------------------------------------------

@dataclass
class PdfDoc:
    """A PDF reduced to what the layouts read: the full page text (header and
    footer wording) and every table on every page."""
    text: str
    tables: list[list[list[str]]] = field(default_factory=list)


def _cell(value: Any) -> str:
    """Table cell → single-line text. pdfplumber keeps the line breaks a
    wrapped column was printed with ("ALSTROEMERI\\nA")."""
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _is_white(color: Any) -> bool:
    """A fill colour that prints nothing on a white page: white in grey, RGB
    or CMYK."""
    if not isinstance(color, (list, tuple)) or not color:
        return False
    values = [float(c) for c in color if isinstance(c, (int, float))]
    if len(values) == 1 or len(values) == 3:
        return all(v >= 0.99 for v in values)
    if len(values) == 4:
        return all(v <= 0.01 for v in values)
    return False


def _clip_overflow(page: Any) -> Any:
    """The page without the text that runs out of its table cell into the next.

    A cell too narrow for its text lets the text run on over its neighbour.
    A viewer clips it, but the characters are still there, so the neighbour
    reads as a mix of both ("FRESH FROM SOURCE B V" in San Andres del Chaupi's
    ID column spills "E", "B" and "V" into the description: "EB BA VBY PINK").
    Text is placed from where it starts, so a run of characters belongs to the
    cell it starts in; whatever of it lies outside that cell is dropped.
    """
    cells = [c for t in page.find_tables() for c in t.cells if c]
    if not cells:
        return page

    def cell_at(x: float, y: float):
        return next((c for c in cells if c[0] <= x < c[2] and c[1] <= y < c[3]), None)

    drop: set[tuple] = set()
    home = None
    prev = None
    for ch in page.chars:
        x, y = (ch["x0"] + ch["x1"]) / 2, (ch["top"] + ch["bottom"]) / 2
        same_run = (prev is not None and abs(ch["top"] - prev["top"]) < 1
                    and -0.5 <= ch["x0"] - prev["x1"] < 3)
        if not same_run:
            home = cell_at(x, y)
        elif home is not None and not (home[0] <= x < home[2]):
            drop.add((ch["x0"], ch["top"], ch["text"]))
        prev = ch
    if not drop:
        return page
    return page.filter(lambda obj: obj.get("object_type") != "char"
                       or (obj["x0"], obj["top"], obj["text"]) not in drop)


def extract_pdf(pdf_bytes: bytes, *, x_tolerance: float | None = None,
                drop_white: bool = False, clip_overflow: bool = False) -> PdfDoc:
    """Read text and tables out of a PDF. Raises PdfParseError for anything
    that is not a readable, text-layer PDF.

    The keyword options are for templates that need them, and are set in that
    supplier's LayoutSpec (`extract`), never globally:
      x_tolerance    a smaller gap still counts as a space; for a template
                     printed so tightly that words run together
                     ("MANDARINGARDEN")
      drop_white     leave out white text, which a template can use to hide
                     data inside the grid (Terra Pacific's "0.70000000…")
      clip_overflow  see _clip_overflow
    """
    try:
        import pdfplumber
    except ImportError as exc:  # pragma: no cover - deployment guard
        raise PdfParseError(
            "PDF support requires the pdfplumber package (add it to requirements.txt)"
        ) from exc

    text_kwargs: dict[str, Any] = {}
    table_settings: dict[str, Any] = {}
    if x_tolerance is not None:
        text_kwargs["x_tolerance"] = x_tolerance
        table_settings["text_x_tolerance"] = x_tolerance

    pages_text: list[str] = []
    tables: list[list[list[str]]] = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                if drop_white:
                    page = page.filter(lambda obj: obj.get("object_type") != "char"
                                       or not _is_white(obj.get("non_stroking_color")))
                if clip_overflow:
                    page = _clip_overflow(page)
                pages_text.append(page.extract_text(**text_kwargs) or "")
                for table in page.extract_tables(table_settings or None):
                    rows = [[_cell(c) for c in row] for row in table]
                    if rows:
                        tables.append(rows)
    except PdfParseError:
        raise
    except Exception as exc:
        raise PdfParseError(f"could not read the PDF: {exc}") from exc

    text = "\n".join(pages_text)
    if len(text.strip()) < _MIN_TEXT_CHARS:
        raise PdfParseError(
            "this PDF has no text layer — it is a scan or an image. "
            "Ask the supplier for the original PDF (or the JSON)."
        )
    return PdfDoc(text=text, tables=tables)


# ---------------------------------------------------------------------------
# Header field readers — the vocabulary a LayoutSpec uses
# ---------------------------------------------------------------------------

Reader = Callable[[PdfDoc, dict[str, str]], str]


def _num(raw: str) -> float:
    """'$1,234.50' → 1234.5 ; '' → 0.0"""
    cleaned = re.sub(r"[^\d.\-]", "", (raw or "").replace(",", ""))
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def _int(raw: str) -> int:
    return int(round(_num(raw)))


# "1.200" groups thousands; "4.00" and "0.300" do not.
_THOUSANDS_DOT_RE = re.compile(r"^[1-9]\d{0,2}(?:\.\d{3})+$")


def _num_comma(raw: str) -> float:
    """A number from an invoice that prints a decimal comma: '0,360',
    '$ 1285,00', '4.438,50' → 0.36, 1285.0, 4438.5.

    Such invoices still print some numbers with a point — Bosqueflowers'
    box count reads "4.00" beside prices of "$ 0,40" — so a point is a
    decimal point unless it groups thousands, and where both appear the
    last one is the decimal separator.
    """
    s = re.sub(r"[^\d.,\-]", "", raw or "")
    if not s:
        return 0.0
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        head, _, tail = s.rpartition(",")
        s = head.replace(",", "") + "." + tail
    elif _THOUSANDS_DOT_RE.match(s):
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return 0.0


# --- value transforms a spec can ask for ---

def nospace(v: str) -> str:
    """Strip the spaces a code picked up from wrapping in a narrow column."""
    return re.sub(r"\s+", "", v)


def date_iso(v: str) -> str:
    """YYYY-MM-DD → DD-MM-YYYY"""
    return _parse_date_iso(v)


def date_us(v: str) -> str:
    """MM/DD/YYYY → DD-MM-YYYY"""
    return _normalise_date(v)


def date_dmy(v: str) -> str:
    """DD/MM/YYYY, D/M/YYYY or DD-MM-YYYY → DD-MM-YYYY"""
    m = re.search(r"(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4})", v)
    return f"{m.group(1).zfill(2)}-{m.group(2).zfill(2)}-{m.group(3)}" if m else v


def date_ymd(v: str) -> str:
    """YYYY/MM/DD or YYYY-MM-DD → DD-MM-YYYY"""
    m = re.search(r"(\d{4})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{1,2})", v)
    return f"{m.group(3).zfill(2)}-{m.group(2).zfill(2)}-{m.group(1)}" if m else v


_MONTHS = {
    "jan": 1, "ene": 1, "feb": 2, "mar": 3, "apr": 4, "abr": 4, "may": 5,
    "jun": 6, "jul": 7, "aug": 8, "ago": 8, "sep": 9, "set": 9, "oct": 10,
    "nov": 11, "dec": 12, "dic": 12,
}


def date_text(v: str) -> str:
    """A date with the month in words, in English or Spanish, in any of the
    orders invoices print it: "21-sep-2026", "16 sept 2026", "24SEP2025",
    "SEPTEMBER 16, 2026", "Sep 16 2026" → DD-MM-YYYY"""
    m = re.search(r"(\d{1,2})\s*[-/ ]?\s*([A-Za-z]{3,})\.?\s*[-/ ,]?\s*(\d{4})", v)
    if m:
        day, month, year = m.group(1), m.group(2), m.group(3)
    else:
        m = re.search(r"([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})", v)
        if not m:
            return v
        month, day, year = m.group(1), m.group(2), m.group(3)
    number = _MONTHS.get(month[:3].lower())
    return f"{day.zfill(2)}-{number:02d}-{year}" if number else v


def last_word(v: str) -> str:
    """The last token of a line.

    Invoices print the bill-to and ship-to blocks side by side, so a line of
    the page text holds one field from each: "FRESH FROM SOURCE BV 1OZH".
    The consignee code is the tail.
    """
    parts = v.split()
    return parts[-1] if parts else ""


def _described(read: Reader, **description: Any) -> Reader:
    """Attach to a reader what it does, as data: pdf_layout_json writes a
    layout out from it, so the layouts in code can be shown to the model that
    drafts a new one, and a drafted layout, which is data, can be read back
    into the same readers."""
    read.description = {k: v for k, v in description.items() if v not in (None, "", (), [])}  # type: ignore[attr-defined]
    return read


def rx(pattern: str, transform: Callable[[str], str] | None = None,
       flags: int = re.IGNORECASE, cases: tuple[tuple[str, str], ...] = (),
       default: str = "") -> Reader:
    """Read a header field with a regex over the page text (group 1).

    With `cases`, the value is a choice rather than the text: the first
    (word, value) whose word the text contains, or `default` — Rosaprima's
    purchase order says which of two FreshPortal suppliers it is.
    """
    compiled = re.compile(pattern, flags)

    def read(doc: PdfDoc, _kv: dict[str, str]) -> str:
        m = compiled.search(doc.text)
        value = m.group(1).strip() if m else ""
        if cases:
            if not m:
                return ""
            return next((v for word, v in cases if word.lower() in value.lower()), default)
        return transform(value) if (transform and value) else value
    return _described(read, regex=pattern, transform=getattr(transform, "__name__", None),
                      multiline=bool(flags & re.MULTILINE) or None,
                      cases=[list(c) for c in cases], default=default,
                      _flags=flags)


def kv(label: str, transform: Callable[[str], str] | None = None) -> Reader:
    """Read a header field from the invoice's label/value table.

    The page text lists such a box as a run of labels followed by a run of
    values, so the label is the only way back to its value.
    """
    key = label.lower()

    def read(_doc: PdfDoc, table_kv: dict[str, str]) -> str:
        value = table_kv.get(key, "")
        return transform(value) if (transform and value) else value
    return _described(read, kv=label, transform=getattr(transform, "__name__", None))


def first_line() -> Reader:
    """The first non-empty line of the document — where most invoices print
    the issuing company."""
    def read(doc: PdfDoc, _kv: dict[str, str]) -> str:
        return next((l.strip() for l in doc.text.split("\n") if l.strip()), "")
    return _described(read, first_line=True)


def any_of(*readers: Reader) -> Reader:
    """First reader that finds something."""
    def read(doc: PdfDoc, table_kv: dict[str, str]) -> str:
        for reader in readers:
            value = reader(doc, table_kv)
            if value:
                return value
        return ""
    return _described(read, any_of=list(readers))


def const(value: str) -> Reader:
    def read(_doc: PdfDoc, _kv: dict[str, str]) -> str:
        return value
    return _described(read, const=value)


# ---------------------------------------------------------------------------
# Reading the grid
# ---------------------------------------------------------------------------

# A column too narrow for its text wraps mid-word, and the remainder comes
# back as a separate line ("ALSTROEMERI" / "A"), which _cell joins with a
# space. A trailing fragment of one or two characters is such a remainder —
# no species name ends in a one- or two-letter word — so it is glued back on,
# while a genuine multi-word value ("MINI CARNATION") is left alone.
#
# This is applied to the species column only. Other columns legitimately end
# in a short token that must survive: a product cell reads "EXPLORER 60CM 25ST
# AR", where gluing the grade onto the pack size would destroy the row.
_WRAP_TAIL_RE = re.compile(r"(?<=\w)\s+(?=\w{1,2}\b\s*$)")


def _unwrap(value: str) -> str:
    return _WRAP_TAIL_RE.sub("", value or "")


def _is_grid_header(row: list[str], wanted: list[str]) -> bool:
    return all(any(w in c.lower() for c in row) for w in wanted)


def _grid_rows(doc: PdfDoc, header_cells: tuple[str, ...]) -> list[list[str]]:
    """Every data row of the product grid, in printed order, across pages.

    The grid is found by its header row, searched for anywhere in a table
    rather than only at the top. Where an invoice's address boxes share their
    borders with the grid below them, pdfplumber sees the lot as one table
    whose first row is the bill-to block, and the product header sits some
    rows down (found 2026-09-22 on a real Alissroses invoice, which was
    refused as having no product table at all).

    A table with no header but the same column count is a continuation of the
    grid — invoices reprint the header on each page, but not always.
    """
    wanted = [h.lower() for h in header_cells]
    width = 0
    rows: list[list[str]] = []

    for table in doc.tables:
        header_at = next((i for i, r in enumerate(table)
                          if _is_grid_header(r, wanted)), None)
        if header_at is not None:
            width = width or len(table[header_at])
            body = table[header_at + 1:]
        elif width and len(table[0]) == width:
            body = table
        else:
            continue
        rows.extend(r for r in body if not _is_grid_header(r, wanted))

    return rows


def _key_values(doc: PdfDoc) -> dict[str, str]:
    """Every two-column table row in the document, as {label: value}.

    Invoice headers are printed as a small label/value box — a real table in
    the PDF, but not in the page text, where the labels come out as one block
    and their values as another further down. Reading the table is the only
    way to pair them back up.
    """
    pairs: dict[str, str] = {}
    for table in doc.tables:
        for row in table:
            if len(row) == 2 and row[0] and row[1]:
                pairs.setdefault(re.sub(r"[:#]", "", row[0]).strip().lower(), row[1])
    return pairs


# ---------------------------------------------------------------------------
# The layout description
# ---------------------------------------------------------------------------

# Grid columns a spec can map. Only `product` is required; the rest are filled
# from the product cell's own named groups when the grid has no column for
# them (a length printed inside "EXPLORER 60CM 25ST AR" rather than beside it).
GRID_FIELDS = ("count", "box", "species", "product", "length",
               "bunches", "stems", "rate", "subtotal")

# What a row of the "boxes" model can carry — from a grid column, a group of a
# text-line regex, or a group of product_re. Beyond GRID_FIELDS:
#   number       box number ("7", "01") or range ("03 - 04", "1-4", "2Q - 3Q")
#   variety      the variety itself, when a column or line holds only that
#   color        a colour word printed between species and variety
#   stems_bunch  stems per bunch
#   bunches_box  bunches in each box of the row
#   stems_box    stems in each box of the row
#   rate_bunch   price per bunch
#   location     the farm the row comes from
#   qual         a grade, for nm_product
#   label        the box label; "COLD"/"FRIO" or "WARM"/"CALIDO" in it
#                qualifies the variety, as the JSON path's tx_label does
#   number_last  the last box number, for a grid printing a range in two
#                columns ("B I" 2, "B F" 3)
#   grams        the weight of one stem in grams ("40 GR"), which goes to
#                FreshPortal as the line's weight in kg
ROW_FIELDS = GRID_FIELDS + ("number", "variety", "color", "stems_bunch", "bunches_box",
                            "stems_box", "rate_bunch", "location", "qual", "label",
                            "number_last", "grams")

# How much of a full box each box code is, for checking the full-box
# equivalent an invoice prints ("TOTAL FULL BOXES 9.125").
BOX_FULLS = {"QBE": 0.25, "HBE": 0.5, "1/8": 0.125}

# Box codes that are one letter, as several Ecuadorian templates print them.
# The Farm Information program also has F, S, D and T; they stay unmapped
# and go as a guessed QBE, like any box we do not know (user, 2026-09-29).
LETTER_BOXES = {"H": "HBE", "Q": "QBE", "E": "1/8"}


@dataclass(frozen=True)
class LayoutSpec:
    """One supplier's invoice template, described rather than coded.

    name         identifier used in logs and error messages
    detect       regex matching wording unique to this supplier's template —
                 not to one shipment, so it still matches next month's invoice
    grid_header  words that together identify the product grid's header row
    columns      grid field → column index (see GRID_FIELDS)
    product_re   splits the product cell; may name variety, stems_bunch,
                 length and qual
    row_model    "flat"    — one row per product, quantities already summed
                             across that product's boxes
                 "grouped" — a row stating a box count opens a block, and the
                             rows under it list what is in those boxes, with
                             quantities summed across the block
    header       DeliveryOrder field → Reader
    nm_product   template for the product name; defaults to the cell as
                 printed. Placeholders: variety, length, stems_bunch, qual
    box_re       regex whose group 1 is the box code inside the box cell.
                 Defaults to the cell with its printed dimensions removed:
                 "QB3 ALSTRO (18*100*45)" -> "QB3 ALSTRO". A supplier whose
                 cell reads "QB 9 (90*35*17.5)" but whose fust is "QB" gives
                 r"^([A-Za-z]+)" here.
    totals_re    regex over the page text yielding (boxes, _, stems, amount)
                 when the totals are not a row of the grid itself
    merge_across_boxes  for a grouped layout, whether a product becomes one
                 line per physical box, each with its own MB code (False), or
                 one line merged across every box holding it, carrying the
                 printed box type and a box count (True).

                 Set this to whatever parser_delivery already does for the
                 same supplier's JSON, so one delivery imports the same way
                 whichever file arrives. Qualisa is True: its JSON products
                 carry no gu_product, and the mix-box test there counts
                 distinct gu_product values, so its boxes go down the
                 single-variety branch and merge.
    totals_marker  product-cell text that marks the grid's own totals row
    location_block  regex whose group 1 is the warehouse summary block. Needed
                 because a bare warehouse-row pattern also matches ordinary
                 product rows, which would make the invoice look like it
                 shipped from several warehouses and lose the location.
    location_re  regex whose group 1 is a warehouse name inside that block

    The "boxes" row model (added 2026-09-28 for the Ecuador and Colombia
    suppliers) generalises both: a row that states a box count or a box
    number opens a block of boxes, and may name a product too; a row that
    names only a product adds it to the block above. It builds lines the way
    parser_delivery._parse_invoices_format does for a JSON with product ids:
    a box holding one product is merged with the other boxes of that product
    into one line with a box count, and each box of a block holding several
    products is a mix box of its own, MB1…MBn. Its fields:

    lines        text mode: regexes tried in turn at the start of each line of
                 the page text, for templates whose grid is not a ruled table.
                 Their named groups are ROW_FIELDS. A pattern may span lines.
    lines_from   text mode: the rows start after the first match of this
    lines_to     text mode: and end before the first match of this

    A row opens a block when its `count` (how many boxes) is filled in, or
    when its `number` (box number or range) differs from the row above; a
    repeated number is the same box again (Stampsybox lists box 23 on nine
    rows). A row with neither continues the block above.

    cell_re     grid field → regex whose group 1 is that field inside its
                 cell, for a cell holding two things ("2Q 2Q - 3Q")
    length_cols  grid column → length, for a grid that prints the bunches
                 under a column per length rather than a length column
    header_columns  grid field → regex for its header cell, for a grid whose
                 columns move between invoices; resolved from each invoice's
                 own header row, over `columns`
    lengths_from_header  every header cell that is a bare number ("50",
                 "60") is a length column — for a grid that prints only the
                 lengths the shipment has
    box_map      printed box code (upper case) → FreshPortal code, for codes
                 _normalise_box does not know ("E" → "1/8", "OCT" → "1/8").
                 A code that is still not one of parser_delivery.KNOWN_BOXES
                 goes as QBE, marked as a guess the screen lets the user change
    default_box  the box code when the invoice prints none
    box_fulls    extra box code → share of a full box, for the fulls check;
                 for a guessed box, keyed by the code as printed ("FBG")
    species      the species when neither the grid nor the product names it
    species_map  printed species (upper case) → the name lines carry
    species_rules  (regex, species) pairs tried on the variety, for a supplier
                 printing no species at all; the first that matches names it,
                 else `species`
    variety_rules  (row field, regex, name) triples: a row whose field
                 matches is the product `name` whatever its variety — a mix
                 the farm packs under its own label ("MIX CALIDO" → "Rosa Ec
                 Bicolor Warm"). The field is "variety" or "label" as cleaned,
                 or any other row field as printed. Such a product merges only
                 across boxes printed one after another, and not across
                 grades, so each run can be given its own length — as does
                 any product the invoice prints no length for
    mix_names    (regex, name) pairs: a mix box whose every product's
                 "species variety" matches is sent combined as `name`,
                 matched against the catalogue by that name
    label_joins_variety  regex; a variety matching it is only half a name
                 without its box label ("MIX COLOR" boxed as "BICO HOT"), so
                 the label is added to it
    stems_bunch  the bunch size when the invoice does not print it. Only for
                 a supplier whose bunch size is fixed; everywhere else a row
                 that does not say is refused.
    decimal      "," for an invoice printing decimal commas
    split_uneven  a block of one product whose bunches do not divide between
                 its boxes is taken as boxes of one bunch more and one fewer,
                 instead of refused — for a supplier that only ever states a
                 total over its boxes
    box_fill     with split_uneven: each box of such a block holds this many
                 bunches and the last one the rest (272 in 3: 100, 100, 72),
                 where that accounts for exactly the block's boxes
    items_per_box  the quantities on a product row under a block row are
                 per box, not summed across the block's boxes
    block_row_is_summary  a block row names a product only for a block no
                 product rows follow: when they do, they are its contents
                 and the block row just sums them up ("ROS AST 70 x 250")
    extract      keyword options for extract_pdf, for templates that need them
    boxes_re     regex over the page text whose group 1, summed over every
                 match, is the invoice's own box count ("TOTAL CAJAS H: 5")
    fulls_re     regex whose group 1 is the full-box equivalent printed
    totals_col   the grid column holding totals_marker, when not the product
                 column

    totals_re may name its groups boxes, bunches, stems, amount and fulls; a
    "boxes" layout must find stems or amount among the printed totals, or it
    refuses the file, because an unchecked parse is exactly what goes wrong
    silently when a supplier changes its template.
    """
    name: str
    detect: str
    grid_header: tuple[str, ...]
    columns: dict[str, int]
    product_re: str
    row_model: str
    header: dict[str, Reader]
    nm_product: str = ""
    box_re: str = ""
    merge_across_boxes: bool = False
    totals_re: str = ""
    totals_marker: str = ""
    location_block: str = ""
    location_re: str = ""
    # --- the "boxes" row model ---
    lines: tuple[str, ...] = ()
    lines_from: str = ""
    lines_to: str = ""
    cell_re: dict[str, str] = field(default_factory=dict)
    length_cols: dict[int, int] = field(default_factory=dict)
    header_columns: dict[str, str] = field(default_factory=dict)
    lengths_from_header: bool = False
    box_map: dict[str, str] = field(default_factory=dict)
    default_box: str = ""
    box_fulls: dict[str, float] = field(default_factory=dict)
    species: str = ""
    species_map: dict[str, str] = field(default_factory=dict)
    species_rules: tuple[tuple[str, str], ...] = ()
    variety_rules: tuple[tuple[str, str, str], ...] = ()
    mix_names: tuple[tuple[str, str], ...] = ()
    label_joins_variety: str = ""
    stems_bunch: int = 0
    decimal: str = "."
    items_per_box: bool = False
    split_uneven: bool = False
    box_fill: int = 0
    block_row_is_summary: bool = False
    extract: dict[str, Any] = field(default_factory=dict)
    boxes_re: str = ""
    fulls_re: str = ""
    totals_col: int = -1

    def __post_init__(self) -> None:
        if self.row_model not in ("flat", "grouped", "boxes"):
            raise ValueError(f"{self.name}: unknown row_model {self.row_model!r}")
        if self.row_model == "boxes":
            self._check_boxes_model()
        else:
            if "product" not in self.columns:
                raise ValueError(f"{self.name}: columns must map 'product'")
            unknown = set(self.columns) - set(GRID_FIELDS)
            if unknown:
                raise ValueError(f"{self.name}: unknown grid columns {sorted(unknown)}")
        for required in ("tx_company", "id_invoice", "dt_invoice", "dt_fly"):
            if required not in self.header:
                raise ValueError(f"{self.name}: header must supply {required!r}")

    def _check_boxes_model(self) -> None:
        mapped = set(self.columns) | set(self.header_columns)
        if not self.lines and not ({"product", "variety"} & mapped):
            raise ValueError(f"{self.name}: map a 'product' or 'variety' column, or give lines")
        if self.lines and mapped:
            raise ValueError(f"{self.name}: a layout reads either the grid or the text lines")
        named = mapped | set(self.cell_re)
        for pattern in (*self.lines, self.product_re):
            named |= set(re.compile(pattern).groupindex) if pattern else set()
        unknown = named - set(ROW_FIELDS)
        if unknown:
            raise ValueError(f"{self.name}: unknown row fields {sorted(unknown)}")
        if not ({"count", "number"} & named):
            raise ValueError(f"{self.name}: nothing says how many boxes a row is")
        if "box" not in named and not self.default_box:
            raise ValueError(f"{self.name}: nothing says what box a row is in; "
                             f"map 'box' or set default_box")
        if self.decimal not in (".", ","):
            raise ValueError(f"{self.name}: decimal must be '.' or ','")
        if not (self.totals_re or self.totals_marker):
            raise ValueError(f"{self.name}: point totals_re or totals_marker at the "
                             f"invoice's printed totals")
        unknown_extract = set(self.extract) - {"x_tolerance", "drop_white", "clip_overflow"}
        if unknown_extract:
            raise ValueError(f"{self.name}: unknown extract options {sorted(unknown_extract)}")
        for row_field, pattern, name in self.variety_rules:
            if row_field not in ROW_FIELDS or not name:
                raise ValueError(f"{self.name}: a variety rule needs a row field and a name, "
                                 f"not {row_field!r} → {name!r}")
            re.compile(pattern)
        for pattern, name in (*self.species_rules, *self.mix_names):
            if not name:
                raise ValueError(f"{self.name}: a species rule or mix name needs a name")
            re.compile(pattern)
        if self.box_fill < 0:
            raise ValueError(f"{self.name}: box_fill cannot be negative")


# ---------------------------------------------------------------------------
# Reading rows into products
# ---------------------------------------------------------------------------

@dataclass
class _Product:
    """One printed product row, before it is attached to a box."""
    variety: str
    species: str
    length: int
    stems_bunch: int
    bunches: int
    rate: float
    nm_product: str
    location: str = ""
    weight: float = 0.0     # one stem, kg
    qual: str = ""
    named: bool = False     # the variety comes from a variety rule


@dataclass
class _Block:
    """`count` physically identical boxes and the products printed inside
    them. A flat layout yields one single-product block per row."""
    count: int
    box_type: str
    products: list[_Product] = field(default_factory=list)


def _read_blocks(rows: list[list[str]], spec: LayoutSpec) -> tuple[list[_Block], dict]:
    """Group the grid's rows into blocks of identical boxes, and pick up the
    totals row on the way past."""
    product_re = re.compile(spec.product_re, re.IGNORECASE)
    cols = spec.columns
    highest = max(cols.values())

    def get(row: list[str], name: str) -> str:
        idx = cols.get(name)
        if idx is None:
            return ""
        return _unwrap(row[idx]) if name == "species" else row[idx].strip()

    blocks: list[_Block] = []
    species_seen: list[str] = []
    printed: dict = {}

    for row in rows:
        if len(row) <= highest:
            continue
        product_cell = get(row, "product")
        count_cell = get(row, "count")

        if spec.totals_marker and product_cell.upper().startswith(spec.totals_marker.upper()):
            printed = {
                "boxes": _int(count_cell),
                "stems": _int(get(row, "stems")),
                "amount": _num(get(row, "subtotal")),
            }
            continue

        match = product_re.match(product_cell)

        if spec.row_model == "grouped" and not match:
            # A row that states a box count but names no product opens a
            # block. Trailing SubTotal/Total rows look the same and open an
            # empty block, which is dropped below.
            if re.fullmatch(r"\d+", count_cell):
                blocks.append(_Block(count=_int(count_cell), box_type=get(row, "box")))
            continue
        if not match:
            continue  # page-break fragment, or a row that is not a product

        groups = match.groupdict()
        species = get(row, "species")
        if species:
            species_seen.append(species)

        product = _Product(
            variety=(groups.get("variety") or "").strip(),
            species=species,
            length=_int(groups.get("length") or get(row, "length")),
            stems_bunch=_int(groups.get("stems_bunch") or get(row, "stems_bunch") or 0),
            bunches=_int(get(row, "bunches")),
            rate=_num(get(row, "rate")),
            nm_product=product_cell,
        )
        if spec.nm_product:
            product.nm_product = spec.nm_product.format(
                variety=product.variety,
                length=product.length,
                stems_bunch=product.stems_bunch,
                qual=(groups.get("qual") or "").strip(),
            ).strip()

        if spec.row_model == "grouped":
            if not blocks:
                continue  # stray fragment printed before the first block
            blocks[-1].products.append(product)
        else:
            blocks.append(_Block(count=max(1, _int(count_cell) or 1),
                                 box_type=get(row, "box"),
                                 products=[product]))

    blocks = [b for b in blocks if b.products]
    return blocks, {"printed": printed, "species_seen": species_seen}


def _box_code(raw: str, spec: LayoutSpec) -> str:
    """The fust code printed in the box cell, normalised to FreshPortal's
    spelling — the same value the JSON path derives from tp_box."""
    if spec.box_re:
        m = re.search(spec.box_re, raw)
        raw = m.group(1) if m else raw
    else:
        raw = re.sub(r"\s*\(.*?\)", "", raw)
    return _normalise_box(raw.strip())


def _species_resolver(species_seen: list[str]) -> Callable[[str], str]:
    """A page break can cut the species column in half, leaving "ALSTROEMERI"
    on one page and its last letter on the next. The invoice's own longest
    spelling is the canonical one; a shorter value that is a prefix of it is
    the same species, printed incomplete."""
    canonical = max(species_seen, key=len) if species_seen else ""

    def resolve(raw: str) -> str:
        if not raw or canonical.upper().startswith(raw.upper()):
            return canonical.title()
        return raw.title()
    return resolve


def _build_lines(blocks: list[_Block], spec: LayoutSpec,
                 nm_location: str, species: Callable[[str], str]) -> tuple[list[DeliveryLine], int]:
    """Turn blocks of boxes into DeliveryLines.

    A flat layout already has one row per product. A grouped layout is walked
    box by box, and `spec.merge_across_boxes` decides whether each box keeps
    its own identity or the products are merged across every box holding them.
    """
    lines: list[DeliveryLine] = []
    # Keyed the way _parse_invoices_format keys a single-variety box, so a
    # merging layout lands on the lines the same delivery's JSON produces.
    merged: dict[str, DeliveryLine] = {}
    mix_box_counter = 0
    nu_boxes = 0

    for block in blocks:
        count = max(1, block.count)
        nu_boxes += count
        box_type = _box_code(block.box_type, spec)

        if spec.row_model == "flat":
            # Quantities are already summed across this product's boxes, which
            # is exactly what a merged DeliveryLine holds; build_stock_entry
            # divides them back down by nu_physical_boxes.
            for product in block.products:
                lines.append(_line(product, spec, species, nm_location,
                                   box_code=box_type, bunches=product.bunches,
                                   physical_boxes=count))
            continue

        # Bunch counts are printed summed across the block's identical boxes.
        # If one does not divide evenly the boxes were not identical, and
        # there is no honest way to split it — say so rather than guess.
        uneven = next((p for p in block.products if p.bunches % count), None)
        if uneven:
            raise PdfChecksumError(
                f"{spec.name} layout: a block of {count} boxes lists {uneven.bunches} "
                f"bunches of {uneven.variety}, which does not divide between them — the "
                f"boxes in this block are not identical, so per-box quantities cannot be "
                f"recovered from the PDF. Use the supplier's JSON."
            )

        is_mix = len({p.variety for p in block.products}) > 1
        for _ in range(count):
            if spec.merge_across_boxes:
                box_code = box_type
            elif is_mix:
                mix_box_counter += 1
                box_code = f"MB{mix_box_counter}"
            else:
                box_code = box_type

            # Products merge within one physical box always — the same product
            # can be printed on two rows of it — and across boxes only when the
            # layout says so. A box that contributes to a line it did not open
            # raises that line's box count by one, which is what
            # build_stock_entry sends as `quantity`.
            into = merged if spec.merge_across_boxes else {}
            opened_here: set[str] = set()
            for product in block.products:
                line = _line(product, spec, species, nm_location,
                             box_code=box_code, bunches=product.bunches // count,
                             physical_boxes=1)
                line.nm_box_type = box_type
                key = (f"{line.gu_product}|{box_code}|{line.nm_variety.lower()}"
                       f"|{line.mny_rate_stem}")
                if key in into:
                    into[key].nu_bunches += line.nu_bunches
                    if key not in opened_here:
                        into[key].nu_physical_boxes += 1
                else:
                    into[key] = line
                opened_here.add(key)
            if not spec.merge_across_boxes:
                lines.extend(into.values())

    if spec.merge_across_boxes:
        lines.extend(merged.values())

    lines.sort(key=lambda l: (l.nm_species, l.nm_variety, l.nu_length))
    return lines, nu_boxes


def _line(product: _Product, spec: LayoutSpec, species: Callable[[str], str],
          nm_location: str, box_code: str, bunches: int, physical_boxes: int) -> DeliveryLine:
    variety = product.variety.title()
    return DeliveryLine(
        # A printed invoice carries no product GUID, so lines are keyed the
        # way parser_delivery keys a JSON product that has none either.
        gu_product=f"{product.variety}_{product.length}_{product.stems_bunch}_{product.rate}",
        nm_variety=variety,
        nm_species=species(product.species),
        nu_length=product.length,
        nu_stems_bunch=product.stems_bunch,
        nu_bunches=bunches,
        mny_rate_stem=product.rate,
        id_floricode="",
        nm_product=product.nm_product,
        nm_box=box_code,
        nu_physical_boxes=physical_boxes,
        nm_location=nm_location,
        nu_weight=product.weight,
    )


# ---------------------------------------------------------------------------
# The "boxes" row model
# ---------------------------------------------------------------------------

# Row fields that count something across a row's boxes. A product row under a
# block row takes the block row's other fields where it leaves them blank —
# its box type, length, bunch size — but never these.
_QUANTITY_FIELDS = {"count", "number", "bunches", "bunches_box", "stems", "stems_box",
                    "subtotal", "product", "variety", "color", "qual"}

# "03 - 04", "1-4", "2Q - 3Q": a range of box numbers.
_BOX_RANGE_RE = re.compile(r"^\s*(\d+)\s*[A-Z]{0,2}\s*-\s*(\d+)\s*[A-Z]{0,2}\s*$", re.IGNORECASE)


def _box_number(raw: str) -> tuple[tuple[int, int], int] | None:
    """A box number or range → ((first, last), how many boxes)."""
    raw = (raw or "").strip()
    m = _BOX_RANGE_RE.match(raw)
    if m:
        first, last = int(m.group(1)), int(m.group(2))
        if last < first:
            raise PdfParseError(f"box range {raw!r} runs backwards")
        return (first, last), last - first + 1
    m = re.fullmatch(r"(\d+)\s*[A-Z]{0,2}", raw, re.IGNORECASE)
    if m:
        n = int(m.group(1))
        return (n, n), 1
    return None


def _table_row_fields(row: list[str], spec: LayoutSpec) -> dict[str, Any] | None:
    """One grid row as {field: text}; None for a row too short to be one."""
    highest = max([*spec.columns.values(), *spec.length_cols], default=-1)
    if len(row) <= highest:
        return None
    fields: dict[str, Any] = {}
    for name, idx in spec.columns.items():
        value = row[idx].strip()
        if name == "species":
            value = _unwrap(value)
        pattern = spec.cell_re.get(name)
        if pattern and value:
            m = re.search(pattern, value, re.IGNORECASE)
            value = (m.group(1) or "").strip() if m else ""
        fields[name] = value
    if spec.length_cols:
        fields["_lengths"] = [(length, row[idx]) for idx, length in spec.length_cols.items()]
    return fields


def _text_rows(doc: PdfDoc, spec: LayoutSpec) -> list[dict[str, Any]]:
    """The rows of a grid that is not a ruled table, read off the page text:
    at the start of every line each of spec.lines is tried in turn, and the
    first that matches is a row. Lines no pattern matches — page headers,
    footers, a wrapped remainder — are passed over, which is why a "boxes"
    layout must check the printed totals."""
    text = doc.text
    if spec.lines_from:
        m = re.search(spec.lines_from, text, re.IGNORECASE | re.MULTILINE)
        if not m:
            return []
        text = text[m.end():]
    if spec.lines_to:
        m = re.search(spec.lines_to, text, re.IGNORECASE | re.MULTILINE)
        if m:
            text = text[:m.start()]
    patterns = [re.compile(p, re.IGNORECASE | re.MULTILINE) for p in spec.lines]

    rows: list[dict[str, Any]] = []
    pos = 0
    while pos < len(text):
        match = None
        for pattern in patterns:
            m = pattern.match(text, pos)
            if m and m.end() > pos:
                match = m
                break
        if match:
            rows.append({k: (v or "").strip() for k, v in match.groupdict().items()})
            pos = match.end()
            if text[pos - 1] == "\n":
                continue
        newline = text.find("\n", pos)
        if newline < 0:
            break
        pos = newline + 1
    return rows


@dataclass
class _BoxBlock:
    """`count` boxes opened by one row, and the products printed in them."""
    count: int
    box: str
    opener: dict[str, Any]
    products: list[_Product] = field(default_factory=list)
    summary: list[_Product] = field(default_factory=list)


# Our own consignee marks, which templates print in their label column too:
# "1OZH", "OZHGYP", "VDF". On a box they say who it is for, not what is in it.
_CUSTOMER_MARK_RE = re.compile(r"^(?:\d?OZ[A-Z]*|VDF|TFPO|PFC)$", re.IGNORECASE)


def _clean_variety(variety: str) -> str:
    """The variety without the marks some templates hang on it: "MONDIAL.",
    "MONDIAL°", "* CARPE DIEM". An apostrophe printed as ° or ´ ("O°HARA")
    becomes one, and a name wrapped after its hyphen ("X- PRESSION") is
    joined again."""
    v = re.sub(r"\s+", " ", variety or "")
    v = re.sub(r"(?<=\w)[°´`’](?=\w)", "'", v)
    v = re.sub(r"(?<=\w)- (?=\w)", "-", v)
    return v.strip(" .*°-_")


def _row_products(fields: dict[str, Any], spec: LayoutSpec, num: Callable[[str], float],
                  block: _BoxBlock, is_item: bool) -> list[_Product]:
    """The products a row names — one, or one per length for a grid printing
    a column per length. Quantities come back summed over the block's boxes."""
    fields = dict(fields)
    if is_item:
        for key, value in block.opener.items():
            if key not in _QUANTITY_FIELDS and not key.startswith("_") and not fields.get(key):
                fields[key] = value

    cell = fields.get("product") or fields.get("variety") or ""
    if spec.product_re:
        m = re.match(spec.product_re, cell, re.IGNORECASE) if cell else None
        if not m:
            return []
        for key, value in m.groupdict().items():
            if value and value.strip():
                fields[key] = value.strip()
    variety = _clean_variety(fields.get("variety") or cell)
    # A totals or subtotals row carries numbers in the product columns too.
    if not variety or re.match(r"(?:SUB\s*-?\s*)?TOTAL", variety, re.IGNORECASE):
        return []
    label = _clean_variety(fields.get("label") or "")
    if _CUSTOMER_MARK_RE.match(label):
        label = ""
    printed = variety

    def rule_value(name: str) -> str:
        if name in ("variety", "label"):
            return printed if name == "variety" else label
        value = fields.get(name)
        return value if isinstance(value, str) else ""

    named = next((name for row_field, pattern, name in spec.variety_rules
                  if re.search(pattern, rule_value(row_field), re.IGNORECASE)), "")
    if named:
        variety = named
    else:
        if label and spec.label_joins_variety and re.search(spec.label_joins_variety, variety,
                                                            re.IGNORECASE):
            variety = f"{variety} {label}"
        variety = _enrich_variety(variety, label)

    raw_species = (fields.get("species") or "").strip()
    if raw_species:
        species = spec.species_map.get(raw_species.upper()) or raw_species.title()
    else:
        species = next((name for pattern, name in spec.species_rules
                        if re.search(pattern, printed, re.IGNORECASE)), spec.species)

    def n(name: str) -> float:
        return num(fields.get(name) or "")

    if "_lengths" in fields:
        variants = [(length, num(value)) for length, value in fields["_lengths"] if num(value) > 0]
        if not variants:
            return []
    else:
        variants = [(int(n("length")), None)]

    count = max(1, block.count)
    scale = count if (is_item and spec.items_per_box) else 1
    products = []
    for length, bunches_here in variants:
        stems_bunch = n("stems_bunch")
        if bunches_here is not None:
            bunches = bunches_here * scale
            stems = 0.0 if len(variants) > 1 else n("stems") * scale
        else:
            bunches = n("bunches") * scale or n("bunches_box") * count
            stems = n("stems") * scale or n("stems_box") * count
        if not stems_bunch and bunches and stems:
            stems_bunch = stems / bunches
        stems_bunch = stems_bunch or spec.stems_bunch
        if not bunches and stems and stems_bunch:
            bunches = stems / stems_bunch
        where = f"{spec.name} layout, {variety} {length}"
        if not bunches or not stems_bunch:
            raise PdfParseError(f"{where}: the invoice does not say how many bunches or stems "
                                f"per bunch this row is")
        if bunches != int(bunches) or stems_bunch != int(stems_bunch):
            raise PdfChecksumError(f"{where}: {stems:g} stems do not make whole bunches "
                                   f"({bunches:g} bunches of {stems_bunch:g})")
        if stems and int(bunches) * int(stems_bunch) != int(stems):
            raise PdfChecksumError(f"{where}: {bunches:g} bunches of {stems_bunch:g} stems is "
                                   f"not the {stems:g} stems printed — the row is read wrongly")
        bunches, stems_bunch = int(bunches), int(stems_bunch)

        rate = n("rate")
        if not rate and n("rate_bunch"):
            rate = n("rate_bunch") / stems_bunch
        # The row's amount is what the invoice charges; a unit price printed
        # rounded ("0.08" for 12 stems at $1.00) gives way to it.
        subtotal = n("subtotal") * scale if bunches_here is None or len(variants) == 1 else 0
        if subtotal and abs(rate * bunches * stems_bunch - subtotal) > 0.01:
            rate = subtotal / (bunches * stems_bunch)
        values = {**{k: v for k, v in fields.items() if isinstance(v, str)},
                  "variety": variety, "length": length, "stems_bunch": stems_bunch}
        nm_product = (spec.nm_product.format_map(_Blank(values)).strip() if spec.nm_product
                      else (fields.get("product") or variety))
        products.append(_Product(
            variety=variety, species=species, length=int(length), stems_bunch=stems_bunch,
            bunches=bunches, rate=round(rate, 6), nm_product=re.sub(r"\s+", " ", nm_product),
            location=(fields.get("location") or "").strip(),
            weight=round(n("grams") / 1000, 4), qual=(fields.get("qual") or "").strip(),
            named=bool(named),
        ))
    return products


class _Blank(dict):
    """format_map values where a missing placeholder reads as nothing."""
    def __missing__(self, key: str) -> str:
        return ""


def _read_box_blocks(rows: list[dict[str, Any]], spec: LayoutSpec,
                     num: Callable[[str], float]) -> tuple[list[_BoxBlock], int | None]:
    """The blocks of boxes, and — when every block carries box numbers
    starting at 1 — the last box number, which is then the box count."""
    blocks: list[_BoxBlock] = []
    last_number = None
    numbers: list[tuple[int, int]] = []
    unnumbered = False
    location = ""
    for fields in rows:
        # A row naming only a farm heads the rows below it ("San Pablo HAWB …").
        if fields.get("location") and not any(
                fields.get(k) for k in ("count", "number", "product", "variety")):
            location = fields["location"]
            continue
        if location and not fields.get("location"):
            fields = {**fields, "location": location}
        count_raw = (fields.get("count") or "").strip()
        number_raw = fields.get("number") or ""
        if number_raw and fields.get("number_last"):
            number_raw = f"{number_raw} - {fields['number_last']}"
        number = _box_number(number_raw)
        opens = 0
        # A box count is a whole number, "4" or "4.00"; a totals row merged
        # into one cell ("TOTALS 8 200 65.00 …") is not one.
        if re.fullmatch(r"\d+(?:[.,]0+)?", count_raw) and num(count_raw) >= 1:
            opens = int(round(num(count_raw)))
            last_number = number[0] if number else None
        elif number and number[0] != last_number:
            opens = number[1]
            last_number = number[0]

        if opens:
            if number:
                numbers.append(number[0])
            else:
                unnumbered = True
            block = _BoxBlock(count=opens, box=fields.get("box") or "", opener=fields)
            blocks.append(block)
            products = _row_products(fields, spec, num, block, is_item=False)
            if spec.block_row_is_summary:
                block.summary = products
            else:
                block.products.extend(products)
        elif blocks:
            blocks[-1].products.extend(
                _row_products(fields, spec, num, blocks[-1], is_item=True))
        # A product before any row that opens a block has no box; it is left
        # out, and the totals check says so.
    for block in blocks:
        if not block.products:
            block.products = block.summary
    last_box = (max(last for _, last in numbers)
                if numbers and not unnumbered and min(first for first, _ in numbers) == 1
                else None)
    return [b for b in blocks if b.products], last_box


def _box_code_boxes(raw: str, spec: LayoutSpec) -> tuple[str, str]:
    """(the box FreshPortal gets, the printed code when that is a guess —
    empty when the code is one we know)."""
    raw = (raw or "").strip() or spec.default_box
    if spec.box_re:
        m = re.search(spec.box_re, raw)
        raw = m.group(1) if m else raw
    else:
        raw = re.sub(r"\s*\(.*?\)", "", raw)
    raw = raw.strip()
    box, guessed = guess_box(spec.box_map.get(raw.upper()) or _normalise_box(raw))
    return box, (raw.upper() if guessed else "")


def _split_uneven(block: _BoxBlock, fill: int = 0) -> list[_BoxBlock]:
    """A block of one product whose bunches do not divide between its boxes,
    as the boxes that hold one more and the boxes that hold one fewer:
    272 stems in 3 boxes are 2 boxes of 91 and 1 of 90. Only for a supplier
    whose invoice states nothing finer (split_uneven).

    With `fill`, boxes are filled with that many and the last takes the
    rest, 100, 100 and 72 (user, 2026-09-29), wherever that makes exactly
    the block's boxes."""
    count = max(1, block.count)
    if len(block.products) != 1:
        return [block]
    product = block.products[0]
    if fill:
        full, rest = divmod(product.bunches, fill)
        if full + (1 if rest else 0) == count:
            parts = [dataclasses.replace(block, count=full,
                                         products=[dataclasses.replace(product, bunches=fill * full)])
                     ] if full else []
            if rest:
                parts.append(dataclasses.replace(
                    block, count=1, products=[dataclasses.replace(product, bunches=rest)]))
            return parts
    if product.bunches % count == 0:
        return [block]
    base, extra = divmod(product.bunches, count)
    parts = [dataclasses.replace(block, count=extra,
                                 products=[dataclasses.replace(product, bunches=(base + 1) * extra)])]
    if base:
        parts.append(dataclasses.replace(
            block, count=count - extra,
            products=[dataclasses.replace(product, bunches=base * (count - extra))]))
    return parts


def _build_box_lines(blocks: list[_BoxBlock], spec: LayoutSpec
                     ) -> tuple[list[DeliveryLine], int, float | None]:
    """Lines as _parse_invoices_format builds them from a JSON with product
    ids: a box of one product is merged with the other boxes of that product,
    and each box holding several is a mix box MBn of its own. Returns the
    lines, the box count and the full-box equivalent (None when a box code's
    size is not known)."""
    lines: list[DeliveryLine] = []
    merged: dict[tuple, DeliveryLine] = {}
    # A named product's merge key → (its run, the last block it was in).
    runs: dict[tuple, tuple[int, int]] = {}
    mix_box_counter = 0
    nu_boxes = 0
    fulls: float | None = 0.0

    if spec.split_uneven:
        blocks = [part for block in blocks for part in _split_uneven(block, spec.box_fill)]
    for index, block in enumerate(blocks):
        count = max(1, block.count)
        nu_boxes += count
        box_type, printed_box = _box_code_boxes(block.box, spec)
        size = (spec.box_fulls.get(printed_box) if printed_box
                else spec.box_fulls.get(box_type, BOX_FULLS.get(box_type)))
        fulls = None if (fulls is None or size is None) else fulls + size * count

        uneven = next((p for p in block.products if p.bunches % count), None)
        if uneven:
            raise PdfChecksumError(
                f"{spec.name} layout: a block of {count} boxes lists {uneven.bunches} "
                f"bunches of {uneven.variety}, which does not divide between them — the "
                f"boxes in this block are not identical, so per-box quantities cannot be "
                f"recovered from the PDF."
            )
        # What one box of the block holds. A product printed on two rows of
        # one box is one product of that box.
        in_box: dict[tuple, list] = {}
        for p in block.products:
            # A named mix keeps its grades apart: they are different lengths.
            key = (p.species.lower(), p.variety.lower(), p.length, p.stems_bunch, p.rate,
                   p.location.lower(), p.weight, p.qual.lower() if p.named else "")
            if key in in_box:
                in_box[key][1] += p.bunches // count
            else:
                in_box[key] = [p, p.bunches // count]
        # Several products in one box make it a mix box, including one variety
        # at two lengths or two prices: as single-product lines, each would
        # count the same box again.
        is_mix = len(in_box) > 1
        mix_name = next((name for pattern, name in spec.mix_names
                         if all(re.search(pattern, f"{p.species} {p.variety}", re.IGNORECASE)
                                for p, _ in in_box.values())), "") if is_mix else ""

        for _ in range(count):
            if is_mix and not spec.merge_across_boxes:
                mix_box_counter += 1
                box_code = f"MB{mix_box_counter}"
                for product, bunches in in_box.values():
                    line = _line(product, spec, lambda s: s, product.location,
                                 box_code=box_code, bunches=bunches, physical_boxes=1)
                    line.nm_box_type = box_type
                    line.mix_name = mix_name
                    lines.append(line)
                continue
            for key, (product, bunches) in in_box.items():
                # Boxes merge only when they hold the same, bunch for bunch:
                # FreshPortal takes a line as N boxes of one content, and
                # 6 boxes of 10 bunches plus 6 of 12 are not 12 boxes of 11.
                merge_key = (*key, box_type, bunches)
                if product.named or not product.length:
                    # A named mix is whatever the farm packed in those boxes,
                    # and a product printed with no length may be two lengths:
                    # boxes printed apart stay apart, so the screen can give
                    # each its own (MYJ 028119, MIX FANCY in boxes 15-16 and
                    # 19-20: two lines; user, 2026-09-29: "często to właśnie
                    # length jest tym co różni produkty").
                    run, last = runs.get(merge_key, (0, index))
                    if last < index - 1:
                        run += 1
                    runs[merge_key] = (run, index)
                    merge_key = (*merge_key, run)
                if merge_key in merged:
                    merged[merge_key].nu_bunches += bunches
                    merged[merge_key].nu_physical_boxes += 1
                else:
                    merged[merge_key] = _line(product, spec, lambda s: s, product.location,
                                              box_code=box_type, bunches=bunches,
                                              physical_boxes=1)
                    if printed_box:
                        merged[merge_key].box_guessed = True
                        merged[merge_key].nm_box_printed = printed_box

    lines.extend(merged.values())
    lines.sort(key=lambda l: (l.nm_species, l.nm_variety, l.nu_length))
    return lines, nu_boxes, (round(fulls, 4) if fulls is not None else None)


def _printed_totals(doc: PdfDoc, spec: LayoutSpec, num: Callable[[str], float],
                    from_grid: dict) -> dict:
    """The totals the invoice prints for itself, from its totals row, its
    totals text and its box count lines."""
    printed = dict(from_grid)
    if spec.totals_re:
        m = re.search(spec.totals_re, doc.text, re.IGNORECASE | re.MULTILINE)
        if m:
            for key, value in m.groupdict().items():
                if not value:
                    continue
                if key in ("boxes", "bunches", "stems"):
                    printed[key] = int(round(num(value)))
                elif key in ("amount", "fulls"):
                    printed[key] = num(value)
    if spec.boxes_re:
        found = re.findall(spec.boxes_re, doc.text, re.IGNORECASE | re.MULTILINE)
        if found:
            printed["boxes"] = sum(int(round(num(v))) for v in found)
    if spec.fulls_re:
        m = re.search(spec.fulls_re, doc.text, re.IGNORECASE | re.MULTILINE)
        if m:
            printed["fulls"] = num(m.group(1))
    return {k: v for k, v in printed.items() if v}


def _resolve_columns(doc: PdfDoc, spec: LayoutSpec) -> LayoutSpec:
    """The spec with header_columns and lengths_from_header turned into
    column indexes, from this invoice's own header row."""
    if not (spec.header_columns or spec.lengths_from_header):
        return spec
    wanted = [h.lower() for h in spec.grid_header]
    header = next((row for table in doc.tables for row in table
                   if _is_grid_header(row, wanted)), None)
    if header is None:
        return spec
    columns = dict(spec.columns)
    for name, pattern in spec.header_columns.items():
        idx = next((i for i, cell in enumerate(header)
                    if re.search(pattern, cell, re.IGNORECASE)), None)
        if idx is None:
            raise PdfParseError(f"{spec.name} layout: the product table has no column "
                                f"headed like {pattern!r} for {name}")
        columns[name] = idx
    length_cols = dict(spec.length_cols)
    if spec.lengths_from_header:
        length_cols.update({i: int(cell) for i, cell in enumerate(header)
                            if re.fullmatch(r"\d{2,3}", cell.strip())})
    return dataclasses.replace(spec, columns=columns, header_columns={},
                               lengths_from_header=False, length_cols=length_cols)


def _parse_boxes(doc: PdfDoc, spec: LayoutSpec) -> DeliveryOrder:
    num = _num_comma if spec.decimal == "," else _num
    spec = _resolve_columns(doc, spec)
    from_grid: dict = {}
    if spec.lines:
        rows = _text_rows(doc, spec)
        if not rows:
            raise PdfParseError(
                f"{spec.name} layout: no line of this PDF's text reads as a product row. "
                f"The template's lines no longer match the spec — run "
                f"`python -m pdf_layouts <file.pdf>` to compare."
            )
    else:
        grid = _grid_rows(doc, spec.grid_header)
        if not grid:
            raise PdfParseError(
                f"{spec.name} layout: the product table was not found in this PDF. "
                f"Expected a table with {', '.join(spec.grid_header)} in its header; "
                f"the PDF has {_table_shapes(doc)}. Run "
                f"`python -m pdf_layouts <file.pdf>` to see what it actually contains."
            )
        marker_col = spec.totals_col if spec.totals_col >= 0 else spec.columns.get(
            "product", spec.columns.get("variety"))
        rows = []
        for row in grid:
            if (spec.totals_marker and marker_col is not None and marker_col < len(row)
                    and row[marker_col].strip().upper().startswith(spec.totals_marker.upper())):
                def cell(name: str) -> str:
                    idx = spec.columns.get(name)
                    return row[idx] if idx is not None and idx < len(row) else ""
                from_grid = {"boxes": int(round(num(cell("count")))),
                             "bunches": int(round(num(cell("bunches")))),
                             "stems": int(round(num(cell("stems")))),
                             "amount": num(cell("subtotal"))}
                continue
            fields = _table_row_fields(row, spec)
            if fields is not None:
                rows.append(fields)

    blocks, last_box = _read_box_blocks(rows, spec, num)
    if not blocks:
        raise PdfParseError(
            f"{spec.name} layout: {len(rows)} row(s) were found but none parsed as a product. "
            f"The column map, lines or product_re in this layout's spec no longer match "
            f"what the invoice prints — run `python -m pdf_layouts <file.pdf>` to compare."
        )
    lines, nu_boxes, fulls = _build_box_lines(blocks, spec)
    locations = {l.nm_location for l in lines}
    nm_location = _warehouse(doc, spec) or (next(iter(locations)) if len(locations) == 1 else "")
    order = _make_order(doc, spec, lines, nu_boxes, nm_location)

    printed = _printed_totals(doc, spec, num, from_grid)
    # Boxes numbered 1 to N are N boxes: a row missed on the way shows as one
    # box short, where an invoice prints no box count of its own.
    if last_box and not printed.get("boxes"):
        printed["boxes"] = last_box
    if not (printed.get("stems") or printed.get("amount")):
        raise PdfChecksumError(
            f"{spec.name} layout: the totals this invoice prints were not found, so the "
            f"parsed lines cannot be checked against them. Nothing was imported — the "
            f"template has probably changed; run `python -m pdf_layouts <file.pdf>`."
        )
    _check_totals(printed, order, spec.name, fulls=fulls)
    return order


# ---------------------------------------------------------------------------
# Checksum
# ---------------------------------------------------------------------------

# A line total is stems × a rate printed to four decimals; rounding at that
# scale can move the invoice total by a cent or two.
_AMOUNT_TOLERANCE = 0.05


def _check_totals(printed: dict, order: DeliveryOrder, layout: str,
                  fulls: float | None = None) -> None:
    """Compare the rebuilt order against the totals the invoice prints for
    itself. This is what catches a supplier quietly changing their template."""
    if not printed:
        log.warning("[pdf/%s] no totals row found — checksum skipped", layout)
        return

    problems = []
    if printed.get("boxes") and printed["boxes"] != order.nu_boxes:
        problems.append(f"boxes: invoice says {printed['boxes']}, parsed {order.nu_boxes}")
    if printed.get("stems") and printed["stems"] != order.nu_stems_total:
        problems.append(f"stems: invoice says {printed['stems']}, parsed {order.nu_stems_total}")
    if printed.get("amount") and abs(printed["amount"] - order.mny_total) > _AMOUNT_TOLERANCE:
        problems.append(f"amount: invoice says {printed['amount']:.2f}, "
                        f"parsed {order.mny_total:.2f}")
    bunches = sum(l.nu_bunches for l in order.lines)
    if printed.get("bunches") and printed["bunches"] != bunches:
        problems.append(f"bunches: invoice says {printed['bunches']}, parsed {bunches}")
    if printed.get("fulls") and fulls is not None and abs(printed["fulls"] - fulls) > 0.001:
        problems.append(f"full boxes: invoice says {printed['fulls']:g}, parsed {fulls:g}")
    if problems:
        raise PdfChecksumError(
            f"{layout} layout: the parsed lines do not add up to the totals printed on "
            f"the invoice ({'; '.join(problems)}). Nothing was imported — check the PDF, "
            f"or use the supplier's JSON."
        )
    log.info("[pdf/%s] checksum ok — %d boxes, %d stems, %.2f",
             layout, order.nu_boxes, order.nu_stems_total, order.mny_total)


# ---------------------------------------------------------------------------
# Parsing one document against one spec
# ---------------------------------------------------------------------------

def _table_shapes(doc: PdfDoc) -> str:
    """"3 tables (7x2, 6x13, 4x4)" — enough detail in a failure message for
    someone to tell a missing table from a mis-mapped one."""
    if not doc.tables:
        return "no tables at all, so its rows are not ruled"
    shapes = ", ".join(f"{len(t)}x{len(t[0])}" for t in doc.tables[:8])
    more = "" if len(doc.tables) <= 8 else f", +{len(doc.tables) - 8} more"
    return f"{len(doc.tables)} table(s) ({shapes}{more})"


def _warehouse(doc: PdfDoc, spec: LayoutSpec) -> str:
    """The nm_location the JSON carries per product, when the invoice prints a
    warehouse summary naming exactly one warehouse. With several there is no
    way to tell which line came from which, so none is claimed."""
    if not spec.location_re:
        return ""
    scope = doc.text
    if spec.location_block:
        block = re.search(spec.location_block, doc.text, re.IGNORECASE | re.DOTALL)
        if not block:
            return ""
        scope = block.group(1)
    names = re.findall(spec.location_re, scope, re.IGNORECASE | re.MULTILINE)
    unique = {n.strip().upper(): n.strip() for n in names if n.strip()}
    return next(iter(unique.values())) if len(unique) == 1 else ""


def _make_order(doc: PdfDoc, spec: LayoutSpec, lines: list[DeliveryLine],
                nu_boxes: int, nm_location: str) -> DeliveryOrder:
    table_kv = _key_values(doc)

    def header(name: str) -> str:
        reader = spec.header.get(name)
        return reader(doc, table_kv) if reader else ""

    id_invoice = header("id_invoice")
    return DeliveryOrder(
        tx_company=header("tx_company"),
        nm_location=nm_location,
        id_invoice=id_invoice,
        # Invoices that print no separate PO number repeat the invoice number,
        # which is what the JSON parsers do for the same suppliers.
        id_purchaseorder=header("id_purchaseorder") or id_invoice,
        dt_fly=header("dt_fly"),
        dt_invoice=header("dt_invoice"),
        nm_ship=header("nm_ship"),
        nm_cargo=header("nm_cargo"),
        tx_awb=header("tx_awb"),
        tx_hawb=header("tx_hawb"),
        nu_boxes=nu_boxes,
        nu_stems_total=sum(l.nu_stems_total for l in lines),
        mny_total=round(sum(l.mny_total for l in lines), 2),
        lines=lines,
    )


def parse_with_spec(doc: PdfDoc, spec: LayoutSpec) -> DeliveryOrder:
    if spec.row_model == "boxes":
        return _parse_boxes(doc, spec)

    rows = _grid_rows(doc, spec.grid_header)
    if not rows:
        raise PdfParseError(
            f"{spec.name} layout: the product table was not found in this PDF. "
            f"Expected a table with {', '.join(spec.grid_header)} in its header; "
            f"the PDF has {_table_shapes(doc)}. Run "
            f"`python -m pdf_layouts <file.pdf>` to see what it actually contains."
        )

    blocks, extra = _read_blocks(rows, spec)
    if not blocks:
        raise PdfParseError(
            f"{spec.name} layout: the product table was found ({len(rows)} rows) but no "
            f"row in it parsed as a product. The column map or product_re in this "
            f"layout's spec no longer matches what the invoice prints — run "
            f"`python -m pdf_layouts <file.pdf>` to compare."
        )

    nm_location = _warehouse(doc, spec)
    lines, nu_boxes = _build_lines(
        blocks, spec, nm_location, _species_resolver(extra["species_seen"])
    )
    order = _make_order(doc, spec, lines, nu_boxes, nm_location)

    printed = extra["printed"]
    if not printed and spec.totals_re:
        m = re.search(spec.totals_re, doc.text, re.IGNORECASE)
        if m:
            printed = {"boxes": _int(m.group(1)),
                       "stems": _int(m.group(3)),
                       "amount": _num(m.group(4))}
    _check_totals(printed, order, spec.name)
    return order


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _specs() -> list[LayoutSpec]:
    from pdf_layouts import LAYOUTS
    return LAYOUTS


def _parse_with_stored(pdf_bytes: bytes) -> list[DeliveryOrder] | None:
    try:
        from pdf_layout_store import parse_with_stored
    except ImportError:  # pragma: no cover - the module ships with this one
        return None
    return parse_with_stored(pdf_bytes)


def detect_pdf_layout(text: str) -> LayoutSpec | None:
    for spec in _specs():
        if re.search(spec.detect, text, re.IGNORECASE):
            return spec
    return None


def parse_delivery_pdf(pdf_bytes: bytes) -> list[DeliveryOrder]:
    """Parse a supplier PDF invoice into DeliveryOrder objects.

    Raises PdfParseError when the file cannot be read at all (not a PDF, a
    scan), and PdfUnknownLayoutError when no layout reads it - including a
    known supplier's invoice whose lines disagree with the totals it prints.
    """
    doc = extract_pdf(pdf_bytes)
    spec = detect_pdf_layout(doc.text)
    if not spec:
        # A layout drafted for a new supplier, while IT has not yet added one
        # in code (pdf_layout_store). Tried only after every layout in code.
        stored = _parse_with_stored(pdf_bytes)
        if stored is not None:
            return stored
        known = ", ".join(sorted(s.name for s in _specs()))
        raise PdfUnknownLayoutError(
            f"this PDF is not in a supported supplier layout ({known}). Every supplier "
            f"prints a different invoice, so each template needs to be described once "
            f"before its PDFs can be imported — send this file in to have it added."
        )
    try:
        if spec.extract:
            # Read again the way this template needs; detection above only
            # needs the supplier's name, which any reading shows.
            doc = extract_pdf(pdf_bytes, **spec.extract)
        log.info("[pdf] layout=%s tables=%d", spec.name, len(doc.tables))
        order = parse_with_spec(doc, spec)
    except Exception as exc:
        # The supplier's layout finds the invoice but cannot read it: a new
        # printout, most likely. A layout drafted for it reads it instead;
        # without one it goes to IT like an unknown supplier's.
        if not isinstance(exc, PdfParseError):
            log.exception("[pdf/%s] the layout failed", spec.name)
        stored = _parse_with_stored(pdf_bytes)
        if stored is not None:
            return stored
        reason = str(exc) if isinstance(exc, PdfParseError) else f"{type(exc).__name__}: {exc}"
        raise PdfUnknownLayoutError(
            f"the {spec.name} layout finds this invoice but cannot read it: {reason}",
            layout=spec.name,
        ) from exc
    log.info("[pdf/%s] parsed %d line(s), %d box(es)", spec.name, len(order.lines), order.nu_boxes)
    return [order]
