"""Layout specs checked against real invoice content.

The page text and table rows below are what pdfplumber actually returns for
two invoices that were also supplied as JSON, copied from
`python -m pdf_layouts <file.pdf>`. Every expectation is what parser_delivery
produces from the same shipment — the point of the PDF path is to land on the
same DeliveryLines.

Using the real text matters. An earlier version of this file used fixtures
written from how the invoices *look*, and they passed while the real files
failed: the header labels sit beside their values on one text line rather
than in a label block, the bill-to and ship-to blocks share a line, and the
invoice title runs into the invoice number with no space.

These tests start at PdfDoc, i.e. after pdfplumber. When a supplier is added
or an invoice stops parsing, run `python -m pdf_layouts <file.pdf>` and bring
the new rows here.

Run either way:
    python -m pytest python/tests/test_parser_delivery_pdf.py -q
    python python/tests/test_parser_delivery_pdf.py

The second form is what the ship-to-test gate uses — it runs every file in
this directory as a script. Without the __main__ block at the bottom, running
this file that way would import it, define the tests, exit 0 and check
nothing, which reads as a pass.

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from parser_delivery_pdf import (  # noqa: E402
    PdfChecksumError,
    PdfDoc,
    PdfParseError,
    _unwrap,
    detect_pdf_layout,
    parse_with_spec,
)
from parser_delivery import mix_box_lines  # noqa: E402
from pdf_layouts import ALISSROSES, QUALISA  # noqa: E402


# ---------------------------------------------------------------------------
# Alissroses 5053027 — compared against 5053027.json
# ---------------------------------------------------------------------------

ALIS_TEXT = """CUSTOMER INVOICE 5053027
Incoterm FOB UIO
Invoice Date 09/01/2026
ALISSROSES SAS
RUC: 1793208810001 Invoice Numbers 5053027
Dirección: Barrio Llanos de Alba, Vía a Olmedo-Zuleta, Pesillo -
Internal PO ID: 121827
ECUADOR
Teléfono: +593 968952492 Ship Date 09/01/2026
Correo: sales@alisroses.com
Fly Date 09/02/2026
Web: https://alisroses.com/
Amount Due $329.00
TO BILL CUSTOMER SHIP CUSTOMER
FRESH FROM SOURCE B.V. 1OZH
Betula 71 1424 LH Betula 71 1424 LH
AALSMEER, AALSMEER,
NL NL
QTY RATE PER QTY RATE PER SUB-TOTAL VOLUME WEIGHT REAL WEIGHT
# BOX PRODUCT SPECIES LABEL BOX NAME
BUNCH BUNCH ($) STEMS Stem($) USD ($) PER BOX(kg) PER BOX(kg)
1 HB 9 EXPLORER 60CM 25ST AR ROSES 8 $11.2500 200 $0.4500 $90.00 15.75 0.00
(90*35*30)
2 QB 9 FRUTTETO 60CM 25ST AR ROSES 8 $10.5000 200 $0.4200 $84.00 9.19 0.00
(90*35*17.5)
2 QB 9 LOLA 60CM 25ST AR ROSES 8 $12.5000 200 $0.5000 $100.00 9.19 0.00
(90*35*17.5)
1 QB 9 MAGIC TIMES 60CM 25ST AR ROSES 4 $13.7500 100 $0.5500 $55.00 9.19 0.00
(90*35*17.5)
6 TOTALS 28 700 $329.00 61.69 0.00
MAWB 369-1150 4522 HAWB LA1609000358
Cargo Agency ECUCARGA Truck Company
Airline Atlas Air Country Netherlands
Destination
Number in Fulls 1.7500 DAU-40 055-2026-40-
01595762
60CM
700"""

# The invoice's label/value box, a ruled table of its own.
ALIS_KV = [["Incoterm", "FOB UIO"],
           ["Invoice Date", "09/01/2026"],
           ["Invoice Numbers", "5053027"],
           ["Internal PO ID:", "121827"],
           ["Ship Date", "09/01/2026"],
           ["Fly Date", "09/02/2026"],
           ["Amount Due", "$329.00"]]

ALIS_HEADER_ROW = ["#", "BOX", "PRODUCT", "SPECIES", "QTY BUNCH", "RATE PER BUNCH ($)",
                   "QTY STEMS", "RATE PER Stem($)", "SUB-TOTAL USD ($)", "LABEL",
                   "VOLUME WEIGHT PER BOX(kg)", "REAL WEIGHT PER BOX(kg)", "BOX NAME"]


def _alis_row(count, box, product, bunch, rate_bunch, stems, rate_stem, subtotal, volume):
    return [count, box, product, "ROSES", bunch, rate_bunch, stems, rate_stem,
            subtotal, "", volume, "0.00", ""]


ALIS_PRODUCTS = [
    _alis_row("1", "HB 9 (90*35*30)", "EXPLORER 60CM 25ST AR",
              "8", "$11.2500", "200", "$0.4500", "$90.00", "15.75"),
    _alis_row("2", "QB 9 (90*35*17.5)", "FRUTTETO 60CM 25ST AR",
              "8", "$10.5000", "200", "$0.4200", "$84.00", "9.19"),
    _alis_row("2", "QB 9 (90*35*17.5)", "LOLA 60CM 25ST AR",
              "8", "$12.5000", "200", "$0.5000", "$100.00", "9.19"),
    _alis_row("1", "QB 9 (90*35*17.5)", "MAGIC TIMES 60CM 25ST AR",
              "4", "$13.7500", "100", "$0.5500", "$55.00", "9.19"),
    ["6", "", "TOTALS", "", "28", "", "700", "", "$329.00", "", "61.69", "0.00", ""],
]

# The address boxes sit on top of the grid and share its borders, so this all
# comes back as one table whose first rows are the bill-to block — the product
# header is the third row, not the first.
ALIS_GRID = [
    ["TO BILL CUSTOMER", "", *[""] * 11],
    ["FRESH FROM SOURCE B.V. Betula 71 1424 LH AALSMEER, NL", *[""] * 12],
    ALIS_HEADER_ROW,
    *ALIS_PRODUCTS,
]


@pytest.fixture
def alis_doc():
    return PdfDoc(text=ALIS_TEXT, tables=[ALIS_KV, ALIS_GRID])


def test_alissroses_detected(alis_doc):
    assert detect_pdf_layout(alis_doc.text) is ALISSROSES


def test_alissroses_header(alis_doc):
    order = parse_with_spec(alis_doc, ALISSROSES)
    # Read off the line above "RUC:", not the line under the title — the
    # title is followed by the incoterm, not by the company name.
    assert order.tx_company == "ALISSROSES SAS"
    assert order.id_invoice == "5053027"
    assert order.id_purchaseorder == "121827"
    # 09/01/2026 MM/DD → 1 September, the same day the JSON's dt_invoice gives.
    assert order.dt_invoice == "01-09-2026"
    assert order.dt_fly == "02-09-2026"
    # Bill-to and ship-to share a line: "FRESH FROM SOURCE B.V. 1OZH".
    assert order.nm_ship == "1OZH"
    assert order.nm_cargo == "ECUCARGA"
    assert order.tx_awb == "369-1150 4522"
    assert order.tx_hawb == "LA1609000358"


def test_alissroses_lines_match_the_json(alis_doc):
    """The JSON's six boxes aggregate into these four lines; so does the PDF."""
    order = parse_with_spec(alis_doc, ALISSROSES)

    assert order.nu_boxes == 6
    assert order.nu_stems_total == 700
    assert order.mny_total == 329.0

    got = {
        l.nm_variety: (l.nu_length, l.nu_stems_bunch, l.nu_bunches,
                       l.nu_physical_boxes, l.mny_rate_stem, l.nm_box, l.nm_species)
        for l in order.lines
    }
    assert got == {
        "Explorer":    (60, 25, 8, 1, 0.45, "HBE", "Roses"),
        "Frutteto":    (60, 25, 8, 2, 0.42, "QBE", "Roses"),
        "Lola":        (60, 25, 8, 2, 0.50, "QBE", "Roses"),
        "Magic Times": (60, 25, 4, 1, 0.55, "QBE", "Roses"),
    }


