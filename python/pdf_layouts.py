"""One description per supplier invoice template.

This is the file that grows: adding a supplier means adding a LayoutSpec here,
not writing a parser. parser_delivery_pdf.py does the reading — finding the
grid, following it across pages, repairing wrapped words, expanding blocks of
identical boxes, checking the totals.

To add a supplier:

 1. Run `python -m pdf_layouts <invoice.pdf>` to print the page text and every
    table the PDF contains, with column indexes.
 2. Copy the closest spec below — most suppliers print from a program some
    other supplier here uses too — and fill in: `detect` (the supplier's own
    name or tax number, not the program's wording, which other farms share),
    `grid_header` and `columns` for a ruled grid, or `lines` for one read off
    the text, `product_re`, and the four required header fields —
    tx_company, id_invoice, dt_invoice, dt_fly.
 3. Point `totals_re` / `totals_marker`, and `boxes_re` / `fulls_re` where
    the invoice prints them, at the invoice's own totals, so a silent change
    to the template is caught instead of imported.
 4. Where the invoice leaves something out — the bunch size, what its box
    letters mean — set it in the spec from the supplier's other rows or its
    box summary, and say so in a comment.
 5. Run `.claude/skills/new-delivery-json-format/scripts/run_samples.py` over
    the sample collection before and after, with --save-baseline/--compare,
    and add the engine behaviour a new layout needed to
    tests/test_parser_delivery_pdf.py.

Three row models:

  flat      one row per product, quantities already summed across that
            product's boxes — the shape parser_delivery produces when it
            merges single-variety boxes. (Alissroses)
  grouped   a row states how many identical boxes follow, and the rows under
            it list what is inside them with quantities summed across the
            block. (Qualisa)
  boxes     both, and every supplier since: a row with a box count or box
            number opens a block of boxes and may name a product; the rows
            under it without one add products to it. Built into lines the
            way _parse_invoices_format builds a JSON with product ids, and
            refused unless the invoice's printed totals agree.
"""
from __future__ import annotations

import dataclasses
import re

