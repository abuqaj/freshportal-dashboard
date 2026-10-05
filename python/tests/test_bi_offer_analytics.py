"""The offer views of the Analysis Tool: what was online, at what price, and
what came of it (db.py, "overview and the webshop's offer").

One small week, small enough to count by hand. Product 119722, supplier 93,
everything listed from 25 September, recorded from that day:

  lot A 549595  60 cm  0,725 €  500 stems  25–27.09
        sold 200 stems on 25.09 08:00 and 300 on 26.09 09:00, both to
        customer 12 at 0,734 (the offer price plus 0,009 transport);
        empty on 26.09 09:00 — 28 hours after buying opened at 05:00 on 25.09
  lot B 700001  70 cm  0,900 €  200 stems  25–27.09
        100 stems to customer 12 at 0,850 (a 5,9-cent discount) and 100 to
        customer 14 at 1,000, both on 25.09; empty at 11:00 — 6 hours
  lot C 700002  60 cm  0,700 €  300 stems  25–30.09, nothing sold

so sell-through is 700 of 1 000 stems (70%): 60 cm 500 of 800, 70 cm all;
customer 12 bought 600 stems, 500 of them at the offer price.

The analytics swallow database errors and return an empty result, so the
fixture also fails on any warning db logs: a broken query must not pass as
"no data". The pure fit test runs anywhere; the rest need Postgres —
point BI_TEST_POSTGRES_URL (or KB_TEST_POSTGRES_URL) at one. It works in a
throwaway schema.
    python -m pytest python/tests/test_bi_offer_analytics.py -q
"""
from __future__ import annotations

import contextlib
import logging
import os
import sys
import uuid
from datetime import datetime

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from bi_sync import OZH_GROUP_PRICE_COLUMN, offer_state_from_row, plan_offer_state_changes  # noqa: E402
from db import log_log_fit  # noqa: E402

DB_URL = os.getenv("BI_TEST_POSTGRES_URL") or os.getenv("KB_TEST_POSTGRES_URL") or ""
PRODUCT = "119722"
WEEK = ("2026-09-20", "2026-09-30")


# --- the elasticity fit (runs anywhere) ---------------------------------------

def test_log_log_fit_returns_the_exponent_of_a_power_law():
    # stems = 1000 · price^-2: a 1% dearer price sells 2% fewer stems
    points = [(p, 1000 * p ** -2) for p in (0.5, 0.6, 0.7, 0.8, 0.9)]
    fit = log_log_fit(points)
    assert fit["elasticity"] == pytest.approx(-2.0)
    assert fit["r2"] == pytest.approx(1.0)


def test_log_log_fit_needs_three_points_and_a_moving_price():
    assert log_log_fit([(0.5, 100), (0.6, 90)]) is None
    assert log_log_fit([(0.5, 100), (0.5, 90), (0.5, 80)]) is None


# --- the week above, in Postgres ----------------------------------------------

def lot(id_: str, length: int, price: str, stems: int, until: str, **overrides) -> dict:
    row = {
        "id": id_, "description": "Rosa Ec Silantoi", "product_id": PRODUCT,
        "stock_entry_type_id": "5", "manufacturer_id": "57451", "supplier_id": "93",
        "price": "0.398618", "quantity": "1", "quantity_per_pack": "100",
        "quantity_available": str(stems), "visible": "1", "length": str(length),
        "mutation_date_time": "2026-09-25 03:00:00",
        "availability_start_date": "2026-09-25", "availability_end_date": until,
        "webshop_visible": "1", OZH_GROUP_PRICE_COLUMN: price,
    }
    row.update(overrides)
    return row


def sale(id_: str, lot_id: str, length: int, created: str, boxes: int, price: float, customer: str = "12") -> dict:
    return {
        "id": id_, "invoice_id": "25832", "main_invoice_id": "25832",
        "created_from_stock_entry_id": lot_id, "product_id": PRODUCT, "manufacturer_id": "57451",
        "length": str(length), "supplier_id": "93", "customer_id": customer,
        "quantity": str(boxes), "quantity_per_pack": "100",
        "supplier_price": "0.35", "store_price": str(price), "creation_date_time": created,
    }