def test_alissroses_grid_found_below_the_address_rows(alis_doc):
    """Looking only at a table's first row would miss this grid entirely —
    the real invoice was refused as having no product table at all."""
    order = parse_with_spec(alis_doc, ALISSROSES)
    assert len(order.lines) == 4
    assert "TO BILL CUSTOMER" not in {l.nm_variety for l in order.lines}


def test_alissroses_per_box_quantities_reach_the_api(alis_doc):
    """build_stock_entry divides a merged line back down per box — 2 boxes of
    4 bunches, not one box of 8."""
    from dfg_api_client import build_stock_entry

    order = parse_with_spec(alis_doc, ALISSROSES)
    frutteto = next(l for l in order.lines if l.nm_variety == "Frutteto")
    frutteto.fp_product_id = "TEST"
    entry = build_stock_entry(frutteto)

    assert entry["quantity"] == 2
    assert entry["quantity_per_pack"] == 100
    assert entry["characteristics"]["number_of_bunches"] == "4"
    assert entry["fust"] == "QBE"


def test_alissroses_checksum_catches_a_dropped_row():
    """A template change that hides a row must fail loudly, not import short."""
    grid = [r for r in ALIS_GRID if "LOLA" not in str(r)]
    doc = PdfDoc(text=ALIS_TEXT, tables=[ALIS_KV, grid])
    with pytest.raises(PdfChecksumError) as exc:
        parse_with_spec(doc, ALISSROSES)
    assert "stems" in str(exc.value)


def test_a_pdf_without_the_grid_says_what_it_did_find():
    """The refusal has to be actionable: at many supplier templates, "not
    found" alone cannot tell a missing table from a mis-mapped one."""
    doc = PdfDoc(text=ALIS_TEXT, tables=[ALIS_KV])
    with pytest.raises(PdfParseError) as exc:
        parse_with_spec(doc, ALISSROSES)
    message = str(exc.value)
    assert "1 table(s)" in message and "7x2" in message
    assert "pdf_layouts" in message


# ---------------------------------------------------------------------------
# Qualisa 21022 — compared against the invoice's own JSON export
# ---------------------------------------------------------------------------

# Verbatim, minus the eight pages of product rows in the middle. Note the
# title running into the invoice number, the header labels sharing lines with
# unrelated address text, and the waybill wrapping across two lines.
QUALISA_TEXT = """QUALITY SERVICE QUALISA S.A.SCustomer Invoice#: 21022
1791740262001
Cayambe Juan Montalvo, Primaria S/N y Secundaria
Bill to (Customer): Ship to (Destinatario): Invoice Date 2026-09-01
FRESH FROM SOURCE BV 1OZH
Delivery Date 2026-09-02
PO
1430 BB AALSMEER P.O. BOX 1430 BB AALSMEER AMSTERDAM
1076 AALSMEER Term Payment 60
THE NETHERLANDS THE NETHERLANDS Method
Carrier:
Seller ANA MARIA JARAMILL
ALIANZA-OYAMBARILLO
Airline: Observacion 2: Amount $ 800.00
Atlas Air AWB 36911504522
HAWB LA160900067
8
DAE 05520264001582502
Bunch Total Unit Total
Order Type Boxes Box Type Species Varieties CM Box Label
Box Stems Price Price
Open 2 QB3 ALSTRO MIXED BOX MIXED BOX 32 320 0.2500 80.00
Market (18*100*45)
ALSTROEMERI PIERROT N 10ST QUCT 80 2 20 0.2500 5.00
A
{totals}
TOTAL: EIGHT HUNDRED AND 0/100 USD
Warehouse Species Stems Price Total Box Type Qty. EQ. Full Order Type Qty. Stems Price Total
QUALISA 3 ALSTROEMERIA 3,200 0.25 800.00 QB3 ALSTRO 20 5.00 Open Market 20 3,200 0.25 800.00
Total 3,200 800.00 Total 20 5.00 Total 20 3,200 0.25 800.00
PRODUCT OF ECUADOR
INCOTERMS: FOB Page 8 of 8"""

