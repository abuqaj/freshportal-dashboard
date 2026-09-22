"""Layout specs checked against real invoice content.

The fixtures below are the page text and table rows of two invoices that were
also supplied as JSON, so every expectation is what parser_delivery produces
from the same shipment — the point of the PDF path is to land on the same
DeliveryLines.

These tests start at PdfDoc, i.e. after pdfplumber. They cover what the specs
and the engine do; they do not prove that pdfplumber recovers these exact
cells from the binaries. Put a real PDF through
`python -m pdf_layouts <file.pdf>` when a supplier is first added, and keep
the resulting rows here.

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
from pdf_layouts import ALISSROSES, QUALISA  # noqa: E402


# ---------------------------------------------------------------------------
# Alissroses 5053027 — compared against 5053027.json
# ---------------------------------------------------------------------------

ALIS_TEXT = """Incoterm FOB UIO
Invoice Date 09/01/2026
Invoice Numbers 5053027
Internal PO ID: 121827
Ship Date 09/01/2026
Fly Date 09/02/2026
Amount Due $329.00
CUSTOMER INVOICE 5053027
ALISSROSES SAS
RUC: 1793208810001
Direccion: Barrio Llanos de Alba, Via a Olmedo-Zuleta, Pesillo - ECUADOR
TO BILL CUSTOMER
FRESH FROM SOURCE B.V.
Betula 71 1424 LH
AALSMEER,
NL
SHIP CUSTOMER
1OZH
Betula 71 1424 LH
AALSMEER,
NL
MAWB 369-1150 4522 HAWB LA1609000358
Cargo Agency ECUCARGA Truck Company
Airline Atlas Air Country Destination Netherlands
Number in Fulls 1.7500 DAU-40 055-2026-40-01595762
"""

ALIS_HEADER_ROW = ["#", "BOX", "PRODUCT", "SPECIES", "QTY\nBUNCH", "RATE PER\nBUNCH ($)",
                   "QTY\nSTEMS", "RATE PER\nStem($)", "SUB-TOTAL\nUSD ($)", "LABEL",
                   "VOLUME WEIGHT\nPER BOX(kg)", "REAL WEIGHT\nPER BOX(kg)", "BOX NAME"]


def _alis_row(count, box, product, bunch, rate_bunch, stems, rate_stem, subtotal, volume):
    return [count, box, product, "ROSES", bunch, rate_bunch, stems, rate_stem,
            subtotal, "", volume, "0.00", ""]


ALIS_TABLE = [
    ALIS_HEADER_ROW,
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

ALIS_KV = [["Incoterm", "FOB UIO"], ["Invoice Date", "09/01/2026"],
           ["Invoice Numbers", "5053027"], ["Internal PO ID:", "121827"],
           ["Ship Date", "09/01/2026"], ["Fly Date", "09/02/2026"],
           ["Amount Due", "$329.00"]]


@pytest.fixture
def alis_doc():
    return PdfDoc(text=ALIS_TEXT, tables=[ALIS_KV, ALIS_TABLE])


def test_alissroses_detected(alis_doc):
    assert detect_pdf_layout(alis_doc.text) is ALISSROSES


def test_alissroses_header(alis_doc):
    order = parse_with_spec(alis_doc, ALISSROSES)
    assert order.tx_company == "ALISSROSES SAS"
    assert order.id_invoice == "5053027"
    assert order.id_purchaseorder == "121827"
    # 09/01/2026 MM/DD → 1 September, the same day the JSON's dt_invoice gives.
    assert order.dt_invoice == "01-09-2026"
    assert order.dt_fly == "02-09-2026"
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


def test_alissroses_checksum_catches_a_dropped_row(alis_doc):
    """A template change that hides a row must fail loudly, not import short."""
    doc = PdfDoc(text=ALIS_TEXT, tables=[ALIS_KV, [r for r in ALIS_TABLE if
                                                   "LOLA" not in str(r)]])
    with pytest.raises(PdfChecksumError) as exc:
        parse_with_spec(doc, ALISSROSES)
    assert "stems" in str(exc.value)


# ---------------------------------------------------------------------------
# Qualisa 21022 — compared against the invoice's own JSON export
# ---------------------------------------------------------------------------

QUALISA_TEXT = """QUALITY SERVICE QUALISA S.A.S
1791740262001
Cayambe Juan Montalvo, Primaria S/N y Secundaria
Customer Invoice#: 21022
Bill to (Customer): Ship to (Destinatario):
Carrier:
Airline: Observacion 2:
FRESH FROM SOURCE BV
1430 BB AALSMEER P.O. BOX
1076 AALSMEER
THE NETHERLANDS
1OZH
1430 BB AALSMEER AMSTERDAM
THE NETHERLANDS
ALIANZA-OYAMBARILLO
Atlas Air
Invoice Date
Delivery Date
2026-09-01
2026-09-02
Order Type Boxes Box Type Species Varieties CM Bunch
Open Market 2 QB3 ALSTRO (18*100*45) MIXED BOX MIXED BOX 32 320 0.2500 80.00
ALSTROEMERIA PIERROT N 10ST QUCT 80 2 20 0.2500 5.00
ALSTROEMERIA DIRTY DANCING N 10ST QUCT 90 2 20 0.2500 5.00
20 SubTotal 320 3,200 0.2500 800.00
20 Total 320 3,200 0.2500 800.00
TOTAL: EIGHT HUNDRED AND 0/100 USD
Warehouse Species Stems Price Total
QUALISA 3 ALSTROEMERIA 3,200 0.25 800.00
Total 3,200 800.00
PRODUCT OF ECUADOR
INCOTERMS: FOB
"""

QUALISA_HEADER_ROW = ["Order Type", "Boxes", "Box Type", "Species", "Varieties", "CM",
                      "Bunch\nBox", "Total\nStems", "Unit\nPrice", "Total\nPrice",
                      "Box Label"]

QUALISA_KV = [["Invoice Date", "2026-09-01"], ["Delivery Date", "2026-09-02"],
              ["Term Payment", "60"], ["Seller", "ANA MARIA JARAMILL"],
              ["Amount", "$ 800.00"], ["AWB", "36911504522"],
              ["HAWB", "LA160900067 8"], ["DAE", "05520264001582502"]]


def _q_group(boxes, bunches, stems, amount):
    return ["Open\nMarket", boxes, "QB3 ALSTRO\n(18*100*45)", "MIXED BOX", "MIXED BOX",
            "", bunches, stems, "0.2500", amount, ""]


def _q_row(variety, cm, bunches, stems, amount, species="ALSTROEMERI\nA"):
    return ["", "", "", species, f"{variety} N 10ST QUCT", cm, bunches, stems,
            "0.2500", amount, ""]


# The invoice's first block: two identical boxes of sixteen bunches each.
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


def _qualisa_doc(blocks, totals_line="3 Total 48 480 0.2500 120.00"):
    rows = [QUALISA_HEADER_ROW]
    for block in blocks:
        rows.extend(block)
    text = QUALISA_TEXT.replace("20 Total 320 3,200 0.2500 800.00", totals_line)
    return PdfDoc(text=text, tables=[QUALISA_KV, rows])


def test_qualisa_detected():
    assert detect_pdf_layout(QUALISA_TEXT) is QUALISA


def test_qualisa_header():
    order = parse_with_spec(_qualisa_doc([QUALISA_BLOCK_1, QUALISA_BLOCK_2]), QUALISA)
    assert order.tx_company == "QUALITY SERVICE QUALISA S.A.S"
    assert order.id_invoice == "21022"
    assert order.id_purchaseorder == "21022"
    assert order.dt_invoice == "01-09-2026"
    assert order.dt_fly == "02-09-2026"
    assert order.nm_ship == "1OZH"
    assert order.nm_cargo == "ALIANZA-OYAMBARILLO"
    # The JSON leaves both waybills blank; the printed invoice carries them.
    assert order.tx_awb == "36911504522"
    assert order.tx_hawb == "LA1609000678"
    # Recovered from the warehouse summary — the JSON's nm_location.
    assert order.nm_location == "QUALISA 3"


def test_qualisa_block_expands_into_one_box_each():
    """Two identical boxes printed as one block of 32 bunches become two boxes
    of 16, labelled MB1 and MB2 — what the JSON's boxes 262632 and 262645 are."""
    order = parse_with_spec(_qualisa_doc([QUALISA_BLOCK_1], "2 Total 32 320 0.2500 80.00"),
                            QUALISA)

    assert order.nu_boxes == 2
    assert order.nu_stems_total == 320
    assert order.mny_total == 80.0

    boxes = sorted({l.nm_box for l in order.lines})
    assert boxes == ["MB1", "MB2"]
    for box in boxes:
        in_box = [l for l in order.lines if l.nm_box == box]
        assert len(in_box) == 15                              # 15 products per box
        assert sum(l.nu_bunches for l in in_box) == 16        # 16 bunches per box
        assert all(l.nu_physical_boxes == 1 for l in in_box)

    winterfell = [l for l in order.lines if l.nm_variety == "Winterfell"]
    assert [l.nu_bunches for l in winterfell] == [2, 2]       # 4 printed, 2 per box


