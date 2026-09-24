"""Rules of the delivery JSON parser that came from real files.

Delivery files carry prices and customer data, so they stay out of git; the
invoices below are synthetic and keep only the shape that mattered.

- Boxes of the same product from different farms (nm_location) never merge:
  a different farm is a different grower (Pomarosa, 2026-09-24).
- Ceresfarms sends the price per bunch, and can repeat a row's total bunches
  in each of its boxes; only the invoice total tells that apart from separate
  rows of the same product (Ceresfarms invoice 00020172, 2026-09-24).

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

from parser_delivery import parse_delivery_json, resolve_growers  # noqa: E402


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


def test_other_suppliers_keep_price_per_stem():
    [order] = parse_delivery_json(_invoice("QUALISA", [_box("MONDIAL", 10, 0.35)], 87.5))
    assert order.lines[0].mny_rate_stem == 0.35
    assert order.warnings == []


if __name__ == "__main__":
    # A machine without pytest must report "could not run" (2) rather than
    # a pass, or the ship gate would wave through untested changes.
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