QUALISA_HEADER_ROW = ["Order Type", "Boxes", "Box Type", "Species", "Varieties", "CM",
                      "Bunch Box", "Total Stems", "Unit Price", "Total Price", "Box Label"]


def _q_group(boxes, bunches, stems, amount):
    return ["Open Market", boxes, "QB3 ALSTRO (18*100*45)", "MIXED BOX", "MIXED BOX",
            "", bunches, stems, "0.2500", amount, ""]


def _q_row(variety, cm, bunches, stems, amount, species="ALSTROEMERI A"):
    return ["", "", "", species, f"{variety} N 10ST QUCT", cm, bunches, stems,
            "0.2500", amount, ""]


# The invoice's first block: two identical boxes of sixteen bunches each,
# which the JSON carries as boxes 262632 and 262645.
QUALISA_BLOCK_1 = [
    _q_group("2", "32", "320", "80.00"),
    _q_row("PIERROT", "80", "2", "20", "5.00"),
    _q_row("INTENZZ PINK", "80", "2", "20", "5.00"),
    _q_row("LUCIA", "80", "2", "20", "5.00"),
    _q_row("FIFI", "80", "2", "20", "5.00"),
    _q_row("PIERROT", "90", "2", "20", "5.00"),
    _q_row("INTENZZ PINK", "90", "2", "20", "5.00"),
    _q_row("LUCIA", "90", "2", "20", "5.00"),
    _q_row("CANYON", "90", "2", "20", "5.00"),
    _q_row("DIRTY DANCING", "90", "2", "20", "5.00"),
    _q_row("PRIMADONNA", "90", "2", "20", "5.00"),
    _q_row("AUDREY", "90", "2", "20", "5.00"),
    _q_row("FIFI", "90", "2", "20", "5.00"),
    _q_row("BIANCA", "90", "2", "20", "5.00"),
    _q_row("HIMALAYA", "90", "2", "20", "5.00"),
    _q_row("WINTERFELL", "90", "4", "40", "10.00"),
]

# A one-box block that prints CANYON 90 twice, as box 262637 does in the JSON.
QUALISA_BLOCK_2 = [
    _q_group("1", "16", "160", "40.00"),
    _q_row("CORDOVA", "80", "1", "10", "2.50"),
    _q_row("PIERROT", "80", "1", "10", "2.50"),
    _q_row("CANYON", "80", "1", "10", "2.50"),
    _q_row("DIRTY DANCING", "80", "1", "10", "2.50"),
    _q_row("AUDREY", "80", "1", "10", "2.50"),
    _q_row("FIFI", "80", "1", "10", "2.50"),
    _q_row("INTENZZ PINK", "90", "1", "10", "2.50"),
    _q_row("LUCIA", "90", "1", "10", "2.50"),
    _q_row("MARACANA", "90", "1", "10", "2.50"),
    _q_row("CANYON", "90", "1", "10", "2.50"),
    _q_row("CANYON", "90", "1", "10", "2.50"),
    _q_row("AUDREY", "90", "1", "10", "2.50"),
    _q_row("FIFI", "90", "1", "10", "2.50"),
    _q_row("BIANCA", "90", "1", "10", "2.50"),
    _q_row("HIMALAYA", "90", "1", "10", "2.50"),
    _q_row("WINTERFELL", "90", "1", "10", "2.50"),
]


def _qualisa_doc(blocks, boxes, bunches, stems, amount):
    rows = [QUALISA_HEADER_ROW]
    for block in blocks:
        rows.extend(block)
    totals = (f"{boxes} SubTotal {bunches} {stems} 0.2500 {amount}\n"
              f"{boxes} Total {bunches} {stems} 0.2500 {amount}")
    return PdfDoc(text=QUALISA_TEXT.format(totals=totals), tables=[rows])


def test_qualisa_detected():
    assert detect_pdf_layout(QUALISA_TEXT) is QUALISA


def test_qualisa_header():
    doc = _qualisa_doc([QUALISA_BLOCK_1], 2, 32, 320, "80.00")
    order = parse_with_spec(doc, QUALISA)

    # The title runs into the invoice label with no space between them.
    assert order.tx_company == "QUALITY SERVICE QUALISA S.A.S"
    assert order.id_invoice == "21022"
    assert order.id_purchaseorder == "21022"
    assert order.dt_invoice == "01-09-2026"
    assert order.dt_fly == "02-09-2026"
    # Bill-to and ship-to share a line: "FRESH FROM SOURCE BV 1OZH".
    assert order.nm_ship == "1OZH"
    # Printed on its own line directly above "Airline:".
    assert order.nm_cargo == "ALIANZA-OYAMBARILLO"
    # The JSON leaves both waybills blank; the printed invoice carries them,
    # the house one wrapped across two lines.
    assert order.tx_awb == "36911504522"
    assert order.tx_hawb == "LA1609000678"
    # Recovered from the warehouse summary — the JSON's nm_location.
    assert order.nm_location == "QUALISA 3"


