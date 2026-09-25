"""Rules of the delivery JSON parser that came from real files.

Delivery files carry prices and customer data, so they stay out of git; the
invoices below are synthetic and keep only the shape that mattered.

- Boxes of the same product from different farms (nm_location) never merge:
  a different farm is a different grower (Pomarosa, 2026-09-24).
- Ceresfarms sends the price per bunch, and can repeat a row's total bunches
  in each of its boxes; only the invoice total tells that apart from separate
  rows of the same product (Ceresfarms invoice 00020172, 2026-09-24).
- Utopia Farms sends one entry per row of boxes: nu_bunches is the box count,
  nu_stems_bunch the row's stems, tp_box a letter Q (QBE) or E (1/8)
  (Utopia invoice 186970, 2026-09-24).
- FreshPortal receives QBE, HBE, 1/8 or a mix box label, and the invoice
  number exactly as sent.
- A treated product whose name does not contain its nm_variety is a
  different product built on it, e.g. Florecal's tinted "TA RAINBOW MD" with
  nm_variety MONDIAL (invoice 1586318, 2026-09-24). A plain product whose
  name abbreviates its variety ("FREED 50CM" for FREEDOM) keeps the variety.
- Mix boxes can be sent combined: one line per kind of box, RECMIBO for
  roses and ALSMIXF for alstroemeria, in the box's own QBE or HBE, at the
  price that keeps the invoice amount (Florecal invoice 1586318, 2026-09-25).

Run either way:
    python -m pytest python/tests/test_parser_delivery_json.py -q
    python python/tests/test_parser_delivery_json.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from parser_delivery import mix_box_lines, parse_delivery_json, resolve_growers  # noqa: E402


def _box(variety: str, bunches: int, rate: float, *, location: str = "", length: int = 60,
         gu: str = "", tp_box: str = "QB") -> dict:
    return {"tp_box": tp_box, "nm_box": tp_box, "tx_label": "", "nu_box_weight": 0, "products": [{
        "gu_product": gu, "nm_location": location or variety, "id_migros": variety,
        "nm_variety": "", "nm_species": "", "nm_product": "", "id_floricode": "",
        "nu_length": length, "nu_weight": 0, "nu_stems_bunch": 25,
        "nu_bunches": bunches, "mny_rate_stem": rate,
    }]}


def _invoice(company: str, boxes: list[dict], total: float) -> dict:
    return {"invoices": [{
        "tx_company": company, "id_invoice": "1", "id_purchaseorder": "1",
        "dt_fly": "09/24/2026", "dt_invoice": "09/23/2026",
        "nu_boxes": len(boxes), "mny_total": total, "boxes": boxes,
    }]}


def _lines(order) -> dict[tuple[str, str], tuple[int, int]]:
    """(variety, location) -> (physical boxes, bunches per box)."""
    return {
        (l.nm_variety, l.nm_location): (l.nu_physical_boxes, l.nu_bunches // l.nu_physical_boxes)
        for l in order.lines
    }


# ── Farms ──────────────────────────────────────────────────────────────────

def test_same_product_from_two_farms_stays_two_lines():
    boxes = [
        _box("EXPLORER", 8, 0.52, location="TESSA-3", gu="G60"),
        _box("EXPLORER", 8, 0.52, location="TESSA-1", gu="G60"),
        _box("EXPLORER", 8, 0.52, location="TESSA-1", gu="G60"),
    ]
    [order] = parse_delivery_json(_invoice("POMAROSA LIMITED PARTNERSHIP", boxes, 312))
    assert _lines(order) == {
        ("Explorer", "TESSA-3"): (1, 8),
        ("Explorer", "TESSA-1"): (2, 8),
    }


def test_built_in_maps_win_and_a_remembered_grower_fills_the_rest():
    # The built-in maps are fixed (user, 2026-09-24); picking is for what they don't cover.
    boxes = [
        _box("EXPLORER", 4, 0.62, location="TESSA-R1", gu="G70"),
        _box("EXPLORER", 4, 0.62, location="TESSA-X9", gu="G70"),
    ]
    [order] = parse_delivery_json(_invoice("POMAROSA LIMITED PARTNERSHIP", boxes, 124))
    resolve_growers(order, choices={"tessa-r1": "99999", "tessa-x9": "61370"})
    assert {l.nm_location: l.manufacturer_id for l in order.lines} == {
        "TESSA-R1": "57344", "TESSA-X9": "61370",
    }

    [florecal] = parse_delivery_json(_invoice("FLORECAL SA", [_box("MONDIAL", 4, 0.30, location="FLORECAL")], 30))
    resolve_growers(florecal, "Florecal", choices={"florecal": "99999"})
    assert florecal.lines[0].manufacturer_id == "57346"


def test_remembered_grower_for_a_supplier_that_sends_no_farm():
    box = _box("MONDIAL", 4, 0.30)
    box["products"][0]["nm_location"] = ""
    [order] = parse_delivery_json(_invoice("A FARM NOBODY MAPPED", [box], 30))
    resolve_growers(order)
    assert order.lines[0].manufacturer_id == ""
    resolve_growers(order, choices={"": "12345"})
    assert order.lines[0].manufacturer_id == "12345"


def test_farm_split_gives_each_line_its_own_grower():
    boxes = [
        _box("EXPLORER", 4, 0.62, location="TESSA-R1", gu="G70"),
        _box("EXPLORER", 4, 0.62, location="TESSA-E1", gu="G70"),
    ]
    [order] = parse_delivery_json(_invoice("POMAROSA LIMITED PARTNERSHIP", boxes, 124))
    resolve_growers(order)
    assert {l.nm_location: l.manufacturer_id for l in order.lines} == {
        "TESSA-R1": "57344", "TESSA-E1": "57396",
    }


# ── Product names ──────────────────────────────────────────────────────────

def test_tinted_product_is_named_by_its_product_not_its_base_variety():
    tinted = _box("MONDIAL", 4, 0.70, gu="TARMD60", tp_box="QB")
    tinted["products"][0].update(nm_product="TA RAINBOW MD 60CM X2 25ST FL", nm_species="TINTED ROSES")
    plain = _box("MONDIAL", 4, 0.30, gu="MD60", tp_box="QB")
    plain["products"][0]["nm_product"] = "MONDIAL 60CM X2 25ST FL"
    [order] = parse_delivery_json(_invoice("FLORECAL SA", [tinted, plain], 100))
    assert {(l.nm_variety, l.mny_rate_stem) for l in order.lines} == {
        ("Ta Rainbow Md", 0.70), ("Mondial", 0.30),
    }


def test_abbreviated_product_name_keeps_its_variety():
    boxes = []
    for variety, product, gu in [
        ("FREEDOM", "FREED 50CM", "F50"),
        ("EXPLORER", "R-EXP-60", "E60"),
        ("PINK FLOYD", "PINK-FLOYD 60CM", "P60"),
    ]:
        box = _box(variety, 4, 0.30, gu=gu)
        box["products"][0].update(nm_product=product, nm_species="ROSES")
        boxes.append(box)
    [order] = parse_delivery_json(_invoice("ELITE FLOWER", boxes, 90))
    assert sorted(l.nm_variety for l in order.lines) == ["Explorer", "Freedom", "Pink Floyd"]


# ── Ceresfarms ─────────────────────────────────────────────────────────────

CERES = "CERESFARMS CIA. LTDA."


def test_ceres_price_per_bunch_becomes_price_per_stem():
    [order] = parse_delivery_json(_invoice(CERES, [_box("SWAN", 5, 8.5)], 42.5))
    [line] = order.lines
    assert line.mny_rate_stem == 0.34
    assert order.mny_total == 42.5
    assert order.warnings == []


def test_ceres_repeated_row_is_split_when_invoice_total_says_so():
    # Magic Times: one row of 10 bunches in 2 boxes, written as 10 in each.
    # Pink X-Pression: two rows of 5, one per box, billed for both.
    boxes = [
        _box("MAGIC TIMES", 10, 6.25, length=40),
        _box("MAGIC TIMES", 10, 6.25, length=40),
        _box("PINK X-PRESSION", 5, 8.5, length=50),
        _box("PINK X-PRESSION", 5, 8.5, length=50),
    ]
    [order] = parse_delivery_json(_invoice(CERES, boxes, 62.5 + 85))
    assert _lines(order) == {
        ("Magic Times", "MAGIC TIMES"): (2, 5),
        ("Pink X-Pression", "PINK X-PRESSION"): (2, 5),
    }
    assert order.mny_total == 147.5
    assert order.warnings == [{
        "code": "bunches_split_by_invoice_total", "variety": "Magic Times", "length": 40,
        "boxes": 2, "bunches_in_file": 10, "bunches_per_box": 5,
    }]


def test_ceres_boxes_stay_as_sent_when_invoice_total_agrees():
    boxes = [_box("MAGIC TIMES", 10, 6.25, length=40), _box("MAGIC TIMES", 10, 6.25, length=40)]
    [order] = parse_delivery_json(_invoice(CERES, boxes, 125))
    assert _lines(order) == {("Magic Times", "MAGIC TIMES"): (2, 10)}
    assert order.warnings == []


@pytest.mark.parametrize("total", [
    100,    # no set of repeated boxes explains the difference
    187.5,  # either run alone explains it: no guessing
])
def test_ceres_unexplained_total_changes_nothing_and_warns(total):
    boxes = [
        _box("MAGIC TIMES", 10, 6.25, length=40),
        _box("MAGIC TIMES", 10, 6.25, length=40),
        _box("SWEETNESS", 10, 6.25, length=40),
        _box("SWEETNESS", 10, 6.25, length=40),
    ]
    [order] = parse_delivery_json(_invoice(CERES, boxes, total))
    assert _lines(order) == {
        ("Magic Times", "MAGIC TIMES"): (2, 10),
        ("Sweetness", "SWEETNESS"): (2, 10),
    }
    assert order.warnings == [{"code": "invoice_total_mismatch", "invoice_total": total, "file_total": 250.0}]


# ── Utopia Farms ───────────────────────────────────────────────────────────

UTOPIA = "UTOPIA FARMS UTF S.A.S"


def _utopia_row(tp_box: str, boxes: int, stems: int, rate: float, length: int) -> dict:
    """One Utopia box entry: nu_bunches = boxes in the row, nu_stems_bunch = its stems."""
    return {"tp_box": tp_box, "nm_box": "ATC 39X10X6 ES", "tx_label": "COL", "nu_box_weight": "6.24",
            "products": [{
                "gu_product": "", "nm_location": "San Pablo", "id_migros": "", "id_floricode": "",
                "nm_product": f"RICE FLOW. VICTORIA WHITE 10ST {length}CM 300ST (ST 2093759-2)",
                "nm_species": f"{length} CM", "nm_variety": "VICTORIA WHITE", "nu_length": "",
                "nu_weight": "", "nu_stems_bunch": str(stems), "nu_bunches": str(boxes),
                "mny_rate_stem": str(rate),
            }]}


def test_utopia_rows_become_boxes_of_their_stems():
    data = _invoice(UTOPIA, [_utopia_row("E", 1, 300, 0.40, 50), _utopia_row("Q", 9, 2700, 0.43, 60)], 1281)
    data["invoices"][0]["nu_boxes"] = "10"
    [order] = parse_delivery_json(data)
    got = {(l.nm_box, l.nu_length): (l.nu_physical_boxes, l.nu_bunches // l.nu_physical_boxes,
                                     l.nu_stems_bunch, l.nu_stems_total) for l in order.lines}
    assert got == {("1/8", 50): (1, 30, 10, 300), ("QBE", 60): (9, 30, 10, 2700)}
    assert order.mny_total == 1281
    assert order.warnings == []
    assert {l.nm_species for l in order.lines} == {""}


def test_utopia_row_that_does_not_divide_is_left_and_flagged():
    data = _invoice(UTOPIA, [_utopia_row("Q", 3, 1000, 0.43, 60)], 430)
    data["invoices"][0]["nu_boxes"] = "3"
    [order] = parse_delivery_json(data)
    [line] = order.lines
    assert (line.nm_box, line.nu_physical_boxes) == ("QBE", 1)
    assert {w["code"] for w in order.warnings} == {"invoice_total_mismatch", "box_count_mismatch"}


# ── Packaging and invoice number ───────────────────────────────────────────

@pytest.mark.parametrize("sent, expected", [
    ("QB ROSALEDA", "QBE"), ("QB3 ALSTRO", "QBE"), ("QB 5", "QBE"), ("QB", "QBE"),
    ("HB XL 1", "HBE"), ("HB", "HBE"), ("HBE", "HBE"),
])
def test_box_codes_reach_freshportal_as_qbe_or_hbe(sent, expected):
    box = _box("TIBET", 4, 0.5)
    box["tp_box"], box["nm_box"] = "", sent
    [order] = parse_delivery_json(_invoice("FLORICOLA LA ROSALEDA S.A.", [box], 50))
    assert order.lines[0].nm_box == expected


def test_mix_box_keeps_its_mb_label():
    box = _box("TIBET", 2, 0.5, gu="G1")
    box["products"].append(_box("OHARA", 2, 0.8, gu="G2")["products"][0])
    [order] = parse_delivery_json(_invoice("QUALISA", [box], 65))
    assert {l.nm_box for l in order.lines} == {"MB1"}


@pytest.mark.parametrize("number", ["00020172", "0021803", "21803"])
def test_invoice_number_is_kept_exactly(number):
    data = _invoice(CERES, [_box("SWAN", 5, 8.5)], 42.5)
    data["invoices"][0]["id_invoice"] = number
    assert parse_delivery_json(data)[0].id_invoice == number


def test_text_invoice_keeps_leading_zeros():
    text = "FIORENTINA FLOWERS\nINVOICE # 000123\nDate : 23/09/2026\n"
    [order] = parse_delivery_json({text: None})
    assert order.id_invoice == "000123"


def test_other_suppliers_keep_price_per_stem():
    [order] = parse_delivery_json(_invoice("QUALISA", [_box("MONDIAL", 10, 0.35)], 87.5))
    assert order.lines[0].mny_rate_stem == 0.35
    assert order.warnings == []


# ── Mix boxes sent combined ────────────────────────────────────────────────

def _mix(tp_box: str, *products: tuple[str, int, float], length: int = 60,
         species: str = "ROSES", location: str = "FLORECAL") -> dict:
    """One mix box of (variety, bunches, rate) products, all from one farm."""
    box = _box(*products[0], gu=products[0][0], tp_box=tp_box, length=length, location=location)
    for variety, bunches, rate in products[1:]:
        box["products"].append(_box(variety, bunches, rate, gu=variety, length=length,
                                    location=location)["products"][0])
    for p in box["products"]:
        p["nm_species"] = species
    return box


def _combined(boxes: list[dict], total: float):
    [order] = parse_delivery_json(_invoice("FLORECAL SA", boxes, total))
    resolve_growers(order, "Florecal")
    return order, mix_box_lines(order)


def test_mix_boxes_that_come_out_the_same_are_one_line():
    # Florecal 1586318: 60cm mix boxes of four different varieties each.
    order, mixed = _combined([
        _mix("QB", ("VIOLET HILL", 1, 0.30), ("MONDIAL", 1, 0.30), ("IMPACT", 1, 0.30), ("V.I.PINK", 1, 0.30)),
        _mix("QB", ("STAR PLATINUM", 1, 0.30), ("NINA", 1, 0.30), ("MANDALA", 1, 0.30), ("MONDIAL", 1, 0.30)),
        _mix("QB", ("ALOHA", 1, 0.20), ("HIGHLIGHT", 1, 0.20), ("SHIMMER", 1, 0.20), ("LEMONADE", 1, 0.20), length=40),
        _box("EXPLORER", 4, 0.34, gu="E60", location="FLORECAL"),
    ], 114)
    got = {(l.nm_variety, l.fp_product_id, l.nm_box, l.nu_length):
           (l.nu_physical_boxes, l.nu_bunches // l.nu_physical_boxes, l.nu_stems_bunch, l.mny_rate_stem, l.mix_boxes)
           for l in mixed}
    assert got == {
        ("Mix Roses", "RECMIBO", "QBE", 40): (1, 4, 25, 0.20, ["MB3"]),
        ("Mix Roses", "RECMIBO", "QBE", 60): (2, 4, 25, 0.30, ["MB1", "MB2"]),
    }
    sixty = next(l for l in mixed if l.nu_length == 60)
    assert {c["nm_variety"]: c["nu_bunches"] for c in sixty.mix_content}["Mondial"] == 2
    assert sixty.manufacturer_id == "57346"
    plain = [l for l in order.lines if not l.nm_box.startswith("MB")]
    assert round(sum(l.mny_total for l in plain + mixed), 2) == order.mny_total == 114


def test_mix_box_goes_at_the_price_that_keeps_its_amount():
    _, [line] = _combined([_mix("QB", ("MONDIAL", 2, 0.30), ("EXPLORER", 2, 0.34))], 32)
    assert (line.mny_rate_stem, line.nu_stems_total, line.mny_total) == (0.32, 100, 32)


@pytest.mark.parametrize("species, product, name", [
    ("ROSES", "RECMIBO", "Mix Roses"),
    ("ALSTROEMERIA", "ALSMIXF", "Mix Alstroemeria"),
    ("CARNATION", "", "Mix Carnation"),
])
def test_mix_box_product_follows_what_it_holds(species, product, name):
    _, [line] = _combined([_mix("HB XL", ("A", 2, 0.2), ("B", 2, 0.2), species=species)], 20)
    assert (line.fp_product_id, line.nm_variety, line.nm_box) == (product, name, "HBE")
    assert line.match_method == ("mix_box" if product else "none")


def test_mix_box_one_line_cannot_hold_keeps_its_varieties():
    box = _mix("QB", ("MONDIAL", 2, 0.30), ("EXPLORER", 2, 0.30))
    box["products"][1]["nu_length"] = 50
    order, mixed = _combined([box], 30)
    assert mixed == [l for l in order.lines if l.nm_box == "MB1"]
    assert len(mixed) == 2


if __name__ == "__main__":
    # A machine without pytest must report "could not run" (2) rather than
    # a pass, or the ship gate would wave through untested changes.
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
