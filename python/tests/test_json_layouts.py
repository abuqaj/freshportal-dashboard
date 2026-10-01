"""Temporary layouts for delivery JSON no parser reads (2026-10-01).

json_layout reads a file with a layout given as data: paths to the
invoices, boxes and products, a reader per field, and the file's own totals
as the check. read_delivery_json tries the parsers in code first, then the
stored layouts, and otherwise says the file is unknown, for it to be saved
for IT and offered a temporary layout, like an unreadable PDF.

None of it needs the network or a database here: stored layouts are handed
in by the test.

Run either way:
    python -m pytest python/tests/test_json_layouts.py -q
    python python/tests/test_json_layouts.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import delivery_parse_log  # noqa: E402
import json_layout as jl  # noqa: E402
import pdf_layout_store as store  # noqa: E402
from parser_delivery import parse_delivery_json  # noqa: E402
from test_parser_delivery_json import _box, _invoice, _mix  # noqa: E402

ELITE, FACTURA, ETIQUETA = jl.EXAMPLES


def _lines(orders) -> list[tuple]:
    return sorted(
        (l.nm_variety, l.nm_species, l.nm_box, l.nm_box_type, l.nu_length, l.nu_physical_boxes,
         l.nu_bunches, l.nu_stems_bunch, round(l.mny_rate_stem, 6), l.nm_location)
        for o in orders for l in o.lines)


# A supplier no parser knows: its own Spanish field names, the price per
# bunch, and each row standing for several identical boxes.
NEW_FILE = {
    "proveedor": {"nombre": "FLORES NUEVAS S.A.", "ruc": "1790011122001"},
    "factura": {
        "numero": "000981",
        "fecha": "2026-09-30",
        "vuelo": "01/10/2026",
        "guia": "729-12345675",
        "total_cajas": 4,
        "total_tallos": 325,
        "total": "117,50",
        "filas": [
            {"caja": "QB", "cajas": 3, "variedad": "EXPLORER 60CM", "ramos": 9, "tallos_ramo": 25,
             "precio_ramo": "7,50"},
            {"caja": "HB", "cajas": 1, "variedad": "MONDIAL 50CM", "ramos": 4, "tallos_ramo": 25,
             "precio_ramo": "12,50"},
        ],
    },
}

NEW_LAYOUT = {
    "name": "anything",
    "detect": r"1790011122001",
    "invoices": "factura",
    "boxes": "filas",
    "header": {
        "tx_company": {"const": "FLORES NUEVAS S.A."},
        "id_invoice": {"path": "numero"},
        "dt_invoice": {"path": "fecha", "transform": "date_iso"},
        "dt_fly": {"path": "vuelo", "transform": "date_dmy"},
        "tx_awb": {"path": "guia"},
    },
    "box": {"tp_box": {"path": "caja"}, "count": {"path": "cajas"}},
    "product": {
        "nm_variety": {"path": "variedad", "regex": r"^(.+?)\s+\d+\s*CM"},
        "nm_species": {"const": "Roses"},
        "nu_length": {"path": "variedad", "regex": r"(\d+)\s*CM"},
        "nm_product": {"path": "variedad"},
        "nu_stems_bunch": {"path": "tallos_ramo"},
        "nu_bunches": {"path": "ramos"},
        "mny_rate_stem": {"path": "precio_ramo"},
    },
    "totals": {"boxes": {"path": "total_cajas"}, "stems": {"path": "total_tallos"},
               "amount": {"path": "total"}},
    "price": "bunch",
    "bunches": "per_entry",
    "decimal": ",",
}


# ---------------------------------------------------------------------------
# The formats in code, as layouts, read like their parsers
# ---------------------------------------------------------------------------

def test_the_elite_format_as_a_layout_reads_like_its_parser():
    boxes = [
        _box("FREEDOM", 10, 0.36, gu="G1", tp_box="HB"),
        _box("FREEDOM", 10, 0.36, gu="G1", tp_box="HB"),
        _box("EXPLORER", 8, 0.52, location="TESSA-3", gu="G60"),
        _mix("QB", ("MONDIAL", 2, 0.30), ("NINA", 2, 0.30)),
    ]
    data = _invoice("ECOROSES S.A.", boxes, 0)
    [code] = parse_delivery_json(data)
    data["invoices"][0]["mny_total"] = code.mny_total
    [drafted] = jl.parse_with_layout(data, jl.spec_from_dict(ELITE))
    assert _lines([drafted]) == _lines([code])
    for field in ("tx_company", "id_invoice", "dt_fly", "dt_invoice", "nu_boxes", "mny_total"):
        assert getattr(drafted, field) == getattr(code, field), field


def test_the_factura_format_as_a_layout_reads_like_its_parser():
    def detalle(product: str, ramos: int) -> dict:
        return {"code_caja": "QB", "productos": [{
            "id_producto": product, "nombre_variedad": product, "tipo_producto": "ROSES",
            "grado": 60, "tallos_x_ramo": 25, "ramos": ramos, "precio": 0.4, "variedad": product}]}
    data = {"id_factura": "0001", "empresa": "FLORICOLA BLOOMINGACRES S.A",
            "fecha": "2026-09-29T00:00:00", "fecha_embarque": "2026-09-30", "cajas": 3,
            "detalles": [detalle("EXPLORER", 4), detalle("EXPLORER", 4), detalle("FREEDOM", 5)]}
    code = parse_delivery_json(data)
    drafted = jl.parse_with_layout(data, jl.spec_from_dict(FACTURA))
    assert _lines(drafted) == _lines(code)
    assert (drafted[0].dt_fly, drafted[0].dt_invoice) == (code[0].dt_fly, code[0].dt_invoice)


def test_the_etiqueta_format_as_a_layout_counts_its_boxes_like_its_parser():
    def row(bunches: int, boxes: int = 1) -> dict:
        return {"PRODUCTO": "ROSE MONDIAL", "NomVariedad": "MONDIAL", "NomColor": "", "BOX": "HB",
                "Bch/box": bunches, "st/Bch": 25, "Price": 0.35, "Boxes": boxes}
    data = {"invoice": "7", "fecha": "2026-09-30", "cajas": 5,
            "detalle": [row(10), row(12), row(10, boxes=3)]}
    [code] = parse_delivery_json(data)
    [drafted] = jl.parse_with_layout(data, jl.spec_from_dict(ETIQUETA))
    per_box = sorted((l.nu_physical_boxes, l.nu_bunches // l.nu_physical_boxes) for l in drafted.lines)
    assert per_box == sorted((l.nu_physical_boxes, l.nu_bunches // l.nu_physical_boxes)
                             for l in code.lines) == [(1, 12), (4, 10)]
    assert drafted.tx_company == "EXAMPLE FARM S.A."


# ---------------------------------------------------------------------------
# What a layout can say
# ---------------------------------------------------------------------------

def test_a_new_format_is_read_by_its_layout():
    [order] = jl.parse_with_layout(NEW_FILE, jl.spec_from_dict(NEW_LAYOUT))
    assert (order.tx_company, order.id_invoice, order.dt_invoice, order.dt_fly, order.tx_awb) == (
        "FLORES NUEVAS S.A.", "000981", "30-09-2026", "01-10-2026", "729-12345675")
    # 9 bunches over 3 boxes at 7,50 a bunch of 25: 0.30 a stem; 1 box of 4 at 0.50.
    got = {(l.nm_variety, l.nm_box): (l.nu_physical_boxes, l.nu_bunches, l.nu_length, l.mny_rate_stem)
           for l in order.lines}
    assert got == {("Explorer", "QBE"): (3, 9, 60, 0.3), ("Mondial", "HBE"): (1, 4, 50, 0.5)}
    assert (order.nu_boxes, order.nu_stems_total, order.mny_total) == (4, 325, 117.5)


def test_a_price_per_row_is_the_rows_amount_over_its_stems():
    data = {"inv": {"no": "1", "boxes": 2, "amount": 100, "rows": [
        {"box": "QB", "n": 2, "variety": "FREEDOM", "bunches": 4, "stems": 25, "row_total": 100}]}}
    layout = {**NEW_LAYOUT, "detect": "FREEDOM", "invoices": "inv", "boxes": "rows",
              "price": "line", "bunches": "per_box", "decimal": ".",
              "header": {"tx_company": {"const": "X"}, "id_invoice": {"path": "no"}},
              "box": {"tp_box": {"path": "box"}, "count": {"path": "n"}},
              "product": {"nm_variety": {"path": "variety"}, "nu_bunches": {"path": "bunches"},
                          "nu_stems_bunch": {"path": "stems"}, "mny_rate_stem": {"path": "row_total"}},
              "totals": {"boxes": {"path": "boxes"}, "amount": {"path": "amount"}}}
    [order] = jl.parse_with_layout(data, jl.spec_from_dict(layout))
    [line] = order.lines
    # 2 boxes of 4 bunches of 25 = 200 stems for 100.
    assert (line.nu_physical_boxes, line.nu_bunches, line.mny_rate_stem) == (2, 8, 0.5)


def test_a_box_code_is_mapped_only_as_the_layout_says():
    layout = {**NEW_LAYOUT, "box_map": {"q": "1/8"}}
    data = {**NEW_FILE, "factura": {**NEW_FILE["factura"], "filas": [
        {**NEW_FILE["factura"]["filas"][0], "caja": "Q"}, NEW_FILE["factura"]["filas"][1]]}}
    [order] = jl.parse_with_layout(data, jl.spec_from_dict(layout))
    assert sorted(l.nm_box for l in order.lines) == ["1/8", "HBE"]


def test_lines_that_disagree_with_the_files_totals_are_refused():
    data = {**NEW_FILE, "factura": {**NEW_FILE["factura"], "total_tallos": 1100}}
    with pytest.raises(jl.JsonReadError) as exc:
        jl.parse_with_layout(data, jl.spec_from_dict(NEW_LAYOUT))
    assert "stems: file says 1100, read 325" in str(exc.value)


def test_a_file_without_the_totals_its_layout_points_at_is_refused():
    factura = {k: v for k, v in NEW_FILE["factura"].items()
               if k not in ("total_cajas", "total_tallos", "total")}
    with pytest.raises(jl.JsonReadError) as exc:
        jl.parse_with_layout({**NEW_FILE, "factura": factura}, jl.spec_from_dict(NEW_LAYOUT))
    assert "none of the totals" in str(exc.value)


@pytest.mark.parametrize("change, message", [
    ({"exec": "import os"}, "unknown fields"),
    ({"totals": {}}, "at least one total"),
    ({"header": {"tx_company": {"path": "x", "transform": "eval"}}}, "unknown transform"),
    ({"detect": "("}, "not a valid regex"),
    ({"header": {"tx_company": {"python": "x"}}}, "a reader is one of"),
    ({"header": {"tx_company": {"path": "x", "from": "product"}}}, "from must be one of"),
    ({"product": {"nm_variety": {"path": "v"}}}, "missing readers"),
    ({"price": "box"}, "price"),
    ({"boxes": ""}, "cannot be empty"),
])
def test_a_layout_takes_only_what_the_engine_knows(change, message):
    with pytest.raises(jl.JsonLayoutError) as exc:
        jl.spec_from_dict({**NEW_LAYOUT, **change})
    assert message in str(exc.value)


def test_trying_a_wrong_layout_says_what_its_paths_found():
    result = jl.try_layout(NEW_FILE, {**NEW_LAYOUT, "boxes": "lineas"})
    assert not result["ok"] and "no boxes at lineas" in result["error"]
    assert result["found"] == {"invoices": 1, "boxes_in_first_invoice": 0}
    good = jl.try_layout(NEW_FILE, NEW_LAYOUT)
    assert good["ok"] and good["printed_totals_checked"] == {"boxes": 4, "stems": 325, "amount": 117.5}
    assert good["header"]["id_invoice"] == "000981" and good["line_count"] == 2


def test_an_outer_array_is_unwrapped():
    assert jl.unwrap([{"invoices": [1]}, {"invoices": [2], "x": 3}]) == {"invoices": [1, 2], "x": 3}
    assert jl.unwrap({"a": 1}) == {"a": 1}


# ---------------------------------------------------------------------------
# Delivery import's way in: code first, then stored layouts, else unknown
# ---------------------------------------------------------------------------

def test_a_known_format_is_read_by_its_parser_alone(monkeypatch):
    monkeypatch.setattr(store, "parse_json_with_stored",
                        lambda data: pytest.fail("a stored layout was asked"))
    [order] = jl.read_delivery_json(_invoice("QUALISA", [_box("MONDIAL", 10, 0.35)], 87.5))
    assert order.lines[0].nm_variety == "Mondial"


def test_an_unknown_json_is_refused_as_unknown_without_a_database(monkeypatch):
    monkeypatch.setattr(store, "reading_layouts", lambda *a: (_ for _ in ()).throw(RuntimeError("no db")))
    with pytest.raises(jl.JsonUnknownLayoutError) as exc:
        jl.read_delivery_json(NEW_FILE)
    assert exc.value.read_error is None


def test_a_known_format_that_reads_as_nothing_goes_to_it_with_the_reason(monkeypatch):
    """A new supplier with an "invoices" key and fields of its own names
    reads as empty lines; that is a file no parser reads."""
    monkeypatch.setattr(store, "parse_json_with_stored", lambda data: None)
    data = {"invoices": [{"tx_company": "NEW FARM", "id_invoice": "1",
                          "boxes": [{"caja": "QB", "products": [{"variedad": "X", "tallos": 25}]}]}]}
    with pytest.raises(jl.JsonUnknownLayoutError) as exc:
        jl.read_delivery_json(data)
    assert "without a single stem" in exc.value.read_error


def test_a_stored_layout_reads_what_no_parser_does(monkeypatch):
    stored = [{"id": 5, "status": store.PROVISIONAL, "supplier": "FLORES NUEVAS S.A.",
               "spec": NEW_LAYOUT, "assumptions": ["Species Roses."]},
              {"id": 4, "status": store.VERIFIED, "supplier": "OTHER", "spec": {**NEW_LAYOUT,
               "detect": "SOMEONE ELSE"}, "assumptions": []}]
    asked = []
    monkeypatch.setattr(store, "reading_layouts", lambda kind="pdf": (asked.append(kind), stored)[1])
    [order] = jl.read_delivery_json(NEW_FILE)
    assert asked == ["json"]
    assert order.nu_stems_total == 325
    [warning] = order.warnings
    assert warning["code"] == "provisional_pdf_layout" and warning["layout_id"] == 5


def test_a_file_name_tells_a_txt_from_a_json():
    assert [delivery_parse_log.kind_of(n) for n in ("a.TXT", "b.json", "c.pdf", "", "d")] == [
        "txt", "json", "pdf", "json", "json"]


if __name__ == "__main__":
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