def test_qualisa_block_merges_across_its_boxes():
    """Qualisa's JSON products carry no gu_product, so parser_delivery treats
    its boxes as single-variety ones and merges each product across them.
    The PDF has to land on the same lines, or one delivery would import two
    different ways depending on which file arrived."""
    order = parse_with_spec(_qualisa_doc([QUALISA_BLOCK_1], 2, 32, 320, "80.00"), QUALISA)

    assert order.nu_boxes == 2
    assert order.nu_stems_total == 320
    assert order.mny_total == 80.0

    # One line per product, as QBE (never the printed "QB3 ALSTRO"), not a per-box code.
    assert {l.nm_box for l in order.lines} == {"QBE"}
    assert len(order.lines) == 15
    assert sum(l.nu_bunches for l in order.lines) == 32
    assert all(l.nu_physical_boxes == 2 for l in order.lines)

    winterfell = next(l for l in order.lines if l.nm_variety == "Winterfell")
    assert winterfell.nu_bunches == 4          # as printed, across both boxes
    assert winterfell.nu_physical_boxes == 2


def test_qualisa_counts_every_box_a_product_appears_in():
    """A product in three boxes across two blocks is one line of quantity 3 —
    what build_stock_entry divides back down per box."""
    from dfg_api_client import build_stock_entry

    doc = _qualisa_doc([QUALISA_BLOCK_1, QUALISA_BLOCK_2], 3, 48, 480, "120.00")
    order = parse_with_spec(doc, QUALISA)

    assert order.nu_boxes == 3
    pierrot80 = [l for l in order.lines
                 if l.nm_variety == "Pierrot" and l.nu_length == 80]
    assert len(pierrot80) == 1
    # 2 bunches over the 2-box block, 1 over the single-box block.
    assert pierrot80[0].nu_bunches == 3
    assert pierrot80[0].nu_physical_boxes == 3

    pierrot80[0].fp_product_id = "TEST"
    entry = build_stock_entry(pierrot80[0])
    assert entry["quantity"] == 3
    assert entry["characteristics"]["number_of_bunches"] == "1"
    assert entry["fust"] == "QBE"


def test_a_layout_that_does_not_merge_gives_each_box_its_own_code():
    """The other half of merge_across_boxes, kept covered for the next
    supplier whose JSON does treat its boxes as mix boxes."""
    import dataclasses

    per_box = dataclasses.replace(QUALISA, merge_across_boxes=False)
    order = parse_with_spec(_qualisa_doc([QUALISA_BLOCK_1], 2, 32, 320, "80.00"), per_box)

    assert sorted({l.nm_box for l in order.lines}) == ["MB1", "MB2"]
    for box in ("MB1", "MB2"):
        in_box = [l for l in order.lines if l.nm_box == box]
        assert len(in_box) == 15                              # 15 products per box
        assert sum(l.nu_bunches for l in in_box) == 16        # 16 bunches per box
        assert all(l.nu_physical_boxes == 1 for l in in_box)
    assert order.nu_stems_total == 320


def test_qualisa_line_shape_matches_the_json():
    order = parse_with_spec(_qualisa_doc([QUALISA_BLOCK_1], 2, 32, 320, "80.00"), QUALISA)
    line = next(l for l in order.lines
                if l.nm_variety == "Dirty Dancing" and l.nu_length == 90)

    assert line.nm_species == "Alstroemeria"      # "ALSTROEMERI A" glued back
    assert line.nm_product == "DIRTY DANCING 90CM 10ST QUCT"
    assert line.nu_stems_bunch == 10
    assert line.mny_rate_stem == 0.25
    assert line.nm_location == "QUALISA 3"


def test_qualisa_merges_a_product_printed_twice_in_one_box():
    """Box 262637 lists CANYON 90 on two rows; the JSON parser merges them into
    one line of two bunches without counting a second box."""
    order = parse_with_spec(_qualisa_doc([QUALISA_BLOCK_2], 1, 16, 160, "40.00"), QUALISA)

    canyon90 = [l for l in order.lines if l.nm_variety == "Canyon" and l.nu_length == 90]
    assert len(canyon90) == 1
    assert canyon90[0].nu_bunches == 2
    assert canyon90[0].nu_physical_boxes == 1
    assert order.nu_boxes == 1


def test_qualisa_refuses_a_block_that_does_not_divide():
    """Three bunches across two boxes is not recoverable — the parser must say
    so rather than round."""
    block = [_q_group("2", "3", "30", "7.50"), _q_row("PIERROT", "80", "3", "30", "7.50")]
    with pytest.raises(PdfChecksumError) as exc:
        parse_with_spec(_qualisa_doc([block], 2, 3, 30, "7.50"), QUALISA)
    assert "does not divide" in str(exc.value)


def test_qualisa_ignores_page_break_fragments():
    """A species column cut across a page leaves an orphan row with no variety."""
    block = list(QUALISA_BLOCK_1) + [_q_row("", "", "", "", "", species="A")]
    order = parse_with_spec(_qualisa_doc([block], 2, 32, 320, "80.00"), QUALISA)
    assert order.nu_stems_total == 320


# ---------------------------------------------------------------------------
# Engine behaviour that is not specific to one supplier
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw, expected", [
    ("ALSTROEMERI A", "ALSTROEMERIA"),       # wrapped mid-word
    ("MINI CARNATION", "MINI CARNATION"),    # genuinely two words
    ("ROSES", "ROSES"),
    ("", ""),
])
def test_unwrap_only_glues_wrap_remainders(raw, expected):
    assert _unwrap(raw) == expected


def test_unknown_layout_is_refused():
    from parser_delivery_pdf import parse_delivery_pdf

    with pytest.raises(PdfParseError):
        parse_delivery_pdf(b"%PDF-1.4 not really a pdf")


def test_every_spec_declares_what_freshportal_needs():
    """A spec missing one of the four fields the DFG payload is built from
    must fail at import time, not at import-a-delivery time."""
    from pdf_layouts import LAYOUTS

    assert LAYOUTS
    for spec in LAYOUTS:
        for required in ("tx_company", "id_invoice", "dt_invoice", "dt_fly"):
            assert required in spec.header, f"{spec.name} is missing {required}"


