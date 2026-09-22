"""One description per supplier invoice template.

This is the file that grows: adding a supplier means adding a LayoutSpec here,
not writing a parser. parser_delivery_pdf.py does the reading — finding the
grid, following it across pages, repairing wrapped words, expanding blocks of
identical boxes, checking the totals.

To add a supplier:

 1. Run `python -m pdf_layouts <invoice.pdf>` to print the page text and every
    table the PDF contains, with column indexes.
 2. Copy the closest spec below and fill in: `detect` (wording from the
    supplier's template, not from one shipment), `grid_header`, `columns`,
    `product_re`, and the four required header fields — tx_company,
    id_invoice, dt_invoice, dt_fly.
 3. Point `totals_marker` or `totals_re` at the invoice's own totals, so a
    silent change to the template is caught instead of imported.
 4. For a grouped layout, parse one of the supplier's JSON exports too and
    set `merge_across_boxes` to whatever parser_delivery does with it. A
    delivery must import the same way whichever file arrives.
 5. Add a case to tests/test_parser_delivery_pdf.py with a few real rows.

Two row models cover both suppliers so far:

  flat      one row per product, quantities already summed across that
            product's boxes — the shape parser_delivery produces when it
            merges single-variety boxes.
  grouped   a row states how many identical boxes follow, and the rows under
            it list what is inside them with quantities summed across the
            block.
"""
from __future__ import annotations

import re

from parser_delivery_pdf import (
    LayoutSpec,
    any_of,
    date_iso,
    date_us,
    first_line,
    kv,
    last_word,
    nospace,
    rx,
)

# ---------------------------------------------------------------------------
# Quality Service Qualisa S.A.S
# ---------------------------------------------------------------------------
# 11-column grid, one block per set of identical boxes:
#   Order Type | Boxes | Box Type | Species | Varieties | CM | Bunch Box |
#   Total Stems | Unit Price | Total Price | Box Label
# The header box on the right is drawn without ruling lines, so it is not a
# table pdfplumber can return — but each label lands on the same text line as
# its value ("Invoice Date 2026-09-01"), so regexes read it. The invoice title
# runs into the invoice number with no space between them.

QUALISA = LayoutSpec(
    name="qualisa",
    detect=r"Ship\s+to\s*\(Destinatario\)|Customer\s+Invoice\s*#",
    grid_header=("order type", "boxes", "box type", "species", "varieties"),
    columns={"count": 1, "box": 2, "species": 3, "product": 4,
             "length": 5, "bunches": 6, "stems": 7, "rate": 8},
    # "PIERROT N 10ST QUCT" — greedy variety so it splits at the last
    # "<grade> <n>ST", leaving a multi-word name ("DIRTY DANCING") whole.
    product_re=r"^(?P<variety>.+)\s+\S+\s+(?P<stems_bunch>\d+)\s*ST\b\s*(?P<qual>\S*)$",
    row_model="grouped",
    # Qualisa's JSON products carry no gu_product, and the mix-box test in
    # parser_delivery counts distinct gu_product values — so its boxes go down
    # the single-variety branch there and merge into one line per product,
    # carrying the printed box type. Matching that keeps one delivery
    # importing the same way whether the JSON or the PDF arrives.
    merge_across_boxes=True,
    # The grid prints the length in its own column, so the name is rebuilt to
    # match what the JSON carries: "PIERROT 90CM 10ST QUCT".
    nm_product="{variety} {length}CM {stems_bunch}ST {qual}",
    header={
        # The title runs straight into the invoice label on the first line:
        # "QUALITY SERVICE QUALISA S.A.SCustomer Invoice#: 21022".
        "tx_company": any_of(rx(r"^\s*(.+?)\s*Customer\s+Invoice\s*#"), first_line()),
        "id_invoice": rx(r"Customer\s+Invoice\s*#?\s*:?\s*(\d+)"),
        "dt_invoice": rx(r"Invoice\s+Date\s+(\d{4}-\d{2}-\d{2})", date_iso),
        "dt_fly": rx(r"Delivery\s+Date\s+(\d{4}-\d{2}-\d{2})", date_iso),
        # Bill-to and ship-to are printed side by side, so the line under the
        # two labels carries both: "FRESH FROM SOURCE BV 1OZH".
        "nm_ship": rx(r"Ship\s+to\s*\(Destinatario\)[^\n]*\n([^\n]+)", last_word),
        # The carrier is printed on its own line directly above "Airline:".
        "nm_cargo": rx(r"\n([^\n]+)\n\s*Airline\s*:"),
        # \bAWB does not match inside HAWB. The house air waybill wraps
        # mid-code in a narrow column ("LA160900067" + "8" on the next line),
        # so the spaces the wrap leaves behind are stripped out.
        "tx_awb": rx(r"\bAWB\s+([\d][\d\s]*)", nospace),
        "tx_hawb": rx(r"\bHAWB\s+([A-Z0-9]+(?:\s*\n\s*\d+)?)", nospace),
    },
    # "20 Total 320 3,200 0.2500 800.00" — boxes, bunches, stems, rate, amount.
    totals_re=r"(\d+)\s+Total\s+([\d,]+)\s+([\d,]+)\s+[\d.]+\s+([\d,.]+)",
    # The warehouse summary at the end: "QUALISA 3 ALSTROEMERIA 3,200 0.25
    # 800.00", down to its Total row. Scoped to that block because the row
    # pattern alone also fits a product row ("ALSTROEMERIA PIERROT N 10ST
    # QUCT 80 2 20"), which would read as a second warehouse.
    location_block=r"Warehouse\s+Species\s+Stems[^\n]*\n(.*?)(?:\n\s*Total\b|\Z)",
    location_re=r"^\s*([A-Za-z][A-Za-z0-9 .\-]*?)\s+[A-Z]{4,}\s+[\d,]+",
)


