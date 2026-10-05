"""Volume in stems, prices per stem.

order_line.quantity is a number of boxes and quantity_per_pack the stems in
each box; store_price and supplier_price are per stem. The Analysis Tool's
reference unit is the stem price (user, 2026-10-03), so every volume is
quantity × quantity_per_pack and every displayed price is weighted by stems.
Weighting by boxes counts a 250-stem box like a 100-stem one, and
quantity × store_price is a box count times a stem price. Neither fails
loudly: the charts just show plausible wrong numbers.

The fixture day, 1 August 2026, has two lines of one product:
    1 box  × 250 stems at 0.50  (purchase 0.30)
    2 boxes × 100 stems at 0.80  (purchase 0.40)
by stems: 450 stems, 285.00 €, 0.6333 €/stem
by boxes: 3 boxes, and a "price" of 0.70.
On 31 August one more box of 100 at 0.60 (purchase 0.35) makes August a whole
month for the seasonality chart: 550 stems, 345.00 €, 0.6273 €/stem.

The analytics functions swallow database errors and return an empty result,
so every scenario also fails on a warning logged by db: a broken query must
not pass as "no data".

Needs Postgres: point BI_TEST_POSTGRES_URL (or KB_TEST_POSTGRES_URL) at a
database. It works in a throwaway schema, so a shared database is untouched.
    python -m pytest python/tests/test_bi_stem_units.py -q
"""
from __future__ import annotations

import contextlib
import logging
import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

DB_URL = os.getenv("BI_TEST_POSTGRES_URL") or os.getenv("KB_TEST_POSTGRES_URL") or ""

PRODUCT, SUPPLIER, CUSTOMER = "119722", "93", "12"
AUGUST = ("2026-08-01", "2026-08-31")


def line(id_: str, created: str, boxes: int, per_box: int, price: float, purchase: float) -> dict:
    return {
        "id": id_, "invoice_id": "25832", "main_invoice_id": "25832",
        "created_from_stock_entry_id": "549595", "product_id": PRODUCT,
        "manufacturer_id": "57451", "length": "60", "supplier_id": SUPPLIER,
        "customer_id": CUSTOMER, "quantity": str(boxes), "quantity_per_pack": str(per_box),
        "supplier_price": str(purchase), "store_price": str(price),
        "creation_date_time": created,
    }


LINES = [
    line("1", "2026-08-01 10:00:00", 1, 250, 0.50, 0.30),
    line("2", "2026-08-01 11:00:00", 2, 100, 0.80, 0.40),
    line("3", "2026-08-31 09:00:00", 1, 100, 0.60, 0.35),
]


@pytest.fixture
def db(caplog):
    """db pointed at a throwaway schema holding LINES; fails the test if db
    logged a warning, which is how its analytics report a broken query."""
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
    try:
        db_module.upsert_bi_order_lines([dict(r) for r in LINES])
        yield db_module
        warnings = [r.getMessage() for r in caplog.records if r.name == db_module.logger.name]
        assert not warnings, f"db logged: {warnings}"
    finally:
        db_module._conn, db_module._bi_tables_ensured = original, False
        with admin.cursor() as cur:
            cur.execute(f'DROP SCHEMA "{schema}" CASCADE')
        admin.close()


def test_sales_chart_counts_stems_and_weights_price_by_stems(db):
    series = db.get_bi_sales_overview(*AUGUST, group_by="product", customer_id=CUSTOMER)["series"]
    first_day = series[0]["points"][0]
    assert first_day["day"] == "2026-08-01"
    assert first_day["quantity"] == 450
    assert first_day["value"] == pytest.approx(285 / 450)     # 0.70 when weighted by boxes

    for points in (
        db.get_bi_sales_by_supplier(SUPPLIER, *AUGUST, customer_id=CUSTOMER)["series"][0]["points"],
        db.get_bi_sales_by_product(PRODUCT, *AUGUST, customer_id=CUSTOMER)["series"][0]["points"],
        db.get_bi_price_trend_by_length(PRODUCT, *AUGUST, customer_id=CUSTOMER)["series"][0]["points"],
    ):
        assert (points[0]["quantity"], round(points[0]["value"], 4)) == (450, round(285 / 450, 4))


def test_supplier_ranking_volume_and_revenue_are_stems_and_euros(db):
    top = db.get_bi_top_products_for_supplier(SUPPLIER, *AUGUST, customer_id=CUSTOMER)["points"]
    assert (top[0]["quantity"], top[0]["value"]) == (550, pytest.approx(345))


def test_price_by_length_weights_both_prices_by_stems(db):
    point = db.get_bi_price_vs_length(PRODUCT, *AUGUST, customer_id=CUSTOMER)["points"][0]
    assert point["quantity"] == 550
    assert point["avg_price"] == round(345 / 550, 4)
    assert point["avg_supplier_price"] == round((0.30 * 250 + 0.40 * 200 + 0.35 * 100) / 550, 4)


def test_elasticity_points_are_weekly_stems(db):
    points = db.get_bi_price_elasticity(PRODUCT, *AUGUST, customer_id=CUSTOMER)["points"]
    assert [p["quantity"] for p in points] == [450, 100]


def test_supplier_comparison_and_market_use_stem_weights(db):
    row = db.get_bi_supplier_price_comparison(PRODUCT, *AUGUST, customer_id=CUSTOMER)["points"][0]
    assert (row["quantity"], row["avg_price"]) == (550, round(345 / 550, 4))
    market = db.get_bi_supplier_market_deviation(*AUGUST, customer_id=CUSTOMER)["points"][0]
    assert market["market_price"] == round(345 / 550, 4)
    db.get_bi_supplier_volatility(*AUGUST, customer_id=CUSTOMER)


def test_seasonality_and_events_count_stems(db):
    years = db.get_bi_seasonality(PRODUCT, customer_id=CUSTOMER)["years"]
    assert years == [{"year": 2026, "months": [
        {"month": 8, "quantity": 550, "price": pytest.approx(345 / 550)}]}]
    db.get_bi_event_impact(PRODUCT, customer_id=CUSTOMER)


def test_daily_series_revenue_is_stems_times_stem_price(db):
    rows = db.get_bi_order_lines_daily_series(30)
    first = next(r for r in rows if r["day"] == "2026-08-01")
    assert (float(first["total_quantity"]), float(first["revenue"])) == (450, pytest.approx(285))


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