# ---------------------------------------------------------------------------
# The "boxes" row model (2026-09-28, 45 Ecuador and Colombia suppliers)
# ---------------------------------------------------------------------------
# Rows in the shapes those invoices print, with made-up figures. Every one of
# the 49 real sample invoices is checked with run_samples.py against the
# local sample collection; these pin the engine behaviour they rely on.

import dataclasses  # noqa: E402

from parser_delivery_pdf import (  # noqa: E402
    LETTER_BOXES,
    LayoutSpec,
    _num_comma,
    const,
    date_dmy,
    date_text,
    date_ymd,
    rx,
)

_HEADER = {"tx_company": const("TEST FARM"), "id_invoice": rx(r"INVOICE\s+(\d+)"),
           "dt_invoice": rx(r"DATE\s+(\S+)"), "dt_fly": rx(r"DATE\s+(\S+)")}

# BOX | TB | VARIETY | BUNCHES | ST/BUNCH | LENGTH | STEMS | PRICE | TOTAL, with
# decimal commas and a box number or range in BOX, as the Farm Information
# program prints it at Florequisa and Stampsybox.
_NUMBERED = LayoutSpec(
    name="numbered",
    detect="NUMBERED",
    grid_header=("box", "tb", "variety", "bunches"),
    columns={"number": 0, "box": 1, "variety": 2, "bunches": 3, "stems_bunch": 4,
             "length": 5, "stems": 6, "rate": 7, "subtotal": 8},
    product_re="",
    row_model="boxes",
    header=_HEADER,
    box_map=LETTER_BOXES,
    species="Roses",
    decimal=",",
    totals_re=r"^TOTAL\s+(?P<bunches>\d+)\s+(?P<stems>\d+)\s+(?P<amount>[\d.,]+)\s*$",
    boxes_re=r"TOTAL\s+CAJAS\s+[A-Z]\s*:\s*(\d+)",
)
_NUMBERED_HEADER = ["BOX", "TB", "VARIETY", "BUNCHES", "ST/BUNCH", "LENGTH", "STEMS",
                    "PRICE", "TOTAL"]


def _numbered_doc(rows, bunches, stems, amount, boxes_q=0, boxes_h=0):
    text = (f"INVOICE 0001234\nDATE 21/09/2026\nTOTAL {bunches} {stems} {amount}\n"
            f"TOTAL CAJAS H: {boxes_h}\nTOTAL CAJAS Q: {boxes_q}\n")
    return PdfDoc(text=text, tables=[[_NUMBERED_HEADER, *rows]])


def test_boxes_a_range_is_that_many_identical_boxes():
    doc = _numbered_doc([["03 - 04", "Q", "MOONLIGHT", "8", "25", "60", "200", "0,400", "80,000"]],
                        8, 200, "80,00", boxes_q=2)
    order = parse_with_spec(doc, _NUMBERED)
    [line] = order.lines
    assert (line.nm_box, line.nu_physical_boxes, line.nu_bunches) == ("QBE", 2, 8)
    assert line.mny_rate_stem == 0.4          # "0,400", a decimal comma
    assert order.id_invoice == "0001234"      # leading zeros kept


def test_boxes_a_repeated_number_is_one_mix_box():
    """Stampsybox prints box 23 on every row of its contents."""
    rows = [["23", "H", "MONDIAL", "2", "25", "60", "50", "0,450", "22,500"],
            ["23", "H", "TARA", "1", "25", "60", "25", "0,450", "11,250"],
            ["24", "Q", "EXPLORER", "4", "25", "60", "100", "0,500", "50,000"]]
    order = parse_with_spec(_numbered_doc(rows, 7, 175, "83,75", boxes_q=1, boxes_h=1),
                            _NUMBERED)
    assert order.nu_boxes == 2
    mix = [l for l in order.lines if l.nm_box == "MB1"]
    assert {l.nm_variety for l in mix} == {"Mondial", "Tara"}
    assert {l.nm_box_type for l in mix} == {"HBE"}
    assert next(l for l in order.lines if l.nm_variety == "Explorer").nm_box == "QBE"


def test_boxes_one_variety_at_two_lengths_is_a_mix_box():
    """As two single-product lines, each would count the same box again."""
    rows = [["1", "Q", "POMAROSA", "1", "25", "60", "25", "0,420", "10,500"],
            ["", "Q", "POMAROSA", "3", "25", "70", "75", "0,420", "31,500"]]
    order = parse_with_spec(_numbered_doc(rows, 4, 100, "42,00", boxes_q=1), _NUMBERED)
    assert {l.nm_box for l in order.lines} == {"MB1"}
    assert sum(l.nu_physical_boxes for l in order.lines if l.nm_box == "QBE") == 0


def test_boxes_merge_only_boxes_that_hold_the_same():
    """Six boxes of 10 bunches and six of 12 are two lines, not twelve boxes
    of 11 — FreshPortal takes a line as N boxes of one content."""
    spec = dataclasses.replace(_NUMBERED, columns={**_NUMBERED.columns, "count": 0,
                                                   "number": 9})
    rows = [["6", "H", "MIX COLOR", "60", "25", "60", "1500", "0,360", "540,000", ""],
            ["6", "H", "MIX COLOR", "72", "25", "60", "1800", "0,360", "648,000", ""]]
    order = parse_with_spec(_numbered_doc(rows, 132, 3300, "1188,00", boxes_h=12), spec)
    got = sorted((l.nu_physical_boxes, l.nu_bunches) for l in order.lines)
    assert got == [(6, 60), (6, 72)]


def test_boxes_a_totals_row_is_never_a_product():
    rows = [["1", "Q", "MONDIAL", "4", "25", "60", "100", "0,400", "40,000"],
            ["", "", "TOTAL FCA", "4", "", "", "100", "", "40,000"]]
    order = parse_with_spec(_numbered_doc(rows, 4, 100, "40,00", boxes_q=1), _NUMBERED)
    assert [l.nm_variety for l in order.lines] == ["Mondial"]


