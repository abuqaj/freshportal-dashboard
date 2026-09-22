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
 4. Add a case to tests/test_parser_delivery_pdf.py with a few real rows.

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
    nospace,
    rx,
    short_code,
)

# ---------------------------------------------------------------------------
# Quality Service Qualisa S.A.S
# ---------------------------------------------------------------------------
# 11-column grid, one block per set of identical boxes:
#   Order Type | Boxes | Box Type | Species | Varieties | CM | Bunch Box |
#   Total Stems | Unit Price | Total Price | Box Label
# The header is a label/value box on the right, which the page text scrambles
# into a run of labels followed by a run of values — hence kv() for the dates
# and waybills, which only the table pairs back up correctly.

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
    # The grid prints the length in its own column, so the name is rebuilt to
    # match what the JSON carries: "PIERROT 90CM 10ST QUCT".
    nm_product="{variety} {length}CM {stems_bunch}ST {qual}",
    header={
        "tx_company": first_line(),
        "id_invoice": any_of(rx(r"Customer\s+Invoice\s*#?\s*:?\s*(\d+)"),
                             kv("customer invoice")),
        "dt_invoice": kv("invoice date", date_iso),
        "dt_fly": kv("delivery date", date_iso),
        # Printed under "Ship to (Destinatario):", a label the page text
        # separates from its value.
        "nm_ship": short_code(),
        # Values in the bill-to block are printed in the order of their
        # labels, so the carrier is the line directly above the airline.
        "nm_cargo": rx(r"Airline\s*:[^\n]*\n(?:[^\n]*\n)*?([^\n]+)\n[^\n]+\n\s*Invoice\s+Date"),
        # Both waybills wrap mid-code in a narrow column.
        "tx_awb": kv("awb", nospace),
        "tx_hawb": kv("hawb", nospace),
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
# The header prints each label beside its value on the same text line, so
# plain regexes read it.

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
        # The trading name is printed directly under the invoice title.
        "tx_company": any_of(rx(r"CUSTOMER\s+INVOICE\s+\d+\s*\n\s*([^\n]+)"),
                             rx(r"^([^\n]*S\.?A\.?S\.?)\s*$",
                                flags=re.IGNORECASE | re.MULTILINE)),
        "id_invoice": rx(r"Invoice\s+Numbers?\s+(\d+)"),
        "id_purchaseorder": rx(r"Internal\s+PO\s+ID:?\s+(\d+)"),
        "dt_invoice": rx(r"Invoice\s+Date\s+(\d{2}/\d{2}/\d{4})", date_us),
        "dt_fly": rx(r"Fly\s+Date\s+(\d{2}/\d{2}/\d{4})", date_us),
        "nm_ship": rx(r"SHIP\s+CUSTOMER\s*\n\s*([^\n]+)"),
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