A = lot("549595", 60, "0,725", 500, "2026-09-27")
B = lot("700001", 70, "0,900", 200, "2026-09-27")
C = lot("700002", 60, "0,700", 300, "2026-09-30")


@pytest.fixture
def db(caplog):
    if not DB_URL:
        pytest.skip("set BI_TEST_POSTGRES_URL to a Postgres to run these scenarios")
    import psycopg2

    import db as db_module

    schema = "bi_test_" + uuid.uuid4().hex[:12]
    admin = psycopg2.connect(DB_URL)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f'CREATE SCHEMA "{schema}"')

    @contextlib.contextmanager
    def scoped():
        conn = psycopg2.connect(DB_URL)
        try:
            with conn.cursor() as cur:
                cur.execute(f'SET search_path TO "{schema}"')
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    original = db_module._conn
    db_module._conn, db_module._bi_tables_ensured = scoped, False
    caplog.set_level(logging.WARNING, logger=db_module.logger.name)

    def sync(rows: list[dict]) -> None:
        states = [s for s in (offer_state_from_row(r) for r in rows) if s]
        current = db_module.get_bi_offer_current_states([s["stock_entry_id"] for s in states])
        db_module.apply_bi_offer_state_changes(*plan_offer_state_changes(current, states, datetime(2026, 9, 30)))

    try:
        db_module.upsert_bi_stock_entry_dim([A, B, C])
        sync([A, B, C])
        sync([lot("700001", 70, "0,900", 0, "2026-09-27", mutation_date_time="2026-09-25 11:00:00")])
        sync([lot("549595", 60, "0,725", 0, "2026-09-27", mutation_date_time="2026-09-26 09:00:00")])
        db_module.upsert_bi_order_lines([
            sale("1", "549595", 60, "2026-09-25 08:00:00", 2, 0.734),
            sale("2", "549595", 60, "2026-09-26 09:00:00", 3, 0.734),
            sale("3", "700001", 70, "2026-09-25 10:00:00", 1, 0.850),
            sale("4", "700001", 70, "2026-09-25 10:30:00", 1, 1.000, customer="14"),
        ])
        with scoped() as conn, conn.cursor() as cur:
            cur.execute("UPDATE bi_offer_states SET synced_at = '2026-09-25 06:00:00+00'")
        db_module.scoped = scoped
        yield db_module
        warnings = [r.getMessage() for r in caplog.records if r.name == db_module.logger.name]
        assert not warnings, f"db logged: {warnings}"
    finally:
        db_module._conn, db_module._bi_tables_ensured = original, False
        with admin.cursor() as cur:
            cur.execute(f'DROP SCHEMA "{schema}" CASCADE')
        admin.close()


def test_the_day_range_query_agrees_with_the_single_day_one(db):
    with db.scoped() as conn, conn.cursor() as cur:
        for day in ("2026-09-24", "2026-09-25", "2026-09-27", "2026-09-28", "2026-09-30"):
            cur.execute(f"SELECT stock_entry_id FROM ({db._OFFERS_ONLINE_ON_DAY}) o", {"day": day})
            single = sorted(r[0] for r in cur.fetchall())
            cur.execute(f"SELECT stock_entry_id FROM ({db._OFFERS_ONLINE_ON_DAYS}) o",
                        {"start": day, "end": day})
            assert sorted(r[0] for r in cur.fetchall()) == single, day