def test_boxes_refuse_a_row_whose_figures_disagree():
    """4 bunches of 25 is not 125 stems: a column is read wrongly."""
    rows = [["1", "Q", "MONDIAL", "4", "25", "60", "125", "0,400", "50,000"]]
    with pytest.raises(PdfChecksumError) as exc:
        parse_with_spec(_numbered_doc(rows, 4, 125, "50,00", boxes_q=1), _NUMBERED)
    assert "read wrongly" in str(exc.value)


def test_boxes_refuse_an_invoice_whose_totals_are_not_found():
    rows = [["1", "Q", "MONDIAL", "4", "25", "60", "100", "0,400", "40,000"]]
    doc = PdfDoc(text="INVOICE 1\nDATE 21/09/2026\n", tables=[[_NUMBERED_HEADER, *rows]])
    with pytest.raises(PdfChecksumError) as exc:
        parse_with_spec(doc, _NUMBERED)
    assert "totals" in str(exc.value)


def test_boxes_check_the_printed_box_count():
    rows = [["1", "Q", "MONDIAL", "4", "25", "60", "100", "0,400", "40,000"]]
    with pytest.raises(PdfChecksumError) as exc:
        parse_with_spec(_numbered_doc(rows, 4, 100, "40,00", boxes_q=2), _NUMBERED)
    assert "boxes" in str(exc.value)


def test_boxes_a_rounded_unit_price_gives_way_to_the_row_amount():
    """12 stems printed at 0.08 but charged 1.00."""
    rows = [["1", "Q", "SAMPLES", "2", "6", "50", "12", "0,080", "1,000"]]
    order = parse_with_spec(_numbered_doc(rows, 2, 12, "1,00", boxes_q=1), _NUMBERED)
    assert order.mny_total == 1.0


def test_boxes_boxes_numbered_from_one_are_counted():
    """Where the invoice prints no box count, box numbers 1 to N are N boxes."""
    spec = dataclasses.replace(_NUMBERED, boxes_re="")
    rows = [["1", "Q", "MONDIAL", "4", "25", "60", "100", "0,400", "40,000"],
            ["3", "Q", "MONDIAL", "4", "25", "60", "100", "0,400", "40,000"]]
    with pytest.raises(PdfChecksumError) as exc:     # box 2 is missing
        parse_with_spec(_numbered_doc(rows, 8, 200, "80,00"), spec)
    assert "boxes: invoice says 3, parsed 2" in str(exc.value)


# Text mode: a block line summing up an assorted box, then its contents per
# box, as Rosaprima prints it.
_ASSORTED = LayoutSpec(
    name="assorted",
    detect="ASSORTED",
    grid_header=(),
    columns={},
    lines=(r"^ROS\s+(?:(?P<color>[A-Z]{3})\s+)?(?P<variety>.+?)\s+(?P<length>\d+)\s+x\s+"
           r"(?P<stems_box>\d+)\s+Stem\s+(?P<count>\d+)\s+(?P<box>[A-Z]{2})\s+(?P<stems>\d+)\s+"
           r"\$(?P<rate>[\d.]+)\s+\$(?P<subtotal>[\d,.]+)\s*$",
           r"^ROS\s+(?:(?P<color>[A-Z]{3})\s+)?(?P<variety>.+?)\s+(?P<length>\d+)\s+"
           r"(?P<bunches>\d+)\s+Bun\.\s+(?P<stems_bunch>\d+)\s+St/Bun\s+at\s+\$(?P<rate>[\d.]+)\s*$"),
    product_re="",
    row_model="boxes",
    header=_HEADER,
    block_row_is_summary=True,
    items_per_box=True,
    box_map={"JB": "HBE"},
    stems_bunch=25,
    totals_re=r"Total\s+stems:\s*(?P<stems>\d+)\s+Amount\s+\$(?P<amount>[\d.]+)",
)
_ASSORTED_TEXT = """INVOICE 1136840
DATE 16/09/2026
ROS AST 70 x 50 Stem 2 JB 100 $0.450 $45.00
Vendor:Rosaprima
ROS LAV Purple Crown 70 1 Bun. 25 St/Bun at $0.450
ROS ORG Orange Crush 70 1 Bun. 25 St/Bun at $0.450
ROS RED Freedom 70 x 250 Stem 4 JB 1000 $0.450 $450.00
Vendor:Rosaprima
Total stems: 1100 Amount $495.00"""


def test_text_mode_assorted_box_takes_its_contents():
    order = parse_with_spec(PdfDoc(text=_ASSORTED_TEXT), _ASSORTED)
    mix = sorted((l.nm_box, l.nm_variety, l.nu_bunches) for l in order.lines
                 if l.nm_box.startswith("MB"))
    # Two boxes, each with one bunch of each; "AST" itself is not a product.
    assert mix == [("MB1", "Orange Crush", 1), ("MB1", "Purple Crown", 1),
                   ("MB2", "Orange Crush", 1), ("MB2", "Purple Crown", 1)]
    freedom = next(l for l in order.lines if l.nm_variety == "Freedom")
    # A box of one variety prints stems only: the spec's bunch size applies.
    assert (freedom.nm_box, freedom.nu_physical_boxes, freedom.nu_bunches,
            freedom.nu_stems_bunch) == ("HBE", 4, 40, 25)
    assert order.nu_boxes == 6


