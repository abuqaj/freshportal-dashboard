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

import io
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from parser_delivery import (
    DeliveryLine,
    DeliveryOrder,
    _normalise_box,
    _normalise_date,
    _parse_date_iso,
)

log = logging.getLogger(__name__)


class PdfParseError(ValueError):
    """The PDF could not be read as a delivery invoice."""


class PdfChecksumError(PdfParseError):
    """Parsed lines do not add up to the totals the invoice prints."""


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


def extract_pdf(pdf_bytes: bytes) -> PdfDoc:
    """Read text and tables out of a PDF. Raises PdfParseError for anything
    that is not a readable, text-layer PDF."""
    try:
        import pdfplumber
    except ImportError as exc:  # pragma: no cover - deployment guard
        raise PdfParseError(
            "PDF support requires the pdfplumber package (add it to requirements.txt)"
        ) from exc

    pages_text: list[str] = []
    tables: list[list[list[str]]] = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                pages_text.append(page.extract_text() or "")
                for table in page.extract_tables():
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


def last_word(v: str) -> str:
    """The last token of a line.

    Invoices print the bill-to and ship-to blocks side by side, so a line of
    the page text holds one field from each: "FRESH FROM SOURCE BV 1OZH".
    The consignee code is the tail.
    """
    parts = v.split()
    return parts[-1] if parts else ""


def rx(pattern: str, transform: Callable[[str], str] | None = None,
       flags: int = re.IGNORECASE) -> Reader:
    """Read a header field with a regex over the page text (group 1)."""
    compiled = re.compile(pattern, flags)

    def read(doc: PdfDoc, _kv: dict[str, str]) -> str:
        m = compiled.search(doc.text)
        value = m.group(1).strip() if m else ""
        return transform(value) if (transform and value) else value
    return read


def kv(label: str, transform: Callable[[str], str] | None = None) -> Reader:
    """Read a header field from the invoice's label/value table.

    The page text lists such a box as a run of labels followed by a run of
    values, so the label is the only way back to its value.
    """
    key = label.lower()

    def read(_doc: PdfDoc, table_kv: dict[str, str]) -> str:
        value = table_kv.get(key, "")
        return transform(value) if (transform and value) else value
    return read


def first_line() -> Reader:
    """The first non-empty line of the document — where most invoices print
    the issuing company."""
    def read(doc: PdfDoc, _kv: dict[str, str]) -> str:
        return next((l.strip() for l in doc.text.split("\n") if l.strip()), "")
    return read


def any_of(*readers: Reader) -> Reader:
    """First reader that finds something."""
    def read(doc: PdfDoc, table_kv: dict[str, str]) -> str:
        for reader in readers:
            value = reader(doc, table_kv)
            if value:
                return value
        return ""
    return read


def const(value: str) -> Reader:
    def read(_doc: PdfDoc, _kv: dict[str, str]) -> str:
        return value
    return read


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

    def __post_init__(self) -> None:
        if self.row_model not in ("flat", "grouped"):
            raise ValueError(f"{self.name}: unknown row_model {self.row_model!r}")
        if "product" not in self.columns:
            raise ValueError(f"{self.name}: columns must map 'product'")
        unknown = set(self.columns) - set(GRID_FIELDS)
        if unknown:
            raise ValueError(f"{self.name}: unknown grid columns {sorted(unknown)}")
        for required in ("tx_company", "id_invoice", "dt_invoice", "dt_fly"):
            if required not in self.header:
                raise ValueError(f"{self.name}: header must supply {required!r}")


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
    )


# ---------------------------------------------------------------------------
# Checksum
# ---------------------------------------------------------------------------

# A line total is stems × a rate printed to four decimals; rounding at that
# scale can move the invoice total by a cent or two.
_AMOUNT_TOLERANCE = 0.05


def _check_totals(printed: dict, order: DeliveryOrder, layout: str) -> None:
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


def parse_with_spec(doc: PdfDoc, spec: LayoutSpec) -> DeliveryOrder:
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

    table_kv = _key_values(doc)

    def header(name: str) -> str:
        reader = spec.header.get(name)
        return reader(doc, table_kv) if reader else ""

    id_invoice = header("id_invoice")
    order = DeliveryOrder(
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


def detect_pdf_layout(text: str) -> LayoutSpec | None:
    for spec in _specs():
        if re.search(spec.detect, text, re.IGNORECASE):
            return spec
    return None


def parse_delivery_pdf(pdf_bytes: bytes) -> list[DeliveryOrder]:
    """Parse a supplier PDF invoice into DeliveryOrder objects.

    Raises PdfParseError when the file is not a readable invoice in a known
    layout, and PdfChecksumError when the parsed lines disagree with the
    totals the invoice prints for itself.
    """
    doc = extract_pdf(pdf_bytes)
    spec = detect_pdf_layout(doc.text)
    if not spec:
        known = ", ".join(s.name for s in _specs())
        raise PdfParseError(
            f"this PDF is not in a supported supplier layout ({known}). Every supplier "
            f"prints a different invoice, so each template needs to be described once "
            f"before its PDFs can be imported — send this file in to have it added."
        )
    log.info("[pdf] layout=%s tables=%d", spec.name, len(doc.tables))
    order = parse_with_spec(doc, spec)
    log.info("[pdf/%s] parsed %d line(s), %d box(es)", spec.name, len(order.lines), order.nu_boxes)
    return [order]