def test_qualisa_line_shape_matches_the_json():
    order = parse_with_spec(_qualisa_doc([QUALISA_BLOCK_1], "2 Total 32 320 0.2500 80.00"),
                            QUALISA)
    line = next(l for l in order.lines
                if l.nm_variety == "Dirty Dancing" and l.nu_length == 90)

    assert line.nm_species == "Alstroemeria"      # "ALSTROEMERI\nA" glued back
    assert line.nm_product == "DIRTY DANCING 90CM 10ST QUCT"
    assert line.nu_stems_bunch == 10
    assert line.mny_rate_stem == 0.25
    assert line.nm_location == "QUALISA 3"


def test_qualisa_merges_a_product_printed_twice_in_one_box():
    """Box 262637 lists CANYON 90 on two rows; the JSON parser merges them into
    one line of two bunches without counting a second box."""
    order = parse_with_spec(_qualisa_doc([QUALISA_BLOCK_2], "1 Total 16 160 0.2500 40.00"),
                            QUALISA)

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
        parse_with_spec(_qualisa_doc([block], "2 Total 3 30 0.2500 7.50"), QUALISA)
    assert "does not divide" in str(exc.value)


def test_qualisa_ignores_page_break_fragments():
    """A species column cut across a page leaves an orphan row with no variety."""
    block = list(QUALISA_BLOCK_1) + [_q_row("", "", "", "", "", species="A")]
    order = parse_with_spec(_qualisa_doc([block], "2 Total 32 320 0.2500 80.00"), QUALISA)
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