def test_length_columns_give_the_length():
    """Tierra Verde prints the bunches under a column per length."""
    spec = LayoutSpec(
        name="by_length", detect="X", grid_header=("# box", "variedad"),
        columns={"number": 0, "box": 1, "variety": 2, "stems_bunch": 3, "stems": 7,
                 "rate": 8, "subtotal": 9},
        length_cols={4: 50, 5: 60, 6: 70}, product_re="", row_model="boxes",
        header=_HEADER, species="Roses",
        totals_re=r"TOT\.\s*STEMS\s+(?P<stems>\d+)\s+TOTAL\s+(?P<amount>[\d.]+)")
    doc = PdfDoc(text="INVOICE 1\nDATE 21/09/2026\nTOT. STEMS 100 TOTAL 90.00",
                 tables=[[["# BOX", "BOX T", "VARIEDAD", "STxB", "50", "60", "70", "TALLOS",
                           "UNIT", "TOTAL"],
                          ["1", "QB", "PLAYA BLANCA", "25", "", "", "4", "100", "0.90", "90.00"]]])
    [line] = parse_with_spec(doc, spec).lines
    assert (line.nu_length, line.nu_bunches) == (70, 4)


def test_split_uneven_boxes_keep_every_stem():
    """272 stems in 3 half boxes: 2 of 91 and 1 of 90."""
    spec = dataclasses.replace(
        _NUMBERED, columns={"count": 0, "box": 1, "variety": 2, "stems": 6, "rate": 7,
                            "subtotal": 8},
        stems_bunch=1, split_uneven=True, boxes_re="",
        totals_re=r"^TOTAL\s+\d+\s+(?P<stems>\d+)\s+(?P<amount>[\d.,]+)\s*$")
    rows = [["3", "H", "STEMS OF ROSE", "", "", "", "272", "0,010", "2,720"]]
    order = parse_with_spec(_numbered_doc(rows, 0, 272, "2,72"), spec)
    assert sorted((l.nu_physical_boxes, l.nu_bunches) for l in order.lines) == [(1, 90), (2, 182)]
    assert order.nu_boxes == 3


def test_box_fill_packs_whole_boxes_and_the_rest_last():
    """272 stems in 3 half boxes, 100 a box: 100, 100 and 72 (user, 2026-09-29)."""
    spec = dataclasses.replace(
        _NUMBERED, columns={"count": 0, "box": 1, "variety": 2, "stems": 6, "rate": 7,
                            "subtotal": 8},
        stems_bunch=1, split_uneven=True, box_fill=100, boxes_re="",
        totals_re=r"^TOTAL\s+\d+\s+(?P<stems>\d+)\s+(?P<amount>[\d.,]+)\s*$")
    rows = [["3", "H", "STEMS OF ROSE", "", "", "", "272", "0,010", "2,720"]]
    order = parse_with_spec(_numbered_doc(rows, 0, 272, "2,72"), spec)
    assert sorted((l.nu_physical_boxes, l.nu_bunches) for l in order.lines) == [(1, 72), (2, 200)]


# BOX | TB | VARIETY | … | TOTAL | LABEL: Agrogana's MIX CALIDO boxes.
_LABELLED = dataclasses.replace(
    _NUMBERED, columns={**_NUMBERED.columns, "label": 9},
    variety_rules=(("label", r"^MIX\s+CALIDO$", "Rosa Ec Bicolor Warm"),))


def test_variety_rule_names_the_product_and_keeps_runs_apart():
    """Boxes labelled MIX CALIDO are one product, whatever variety they list;
    boxes printed apart stay apart, so each run can get its own length."""
    rows = [["01", "H", "HIGH MAGIC", "10", "25", "60", "250", "0,340", "85,000", "MIX CALIDO"],
            ["02", "H", "BOGART", "10", "25", "60", "250", "0,340", "85,000", "MIX CALIDO"],
            ["03", "H", "FREEDOM", "10", "25", "60", "250", "0,340", "85,000", ""],
            ["04", "H", "TYCOON", "10", "25", "60", "250", "0,340", "85,000", "MIX CALIDO"]]
    order = parse_with_spec(_numbered_doc(rows, 40, 1000, "340,00", boxes_h=4), _LABELLED)
    got = sorted((l.nm_variety, l.nu_physical_boxes) for l in order.lines)
    assert got == [("Freedom", 1), ("Rosa Ec Bicolor Warm", 1), ("Rosa Ec Bicolor Warm", 2)]


def test_variety_rule_keeps_grades_apart():
    """MYJ's MIX SELECT and MIX FANCY are one mix product at different
    lengths, even at one price and in boxes side by side."""
    spec = dataclasses.replace(
        _NUMBERED, product_re=r"^(?P<variety>.+?)(?:\s+(?P<qual>FANCY|SELECT))?$",
        variety_rules=(("variety", r"^MIX$", "Dianthus St Mix"),))
    rows = [["1", "Q", "MIX SELECT", "20", "20", "", "400", "0,150", "60,000"],
            ["2", "Q", "MIX FANCY", "20", "20", "", "400", "0,150", "60,000"]]
    order = parse_with_spec(_numbered_doc(rows, 40, 800, "120,00", boxes_q=2), spec)
    assert [(l.nm_variety, l.nu_physical_boxes, l.nu_length) for l in order.lines] == [
        ("Dianthus St Mix", 1, 0), ("Dianthus St Mix", 1, 0)]


def test_boxes_with_no_length_printed_apart_stay_apart():
    """With no length printed, boxes of one product printed apart may be two
    lengths, which the screen sets per line (Florequisa's PINK PIGEON in
    boxes 10-11 and 14-15; user, 2026-09-29). A printed length still merges."""
    rows = [["1", "Q", "PINK PIGEON", "30", "10", "", "300", "0,200", "60,000"],
            ["2", "Q", "PINK PIGEON", "30", "10", "", "300", "0,200", "60,000"],
            ["3", "Q", "THEA", "30", "10", "", "300", "0,200", "60,000"],
            ["4", "Q", "PINK PIGEON", "30", "10", "", "300", "0,200", "60,000"],
            ["5", "Q", "MOONLIGHT", "30", "10", "65", "300", "0,200", "60,000"],
            ["6", "Q", "THEA", "30", "10", "", "300", "0,200", "60,000"],
            ["7", "Q", "MOONLIGHT", "30", "10", "65", "300", "0,200", "60,000"]]
    order = parse_with_spec(_numbered_doc(rows, 210, 2100, "420,00", boxes_q=7), _NUMBERED)
    got = sorted((l.nm_variety, l.nu_physical_boxes) for l in order.lines)
    assert got == [("Moonlight", 2), ("Pink Pigeon", 1), ("Pink Pigeon", 2), ("Thea", 1), ("Thea", 1)]


