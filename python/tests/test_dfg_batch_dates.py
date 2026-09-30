"""The two dates a new shipment goes to FreshPortal with (user, 2026-09-30).

`date` is the day the shipment is entered, as the Netherlands counts days,
not the supplier's invoice date. `delivery_date` is the file's delivery date
or the one set on the screen; a file with none (Florisol's PI246249 prints
"Date : / /") gets tomorrow's at parse time, with a warning, and a payload
still without one is refused. No request leaves the machine.

Run either way:
    python -m pytest python/tests/test_dfg_batch_dates.py -q
    python python/tests/test_dfg_batch_dates.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    import pytest
except ImportError:
    print("pytest is not installed — these tests could not run")
    raise SystemExit(2)

import dfg_api_client  # noqa: E402
from parser_delivery import DeliveryLine, DeliveryOrder  # noqa: E402


def _order(**kw) -> DeliveryOrder:
    line = DeliveryLine(gu_product="g1", nm_variety="Explorer", nm_species="Roses", nu_length=60,
                        nu_stems_bunch=25, nu_bunches=20, mny_rate_stem=0.38, id_floricode="",
                        nm_product="ROSE SPECIAL EXPLORER", nm_box="HB", nu_physical_boxes=2,
                        fp_product_id="ROEEXPL", manufacturer_id="58580")
    base = dict(tx_company="FLORISOL CIA LTDA", nm_location="", id_invoice="PI 246035",
                id_purchaseorder="PI 246035", dt_fly="24-09-2026", dt_invoice="22-09-2026",
                nm_ship="1OZH", nm_cargo="", tx_awb="", tx_hawb="", nu_boxes=2,
                nu_stems_total=500, mny_total=190.0, lines=[line], supplier_fp_id="31")
    base.update(kw)
    return DeliveryOrder(**base)


class _HalfPastMidnightInAmsterdam(datetime):
    """22:30 UTC on 29 September: already the 30th in Amsterdam."""
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 9, 29, 22, 30, tzinfo=timezone.utc).astimezone(tz)


def test_date_is_the_day_of_entry_not_the_invoice_date(monkeypatch):
    monkeypatch.setattr(dfg_api_client, "datetime", _HalfPastMidnightInAmsterdam)
    payload = dfg_api_client.build_batch_payload(_order())
    assert payload["date"] == "2026-09-30"
    assert payload["delivery_date"] == "2026-09-24"


def test_a_file_without_a_delivery_date_gets_tomorrow_and_says_so(monkeypatch):
    monkeypatch.setattr(dfg_api_client, "datetime", _HalfPastMidnightInAmsterdam)
    order = _order(id_invoice="PI 246249", dt_fly="", dt_invoice="")
    dfg_api_client.fill_missing_delivery_date(order)
    # The 30th in Amsterdam, so tomorrow is 1 October.
    assert order.dt_fly == "01-10-2026"
    assert order.warnings == [{"code": "delivery_date_defaulted", "date": "01-10-2026"}]
    assert dfg_api_client.build_batch_payload(order)["delivery_date"] == "2026-10-01"


def test_a_delivery_date_in_the_file_stays():
    order = _order()
    dfg_api_client.fill_missing_delivery_date(order)
    assert order.dt_fly == "24-09-2026"
    assert order.warnings == []


@pytest.mark.parametrize("dt_fly", ["", "  ", "/ /"])
def test_no_delivery_date_sends_nothing(dt_fly):
    with pytest.raises(dfg_api_client.DfgApiError, match="no delivery date"):
        dfg_api_client.build_batch_payload(_order(id_invoice="PI 246249", dt_fly=dt_fly, dt_invoice=""))


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
