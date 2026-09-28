"""A shipment that is already in FreshPortal, as delivery import reads it and
tops it up.

Re-importing a shipment FreshPortal already held ended in 422 "Invoice is
required for batch_id: 116972" from POST /dfg/v1/batch_stock_entry, which was
sent without an invoice_id (user, 2026-09-28). These tests pin what the GET
is read into and what the top-up sends. No request leaves the machine: the
one HTTP call is replaced.

Run either way:
    python -m pytest python/tests/test_dfg_existing_batch.py -q
    python python/tests/test_dfg_existing_batch.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import dfg_api_client  # noqa: E402
from parser_delivery import DeliveryLine  # noqa: E402

CFG = SimpleNamespace(freshportal_url="https://850255.freshportal.nl")

# GET /dfg/v1/batch as it answers since 2026-08-26: flat, not wrapped in
# "batch", with invoice_id and customer.
GET_ANSWER = {
    "id": 116972,
    "number": "00020172",
    "created_at": "2026-09-27T14:02:11.000000Z",
    "invoice_id": 88123,
    "customer": {"customer_id": 12, "customer_code": "HEEM", "name": "A. Heemskerk"},
    "supplier": {"id": 31, "name": "Florecal"},
    "stock_entries": [
        {"manufacturer_id": 57346, "product_number": "ROGPMON ", "fust": "HBE", "quantity": 2,
         "characteristics": {"length": 60, "number_of_bunches": "10", "stems_per_bunch": "25"}},
        {"manufacturer_id": 57346, "product_number": "ROEMIBO", "fust": "QBE", "quantity": 1,
         "characteristics": {"length": None}},
    ],
}


def test_summary_reads_the_flat_get_answer():
    summary = dfg_api_client.batch_summary(CFG, GET_ANSWER)
    assert summary["id"] == 116972
    assert summary["number"] == "00020172"  # leading zeros kept
    assert summary["customer_name"] == "A. Heemskerk"
    assert summary["invoice_id"] == 88123
    assert summary["batch_url"].endswith("/batch_v2/stock_entry/index/BAT_ID/116972/")
    assert summary["invoice_url"].endswith("/invoice/invoice/details/INV_ID/88123/")
    assert summary["stock_entries"] == [
        {"product_number": "ROGPMON", "length": 60, "manufacturer_id": "57346", "fust": "HBE", "quantity": 2},
        {"product_number": "ROEMIBO", "length": 0, "manufacturer_id": "57346", "fust": "QBE", "quantity": 1},
    ]


def test_a_shipment_on_stock_has_no_invoice():
    summary = dfg_api_client.batch_summary(CFG, {**GET_ANSWER, "invoice_id": 0, "customer": None})
    assert summary["invoice_id"] is None
    assert summary["invoice_url"] == ""
    assert summary["customer_name"] == ""


def _line(**kw) -> DeliveryLine:
    base = dict(gu_product="g1", nm_variety="Pink Mondial", nm_species="Rosa", nu_length=60,
                nu_stems_bunch=25, nu_bunches=10, mny_rate_stem=0.3, id_floricode="",
                nm_product="Pink Mondial 60", nm_box="HB", nu_physical_boxes=1,
                fp_product_id="ROGPMON", manufacturer_id="57346")
    base.update(kw)
    return DeliveryLine(**base)


def _capture_post(monkeypatch, answer: dict) -> list[dict]:
    sent: list[dict] = []

    def fake_request(cfg, method, path, **kwargs):
        sent.append({"method": method, "path": path, "json": kwargs.get("json")})
        return SimpleNamespace(status_code=200, json=lambda: answer, text="", raise_for_status=lambda: None)

    monkeypatch.setattr(dfg_api_client, "_request", fake_request)
    return sent


def test_top_up_sends_the_batch_invoice(monkeypatch):
    sent = _capture_post(monkeypatch, {"batch": {"id": 116972, "number": "00020172", "stock_entries": [{}]}, "errors": []})
    result = dfg_api_client.add_stock_entries(CFG, 116972, "31", [_line()], invoice_id=88123)
    assert sent[0]["path"] == "/dfg/v1/batch_stock_entry"
    assert sent[0]["json"]["invoice_id"] == 88123
    assert sent[0]["json"]["batch_id"] == 116972
    assert sent[0]["json"]["supplier_id"] == 31
    # The answer did not name the invoice, so the one sent stands.
    assert result.invoice_id == 88123
    assert result.invoice_url.endswith("/INV_ID/88123/")


def test_top_up_without_a_known_invoice_still_sends_the_key(monkeypatch):
    sent = _capture_post(monkeypatch, {"batch": {"id": 116972}, "errors": []})
    dfg_api_client.add_stock_entries(CFG, 116972, "31", [_line()])
    assert "invoice_id" in sent[0]["json"] and sent[0]["json"]["invoice_id"] is None


if __name__ == "__main__":
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