from parser_delivery_pdf import (
    LETTER_BOXES,
    LayoutSpec,
    any_of,
    const,
    date_dmy,
    date_iso,
    date_text,
    date_us,
    date_ymd,
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


# ===========================================================================
# Ecuador and Colombia, 2026-09-28 — one sample invoice per supplier
# ===========================================================================
# Everything below uses the "boxes" row model. Each spec is detected by the
# supplier's own name, not by its template: many of these farms print from
# the same invoicing program, and the same program's columns mean different
# things at different farms (Mysticflowers' BOX column counts boxes,
# Fiorentina's numbers them). tx_company is the supplier's name as
# parser_delivery._SUPPLIER_GROWER_MAP spells it, which is FreshPortal's own
# spelling, so the supplier and its grower resolve without a manual match.
# Where that map has no entry, the name is as printed.

# ---------------------------------------------------------------------------
# The "Farm Information" program
# ---------------------------------------------------------------------------
# "INVOICE # 0000314631", a Farm Information and a Customer Information box,
# one grid row per block of boxes with decimal commas, and a list of
# "TOTAL CAJAS H: 5" per box letter. The BOX column differs per farm: a box
# count, a box number, or a range of box numbers ("03 - 04").

FARM_INFO_HEADER = {
    "id_invoice": rx(r"INVOICE\s*#?\s*(\d{5,})"),
    # "Date : 18/09/2026", never "Due Date :". Fiorentina's text runs the
    # label into the address beside it: "Post addressD:ate : 16/09/2026".
    "dt_invoice": rx(r"(?<!Due )D:?ate\s*:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
    "dt_fly": rx(r"(?<!Due )D:?ate\s*:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
    "nm_ship": rx(r"Consignee\s*:\s*(.+?)\s*(?:H\.A\.W\.B.*|Shipper.*|Country.*)?$",
                  flags=re.IGNORECASE | re.MULTILINE),
    "nm_cargo": rx(r"Shipper\s*:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
    "tx_awb": rx(r"(?<!H\.)A\.W\.B\.\s*N\S*\s*:\s*(\S+)"),
    "tx_hawb": rx(r"H\.A\.W\.B\.?\s*(?:N\S*\s*)?:?\s*([A-Z]{2}\d+)"),
}
FARM_INFO_TOTALS = (r"^\s*TOTAL\s+(?P<bunches>\d+)\s+(?P<stems>\d+)\s+\$?\s*(?P<amount>[\d.,]+)\s*$")
FARM_INFO_BOXES = r"TOTAL\s+CAJAS\s+[A-Z]\s*:\s*(\d+)"
# A carnation or spray grade printed after the variety.
GRADE = r"FANCY|SELECT|STANDARD?|PREMIUM|SEL|STD"

FIORENTINA = LayoutSpec(
    name="fiorentina",
    detect=r"FIORENTINA\s+FLOWERS",
    grid_header=("box", "tb", "variety", "can", "bunches"),
    # BOX numbers the boxes: "1", then a blank row is more of box 1.
    columns={"number": 0, "box": 1, "label": 2, "variety": 3, "bunches": 4,
             "stems_bunch": 5, "length": 6, "stems": 7, "rate": 8, "subtotal": 9},
    product_re="",
    row_model="boxes",
    header={"tx_company": const("FIORENTINA FLOWERS"), **FARM_INFO_HEADER},
    box_map=LETTER_BOXES,
    species="Roses",
    decimal=",",
    totals_re=FARM_INFO_TOTALS,
    boxes_re=FARM_INFO_BOXES,
    fulls_re=r"TOTAL\s+BOXES\s+([\d.]+)",
)

MYSTICFLOWERS = LayoutSpec(
    name="mysticflowers",
    detect=r"MYSTICFLOWERS",
    grid_header=("box n", "tb", "variety", "cantid", "bunche"),
    # BOX N° counts the boxes of the row: "5 H" is five half boxes.
    columns={"count": 0, "box": 1, "label": 2, "variety": 3, "bunches": 5,
             "stems_bunch": 6, "length": 7, "stems": 8, "rate": 9, "subtotal": 10},
    # Eryngium comes as "FR Eryngium Natural BL"; roses by variety alone.
    product_re=r"^(?:(?:FR\s+)?(?P<species>ERYNGIUM)\s+)?(?P<variety>.+)$",
    row_model="boxes",
    header={"tx_company": const("MYSTIC FLOWERS S.A."), **FARM_INFO_HEADER},
    box_map=LETTER_BOXES,
    species="Roses",
    # "MIX COLOR" is boxed as "BICO HOT", "RED", "CERISE": which mix it is.
    label_joins_variety=r"^MIX\b",
    decimal=",",
    totals_re=FARM_INFO_TOTALS,
    boxes_re=FARM_INFO_BOXES,
    fulls_re=r"TOTAL\s+BOXES\s+([\d.]+)",
)

FLOREQUISA = LayoutSpec(
    name="florequisa",
    detect=r"FLORES\s+EQUINOCCIALES|FLOREQUISA",
    grid_header=("box", "tb", "variety", "quantit", "stems/bunch"),
    # BOX numbers the boxes, a range for identical ones: "03 - 04".
    columns={"number": 0, "box": 1, "label": 2, "variety": 3, "bunches": 5,
             "stems_bunch": 6, "length": 7, "stems": 8, "rate": 9, "subtotal": 10},
    # "PINK PIGEON SELECT A": the grade is not part of the variety.
    product_re=rf"^(?P<variety>.+?)(?:\s+(?P<qual>{GRADE})(?:\s+[A-Z])?)?$",
    row_model="boxes",
    header={"tx_company": const("FLORES EQUINOCCIALES S.A FLOREQUISA"), **FARM_INFO_HEADER},
    box_map=LETTER_BOXES,
    # No species is printed. The farm grows only chrysanthemum, eryngium,
    # delphinium, gypsophila and dianthus (user, 2026-09-29): a variety not
    # named after one of the first four is a dianthus.
    species_rules=((r"GYPS", "Gypsophila"), (r"ERYNG", "Eryngium"), (r"DELPH", "Delphinium"),
                   (r"CHRYS|CRISANT|POMPON|DAISY|SPIDER|CUSHION|DISBUD|SANTINI",
                    "Chrysanthemum")),
    species="Dianthus",
    # Its assorted boxes go as one mix product each: Minami boxes as Dianthus
    # Mix Minami, the other dianthus as Dianthus Sp Mix (user, 2026-09-29,
    # invoice 0000171464: 2x300 and 3x300).
    mix_names=((r"\bMINAMI\b", "Dianthus Mix Minami"), (r"^Dianthus\b", "Dianthus Sp Mix")),
    decimal=",",
    nm_product="{variety} {qual}",
    totals_re=FARM_INFO_TOTALS,
    boxes_re=FARM_INFO_BOXES,
    fulls_re=r"TOTAL\s+BOXES\s+([\d.]+)",
)

AGROGANA = LayoutSpec(
    name="agrogana",
    detect=r"AGROGANA",
    grid_header=("box", "tb", "variety", "quant", "stems per"),
    # Only the page with the TOTAL row prints an empty column after VARIETY,
    # so on 0000299013 page 1 has QUANT in column 5 and page 2 in column 6:
    # the columns are found by their headers, on each page.
    columns={"number": 0, "box": 1, "label": 2},
    header_columns={"variety": r"^VARIETY$", "bunches": r"^QUANT", "stems_bunch": r"^STEMS\s+PER",
                    "length": r"^LENGT", "stems": r"^STEMS$", "rate": r"^PRICE",
                    "subtotal": r"^TOTAL$"},
    product_re="",
    row_model="boxes",
    header={"tx_company": const("AGROGANA S.A."), **FARM_INFO_HEADER},
    box_map=LETTER_BOXES,
    species="Roses",
    # A box's label is the product, whatever varieties it lists: MIX CALIDO
    # the farm's warm bicolour mix (user, 2026-09-29, 0000294844). The rest
    # as the user entered 0000299013 in FreshPortal (2026-10-06): MIX HOT
    # (Cotton Candy) is warm bicolour too, and MIX RED is Rosa Ec Red, not
    # the "Rosa Ec Mix Red" first answered.
    variety_rules=(("label", r"^MIX\s+CALIDO$", "Rosa Ec Bicolor Warm"),
                   ("label", r"^MIX\s+HOT$", "Rosa Ec Bicolor Warm"),
                   ("label", r"^MIX\s+FRIO$", "Rosa Ec Bicolor Cold"),
                   ("label", r"^MIX\s+HOT\s+PINK$", "Rosa Ec Hot Pink"),
                   ("label", r"^MIX\s+RED$", "Rosa Ec Red"),
                   ("label", r"^MIX\s+WHITE$", "Rosa Ec White")),
    decimal=",",
    totals_re=FARM_INFO_TOTALS,
    boxes_re=FARM_INFO_BOXES,
    fulls_re=r"TOTAL\s+BOXES\s+([\d.]+)",
)

FLORIFRUT = LayoutSpec(
    name="florifrut",
    detect=r"FLORIFRUT",
    grid_header=("box n", "tb", "variety", "cantidad", "bunches"),
    # BOX N° numbers the boxes, 1 to 6 on 0001100089. It was read as a box
    # count, like Mysticflowers', from a first invoice of one box, where the
    # two read the same.
    columns={"number": 0, "box": 1, "label": 2, "variety": 3, "bunches": 4,
             "stems_bunch": 5, "length": 6, "stems": 7, "rate": 8, "subtotal": 9},
    product_re="",
    row_model="boxes",
    header={"tx_company": const("FLORES Y FRUTAS FLORIFRUT S.A."), **FARM_INFO_HEADER},
    box_map=LETTER_BOXES,
    species="Roses",
    decimal=",",
    totals_re=FARM_INFO_TOTALS,
    boxes_re=FARM_INFO_BOXES,
    fulls_re=r"TOTAL\s+BOXES\s+([\d.]+)",
)

ECOFLOR = LayoutSpec(
    name="ecoflor",
    detect=r"ECOFLOR\s+GROUPCHILE",
    grid_header=("box n", "box type", "variety", "qty", "total stems"),
    # "QB (105.0*27.0*16.0)": the dimensions are dropped from the box code.
    columns={"number": 0, "box": 1, "label": 2, "variety": 3, "length": 4, "bunches": 5,
             "stems_bunch": 6, "stems": 7, "rate": 8, "subtotal": 9},
    product_re="",
    row_model="boxes",
    header={"tx_company": const("ECOFLOR GROUPCHILE CIA. LTDA."), **FARM_INFO_HEADER},
    species="Roses",
    decimal=",",
    totals_re=FARM_INFO_TOTALS,
    fulls_re=r"TOTAL\s+BOXES\s+([\d.]+)",
)

CALINAMA = LayoutSpec(
    name="calinama",
    detect=r"CALINAMA\s+CAPITAL",
    grid_header=("box", "farm", "variety", "qty", "stems"),
    # A trader: every box names the farm it comes from, which each line keeps.
    columns={"number": 0, "location": 1, "box": 2, "variety": 3, "bunches": 4,
             "length": 5, "stems": 6, "rate": 7, "subtotal": 8, "label": 9},
    product_re="",
    row_model="boxes",
    header={"tx_company": const("CALINAMA CAPITAL OFFSHORE SAL"), **FARM_INFO_HEADER},
    species="Roses",
    decimal=",",
    totals_re=FARM_INFO_TOTALS,
    # Its box summary: "EXX QB7 18.00 34.00 92.00 3 28,14" — farm, box, size, count.
    boxes_re=r"^[A-Z]{2,4}\s+[A-Z]{2}\d*\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+(\d+)\s",
)

STAMPSYBOX = LayoutSpec(
    name="stampsybox",
    detect=r"STAMPSYBOX",
    grid_header=("box", "tb", "variety", "cantidad", "bunches"),
    # BOX numbers the boxes; a mix box is its number repeated on every row.
    columns={"number": 0, "box": 1, "variety": 3, "bunches": 4, "stems_bunch": 5,
             "length": 6, "stems": 7, "rate": 8, "subtotal": 9},
    product_re="",
    row_model="boxes",
    header={
        **FARM_INFO_HEADER,
        "tx_company": const("STAMPSYBOX CIA. LTDA."),
        "id_invoice": rx(r"INVOICE\s+(\d{5,})"),
        # "Date Delivered 09/19/2026 (mm/dd/yyyy)"
        "dt_invoice": rx(r"Date\s+Delivered\s+(\d{1,2}/\d{1,2}/\d{4})", date_us),
        "dt_fly": rx(r"Date\s+Delivered\s+(\d{1,2}/\d{1,2}/\d{4})", date_us),
    },
    box_map=LETTER_BOXES,
    species="Roses",
    decimal=",",
    totals_re=FARM_INFO_TOTALS,
    boxes_re=FARM_INFO_BOXES,
    fulls_re=r"^TOTAL\s+([\d.]+)\s+INVOICE",
)


# ---------------------------------------------------------------------------
# The "Invoice #:" program — La Rosaleda, Monterosas, Jet Fresh, Royalflowers
# ---------------------------------------------------------------------------
# ORDER | BOX CODE | BX | BOX TYPE | VARIETIES | CM | BUNCH STEMS | BUNCH BOX |
# STEMS BOX | UNIT PRICE | TOTAL PRICE. BX counts the row's boxes, and the
# bunch and stem columns are per box. A row with no ORDER is more of the box
# above ("POMAROSA [EXP] 70" under "5 - 5 … POMAROSA [EXP] 60").

INVOICE_COLON_HEADER = {
    "id_invoice": rx(r"Invoice\s*#\s*:\s*(\d+)"),
    "dt_invoice": rx(r"\bDate\s*:\s*(\d{4}-\d{2}-\d{2})", date_iso),
    "dt_fly": rx(r"Shippment\s+Date\s*:\s*(\d{4}-\d{2}-\d{2})", date_iso),
    "nm_ship": rx(r"^To\s*:\s*(.+?)\s+Due\s+Date", flags=re.IGNORECASE | re.MULTILINE),
    "nm_cargo": rx(r"Freigh\s+Forward\s*:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
    "tx_awb": rx(r"(?<!H)AWB\s*:\s*([\d][\d \-]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
    "tx_hawb": rx(r"HAWB\s*:\s*(\S+)"),
}


def _invoice_colon(name: str, detect: str, company: str) -> LayoutSpec:
    return LayoutSpec(
        name=name,
        detect=detect,
        grid_header=("order", "box code", "bx", "varieties"),
        columns={"number": 0, "label": 1, "count": 2, "box": 3, "variety": 4, "length": 5,
                 "stems_bunch": 6, "bunches_box": 7, "stems_box": 8, "rate": 9,
                 "subtotal": 10},
        # "POMAROSA [EXP]": the grade in brackets is not part of the variety.
        product_re=r"^(?P<variety>.+?)(?:\s*\[(?P<qual>[^\]]+)\])?$",
        row_model="boxes",
        header={"tx_company": const(company), **INVOICE_COLON_HEADER},
        species="Roses",
        totals_marker="TOTAL",
        # "TOTAL FCA 575 0.450 259.000": stems, average price, amount.
        totals_re=r"^TOTAL\s+F[OC][BA]\s+(?P<stems>[\d,]+)\s+[\d.]+\s+(?P<amount>[\d,.]+)\s*$",
        # The box summary: "QB ROSALEDA 1.00" per box type, then "TOTAL 0.25" in fulls.
        boxes_re=r"^[QHE]B\b[^\n]*?\s(\d+)\.\d+\s*$",
        fulls_re=r"^TOTAL\s+([\d.]+)\s*$",
    )


ROSALEDA = _invoice_colon("rosaleda", r"FLORICOLA\s+LA\s+ROSALEDA", "FLORICOLA LA ROSALEDA S.A.")
MONTEROSAS = _invoice_colon("monterosas", r"MONTEROSAS", "MONTEROSAS FARMS")
# The invoice is Jet Fresh Flower Growers of Ecuador; FreshPortal's supplier
# is Jet Fresh Flower Distributors. Its STEMS BOX column is the whole row's
# stems, BUNCH BOX each box's bunches: "2 - 3 2 QB PLAYA BLANCA [EXP] 50 25 5
# 250" is two boxes of 5 bunches, and 50406's rows add up to its 1500 stems
# only that way. No other farm on this program has printed a row of more than
# one box yet, so they keep reading the column per box.
JET_FRESH = dataclasses.replace(
    _invoice_colon("jet_fresh", r"JET\s+FRESH\s+FLOWER", "JET FRESH FLOWER DISTRIBUTORS"),
    columns={"number": 0, "label": 1, "count": 2, "box": 3, "variety": 4, "length": 5,
             "stems_bunch": 6, "bunches_box": 7, "stems": 8, "rate": 9, "subtotal": 10},
)
# Royalflowers prints from this program since it became ROYALFLOWERS S.A.S.
# (00000161964, 2026-09-25); its 2025 invoices are ROYALFLOWERS below, so this
# spec goes before that one. Its box summary adds a size digit to the box,
# "QB1 5.00", which the program's pattern does not take.
ROYALFLOWERS_SAS = dataclasses.replace(
    _invoice_colon("royalflowers_sas", r"ROYALFLOWERS\s+S\.A\.S", "ROYALFLOWERS S.A."),
    boxes_re=r"^[QHE]B\w*\s+(\d+)\.\d+\s*$",
)


# ---------------------------------------------------------------------------
# Royalflowers S.A. — its invoices up to 2025
# ---------------------------------------------------------------------------
# Qualisa's program in another version — it shares Qualisa's "Ship to
# (Destinatario)", which is why this spec must come before QUALISA. Order |
# Box Code | Box Type | Varieties | Cm | Bunch Stems | Package | Bunch Box |
# Unit Price | Total Stems | Boxes | Total Price.

ROYALFLOWERS = LayoutSpec(
    name="royalflowers",
    detect=r"ROYALFLOWERS",
    grid_header=("order", "box type", "varieties", "bunch box", "boxes"),
    columns={"number": 0, "label": 1, "box": 2, "variety": 3, "length": 4, "stems_bunch": 5,
             "bunches_box": 7, "rate": 8, "stems": 9, "count": 10, "subtotal": 11},
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("ROYALFLOWERS S.A."),
        "id_invoice": rx(r"Invoice\s*#\s*(\d+)"),
        "dt_invoice": rx(r"Invoice\s+Date\s+(\d{4}-\d{2}-\d{2})", date_iso),
        "dt_fly": rx(r"Delivery\s+Date\s+(\d{4}-\d{2}-\d{2})", date_iso),
        "nm_ship": rx(r"Ship\s+to\s*\(Destinatario\)[^\n]*\n([^\n]+)", last_word),
        "nm_cargo": rx(r"Method\s*\n([^\n]+)\n\s*Airline"),
        "tx_awb": rx(r"AWB\s*-\s*HAWB\s+(\d+)"),
        "tx_hawb": rx(r"AWB\s*-\s*HAWB\s+\d+\s*\n\s*([A-Z]{2}\d+)"),
    },
    species="Roses",
    totals_marker="TOTAL",
    totals_col=0,
    # "QB2 1 0.25" per box type, then "Total 1 0.25".
    fulls_re=r"^Total\s+\d+\s+([\d.]+)\s*$",
)


# ---------------------------------------------------------------------------
# Alissroses' program at other farms — Naranjo Roses, Lartisan, Hoja Verde
# ---------------------------------------------------------------------------
# The same CUSTOMER INVOICE with its ruled label/value box and a TOTALS row,
# but every farm writes its product cell differently, and Lartisan prints
# its dates day first.

ALIS_PROGRAM_HEADER = {
    "id_invoice": any_of(kv("invoice numbers"), rx(r"Invoice\s+Numbers?\s+(\d+)")),
    "nm_ship": rx(r"SHIP\s+CUSTOMER\s*\n\s*([^\n]+)", last_word),
    "nm_cargo": rx(r"Cargo\s+Agency\s+([A-Za-z0-9 .\-/]+?)(?:\s*Truck|\n|$)"),
    "tx_awb": rx(r"\bMAWB\b\s+([A-Z0-9][A-Z0-9\- ]{6,}?)(?:\s+HAWB|\n|$)"),
    "tx_hawb": rx(r"\bHAWB\b\s+(\S+)"),
}

NARANJO_ROSES = LayoutSpec(
    name="naranjo_roses",
    detect=r"NARANJO\s+ROSES",
    grid_header=("box", "product", "species", "qty", "sub-total"),
    columns={"count": 0, "box": 1, "product": 2, "species": 3, "bunches": 4,
             "rate_bunch": 5, "stems": 6, "rate": 7, "subtotal": 8, "label": 9},
    # Preserved roses: "ASSEMBLED CLASSY BLUE CBL03-ST 1ST 50CM PT PRAS" — the
    # variety, its code, one stem a bunch, the length.
    product_re=(r"^(?:ASSEMBLED\s+)?(?P<variety>.+?)\s+[A-Z]{2,3}\d{2}-ST\s+"
                r"(?P<stems_bunch>\d+)\s*ST\s+(?P<length>\d+)\s*CM\b"),
    row_model="boxes",
    header={
        **ALIS_PROGRAM_HEADER,
        "tx_company": const("NARANJO ROSES"),
        "id_purchaseorder": kv("internal po id"),
        "dt_invoice": kv("invoice date", date_us),
        "dt_fly": kv("fly date", date_us),
    },
    # "FBG" boxes of preserved roses go as QBE, HBE to choose (user,
    # 2026-09-29). For the fulls check each is a full box: 500 are 500 fulls.
    box_fulls={"FBG": 1.0},
    totals_marker="TOTALS",
    fulls_re=r"Number\s+in\s+(?:Fulls\s+)?([\d.]+)",
)

LARTISAN = LayoutSpec(
    name="lartisan",
    detect=r"LARTISAN",
    grid_header=("box", "product", "species", "qty", "sub-total"),
    # The box's dimensions are printed on a row of their own under it.
    columns={"count": 0, "box": 1, "product": 3, "species": 4, "bunches": 5,
             "rate_bunch": 6, "stems": 7, "rate": 8, "subtotal": 9, "label": 10},
    # "ATOMIC 25st 50cm SÓL Emp.": bunch size, then length, then the packing.
    product_re=r"^(?P<variety>.+?)\s+(?P<stems_bunch>\d+)\s*st\s+(?P<length>\d+)\s*cm\b",
    row_model="boxes",
    header={
        **ALIS_PROGRAM_HEADER,
        "tx_company": const("LARTISAN-ROSES S.A.S"),
        # Day first here: "Invoice Date 16/09/2026".
        "dt_invoice": kv("invoice date", date_dmy),
        "dt_fly": kv("fly date", date_dmy),
    },
    # "32 TOTALS 131 3275 $1407.50" — the word sits in the BOX column.
    totals_marker="TOTALS",
    totals_col=1,
    fulls_re=r"Number\s+in\s+(?:Fulls\s+)?([\d.]+)",
)

HOJA_VERDE = LayoutSpec(
    name="hoja_verde",
    detect=r"HOJA\s+VERDE",
    grid_header=("box", "product", "species", "qty", "sub-total"),
    columns={"count": 0, "box": 1, "product": 2, "species": 3, "bunches": 4,
             "rate_bunch": 5, "stems": 6, "rate": 7, "subtotal": 8, "label": 9},
    # "TWILIGHT 40CM N 25ST CRA": a grade letter between length and bunch size.
    product_re=(r"^(?P<variety>.+?)\s+(?P<length>\d+)\s*CM\s+(?:(?P<qual>[A-Z])\s+)?"
                r"(?P<stems_bunch>\d+)\s*ST\b"),
    row_model="boxes",
    # "HB 30 (104*30*30)" is an HB.
    box_re=r"^([A-Za-z]+)",
    header={
        **ALIS_PROGRAM_HEADER,
        "tx_company": const("HOJA VERDE"),
        "id_purchaseorder": kv("internal po id"),
        "dt_invoice": kv("invoice date", date_us),
        "dt_fly": kv("fly date", date_us),
    },
    totals_marker="TOTALS",
    fulls_re=r"Number\s+in\s+(?:Fulls\s+)?([\d.]+)",
)

# Albra Roses (5080448, 2026-09-30) writes its product cell as Hoja Verde
# does: "MONDIAL 60CM N 25ST FRB". The Alissroses spec found it by the
# program's wording and read none of its rows.
ALBRA_ROSES = dataclasses.replace(
    HOJA_VERDE,
    name="albra_roses",
    detect=r"ALBRA\s+ROSES",
    header={**HOJA_VERDE.header, "tx_company": const("ALBRA ROSES")},
)

# Pomarosa (5061969, 2026-10-01), invoiced from its farm Inversiones Ponte
# Tresa. Its grid names the farm of every row in Loc. ("TESSA-R2", wrapped
# after the hyphen), which is the nm_location its JSON carries and what
# resolves its grower: TESSA-R2 is Inversiones Pontetresa, as the header
# says, though the farm summary under the grid prints TESSA-P (user,
# 2026-10-03). No species is printed: it grows roses.
POMAROSA = LayoutSpec(
    name="pomarosa",
    detect=r"POMAROSA\s+LIMITED\s+PARTNERSHIP",
    grid_header=("boxes", "boxt", "loc", "description", "bun/box"),
    # Order is the order number, not a box number. Bun/Box is per box and
    # Stems the row's: Price times Stems is its Total.
    columns={"count": 0, "box": 2, "location": 3, "variety": 4, "length": 5,
             "bunches_box": 6, "stems": 7, "rate": 8, "subtotal": 9, "label": 10},
    product_re="",
    row_model="boxes",
    header={
        **ALIS_PROGRAM_HEADER,
        "tx_company": const("POMAROSA LIMITED PARTNERSHIP"),
        "id_invoice": any_of(kv("invoice number"), rx(r"Invoice\s+Number\s+(\d+)")),
        "dt_invoice": kv("invoice date", date_us),
        "dt_fly": kv("fly date", date_us),
        "tx_awb": rx(r"^AWB\s+([\d\- ]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
    },
    species="Roses",
    # "1 TOTALS 5 125 $62.50": boxes, stems and amount are checked. Its
    # bunches are not: with one box a row, it does not show whether they sum
    # Bun/Box or the bunches of every box.
    totals_marker="TOTALS",
    fulls_re=r"Number\s+in\s+(?:Fulls\s+)?([\d.]+)",
)


# ---------------------------------------------------------------------------
# Farms with a template of their own, read from a ruled grid
# ---------------------------------------------------------------------------

BOSQUEFLOWERS = LayoutSpec(
    name="bosqueflowers",
    detect=r"BOSQUEFLOWERS",
    grid_header=("box #", "boxes", "variety", "bunchs", "stems"),
    # "1-4" in Box # and "4.00" in Boxes: four boxes. "ROSAS FREEDOM".
    columns={"number": 0, "count": 1, "box": 2, "product": 3, "bunches": 6, "length": 7,
             "stems_bunch": 8, "stems": 9, "rate": 10, "subtotal": 11},
    product_re=r"^(?:(?P<species>ROSAS?)\s+)?(?P<variety>.+)$",
    row_model="boxes",
    header={
        "tx_company": const("BOSQUE FLOWERS S.A"),
        "id_invoice": rx(r"^\s*(\d{9})\s*$", flags=re.MULTILINE),
        "dt_invoice": rx(r"DATE:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "dt_fly": rx(r"F\.\s*Vuelo:\s*(\d{1,2}-\d{1,2}-\d{4})", date_dmy),
        "nm_ship": rx(r"Mark:\s*(\S+)"),
        "tx_awb": rx(r"^\s*(\d{11})\s+[A-Z]{2}\d+\s*$", flags=re.MULTILINE),
        "tx_hawb": rx(r"^\s*\d{11}\s+([A-Z]{2}\d+)\s*$", flags=re.MULTILINE),
    },
    species_map={"ROSAS": "Roses", "ROSA": "Roses"},
    species="Roses",
    decimal=",",
    totals_marker="TOTALS",
    totals_col=0,
    # "PIECES: 19,00 | HB : 5,00 | QB : 14,00 | TOTAL FULL BOXES: 6,00"
    boxes_re=r"PIECES:\s*([\d.,]+)",
    fulls_re=r"TOTAL\s+FULL\s+BOXES:\s*([\d.,]+)",
)

PROTEAS_SOLANDINO = LayoutSpec(
    name="proteas_solandino",
    detect=r"PROTEAS\s*SOLANDINO",
    grid_header=("pieces type", "total pieces", "product description", "bu per box"),
    # Bunches per box, not per row: 8 HB of 25 bunches of 10 stems is 2,000.
    columns={"box": 0, "count": 1, "stems": 3, "species": 4, "product": 5,
             "bunches_box": 10, "stems_bunch": 11, "rate": 12, "subtotal": 13},
    # "Protea.Leuca Safari Sunset 80cm": Leucadendron Safari Sunset.
    product_re=(r"^(?:Protea\.(?P<species>[A-Za-z]+)\s+)?(?P<variety>.+?)\s+"
                r"(?P<length>\d+)\s*cm\b"),
    row_model="boxes",
    header={
        "tx_company": const("PROTEASSOLANDINO S.A"),
        "id_invoice": rx(r"PROTEASSOLANDINO\s+S\.?A\.?\s+(\d+)\s"),
        "dt_invoice": rx(r"PROTEASSOLANDINO[^\n]*?\s(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "dt_fly": rx(r"PROTEASSOLANDINO[^\n]*?\s(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "nm_ship": rx(r"SHIP\s+TO:\s*\n\s*(\S+)"),
        "tx_awb": rx(r"(\d{3}-\d{4}-\d{4})"),
        "tx_hawb": rx(r"HAWB\s+No\.\s*\n\s*([A-Z]{2}\s?\d+)", nospace),
    },
    species_map={"LEUCA": "Leucadendron", "PROTEA SP.": "Protea"},
    decimal=",",
    totals_marker="TOTAL",
    totals_col=0,
    fulls_re=r"^TOTAL\s+\d+\s+([\d.,]+)\s+\d+",
)

NIKITA = LayoutSpec(
    name="nikita",
    detect=r"NIKITA\s+FLOWERS",
    grid_header=("num pieces", "piece type", "variety", "bonches"),
    # NUM PIECES numbers the boxes. The second page's table has no header.
    columns={"number": 0, "box": 1, "variety": 2, "length": 3, "bunches": 4,
             "stems_bunch": 5, "stems": 6, "rate": 7, "subtotal": 8},
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("SOCIEDAD CIVIL Y COMERCIAL NIKITA FLOWERS"),
        "id_invoice": rx(r"INVOICE\s*#\s*(\d+)"),
        # The Date cell wraps ("2026-09-" / "16"); the packing date is the same day.
        "dt_invoice": rx(r"Packing\s+Date\s+(\d{4}-\d{2}-\d{2})", date_iso),
        "dt_fly": rx(r"Packing\s+Date\s+(\d{4}-\d{2}-\d{2})", date_iso),
        "nm_ship": rx(r"^\s*(\w*OZH\w*)\s*$", flags=re.MULTILINE),
        "tx_awb": rx(r"\bAWB\s+([\d\- ]+?)\s+HAWB"),
        "tx_hawb": rx(r"HAWB\s+(\S+)"),
    },
    species="Roses",
    totals_re=(r"Total\s+Bonches\s+(?P<bunches>\d+)\s+(?P<stems>[\d,]+)\s+Total\s+"
               r"(?P<amount>[\d,.]+)"),
    fulls_re=r"Total\s+FB\s+([\d.]+)",
)

# The invoice is Palitaflor S.A.S., which sells as Ever Green Rose Farm
# (sales@evergreenrosefarm.com) — FreshPortal's supplier.
PALITAFLOR = LayoutSpec(
    name="palitaflor",
    detect=r"PALITAFLOR",
    grid_header=("box qty", "variety", "bunches", "stems"),
    # "2Q 2Q - 3Q": two quarter boxes, numbers 2 to 3, in one cell.
    columns={"count": 0, "box": 0, "variety": 1, "bunches": 2, "stems": 3, "length": 4,
             "rate": 5, "subtotal": 6},
    cell_re={"count": r"^(\d+)\s*[A-Z]", "box": r"^\d+\s*([A-Z]+)"},
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("EVER GREEN ROSE FARM"),
        "id_invoice": rx(r"INVOICE\s+(\d+)"),
        "dt_invoice": rx(r"^DATE\s+(\d{1,2}/\d{1,2}/\d{4})", date_dmy,
                         flags=re.IGNORECASE | re.MULTILINE),
        "dt_fly": rx(r"^DATE\s+(\d{1,2}/\d{1,2}/\d{4})", date_dmy,
                     flags=re.IGNORECASE | re.MULTILINE),
        "nm_cargo": rx(r"CARGO\s+AGENCY\s+([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"AIRWAY\s*-\s*BILL\s+([\d\- ]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_hawb": rx(r"HAWB\s+([A-Z ]+\d+)", nospace),
    },
    box_map=LETTER_BOXES,
    species="Roses",
    totals_re=(r"Full\s+Box\s+(?P<fulls>[\d.]+)\s+(?P<bunches>\d+)\s+(?P<stems>\d+)\s+"
               r"Subtotal\s+(?P<amount>[\d,.]+)"),
    boxes_re=r"Pieces:\s*(\d+)",
)

COLIBRI = LayoutSpec(
    name="colibri",
    detect=r"COLIBRI\s+FLOWERS",
    grid_header=("boxes", "description", "box #", "unxbox"),
    columns={"count": 0, "box": 1, "product": 2, "stems_box": 7, "stems": 8, "rate": 10,
             "subtotal": 11},
    # "Carnation Don Pedro X 20 - SEL": species, variety, bunch size, grade.
    # "Carnation mix" prints no bunch size; see stems_bunch.
    product_re=(r"^(?P<species>Minicarnation|Carnation)\s+(?P<variety>.+?)"
                r"(?:\s+X\s+(?P<stems_bunch>\d+))?(?:\s*-\s*(?P<qual>[A-Z]+))?$"),
    row_model="boxes",
    header={
        "tx_company": const("COLIBRI FLOWERS S.A."),
        "id_invoice": rx(r"INVOICE\s+No\.\s*([A-Z]*-?\d+)"),
        "dt_invoice": rx(r"Date\s+Invoice:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "dt_fly": rx(r"Date\s+Invoice:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "nm_cargo": rx(r"Freight\s+Forwarder:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"\bAWB:\s*([\d\-]+)"),
        "tx_hawb": rx(r"HAWB:\s*([A-Z]{2}\d+)"),
    },
    box_map=LETTER_BOXES,
    species_map={"CARNATION": "Carnation", "MINICARNATION": "Mini Carnation"},
    # Its mixes are the standard and the spray carnation mix (user,
    # 2026-09-29, FA-123892: 4x240 and 3x240).
    variety_rules=(("product", r"^Minicarnation\s+mix\b", "Dianthus Sp Mix"),
                   ("product", r"^Carnation\s+mix\b", "Dianthus St Mix")),
    # Every row that states its bunch size says 20; minicarnations too
    # (user, 2026-09-29).
    stems_bunch=20,
    totals_re=r"Tt\.\s*Stems:\s*(?P<stems>[\d,]+)\s+Subtotal:\s*(?P<amount>[\d,.]+)",
    boxes_re=r"^(\d+)\s+TOTAL\s+PIECES",
    fulls_re=r"([\d.]+)\s+TOTAL\s+FULL\s+BOXES",
)


# The "silverbook" program: Tierra Verde, Montebello and Laila Flowers. The
# bunches stand under a column per length; the column says the length.
SILVERBOOK_HEADER = {
    # Montebello prints its series first, "001001 00024404"; the number is
    # the last part (user, 2026-09-29). Tierra Verde prints only "00045564".
    "id_invoice": rx(r"INVOICE:\s*(?:\d+ )?(\d+)"),
    # Laila's text runs the label into the date: "DATE25/09/2026".
    "dt_invoice": rx(r"\bDATE\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
    "dt_fly": rx(r"\bDATE\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
    "nm_ship": rx(r"CONSIGNEE\s+(\S+)"),
    "nm_cargo": rx(r"CARRIER\s+([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
    "tx_awb": rx(r"M\.A\.W\.B\s+([\d\- ]+?)\s+(?:DUE|$)", flags=re.IGNORECASE | re.MULTILINE),
    "tx_hawb": rx(r"H\.A\.W\.B\s+(\S+)"),
}
# From a thousand up the counts carry a comma: "TOT. STEMS 4,650".
SILVERBOOK_TOTALS = (r"TOT\.BOX\s+(?P<fulls>[\d.]+)\s+SUB\s+TOTAL\s+(?P<amount>[\d,.]+)\s*\n"
                     r"TOT\.BOUNCH\.\s+(?P<bunches>[\d,]+)[^\n]*\nTOT\.\s*STEMS\s+(?P<stems>[\d,]+)")

TIERRA_VERDE = LayoutSpec(
    name="tierra_verde",
    detect=r"TIERRA\s+VERDE\s+CIA",
    grid_header=("# box", "box t", "variedad", "stxb"),
    # "# BOX" numbers the boxes; box 2 is printed on two rows.
    columns={"number": 0, "box": 1, "variety": 2, "stems_bunch": 3, "stems": 16, "rate": 17,
             "subtotal": 18},
    length_cols={6: 30, 7: 40, 8: 50, 9: 60, 10: 70, 11: 80, 12: 90, 13: 100, 14: 110,
                 15: 120},
    product_re="",
    row_model="boxes",
    header={"tx_company": const("FLORICOLA TIERRA VERDE CIA LTDA"), **SILVERBOOK_HEADER},
    species="Roses",
    totals_re=SILVERBOOK_TOTALS,
)

MONTEBELLO = LayoutSpec(
    name="montebello",
    detect=r"MONTEBELLO\s*FARMS",
    grid_header=("# box", "box t", "variedad", "stxb"),
    columns={"number": 0, "box": 1, "variety": 2, "stems_bunch": 3, "stems": 20, "rate": 21,
             "subtotal": 22},
    length_cols={6: 30, 7: 40, 8: 50, 9: 60, 10: 70, 11: 80, 12: 90, 13: 100, 14: 110,
                 15: 120, 16: 130, 17: 140, 18: 150, 19: 160},
    product_re="",
    row_model="boxes",
    header={"tx_company": const("MONTEBELLOFARMS CIA LTDA"), **SILVERBOOK_HEADER},
    species="Roses",
    totals_re=SILVERBOOK_TOTALS,
)

# Laila Flowers, invoiced by LOMCEM S.C, the name FreshPortal knows it by.
LAILA_FLOWERS = LayoutSpec(
    name="laila_flowers",
    detect=r"LAILA\s+FLOWERS|LOMCEM",
    grid_header=("#", "variedad", "un", "und", "pack"),
    # "#" numbers the boxes. UN and UND both print 25 on every row of
    # 00020326, and 25 times the bunches is the row's stems; UN is taken as
    # the bunch size.
    columns={"number": 0, "box": 1, "variety": 2, "stems_bunch": 3, "stems": 15, "rate": 16,
             "subtotal": 17},
    length_cols={5: 30, 6: 40, 7: 50, 8: 60, 9: 70, 10: 80, 11: 90, 12: 100, 13: 110,
                 14: 120},
    product_re="",
    row_model="boxes",
    header={
        **SILVERBOOK_HEADER,
        "tx_company": const("LOMCEM S.C"),
        "nm_ship": rx(r"CONSIGNEE\s+(.+?)\s+M\.A\.W\.B", nospace),
    },
    species="Roses",
    # Its "Mixtas" boxes are the mixed box product (user, 2026-09-30).
    variety_rules=(("variety", r"^Mixtas$", "Rosa Ec Mix in Box"),),
    totals_re=SILVERBOOK_TOTALS,
)
# Laila's other printout (00020505, 2026-09-30): "# BOX | BOX T | VARIEDAD |
# UNxB | X | UND", a column more before the lengths, and UND printed 0. Its
# other invoices of that day are the printout above, so this one goes first
# and is told apart by its UNxB.
LAILA_FLOWERS_UNXB = dataclasses.replace(
    LAILA_FLOWERS,
    name="laila_flowers_unxb",
    detect=r"(?:LAILA\s+FLOWERS|LOMCEM)(?s:.*)\bUNxB\b",
    grid_header=("#", "variedad", "unxb", "und", "pack"),
    columns={"number": 0, "box": 1, "variety": 2, "stems_bunch": 3, "stems": 16, "rate": 17,
             "subtotal": 18},
    length_cols={6: 30, 7: 40, 8: 50, 9: 60, 10: 70, 11: 80, 12: 90, 13: 100, 14: 110,
                 15: 120},
)

GREENEX = LayoutSpec(
    name="greenex",
    detect=r"GREENEX\s+S\.A\.S",
    grid_header=("pieces", "box size", "product description", "stems", "bunches"),
    columns={"count": 0, "box": 1, "product": 2, "stems": 5, "rate": 6, "bunches": 7,
             "rate_bunch": 8, "subtotal": 9},
    product_re=r"^(?P<variety>.+?)\s+(?P<length>\d+)\s*CM\b",
    row_model="boxes",
    header={
        "tx_company": const("GREENEX S.A.S."),
        "id_invoice": rx(r"^\s*(\d{6})\s*$", flags=re.MULTILINE),
        "dt_invoice": rx(r"(\d{4}-\d{2}-\d{2})", date_iso),
        "dt_fly": rx(r"(\d{4}-\d{2}-\d{2})", date_iso),
        "nm_ship": rx(r"SHIPT\s+TO:[^\n]*-\s*(\S+)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"(\d{3}-\d{4}\s\d{4})\s+[A-Z]{2}\d+"),
        "tx_hawb": rx(r"\d{3}-\d{4}\s\d{4}\s+([A-Z]{2}\d+)"),
    },
    # An "OCT" box is an eighth.
    box_map={"OCT": "1/8"},
    # No species is printed; the farm sends only these four (user, 2026-09-29).
    species_rules=((r"LIL+Y\s*GRASS", "Lily Grass"), (r"RUSCUS", "Ruscus"),
                   (r"PITTOSPORUM", "Pittosporum"), (r"ARALIA", "Aralia")),
    totals_re=(r"^(?P<boxes>\d+)\s+Full\s+Equivalent:\s*(?P<fulls>[\d.]+)\s+Weight:\s*[\d.]+\s+"
               r"(?P<stems>[\d,]+)\s+(?P<bunches>[\d,]+)\s+(?P<amount>[\d,.]+)"),
)

# The invoice does not print the company's name, only platonoffroses.com.
PLATONOFF = LayoutSpec(
    name="platonoff",
    detect=r"platonoffroses|0591764239001",
    grid_header=("# boxes", "box type", "variety", "tot bunches"),
    columns={"count": 0, "box": 1, "variety": 2, "length": 4, "bunches_box": 5, "bunches": 6,
             "stems_bunch": 7, "stems": 8, "rate": 9, "subtotal": 10},
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("PLATONOFF ROSES"),
        "id_invoice": rx(r"INVOICE\s*#\s*(\d+)"),
        "dt_invoice": rx(r"Invoice\s+Date:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "dt_fly": rx(r"Invoice\s+Date:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "nm_ship": rx(r"^To:\s*(.+?)\s+AWB:", flags=re.IGNORECASE | re.MULTILINE),
        "nm_cargo": rx(r"Freigh\s+Forward:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"(?<!H)AWB:\s*([\d\- ]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_hawb": rx(r"HAWB:\s*(\S+)"),
    },
    species="Roses",
    totals_re=r"^TOTALS\s+(?P<bunches>\d+)\s+(?P<stems>[\d,]+)\s+(?P<amount>[\d,.]+)",
    boxes_re=r"TOTAL\s+BOXES\s+(\d+)",
    fulls_re=r"TOTAL\s+FULLS\s+([\d.]+)",
)

FLORAROMA = LayoutSpec(
    name="floraroma",
    detect=r"FLORAROMA",
    grid_header=("boxes", "order", "box type", "description", "s/b"),
    columns={"count": 0, "number": 1, "box": 2, "label": 3, "qual": 4, "bunches": 5,
             "variety": 6, "length": 7, "stems_bunch": 8, "stems": 9, "rate": 10,
             "subtotal": 11},
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("FLORAROMA S.A"),
        "id_invoice": rx(r"I\s*N\s*V\s*O\s*I\s*C\s*E\s+(\d+)"),
        "dt_invoice": rx(r"Date:\s*(\d{4}-\d{2}-\d{2})", date_iso),
        "dt_fly": rx(r"Date:\s*(\d{4}-\d{2}-\d{2})", date_iso),
        "nm_ship": rx(r"CONSIGNEE:\s*(\S+)"),
        "nm_cargo": rx(r"CARGO\s+A\.:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"M\.A\.W\.B\.:\s*(\S+)"),
        "tx_hawb": rx(r"H\.A\.W\.B\.:\s*(\S+)"),
    },
    species="Roses",
    totals_marker="TOTALS",
    totals_col=3,
    boxes_re=r"^[QHE]B\s+([\d.]+)\s",
    fulls_re=r"FULL\s+TOTAL:\s*([\d.]+)",
)

# "By Breeza SA", mails from anniroses.com.ec.
BREZZA = LayoutSpec(
    name="brezza",
    detect=r"By\s+Breeza|brezza\.com",
    grid_header=("boxes", "box type", "order", "description", "grade"),
    columns={"count": 0, "box": 1, "number": 2, "product": 6, "length": 7, "stems_bunch": 8,
             "bunches": 9, "stems": 10, "rate": 11, "subtotal": 12},
    product_re=r"^(?:(?P<species>Roses?)\s+)?(?P<variety>.+)$",
    row_model="boxes",
    header={
        "tx_company": const("BREEZA SA"),
        "id_invoice": rx(r"INVOICE\s*#\s*(\d+)"),
        "dt_invoice": rx(r"Date:\s*(\d{4}/\d{2}/\d{2})", date_ymd),
        "dt_fly": rx(r"Date:\s*(\d{4}/\d{2}/\d{2})", date_ymd),
        "nm_ship": rx(r"Consignee:\s*(\S+)"),
        "nm_cargo": rx(r"Agency:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"M\.A\.W\.B\.:\s*([\d\- ]+?)\s+H\.A\.W"),
        "tx_hawb": rx(r"H\.A\.W\.\s*(\S+)"),
    },
    species_map={"ROSES": "Roses", "ROSE": "Roses"},
    species="Roses",
    # The only total it prints is the amount in its header.
    totals_re=r"Total\s+Invoice\s+USD\s+\$\s*(?P<amount>[\d,.]+)",
)


# One program at Sol Pacific and Valle Verde; the farm's name is at the foot.
TWO_FARMS_HEADER = {
    "id_invoice": rx(r"^INVOICE\s+(\d+)", flags=re.IGNORECASE | re.MULTILINE),
    "dt_invoice": rx(r"^DATE:\s*(\d{4}/\d{2}/\d{2})", date_ymd, flags=re.IGNORECASE | re.MULTILINE),
    "dt_fly": rx(r"^DATE:\s*(\d{4}/\d{2}/\d{2})", date_ymd, flags=re.IGNORECASE | re.MULTILINE),
    "nm_ship": rx(r"CONSIGNE\s+(\S+)"),
    "nm_cargo": rx(r"CARGO\s+AGENCY:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
    "tx_awb": rx(r"M\.\s*A\.W\.B\.:\s*([\d\- ]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
    "tx_hawb": rx(r"H\.\s*A\.W\.B\.:\s*(\S+)"),
}


def _two_farms(name: str, detect: str, company: str) -> LayoutSpec:
    return LayoutSpec(
        name=name,
        detect=detect,
        grid_header=("boxs", "order", "box.t", "description", "bun/box"),
        columns={"count": 0, "number": 1, "box": 2, "label": 3, "variety": 4, "length": 5,
                 "bunches_box": 6, "bunches": 7, "stems": 8, "rate": 9, "subtotal": 10},
        product_re="",
        row_model="boxes",
        header={"tx_company": const(company), **TWO_FARMS_HEADER},
        species="Roses",
        totals_re=(r"Totals:\s*(?P<bunches>[\d.]+)\s+(?P<stems>[\d.,]+)\s+"
                   r"(?P<amount>[\d.,]+)"),
        boxes_re=r"^[QHE]B\s+(\d+)\s+[\d.]+\s+[\d.]+\s*$",
        fulls_re=r"TOTAL\s+IN\s+BOXES\s+FULL\s+([\d.]+)",
    )


SOL_PACIFIC = _two_farms("sol_pacific", r"SOLPACIFIC|1391725280001", "SOL PACIFIC")
VALLE_VERDE = _two_farms("valle_verde", r"VALLEVERDE|1792027691001", "VALLE VERDE")

# Floricola San Isidro Labrador Florsani: the invoice prints no name, only
# its tax number and the Malchingui address.
FLORSANI = LayoutSpec(
    name="florsani",
    detect=r"1792059232001",
    grid_header=("pcs", "box type", "description", "bunch box", "stems bunch"),
    columns={"count": 0, "box": 1, "label": 2, "product": 3, "color": 4, "bunch_grams": 5,
             "length": 6, "bunches_box": 7, "stems_bunch": 8, "rate": 9, "stems": 10,
             "subtotal": 11},
    # "Ornithogalum White Star": the genus, then the variety.
    product_re=r"^(?P<species>\S+)\s+(?P<variety>.+)$",
    # Weigth is a bunch's grams. FreshPortal names gypsophila by it ("Gypso
    # Xlence 1000 gr.", 40 g a stem), not Lepidium's 750 (user, 2026-10-06,
    # 002001000634396).
    bunch_grams_species=r"^Gypsophila$",
    row_model="boxes",
    header={
        "tx_company": const("FLORSANI"),
        "id_invoice": rx(r"INVOICE\s+N\S*\s*(\d+)"),
        "dt_invoice": rx(r"DATE:\s*(\d{4}-\d{2}-\d{2})", date_iso),
        "dt_fly": rx(r"DATE:\s*(\d{4}-\d{2}-\d{2})", date_iso),
        "nm_ship": rx(r"CONSIGNEE\s*:\s*(\S+)"),
        "nm_cargo": rx(r"FORWARDER:\s*(.+?)\s+PO:"),
        "tx_awb": rx(r"AWB#:\s*(\d+)"),
        "tx_hawb": rx(r"HAWB:\s*(\S+)"),
    },
    # 17 "HE" and 5 "EB" make 9.125 full boxes: HE is a half, EB an eighth.
    box_map={"HE": "HBE", "EB": "1/8"},
    # Its totals row has no label: "750 288 35 6,450 1,662.50", and from
    # 2,500 g on its weights group thousands (002001000634396).
    totals_re=(r"^[\d,]+\s+(?P<bunches>[\d,]+)\s+[\d,]+\s+(?P<stems>[\d,]+)\s+"
               r"(?P<amount>[\d,]+\.\d{2})\s*$"),
    boxes_re=r"TOTAL\s+PIECES:\s*(\d+)",
    fulls_re=r"TOTAL\s+FULL\s+BOXES:\s*([\d.]+)",
)

FLORISOL = LayoutSpec(
    name="florisol",
    detect=r"FLORISOL",
    grid_header=("tp", "b i", "b f", "variety", "s/b"),
    # Box numbers from B I to B F. Bn/Bx is per box, but Stem/Bx holds the
    # row's stems ("2 3 … 10 500": two boxes of 250), as does Total.
    columns={"box": 0, "number": 1, "number_last": 2, "product": 3, "stems_bunch": 5,
             "length": 6, "bunches_box": 7, "stems": 10, "rate": 11, "subtotal": 12},
    product_re=(r"^(?:(?P<species>ROSE)\s+)?(?:(?P<qual>SPECIAL|SELECT|PREMIUM|STANDARD)\s+)?"
                r"(?P<variety>.+)$"),
    row_model="boxes",
    header={
        "tx_company": const("FLORISOL CIA LTDA"),
        # As printed, with its space: "PI 246035" (user, 2026-09-29).
        "id_invoice": rx(r"Invoice\s+Number\s*:\s*(PI\s?\d+)"),
        "dt_invoice": rx(r"Date\s*:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "dt_fly": rx(r"Date\s*:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "nm_ship": rx(r"Consignee\s*:\s*(\S+)"),
        "nm_cargo": rx(r"Cargo\s+Ag\s*:\s*(.+?)\s+Remark"),
        "tx_awb": rx(r"A\.\s*W\.\s*B\.\s*:\s*([\d\- ]+?)\s+HAWB"),
        "tx_hawb": rx(r"HAWB\s*:\s*(\S+)"),
    },
    box_map=LETTER_BOXES,
    species_map={"ROSE": "Roses"},
    species="Roses",
    totals_re=(r"Total\s+Price\s+of\s+Flower\s*:\s*(?P<amount>[\d,.]+)(?s:.*?)"
               r"Total\s+Bunches\s+Total\s+Stems\s*\n\s*\d+\s+(?P<stems>[\d,]+)"),
    boxes_re=r"^(\d+)=\s*\d+\+",
    fulls_re=r"=\s*([\d.]+)\s*$",
)


# Terra Pacific and Agroterranorte: one program, the same address. The grid
# hides a line of white figures in every row, and prints a column only for
# the lengths the shipment has.
TERRA_HEADER = {
    "id_invoice": rx(r"Invoice\s+No:\s*(\d+)"),
    "dt_invoice": rx(r"DATE:\s*(\d{4}-\d{2}-\d{2})", date_iso),
    "dt_fly": rx(r"DATE:\s*(\d{4}-\d{2}-\d{2})", date_iso),
    "nm_ship": rx(r"CONSIGNEE:[^\n]*/\s*(\S+)"),
    "tx_awb": rx(r"M\.\s*A\.W\.B\.:\s*(\S+)"),
    "tx_hawb": rx(r"H\.\s*A\.W\.B\.:\s*(\S+)"),
}


def _terra(name: str, detect: str, company: str) -> LayoutSpec:
    return LayoutSpec(
        name=name,
        detect=detect,
        grid_header=("box type", "pieces", "order", "product", "ste"),
        columns={},
        header_columns={"box": r"^Box\s+Type$", "count": r"^Pieces$", "number": r"^Order$",
                        "label": r"^Mark$", "variety": r"^Product", "stems_bunch": r"^Ste$",
                        "bunches": r"^Total\s+Bunch", "stems": r"^Total\s+Stems",
                        "rate": r"^Unit\s+Price", "subtotal": r"^Total\s+USD"},
        lengths_from_header=True,
        product_re="",
        row_model="boxes",
        header={"tx_company": const(company), **TERRA_HEADER},
        species="Roses",
        extract={"drop_white": True},
        totals_marker="TOTAL",
        boxes_re=r"PIECES\s+TOTAL:\s*([\d.]+)",
        fulls_re=r"FULL\s+TOTAL:\s*([\d.]+)",
    )


TERRA_PACIFIC = _terra("terra_pacific", r"TERRA\s+PACIFIC",
                       "PABLO RENAN FLORES HERRERA - TERRAPACIFIC")
AGROTERRANORTE = _terra("agroterranorte", r"AGROTERRANORTE", "AGROTERRANORTE S.A.")


# ---------------------------------------------------------------------------
# Grids that are not ruled tables — read from the page text, a line a row
# ---------------------------------------------------------------------------

# The invoice never prints the company's name, only attarroses.com.
ATTAR_ROSES = LayoutSpec(
    name="attar_roses",
    detect=r"attar-?roses",
    grid_header=(),
    columns={},
    # "4 QB GR CANDLELIGHT 60 25 20 0.40 500 200.00": boxes, box, garden rose
    # mark, variety, length, stems a bunch, bunches, price, stems, amount.
    lines=(r"^(?P<count>\d+)\s+(?P<box>[A-Z]{2})\s+(?:(?P<species>GR)\s+)?(?P<variety>.+?)\s+"
           r"(?P<length>\d{2,3})\s+(?P<stems_bunch>\d+)\s+(?P<bunches>\d+)\s+"
           r"(?P<rate>\d+\.\d+)\s+(?P<stems>\d+)\s+(?P<subtotal>[\d,]+\.\d{2})\s*$",),
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("ATTAR ROSES"),
        "id_invoice": rx(r"INVOICE\s*#\s*(\d+)"),
        "dt_invoice": rx(r"SHIPPING\s+DATE:\s*([A-Z]+\s+\d{1,2},\s*\d{4})", date_text),
        "dt_fly": rx(r"SHIPPING\s+DATE:\s*([A-Z]+\s+\d{1,2},\s*\d{4})", date_text),
        "nm_ship": rx(r"LABEL:\s*(\S+)"),
        "nm_cargo": rx(r"CARGO\s+AGENCY:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"(?<!H)AWB:\s*([\d\- ]+?)\s+HAWB"),
        "tx_hawb": rx(r"HAWB:\s*(\S+)"),
    },
    species_map={"GR": "Garden Roses"},
    species="Roses",
    # "39 171 4275 1581.25": boxes, bunches, stems, amount.
    totals_re=(r"^(?P<boxes>\d+)\s+(?P<bunches>\d+)\s+(?P<stems>\d+)\s+"
               r"(?P<amount>[\d,]+\.\d{2})\s*$"),
    fulls_re=r"^[A-Z]+\s+\d{1,2},\s+\d{4}(?:\s+\d+)+\s+([\d.]+)\s*$",
)

AZULINA = LayoutSpec(
    name="azulina",
    detect=r"AZULINA\s+FLOWERS",
    grid_header=(),
    columns={},
    # "30,000120,00QBx30 HYDRANGEA PREMIUM WHITE 0603190125 1OZH 3600 stem 3600
    # 0,61 2.196,00": full boxes and pieces run together, then box type x stems.
    # Since invoice 3721 (2026-10-05) a QUALITY column follows the description
    # ("WHITE 18CM-PRM"); it is left out of the variety, which the proforma
    # printed without it.
    lines=(r"^\s*[\d.]+,\d{3}\s*(?P<count>\d+),\d{2}\s*(?P<box>[A-Z]{2})x(?P<stems_box>\d+)\s+"
           r"(?P<species>HYDRANGEA)\s+(?:(?P<qual>PREMIUM|SELECT|STANDARD)\s+)?"
           r"(?P<variety>.+?)(?:\s+\d+CM-[A-Z]+)?\s+\d{10}\s+(?:(?P<label>\S+)\s+)?"
           r"(?P<stems>\d+)\s+stem\s+\d+\s+(?P<rate>[\d,]+)\s+(?P<subtotal>[\d.,]+)\s*$",),
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("AZULINA FLOWERS S.A.S."),
        # "PROFORMA 3040" on the proforma, "INVOICE 3721" on the invoice.
        "id_invoice": rx(r"(?:PROFORMA|INVOICE)\s+(\d+)"),
        "dt_invoice": rx(r"\b(\d{1,2}[A-Z]{3}\d{4})\b", date_text),
        "dt_fly": rx(r"\b(\d{1,2}[A-Z]{3}\d{4})\b", date_text),
        "nm_cargo": rx(r"FREIGHT\s+FORWARDER\s*\n[^\n]*?\s*((?:LOGIZTIK|ALIANZA)[^\n]*)$",
                       flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"^\s*(\d{3}-\d{4}\s\d{4})\s*$", flags=re.MULTILINE),
        "tx_hawb": rx(r"^\s*([A-Z]{2}\d{10})\s*$", flags=re.MULTILINE),
    },
    species_map={"HYDRANGEA": "Hydrangea"},
    # Hydrangeas are sold by the stem.
    stems_bunch=1,
    decimal=",",
    # "BXS UNTS" and under it "54,5 6.540": full boxes and stems. The
    # proforma prints "SUBTOTAL 4.438,50" on the BXS line, the invoice three
    # lines further down, so the amount is looked for ahead of the BXS line.
    totals_re=(r"BXS\s+UNTS(?=[\s\S]*?\bSUBTOTAL\s+(?P<amount>[\d.,]+))[^\n]*\n"
               r"\s*(?P<fulls>[\d,]+)\s+(?P<stems>[\d.]+)\s*$"),
)

DAVINCI = LayoutSpec(
    name="davinci",
    detect=r"DAVINCIROSES",
    grid_header=(),
    columns={},
    # A box line, "1OZH SO 1 QRT" or "2 QRT", then its products:
    # "4 25 100 MAGIC TIMES 60 CMS $0.48 $48.00".
    lines=(r"^(?:\S+\s+SO\s+)?(?P<number>\d+)\s+(?P<box>[A-Z]{2,4})\s*$",
           r"^(?P<bunches>\d+)\s+(?P<stems_bunch>\d+)\s+(?P<stems>\d+)\s+(?P<variety>.+?)\s+"
           r"(?P<length>\d+)\s+CMS?\s+\$(?P<rate>[\d.]+)\s+\$(?P<subtotal>[\d,.]+)\s*$"),
    lines_from=r"Number\s+Bunch\s+Bunch\s+Stems\s+Price",
    lines_to=r"^Full\s+Boxes:",
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("DAVINCIROSES EXPORTACIONES CIA LTDA"),
        "id_invoice": rx(r"INVOICE\s*#\s*(\d+)"),
        "dt_invoice": rx(r"Date:\s*(\d{1,2}-[a-z]{3}-\d{4})", date_text),
        "dt_fly": rx(r"Date:\s*(\d{1,2}-[a-z]{3}-\d{4})", date_text),
        "nm_cargo": rx(r"Agent:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"(?<!H)AWB:\s*(\d+)"),
        "tx_hawb": rx(r"HAWB:\s*(\S+)"),
    },
    box_map={"QRT": "QBE", "HLF": "HBE", "HALF": "HBE"},
    species="Roses",
    totals_re=(r"Full\s+Boxes:\s*(?P<fulls>[\d.]+)\s+\$(?P<amount>[\d,.]+)\s*\n\s*"
               r"(?P<stems>[\d,]+)"),
)

MYJ_FLOWERS = LayoutSpec(
    name="myj_flowers",
    detect=r"MYJ\s*FLOWERS",
    grid_header=(),
    columns={},
    # "1OZH 1 QB", then "400 20 20 KOMACHI BLANCO FANCY $0.140 $56.00":
    # stems, stems a bunch, bunches, variety and grade, price, amount.
    lines=(r"^(?:\S+\s+)?(?P<number>\d+)\s+(?P<box>[A-Z]{2,3})\s*$",
           r"^(?P<stems>\d+)\s+(?P<stems_bunch>\d+)\s+(?P<bunches>\d+)\s+(?P<product>.+?)\s*"
           r"\$(?P<rate>[\d.]+)\s+\$(?P<subtotal>[\d,.]+)\s*$"),
    product_re=r"^(?P<variety>.+?)(?:\s+(?P<qual>FANCY|SELECT|STANDARD?))?$",
    row_model="boxes",
    header={
        "tx_company": const("MYJ FLOWERS"),
        "id_invoice": rx(r"INVOICE:\s*(\d+)"),
        "dt_invoice": rx(r"DATE:\s*(\d{1,2}-[a-z]{3}-\d{4})", date_text),
        "dt_fly": rx(r"DATE:\s*(\d{1,2}-[a-z]{3}-\d{4})", date_text),
        "nm_ship": rx(r"Customer:\s*(\S+)"),
        "nm_cargo": rx(r"Agent:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"(?<!H)AWB:\s*([\d\- ]+?)\s+HAWB"),
        "tx_hawb": rx(r"HAWB:\s*(\S+)"),
    },
    species="Carnation",
    # "MIX SELECT", "MIX FANCY": the standard carnation mix, a line per grade
    # and per run of boxes (user, 2026-09-29, 028119: four lines of 2x400).
    variety_rules=(("variety", r"^MIX$", "Dianthus St Mix"),),
    nm_product="{variety} {qual}",
    totals_re=(r"Full\s+Boxes:\s*(?P<fulls>[\d.]+)\s+(?P<stems>\d+)\s+"
               r"\$(?P<amount>[\d,.]+)"),
    # "Detail: 0 FB | 0 HB | 20 QB | 0 OCT"
    boxes_re=r"(\d+)\s+(?:FB|HB|QB|OCT)\s*(?:\||SUBTOTAL)",
)

# Colour words the Komet-style invoices print between species and variety.
KOMET_COLORS = (r"Light\s+Pink|Hot\s+Pink|Dark\s+Pink|Pink|White|Red|Yellow|Orange|Peach|"
                r"Lavender|Purple|Cream|Bicolor|Green|Burgundy|Coral|Salmon|Novelty|Assorted")
KOMET_TOTALS = (r"Total\s+Boxes\s+(?P<boxes>\d+)\s+Inv\.\s+Subtotal\s+\$(?P<amount>[\d,.]+)"
                r"(?s:.*?)Total\s+stems:\s*(?P<stems>[\d,]+)")
KOMET_HEADER = {
    "id_invoice": rx(r"Invoice\s*#\s*(\d+)"),
    "dt_invoice": rx(r"Invoice\s+Date\s+(\d{1,2}/\d{1,2}/\d{4})", date_us),
    "dt_fly": rx(r"Invoice\s+Date\s+(\d{1,2}/\d{1,2}/\d{4})", date_us),
    "nm_ship": rx(r"^PO\s*#\s*(.+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
    "tx_awb": rx(r"Way\s+Bill\s*/\s*Ref\s*#\s*([\d\-]+)"),
}

GUAISA = LayoutSpec(
    name="guaisa",
    detect=r"GUAISA",
    grid_header=(),
    columns={},
    # "ROSE PINK COUNTRY BLUES 60CM 12,86 Kg 1OZH 1 A 100 $0.500 $50.000":
    # colour and variety, length, weight, mark, boxes, box size, stems. A row
    # may have no mark (0270761: "… 8,95 Kg 8 X 1000 …").
    lines=(r"^(?P<species>ROSE)\s+(?P<product>.+?)\s+(?P<length>\d+)CM\s+[\d,]+\s*Kg\s+"
           r"(?:(?P<label>.+?)\s+)?(?P<count>\d+)\s+(?P<box>[A-Z])\s+(?P<stems>\d+)\s+"
           r"\$(?P<rate>[\d.]+)\s+\$(?P<subtotal>[\d,.]+)\s*$",),
    # A mark as long as "FRESH FROM SOURCE BV.-NL" runs on over the box
    # count, box size and stems, and the text interleaves them
    # ("SOURC1E BXV.-NL125", 0269966).
    extract={"clip_overflow": True},
    product_re=rf"^(?:(?P<color>{KOMET_COLORS.upper()})\s+)?(?P<variety>.+)$",
    row_model="boxes",
    header={
        "tx_company": const("GUAISA S.A."),
        "id_invoice": rx(r"INVOICE\s+(\d+)"),
        "dt_invoice": rx(r"^Date\s+(\d{1,2}/\d{1,2}/\d{4})", date_us, flags=re.IGNORECASE | re.MULTILINE),
        "dt_fly": rx(r"^Date\s+(\d{1,2}/\d{1,2}/\d{4})", date_us, flags=re.IGNORECASE | re.MULTILINE),
        "nm_ship": rx(r"PO\s*#\s*(\S+)"),
        "tx_awb": rx(r"AWB:\s*([\d\- ]+?)\s*/"),
        "tx_hawb": rx(r"AWB:[^/\n]*/\s*(\S+)"),
    },
    # Its box sizes are letters, 15 to 25 cm high ("A - 95x32.5x25",
    # "X - 105x31x16.5", "M - 95x31x15.5"), each holding 100-125 stems here.
    # None is mapped: they go as the quarter boxes they look like, and the
    # screen lets the user pick another (user, 2026-09-29).
    species_map={"ROSE": "Roses"},
    # The invoice prints stems only; its roses are bunched by 25.
    stems_bunch=25,
    totals_re=KOMET_TOTALS,
)

ROSAPRIMA = LayoutSpec(
    name="rosaprima",
    detect=r"Rosaprima\s+International",
    grid_header=(),
    columns={},
    lines=(
        # "ROS RED Freedom 70 x 250 Stem (4.32 cubes) 1OZH 4 JB 1000 $0.450 $450.00"
        # — or "ROS AST 70 x 250 …", an assorted box whose contents follow.
        # Garden roses are "GAR CRM Fatima Gardens 60 x 96 Stem …" (1144561).
        r"^(?:ROS|(?P<species>GAR))\s+(?:(?P<color>[A-Z]{3})\s+)?(?P<variety>.+?)\s+(?P<length>\d+)\s+x\s+"
        r"(?P<stems_box>\d+)\s+Stem\s+\([\d.]+\s+cubes\)\s+(?:(?P<label>\S+)\s+)?(?P<count>\d+)\s+"
        r"(?P<box>[A-Z]{2})\s+(?P<stems>\d+)\s+\$(?P<rate>[\d.]+)\s+\$(?P<subtotal>[\d,.]+)\s*$",
        # "ROS LAV Purple Crown 70 1 Bun. 25 St/Bun at $0.450" — per box.
        r"^(?:ROS|(?P<species>GAR))\s+(?:(?P<color>[A-Z]{3})\s+)?(?P<variety>.+?)\s+(?P<length>\d+)\s+"
        r"(?P<bunches>\d+)\s+Bun\.\s+(?P<stems_bunch>\d+)\s+St/Bun\s+at\s+\$(?P<rate>[\d.]+)\s*$",
    ),
    product_re="",
    row_model="boxes",
    block_row_is_summary=True,
    items_per_box=True,
    header={
        **KOMET_HEADER,
        # Two FreshPortal suppliers: Rosaprima for Parfum Flower Company, and
        # for Coloriginz.
        "tx_company": rx(r"^PO\s*#\s*(.+?)\s*$",
                         cases=(("parfum", "ROSAPRIMA PFC"),), default="ROSAPRIMA COLORIGINZ",
                         flags=re.IGNORECASE | re.MULTILINE),
    },
    # 8 JB are 4.00 full boxes, and 11 QB with 3 QL are 3.50. 27 QB, 4 QL
    # and 1 EB are 7.88 (1144561): EB is an eighth.
    box_map={"JB": "HBE", "QL": "QBE", "EB": "1/8"},
    species_map={"GAR": "Garden Roses"},
    species="Roses",
    # A box of one variety prints stems only; its assorted boxes say 25 a
    # bunch. Since 1144561 (2026-09-30) its boxes also hold 96 or 72 stems,
    # which 25 does not divide: those are bunches of 12 (user, 2026-10-03).
    stems_bunch=25,
    stems_bunch_also=(12,),
    totals_re=KOMET_TOTALS + r",[^\n]*FBE's:\s*(?P<fulls>[\d.]+)",
)

EQR_ROSES = LayoutSpec(
    name="eqr_roses",
    detect=r"EQR\s+USA|EQUATOROSES",
    grid_header=(),
    columns={},
    # "Roses Light Pink Pink Mondial 50 Cm x 300 Stem 1OZH 2 HB 600 $0.380 $228.00"
    lines=(r"^(?P<species>Roses?)\s+(?P<product>.+?)\s+(?P<length>\d+)\s+Cm\s+x\s+"
           r"(?P<stems_box>\d+)\s+Stem\s+(?:(?P<label>\S+)\s+)?(?P<count>\d+)\s+(?P<box>[A-Z]{2})\s+"
           r"(?P<stems>\d+)\s+\$(?P<rate>[\d.]+)\s+\$(?P<subtotal>[\d,.]+)\s*$",),
    # "Light Pink Pink Mondial": the colour, then the variety.
    product_re=rf"^(?:(?P<color>{KOMET_COLORS})\s+)?(?P<variety>.+)$",
    row_model="boxes",
    header={"tx_company": const("EQR ROSES"), **KOMET_HEADER},
    species_map={"ROSES": "Roses", "ROSE": "Roses"},
    # The invoice prints stems only; its roses are bunched by 25.
    stems_bunch=25,
    totals_re=KOMET_TOTALS + r",[^\n]*FBE's:\s*(?P<fulls>[\d.]+)",
)

ROSAS_DEL_CORAZON = LayoutSpec(
    name="rosas_del_corazon",
    detect=r"ROSAS\s*DEL\s*CORAZ",
    grid_header=(),
    columns={},
    # "1 I QBM I 25 I 1OZH I MANDARIN GARDEN 40 CM I $0.300000 I $7.50" — the
    # piece count only on a box's first row.
    lines=(r"^(?:(?P<count>\d+)\s+)?I\s+(?P<box>[A-Z]+)\s+I\s+(?P<stems>\d+)\s+I\s+"
           r"(?:(?P<label>\S+)\s+)?I\s+(?P<variety>.+?)\s+(?P<length>\d+)\s+CM\s+I\s+"
           r"\$(?P<rate>[\d.]+)\s+I\s+\$(?P<subtotal>[\d,.]+)\s*$",),
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("ROSAS DEL CORAZON"),
        "id_invoice": rx(r"COMERCIAL\s*INVOICE\s+(\d+)"),
        "dt_invoice": rx(r"DATE:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "dt_fly": rx(r"DATE:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "nm_cargo": rx(r"FORWARDER:\s*(\S+)"),
        "tx_awb": rx(r"MAWB\s*#:\s*([\d\- ]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_hawb": rx(r"HAWB\s*#:\s*(\S+)"),
    },
    species="Roses",
    # The invoice prints stems only, 25 a variety; its roses are bunched by 25.
    stems_bunch=25,
    # Printed so tightly that words run together at the default spacing.
    extract={"x_tolerance": 1},
    totals_re=(r"^(?P<boxes>[\d.]+)\s+I\s+I\s+(?P<stems>\d+)\s+I\s+TOTAL\s+F\.O\.B\.\s+"
               r"VALUE:\s+I\s+\$(?P<amount>[\d,.]+)"),
    fulls_re=r"TOTAL\s+FULL\s+([\d.]+)",
)

UTOPIA = LayoutSpec(
    name="utopia",
    detect=r"UTOPIA\s+FARMS",
    grid_header=(),
    columns={},
    lines=(
        # A farm heads its rows: "San Pablo HAWB: LA1609055897".
        r"^(?P<location>[A-Z][A-Za-z ]+?)\s+HAWB:\s*\S+\s*$",
        # A row of boxes: "LIMONIUM WHITE ACTIVA 25ST 80CM 300ST (ST 2215338-5)
        # 80 CM 3 Q 0.75 900 ST 900 0.320 288.00" — the bunch size is only here.
        # Gypsophila prints a stem's weight where the length goes: "25ST
        # 1000GR … 40 GR" is 25 stems of 40 g (user, 2026-09-29: a weight).
        r"^(?P<product>.+?)\s+(?P<stems_bunch>\d+)ST\b.*?\((?:ST|SP)\s+[\d-]+\)\s+"
        r"(?:(?P<length>\d+)\s+CM|(?P<grams>\d+)\s+GR)\s+(?P<count>\d+)\s+(?P<box>[A-Z])\s+[\d.]+\s+"
        r"\d+\s+(?:ST|BC)\s+(?P<stems>\d+)\s+(?P<rate>[\d.]+)\s+(?P<subtotal>[\d,.]+)\s*$",
        # and what is in them: "GYPSOPHILA (O) OVERTIME 40 GR 72 BC 1800 0.340 612.00"
        r"^(?P<variety>[A-Z].+?)\s+(?:(?P<length>\d+)\s+CM|(?P<grams>\d+)\s+GR)\s+"
        r"(?:(?P<bunches>\d+)\s+BC|\d+\s+ST)\s+(?P<stems>\d+)\s+(?P<rate>[\d.]+)\s+"
        r"(?P<subtotal>[\d,.]+)\s*$",
    ),
    # "GYPSOPHILA (O) OVERTIME", "LIMONIUM WHITE ACTIVA": genus, then variety.
    product_re=r"^(?P<species>[A-Z]+)\.?\s+(?:\([A-Z]\)\s+)?(?P<variety>.+)$",
    row_model="boxes",
    block_row_is_summary=True,
    header={
        "tx_company": const("UTOPIA FARMS UTF S.A.S"),
        "id_invoice": rx(r"RUC:\s*\d+\s+(\d+)\s"),
        "dt_invoice": rx(r"RUC:\s*\d+\s+\d+\s+(\d{1,2}/\d{1,2}/\d{4})", date_us),
        "dt_fly": rx(r"RUC:\s*\d+\s+\d+\s+(\d{1,2}/\d{1,2}/\d{4})", date_us),
        "nm_ship": rx(r"Ship\s+To:[^\n]*\n\s*(.+?)\s+FRESH\s+FROM"),
        "nm_cargo": rx(r"Agent:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"Air\s+Waybill:\s*([\d\- ]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_hawb": rx(r"HAWB:\s*(\S+)"),
    },
    # The PDF is the source of truth: "H" is a half box (the JSON path
    # passes the letter on unmapped).
    box_map=LETTER_BOXES,
    totals_re=(r"Pieces=(?P<boxes>\d+)\s+F\.B\.E=\s*(?P<fulls>[\d.]+)\s+Total\s+Stems:\s*"
               r"(?P<stems>[\d,]+)\s+USD:\s*(?P<amount>[\d,.]+)"),
)

APOSENTOS = LayoutSpec(
    name="aposentos",
    detect=r"FLORES\s+DE\s+APOSENTOS",
    grid_header=(),
    columns={},
    # "2 Tabaco 720 CARNATIONS BRUT NOVELTY DUTY FREE SELECT CONTAINER-Coloriginz
    # CO-0603129000 $0.2200 $158.40": boxes, box, stems, species, variety and
    # colour, criterion, grade, brand, tariff, price, amount.
    lines=(r"^(?P<count>\d+)\s+(?P<box>\S+)\s+(?P<stems>\d+)\s+"
           r"(?P<species>MINI\s*CARNATIONS?|CARNATIONS?)\s+(?P<product>.+?)\s+DUTY\s+FREE\s+"
           r"(?P<qual>\w+)\s+(?:(?P<label>\S+)\s+)?CO-\d+\s+\$(?P<rate>[\d.]+)\s+"
           r"\$(?P<subtotal>[\d,.]+)\s*$",),
    # The colour closes the description: "LEGE PINK NOVELTY", "ZEPELIN HOT PINK".
    product_re=(r"^(?P<variety>.+?)\s+(?P<color>HOT\s+PINK|BICOLOR\s+RED|BICOLOR|NOVELTY|ORANGE|"
                r"GOLD|YELLOW|PINK|GREEN|WHITE|RED|CREAM|LAVENDER|PURPLE|BURGUNDY|SALMON|"
                r"PEACH|CORAL)$"),
    row_model="boxes",
    header={
        "tx_company": const("C.I. FLORES DE APOSENTOS SAS"),
        "id_invoice": rx(r"INVOICE\s+No\.\s*\n[^\n]*\n\s*(\d+)"),
        "dt_invoice": rx(r"ISSUE\s+DATE\s*:\s*([A-Za-z]{3}\s+\d{1,2}\s+\d{4})", date_text),
        "dt_fly": rx(r"SHIP\s+DATE\s+(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "tx_awb": rx(r"\bAWB\s+([\d\-]+)"),
        "tx_hawb": rx(r"\bHAWB\s+(\S+)"),
    },
    # Its summary counts the "Tabaco" boxes as halves: 36 of them, 18 fulls.
    box_map={"TABACO": "HBE"},
    species_map={"CARNATIONS": "Carnation", "CARNATION": "Carnation",
                 "MINI CARNATIONS": "Mini Carnation", "MINICARNATIONS": "Mini Carnation"},
    # The invoice prints stems only; Colombian carnations are bunched by 20.
    stems_bunch=20,
    # The consolidation at the foot: "36 12960 2851.2000000000007".
    totals_re=r"^(?P<boxes>\d+)\s+(?P<stems>\d+)\s+(?P<amount>\d+\.\d+)\s*$",
    fulls_re=r"TOTAL\s+FULLS\s+([\d.]+)",
)

# An SRI electronic invoice (FACTURA) of Pablo Viteri, selling rice flower.
VITERI = LayoutSpec(
    name="viteri",
    detect=r"VITERI\s+CHECA",
    grid_header=(),
    columns={},
    # The description on one line, "RICEFLOWER BOOMING PINK", and the rest on
    # the next: "RBP501026SO 1 250 50 cm. 0.37 92.50" — code, boxes, stems,
    # length, price, amount.
    lines=(r"^(?P<product>[A-Z][A-Z ]+?)\s*\n(?P<label>[A-Z0-9]+)\s+(?P<count>\d+)\s+"
           r"(?P<stems>\d+)\s+(?P<length>\d+)\s+cm\.?\s+(?P<rate>[\d.]+)\s+"
           r"(?P<subtotal>[\d,.]+)\s*$",),
    product_re=r"^(?P<species>RICE\s*FLOWER)\s+(?P<variety>.+)$",
    row_model="boxes",
    header={
        "tx_company": const("PABLO VITERI"),
        "id_invoice": rx(r"SERIE\s*:\s*\n\s*[\d-]+\s*\n\s*(\d+)"),
        "dt_invoice": rx(r"FECHA\s+EMISION\s*:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy),
        "dt_fly": rx(r"FECHA\s+EMB\.\s*:\s*(\d{1,2}/\d{1,2}/\d{4})", date_us),
        "nm_cargo": rx(r"AGE\.\s+CARGA:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"GUIA\s+MADRE:\s*([\d ]+?)\s+AGE"),
        "tx_hawb": rx(r"GUIA\s+HIJA:\s*(\S+)"),
    },
    species_map={"RICEFLOWER": "Rice Flower", "RICE FLOWER": "Rice Flower"},
    # "PIECE: 2" and "FULL BOXES: 0.5": quarter boxes.
    default_box="QB",
    # The product code carries the bunch size: RBP 50 10 26 SO — 50 cm, 10 stems.
    stems_bunch=10,
    totals_re=r"TOTAL\s+USD\s*:\s*(?P<amount>[\d,.]+)",
    boxes_re=r"PIECE:\s*(\d+)",
    fulls_re=r"FULL\s+BOXES:\s*([\d.]+)",
)

# An SRI electronic invoice with a single line: sample stems of rose.
DR_ECUADOR_ROSES = LayoutSpec(
    name="dr_ecuador_roses",
    detect=r"D\s*R\s+ECUADOR\s+ROSES",
    grid_header=(),
    columns={},
    # "223 272 Stems of rose $0.01 $2.72", and in the notes "3 HALF BOXES".
    lines=(r"^(?P<label>\d+)\s+(?P<stems>\d+)\s+(?P<variety>Stems\s+of\s+rose)\s+"
           r"\$(?P<rate>[\d.]+)\s+\$(?P<subtotal>[\d,.]+)\s*$(?s:.*?)^(?P<count>\d+)\s+HALF\s+BOXES",),
    product_re="",
    row_model="boxes",
    header={
        "tx_company": const("D.R. ECUADOR ROSES S.A."),
        "id_invoice": rx(r"Factura:\s*([\d-]+)"),
        "dt_invoice": rx(r"Fecha\s+de\s+Emisi\S*n:\s*(\d{1,2}-\d{1,2}-\d{4})", date_dmy),
        "dt_fly": rx(r"Fecha\s+de\s+Emisi\S*n:\s*(\d{1,2}-\d{1,2}-\d{4})", date_dmy),
        "tx_awb": rx(r"\bAWB\s+([\d ]+?)\s*(?:\(cid|$)", flags=re.IGNORECASE | re.MULTILINE),
        "tx_hawb": rx(r"\bHAWB\s+([A-Z]{2}\d+)"),
    },
    default_box="HB",
    species="Roses",
    # Loose sample stems go as the mixed box product (user, 2026-09-29).
    variety_rules=(("variety", r"^Stems\s+of\s+rose$", "Rosa Ec Mix in Box"),),
    # Loose stems, counted by the stem; 272 of them over 3 half boxes, packed
    # 100 a box and the rest in the last (user, 2026-09-29).
    stems_bunch=1,
    split_uneven=True,
    box_fill=100,
    totals_re=r"TOTAL\s+STEM\s+OF\s+ROSE\s+(?P<stems>\d+)(?s:.*?)VALUE\s+FCA\s+[A-Z]+\s+USD\s+(?P<amount>[\d.]+)",
)

SAN_ANDRES = LayoutSpec(
    name="san_andres",
    detect=r"SAN\s+ANDRES\s+DEL\s+CHAUPI",
    grid_header=("box", "box number", "box type", "description", "t wb"),
    # "WB" bunches a box, "T WB" of the row; "SPLENDID X6" is 6 stems a bunch.
    columns={"count": 0, "number": 1, "box": 2, "label": 3, "product": 4, "qual": 5,
             "bunches_box": 6, "bunches": 7, "stems": 8, "rate": 9, "subtotal": 10},
    # "BABY PINK P-02": the colour code is not part of the name.
    product_re=r"^(?P<variety>.+?)(?:\s+[A-Z]-\d{2})?$",
    row_model="boxes",
    # "BULK ROSE STEM(50cm" — the box name, cut off by its narrow column.
    box_re=r"^([A-Z][A-Z ]*?)\s*(?:\(|$)",
    # MB SPLENDID is ECPS and BULK ROSE STEM a half box; MB SUPER PETITE is
    # not known and goes as QBE for the user to change (user, 2026-09-29).
    box_map={"MB SPLENDID": "ECPS", "BULK ROSE STEM": "HBE"},
    header={
        # FreshPortal's supplier and grower Kiara / El Chaupi (user, 2026-09-29).
        "tx_company": const("KIARA / EL CHAUPI"),
        "id_invoice": rx(r"^INVOICE\s+(\d+)", flags=re.IGNORECASE | re.MULTILINE),
        "dt_invoice": rx(r"^DATE:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy, flags=re.IGNORECASE | re.MULTILINE),
        "dt_fly": rx(r"^DATE:\s*(\d{1,2}/\d{1,2}/\d{4})", date_dmy, flags=re.IGNORECASE | re.MULTILINE),
        "nm_ship": rx(r"CONSIGNEE:\s*(\S+)"),
        "nm_cargo": rx(r"CARGO\s+AGENCY:\s*([^\n]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_awb": rx(r"M\.A\.W\.B:\s*([A-Z0-9\- ]+?)\s*$", flags=re.IGNORECASE | re.MULTILINE),
        "tx_hawb": rx(r"H\.A\.W\.B:\s*(\S+)"),
    },
    species="Roses",
    # The customer ID column runs over into the description.
    extract={"clip_overflow": True},
    totals_marker="TOTALS",
    totals_col=5,
    boxes_re=r"FULL\s+TOTAL\s+([\d.]+)",
)


LAYOUTS: list[LayoutSpec] = [
    FIORENTINA, MYSTICFLOWERS, FLOREQUISA, AGROGANA, FLORIFRUT, ECOFLOR, CALINAMA, STAMPSYBOX,
    ROSALEDA, MONTEROSAS, JET_FRESH, ROYALFLOWERS_SAS, ROYALFLOWERS, NARANJO_ROSES, LARTISAN,
    HOJA_VERDE, ALBRA_ROSES, POMAROSA, BOSQUEFLOWERS, PROTEAS_SOLANDINO, NIKITA, PALITAFLOR, COLIBRI,
    TIERRA_VERDE, MONTEBELLO, LAILA_FLOWERS_UNXB, LAILA_FLOWERS, GREENEX, PLATONOFF, FLORAROMA, BREZZA, SOL_PACIFIC, VALLE_VERDE, FLORSANI, FLORISOL,
    TERRA_PACIFIC, AGROTERRANORTE,
    ATTAR_ROSES, AZULINA, DAVINCI, MYJ_FLOWERS, GUAISA, ROSAPRIMA, EQR_ROSES,
    ROSAS_DEL_CORAZON, UTOPIA, APOSENTOS, VITERI, DR_ECUADOR_ROSES, SAN_ANDRES,
    # The two first layouts go last: they detect by template wording, which
    # other farms' invoices from the same programs share.
    QUALISA, ALISSROSES,
]


# ---------------------------------------------------------------------------
# Inspection helper — `python -m pdf_layouts <invoice.pdf>`
# ---------------------------------------------------------------------------

def _inspect(path: str) -> None:
    """Print what a PDF actually contains, so a new supplier's spec can be
    written from the real column indexes instead of guessed at."""
    from parser_delivery_pdf import detect_pdf_layout, extract_pdf

    with open(path, "rb") as fh:
        data = fh.read()
    doc = extract_pdf(data)

    spec = detect_pdf_layout(doc.text)
    if spec and spec.extract:
        # Show what the spec itself reads.
        doc = extract_pdf(data, **spec.extract)
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