def test_offer_per_day_starts_when_recording_did(db):
    result = db.get_bi_offer_daily(*WEEK)
    assert result["data_from"] == "2026-09-25"
    days = {d["day"]: d for d in result["days"]}
    assert min(days) == "2026-09-25"                       # 20–24.09 are not shown as empty
    assert (days["2026-09-25"]["lots"], days["2026-09-25"]["stems"], days["2026-09-25"]["sold_out"]) == (3, 1000, 1)
    assert (days["2026-09-26"]["lots"], days["2026-09-26"]["sold_out"]) == (3, 1)
    assert (days["2026-09-28"]["lots"], days["2026-09-28"]["stems"]) == (1, 300)   # only C is left


def test_offer_and_sale_price_per_length(db):
    lengths = {ln["length"]: {p["day"]: p for p in ln["points"]}
               for ln in db.get_bi_offer_vs_sale(PRODUCT, *WEEK)["lengths"]}
    assert sorted(lengths) == [60, 70]
    assert lengths[60]["2026-09-25"]["offer"] == pytest.approx(0.7125)   # median of 0,725 and 0,700
    assert lengths[60]["2026-09-25"]["sale"] == pytest.approx(0.734)
    assert lengths[70]["2026-09-25"]["sale"] == pytest.approx(0.85)       # customer 14 left out
    assert "sale" not in lengths[60]["2026-09-27"]


def test_sales_against_the_offer_price(db):
    match = db.get_bi_offer_price_match(*WEEK)
    assert match["lines"] == 3
    assert (match["at_offer_pct"], match["below_pct"], match["above_pct"]) == (83.3, 16.7, 0.0)
    assert sum(b["stems"] for b in match["bins"]) == 600
    assert next(b for b in match["bins"] if b["cents"] == -6)["stems"] == 100


def test_sell_through_counts_sales_against_what_was_left(db):
    by_product = db.get_bi_sell_through(*WEEK, group_by="product")
    assert by_product["total"]["pct"] == 70.0
    row = by_product["rows"][0]
    assert (row["sold"], row["left"], row["listings"], row["sold_out"]) == (700, 300, 3, 2)
    by_length = {r["key"]: r["pct"] for r in db.get_bi_sell_through(*WEEK, group_by="length")["rows"]}
    assert by_length == {"60": 62.5, "70": 100.0}


def test_hours_to_sell_out_count_from_five_in_the_morning(db):
    product = db.get_bi_sellout_speed(*WEEK)["products"][0]
    assert product["hours"] == [6.0, 28.0]
    assert (product["median_hours"], product["listings"], product["sold_out"]) == (17.0, 3, 2)


def test_sold_out_lots_say_what_ran_out_when_and_how_fast(db):
    rows = db.get_bi_sold_out_lots(*WEEK)["rows"]
    assert [(r["stock_entry_id"], r["sold_out_at"], r["hours"], r["stems"]) for r in rows] == [
        ("549595", "2026-09-26 09:00:00", 28.0, 500),
        ("700001", "2026-09-25 11:00:00", 6.0, 200),
    ]
    assert db.get_bi_sold_out_lots("2026-09-25", "2026-09-25")["rows"][0]["stock_entry_id"] == "700001"


def test_a_products_listings_sold_out_first_with_what_sold(db):
    rows = db.get_bi_product_listings(PRODUCT, *WEEK)["rows"]
    assert [(r["stock_entry_id"], r["hours"], r["sold"], r["offered"]) for r in rows] == [
        ("700001", 6.0, 200, 200), ("549595", 28.0, 500, 500), ("700002", None, 0, 300),
    ]


def test_sell_out_dots_name_supplier_and_length(db):
    lots = db.get_bi_sellout_speed(*WEEK)["products"][0]["lots"]
    assert lots == [{"hours": 6.0, "supplier": "93", "length": 70}, {"hours": 28.0, "supplier": "93", "length": 60}]


def test_idle_lots_leave_out_hidden_suppliers(db):
    assert db.get_bi_idle_lots(*WEEK, min_days=3, exclude_suppliers=["93"])["rows"] == []
    assert len(db.get_bi_idle_lots(*WEEK, min_days=3, exclude_suppliers=["12345"])["rows"]) == 1