def test_species_rules_and_mix_names_for_a_farm_printing_no_species():
    """Florequisa prints no species, and its assorted boxes go as one mix
    product each: Minami boxes as Dianthus Mix Minami, the rest as Dianthus
    Sp Mix (user, 2026-09-29)."""
    spec = dataclasses.replace(
        _NUMBERED, species="Dianthus", species_rules=((r"GYPS", "Gypsophila"),),
        mix_names=((r"\bMINAMI\b", "Dianthus Mix Minami"), (r"^Dianthus\b", "Dianthus Sp Mix")))
    rows = [["01", "Q", "FEMENINE MINAMI", "6", "10", "", "60", "0,240", "14,400"],
            ["", "Q", "LEMON MINAMI", "4", "10", "", "40", "0,240", "9,600"],
            ["02", "Q", "AILA", "5", "10", "", "50", "0,200", "10,000"],
            ["", "Q", "PIGEON", "5", "10", "", "50", "0,200", "10,000"],
            ["03", "Q", "GYPSO XLENCE", "10", "25", "80", "250", "0,300", "75,000"]]
    order = parse_with_spec(_numbered_doc(rows, 30, 450, "119,00", boxes_q=3), spec)
    assert {l.nm_variety: l.nm_species for l in order.lines}["Gypso Xlence"] == "Gypsophila"
    combined = {l.nm_variety: (l.fp_product_id, l.mix_boxes) for l in mix_box_lines(order)}
    assert combined == {"Dianthus Mix Minami": ("", ["MB1"]), "Dianthus Sp Mix": ("", ["MB2"])}


def test_a_box_nobody_mapped_goes_as_qbe_and_counts_as_printed():
    """Naranjo's FBG is no box we know: it goes as QBE for the user to change,
    and its size for the fulls check is the printed code's."""
    spec = dataclasses.replace(_NUMBERED, box_fulls={"FBG": 1.0}, fulls_re=r"FULLS\s+([\d.]+)")
    rows = [["1", "FBG", "CLASSY BLUE", "4", "25", "50", "100", "4,000", "400,000"],
            ["2", "FBG", "CLASSY BLUE", "4", "25", "50", "100", "4,000", "400,000"]]

    def doc(fulls):
        text = f"INVOICE 1\nDATE 21/09/2026\nTOTAL 8 200 800,00\nTOTAL CAJAS F: 2\nFULLS {fulls}\n"
        return PdfDoc(text=text, tables=[[_NUMBERED_HEADER, *rows]])

    [line] = parse_with_spec(doc(2), spec).lines
    assert (line.nm_box, line.box_guessed, line.nm_box_printed, line.nu_physical_boxes) == (
        "QBE", True, "FBG", 2)
    with pytest.raises(PdfChecksumError):
        parse_with_spec(doc(0.5), spec)


def test_stem_weight_in_grams_goes_as_kilograms():
    """Utopia's gypsophila: "40 GR" is a stem's weight (user, 2026-09-29)."""
    spec = dataclasses.replace(_NUMBERED, columns={**_NUMBERED.columns, "grams": 9})
    rows = [["1", "H", "OVERTIME", "12", "25", "", "300", "0,340", "102,000", "40"]]
    [line] = parse_with_spec(_numbered_doc(rows, 12, 300, "102,00", boxes_h=1), spec).lines
    assert line.nu_weight == 0.04


@pytest.mark.parametrize("raw, expected", [
    ("0,360", 0.36), ("$ 1285,00", 1285.0), ("4.438,50", 4438.5), ("2,851.200", 2851.2),
    ("4.00", 4.0), ("0.300", 0.3), ("6.540", 6540.0), ("12075", 12075.0), ("", 0.0),
])
def test_decimal_comma_numbers(raw, expected):
    assert _num_comma(raw) == expected


@pytest.mark.parametrize("reader, raw, expected", [
    (date_text, "21-sep-2026", "21-09-2026"),
    (date_text, "16 sept 2026", "16-09-2026"),
    (date_text, "24SEP2025", "24-09-2025"),
    (date_text, "SEPTEMBER 16, 2026", "16-09-2026"),
    (date_text, "Sep 16 2026", "16-09-2026"),
    (date_dmy, "21/9/2026", "21-09-2026"),
    (date_ymd, "2026/09/22", "22-09-2026"),
])
def test_date_readers(reader, raw, expected):
    assert reader(raw) == expected


def test_every_boxes_layout_is_found_by_its_own_name():
    """Farms sharing one invoicing program must not catch each other's files:
    a spec found by the program's wording would read another farm's columns
    with its own map. And the two first layouts, which do detect by wording,
    come after all of them."""
    from pdf_layouts import ALISSROSES as alis, LAYOUTS, QUALISA as qualisa

    names = [s.name for s in LAYOUTS]
    assert len(names) == len(set(names))
    assert LAYOUTS[-2:] == [qualisa, alis]
    for spec in LAYOUTS[:-2]:
        assert spec.row_model == "boxes"
        assert spec.totals_re or spec.totals_marker, spec.name


if __name__ == "__main__":
    # These use pytest fixtures and parametrisation, so pytest runs them —
    # but a machine without pytest must report "could not run" (2) rather
    # than a pass, or the ship gate would wave through untested changes.
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