# ---------------------------------------------------------------------------
# Alissroses SAS
# ---------------------------------------------------------------------------
# 13-column grid, one row per product, already aggregated across its boxes:
#   # | BOX | PRODUCT | SPECIES | QTY BUNCH | RATE PER BUNCH | QTY STEMS |
#   RATE PER Stem | SUB-TOTAL | LABEL | VOLUME WEIGHT | REAL WEIGHT | BOX NAME
# The address boxes above the grid share its borders, so pdfplumber returns
# the lot as one table whose first rows are the bill-to block; the engine
# finds the product header further down. The invoice's own label/value box is
# a separate ruled table, which is where the dates and numbers are read from.

ALISSROSES = LayoutSpec(
    name="alissroses",
    detect=r"ALISSROSES|Internal\s+PO\s+ID|SHIP\s+CUSTOMER",
    grid_header=("box", "product", "species", "qty", "sub-total"),
    columns={"count": 0, "box": 1, "product": 2, "species": 3,
             "bunches": 4, "stems": 6, "rate": 7, "subtotal": 8},
    # "EXPLORER 60CM 25ST AR" — the length is inside the name, not in a column.
    product_re=r"^(?P<variety>.+?)\s+(?P<length>\d+)\s*CM\s+(?P<stems_bunch>\d+)\s*ST\b",
    row_model="flat",
    # "QB 9 (90*35*17.5)" is printed with a size and dimensions, but the fust
    # is "QB" — the same code the JSON carries in tp_box.
    box_re=r"^([A-Za-z]+)",
    header={
        # The trading name sits on the line above the tax id — anchoring on
        # "RUC:" rather than on a corporate suffix, so a rename still reads.
        "tx_company": any_of(rx(r"([^\n]+)\n\s*RUC\s*:"),
                             rx(r"^([^\n]*S\.?A\.?S\.?)\s*$",
                                flags=re.IGNORECASE | re.MULTILINE)),
        # This invoice prints a real label/value box, so those fields are read
        # from the table, which cannot be thrown off by the surrounding text
        # reflowing. The regexes stay as a fallback.
        "id_invoice": any_of(kv("invoice numbers"), rx(r"Invoice\s+Numbers?\s+(\d+)")),
        "id_purchaseorder": any_of(kv("internal po id"),
                                   rx(r"Internal\s+PO\s+ID:?\s+(\d+)")),
        "dt_invoice": any_of(kv("invoice date", date_us),
                             rx(r"Invoice\s+Date\s+(\d{2}/\d{2}/\d{4})", date_us)),
        "dt_fly": any_of(kv("fly date", date_us),
                         rx(r"Fly\s+Date\s+(\d{2}/\d{2}/\d{4})", date_us)),
        # Bill-to and ship-to are printed side by side, so the line under the
        # two labels carries both: "FRESH FROM SOURCE B.V. 1OZH".
        "nm_ship": rx(r"SHIP\s+CUSTOMER\s*\n\s*([^\n]+)", last_word),
        "nm_cargo": rx(r"Cargo\s+Agency\s+([A-Z0-9 .\-]+?)(?:\s*Truck|\n|$)"),
        "tx_awb": rx(r"\bMAWB\b\s+([0-9][0-9\- ]{6,}?)(?:\s+HAWB|\n|$)"),
        "tx_hawb": rx(r"\bHAWB\b\s+(\S+)"),
    },
    # The grid's own last row: "6 TOTALS 28 700 $329.00".
    totals_marker="TOTAL",
)


LAYOUTS: list[LayoutSpec] = [QUALISA, ALISSROSES]


# ---------------------------------------------------------------------------
# Inspection helper — `python -m pdf_layouts <invoice.pdf>`
# ---------------------------------------------------------------------------

def _inspect(path: str) -> None:
    """Print what a PDF actually contains, so a new supplier's spec can be
    written from the real column indexes instead of guessed at."""
    from parser_delivery_pdf import detect_pdf_layout, extract_pdf

    with open(path, "rb") as fh:
        doc = extract_pdf(fh.read())

    spec = detect_pdf_layout(doc.text)
    print(f"=== detected layout: {spec.name if spec else '(none — needs a new spec)'}")
    print(f"=== page text ({len(doc.text)} chars)\n{doc.text}\n")
    for t, table in enumerate(doc.tables):
        print(f"=== table {t}: {len(table)} rows x {len(table[0])} cols")
        for r, row in enumerate(table[:6]):
            for c, value in enumerate(row):
                if value:
                    print(f"  [{r}][{c}] {value!r}")
            print("  --")


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m pdf_layouts <invoice.pdf>")
    _inspect(sys.argv[1])