def test_a_lot_first_seen_empty_is_not_a_sell_out(db):
    # Found on real data: a lot already at 0 stems when first recorded ran
    # out before we watched it, and showed as "sold out after 0 h".
    e = lot("700004", 60, "0,700", 0, "2026-09-27")
    db.upsert_bi_stock_entry_dim([e])
    state = offer_state_from_row(e)
    db.apply_bi_offer_state_changes(*plan_offer_state_changes(
        db.get_bi_offer_current_states([state["stock_entry_id"]]), [state], datetime(2026, 9, 30)))
    assert [r["stock_entry_id"] for r in db.get_bi_sold_out_lots(*WEEK)["rows"]] == ["549595", "700001"]
    speed = db.get_bi_sellout_speed(*WEEK)["products"][0]
    assert (speed["sold_out"], speed["listings"], speed["hours"]) == (2, 4, [6.0, 28.0])
    assert db.get_bi_sell_through(*WEEK, group_by="product")["rows"][0]["sold_out"] == 2
    listing = next(r for r in db.get_bi_product_listings(PRODUCT, *WEEK)["rows"] if r["stock_entry_id"] == "700004")
    assert (listing["sold_out_at"], listing["hours"]) == (None, None)
    assert next(d for d in db.get_bi_offer_daily(*WEEK)["days"] if d["day"] == "2026-09-25")["sold_out"] == 1


def test_idle_lots_are_listed_lots_with_stems_and_no_sale(db):
    rows = db.get_bi_idle_lots(*WEEK, min_days=3)["rows"]
    assert [(r["stock_entry_id"], r["days_online"], r["stems"]) for r in rows] == [("700002", 6, 300)]


def test_product_picker_also_finds_products_on_offer_that_sold_nothing(db):
    # A fourth lot of another product, online the same days, never bought.
    d = lot("700003", 50, "0,600", 400, "2026-09-27", product_id="888888", description="Alstroemeria Unsold")
    db.upsert_bi_stock_entry_dim([d])
    state = offer_state_from_row(d)
    current = db.get_bi_offer_current_states([state["stock_entry_id"]])
    db.apply_bi_offer_state_changes(*plan_offer_state_changes(current, [state], datetime(2026, 9, 30)))
    sold_only = db.get_bi_products_only_picker(300, None, *WEEK, "12")
    assert [p["product_id"] for p in sold_only] == [PRODUCT]
    picker = db.get_bi_products_only_picker(300, None, *WEEK, "12", with_offer=True)
    assert [(p["product_id"], p["row_count"], p["offered"]) for p in picker] == [(PRODUCT, 3, True), ("888888", 0, True)]


def test_overview_compares_with_the_period_before(db):
    overview = db.get_bi_overview("2026-09-25", "2026-09-27", customer_id="12")
    assert overview["current"]["stems"] == 600
    assert overview["current"]["value"] == pytest.approx(452.0)
    assert overview["previous"]["stems"] == 0
    assert overview["previous_range"] == ["2026-09-22", "2026-09-24"]
    assert overview["top_products"][0]["stems"] == 600


def test_elasticity_flags_holiday_weeks_and_says_when_data_is_too_thin(db):
    db.upsert_bi_order_lines([
        sale("10", "549595", 60, "2026-01-12 08:00:00", 3, 0.60),   # ordinary week
        sale("11", "549595", 60, "2026-01-27 08:00:00", 5, 0.90),   # Valentine's window
        sale("12", "549595", 60, "2026-03-03 08:00:00", 2, 0.70),   # Women's Day window
        sale("13", "549595", 60, "2026-03-17 08:00:00", 4, 0.55),
    ])
    result = db.get_bi_price_elasticity(PRODUCT, "2026-01-01", "2026-03-31", customer_id="12", length=60)
    assert [p["excluded"] for p in result["points"]] == [False, True, True, False]
    assert result["periods"] == 2
    assert result["reliable"] is False


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
