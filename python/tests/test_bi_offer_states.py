"""What was online in the webshop, and at what price.

Since 2026-09-25 the BI Sync stock_entry export carries
availability_start_date, availability_end_date, webshop_visible and the
OZ-Hami Quito Amsterdam group price. bi_sync turns each offer lot into a
listing state and keeps one row per change in bi_offer_states (db.py). A
wrong rule here does not fail loudly: it just makes lots look offline, or
prices NULL, in every chart built on top.

The first group runs anywhere. The second stores states in Postgres and
reads "online on day D" back; point BI_TEST_POSTGRES_URL (or
KB_TEST_POSTGRES_URL) at a database to run it. It works in a throwaway
schema, so a shared database is left untouched.

Run either way:
    python -m pytest python/tests/test_bi_offer_states.py -q
    python python/tests/test_bi_offer_states.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import contextlib
import os
import sys
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from bi_sync import (  # noqa: E402
    OZH_GROUP_PRICE_COLUMN, last_bi_sync_slot, offer_state_from_row, plan_offer_state_changes,
)

NOW = datetime(2026, 9, 25, 6, 0)
UTC = timezone.utc


def export_row(**overrides) -> dict:
    """Lot 549595 as the 2026-09-25 export has it: a limited offer, online
    21-24 September at 0,725 for the OZ-Hami Quito Amsterdam group."""
    row = {
        "id": "549595", "description": "Rosa Ec Silantoi", "product_id": "119722",
        "stock_entry_type_id": "5", "manufacturer_id": "57451", "supplier_id": "93",
        "price": "0.398618", "price_plus": "0.399000", "quantity": "2",
        "quantity_per_pack": "100", "quantity_available": "100",
        "visible": "1", "verified": "0", "length": "60",
        "mutation_date_time": "2026-09-22 06:39:22.237",
        "creation_date_time": "01/04/2024 10:21",
        "availability_start_date": "2026-09-21", "availability_end_date": "2026-09-24",
        "webshop_visible": "1", OZH_GROUP_PRICE_COLUMN: "0,725",
    }
    row.update(overrides)
    return row


def state(**overrides) -> dict:
    return offer_state_from_row(export_row(**overrides))


def stored(**overrides) -> dict:
    """A lot's current state as get_bi_offer_current_states returns it."""
    current = {
        "stock_entry_id": "549595", "state_since": datetime(2026, 9, 21),
        "last_mutation_time": datetime(2026, 9, 22, 6, 39, 22, 237000), "listed": True,
        "available_from": "2026-09-21", "available_until": "2026-09-24",
        "group_price": Decimal("0.725"),
    }
    current.update(overrides)
    return current


# --- reading one export row ---------------------------------------------------

def test_the_sample_row_is_listed_with_its_window_and_price():
    s = state()
    assert s["listed"] is True
    assert (s["available_from"], s["available_until"]) == ("2026-09-21", "2026-09-24")
    # Decimal comma: float("0,725") fails, so without the fix this was NULL.
    assert s["group_price"] == 0.725
    assert s["price"] == 0.398618
    assert s["quantity_available"] == 100
    assert s["mutation_time"] == datetime(2026, 9, 22, 6, 39, 22, 237000)


def test_a_copy_that_went_through_excel_reads_the_same():
    s = state(availability_start_date="21/09/2026", availability_end_date="24/09/2026")
    assert (s["available_from"], s["available_until"]) == ("2026-09-21", "2026-09-24")


def test_visible_1_means_shown_so_either_flag_at_0_is_not_listed():
    # visible=1 is "shown to users" (user, 2026-09-25), not a soft delete.
    assert state(visible="0")["listed"] is False
    assert state(webshop_visible="0")["listed"] is False


def test_only_offer_lots_count():
    # Lot 613621 from the same paste: type 9, with a 2017 window.
    assert state(id="613621", stock_entry_type_id="9") is None
    assert state(stock_entry_type_id="1") is None
    assert state(stock_entry_type_id="4") is not None


def test_unset_dates_and_a_missing_price_are_unknown_not_errors():
    s = state(availability_start_date="0000-00-00", availability_end_date="")
    assert (s["available_from"], s["available_until"]) == (None, None)
    row = export_row()
    del row[OZH_GROUP_PRICE_COLUMN]
    assert offer_state_from_row(row)["group_price"] is None


# --- planning what to store ---------------------------------------------------

def test_a_first_listing_starts_when_its_window_opened():
    # First seen through Tuesday's sale, but on sale since Monday.
    inserts, updates = plan_offer_state_changes({}, [state()], NOW)
    assert updates == []
    assert [s["state_since"] for s in inserts] == [datetime(2026, 9, 21)]


def test_a_first_listing_set_up_before_its_window_starts_at_the_mutation():
    s = state(mutation_date_time="2026-09-18 15:00:00")
    inserts, _ = plan_offer_state_changes({}, [s], NOW)
    assert inserts[0]["state_since"] == datetime(2026, 9, 18, 15, 0)


def test_a_lot_never_listed_is_not_stored():
    assert plan_offer_state_changes({}, [state(webshop_visible="0")], NOW) == ([], [])


def test_a_sale_continues_the_listing_instead_of_adding_a_row():
    s = state(mutation_date_time="2026-09-23 09:00:00", quantity_available="40")
    inserts, updates = plan_offer_state_changes({"549595": stored()}, [s], NOW)
    assert inserts == []
    assert updates[0]["state_since"] == datetime(2026, 9, 21)
    assert updates[0]["quantity_available"] == 40


def test_a_stored_decimal_price_matches_the_same_price_parsed_as_float():
    s = state(mutation_date_time="2026-09-23 09:00:00")
    inserts, _ = plan_offer_state_changes({"549595": stored(group_price=Decimal("0.7250"))}, [s], NOW)
    assert inserts == []


@pytest.mark.parametrize("change", [
    {OZH_GROUP_PRICE_COLUMN: "0,750"},
    {"availability_end_date": "2026-09-25"},
    {"availability_start_date": "2026-09-28", "availability_end_date": "2026-10-01"},
    {"webshop_visible": "0"},
    {"visible": "0"},
])
def test_a_new_price_window_or_switch_off_starts_a_new_state(change):
    s = state(mutation_date_time="2026-09-23 10:00:00", **change)
    inserts, updates = plan_offer_state_changes({"549595": stored()}, [s], NOW)
    assert updates == []
    assert [i["state_since"] for i in inserts] == [datetime(2026, 9, 23, 10, 0)]


def test_an_unlisted_lot_rolling_its_window_forward_adds_nothing():
    off = stored(listed=False, available_from="2026-09-14", available_until="2026-09-17")
    s = state(webshop_visible="0", mutation_date_time="2026-09-28 03:00:00",
              availability_start_date="2026-09-28", availability_end_date="2026-10-01")
    inserts, updates = plan_offer_state_changes({"549595": off}, [s], NOW)
    assert inserts == [] and len(updates) == 1


def test_running_the_same_export_again_changes_nothing():
    current: dict = {}
    first = plan_offer_state_changes(current, [state()], NOW)
    assert len(first[0]) == 1
    assert plan_offer_state_changes(current, [state()], NOW) == ([], [])


def test_an_older_export_cannot_overwrite_a_newer_state():
    newer = stored(last_mutation_time=datetime(2026, 9, 24, 12, 0))
    old = state(mutation_date_time="2026-09-23 10:00:00", **{OZH_GROUP_PRICE_COLUMN: "0,500"})
    assert plan_offer_state_changes({"549595": newer}, [old], NOW) == ([], [])


# --- when the scheduled pull runs -----------------------------------------------

@pytest.mark.parametrize("now_utc, slot_amsterdam", [
    # Summer time, Amsterdam = UTC+2.
    (datetime(2026, 9, 25, 2, 59, tzinfo=UTC), "2026-09-24 20:00"),  # 04:59, before buying starts
    (datetime(2026, 9, 25, 3, 0, tzinfo=UTC), "2026-09-25 05:00"),
    (datetime(2026, 9, 25, 10, 0, tzinfo=UTC), "2026-09-25 05:00"),
    (datetime(2026, 9, 25, 18, 30, tzinfo=UTC), "2026-09-25 20:00"),
    (datetime(2026, 9, 25, 22, 30, tzinfo=UTC), "2026-09-25 20:00"),  # 00:30 next day
    # Winter time, Amsterdam = UTC+1, and the night the clocks go back.
    (datetime(2026, 12, 1, 4, 30, tzinfo=UTC), "2026-12-01 05:00"),
    (datetime(2026, 10, 25, 4, 0, tzinfo=UTC), "2026-10-25 05:00"),
])
def test_the_last_scheduled_pull_is_at_05_or_20_amsterdam_time(now_utc, slot_amsterdam):
    assert last_bi_sync_slot(now_utc).strftime("%Y-%m-%d %H:%M") == slot_amsterdam


def test_a_run_finished_after_the_slot_is_not_a_missed_one():
    now = datetime(2026, 9, 25, 10, 0, tzinfo=UTC)
    finished = datetime(2026, 9, 25, 3, 2, tzinfo=UTC)   # the 05:00 run, done at 05:02
    assert not finished < last_bi_sync_slot(now)
    assert datetime(2026, 9, 24, 18, 2, tzinfo=UTC) < last_bi_sync_slot(now)  # only yesterday's 20:00


# --- storing and reading back (needs Postgres) --------------------------------

DB_URL = os.getenv("BI_TEST_POSTGRES_URL") or os.getenv("KB_TEST_POSTGRES_URL") or ""


@pytest.fixture
def pg():
    """db pointed at a throwaway schema; yields a function that runs the
    online-on-day query and returns {stock_entry_id: group_price}."""
    if not DB_URL:
        pytest.skip("set BI_TEST_POSTGRES_URL to a Postgres to run the storage scenarios")
    import psycopg2

    import db

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

    original = db._conn
    db._conn, db._bi_tables_ensured = scoped, False

    def online(day: str) -> dict:
        with scoped() as conn, conn.cursor() as cur:
            cur.execute(f"SELECT stock_entry_id, group_price FROM ({db._OFFERS_ONLINE_ON_DAY}) o",
                        {"day": day})
            return {r[0]: float(r[1]) for r in cur.fetchall()}

    try:
        yield online
    finally:
        db._conn, db._bi_tables_ensured = original, False
        with admin.cursor() as cur:
            cur.execute(f'DROP SCHEMA "{schema}" CASCADE')
        admin.close()


def sync(rows: list[dict]) -> tuple[int, int]:
    """What _run_bi_sync_for_range does with the stock_entry rows."""
    import db

    states = [s for s in (offer_state_from_row(r) for r in rows) if s]
    current = db.get_bi_offer_current_states([s["stock_entry_id"] for s in states])
    inserts, updates = plan_offer_state_changes(current, states, NOW)
    db.apply_bi_offer_state_changes(inserts, updates)
    return len(inserts), len(updates)


def test_online_days_follow_the_window_and_the_changes(pg):
    other = dict(id="700001", quantity_available="0")  # sold out, same window
    never = dict(id="700002", webshop_visible="0")
    assert sync([export_row(), export_row(**other), export_row(**never)]) == (2, 0)

    assert pg("2026-09-20") == {}
    assert pg("2026-09-21") == {"549595": 0.725, "700001": 0.725}
    assert pg("2026-09-25") == {}

    # Price raised on Wednesday morning, lot switched off Thursday 08:00.
    assert sync([export_row(**{"mutation_date_time": "2026-09-23 10:00:00",
                               OZH_GROUP_PRICE_COLUMN: "0,750"})]) == (1, 0)
    assert sync([export_row(mutation_date_time="2026-09-24 08:00:00", webshop_visible="0")]) == (1, 0)

    assert pg("2026-09-22")["549595"] == 0.725
    assert pg("2026-09-23")["549595"] == 0.750       # the later price wins the day
    assert pg("2026-09-24")["549595"] == 0.750       # still on sale until 08:00
    # Nothing moved for 700001, and it stays online through its window.
    assert "700001" in pg("2026-09-24")


def test_quantities_update_in_place_and_sold_out_is_kept(pg):
    import db

    sync([export_row()])
    sync([export_row(mutation_date_time="2026-09-23 09:00:00", quantity_available="0")])
    assert sync([export_row(mutation_date_time="2026-09-23 12:00:00", quantity_available="25")]) == (0, 1)
    assert sync([export_row(mutation_date_time="2026-09-23 12:00:00", quantity_available="25")]) == (0, 0)

    with db._conn() as conn, conn.cursor() as cur:
        cur.execute("""SELECT COUNT(*), MIN(quantity_available_first), MIN(quantity_available_last),
                              MIN(sold_out_at), MIN(last_mutation_time) FROM bi_offer_states""")
        count, first, last, sold_out, mutated = cur.fetchone()
    assert count == 1
    assert (first, last) == (100, 25)
    assert sold_out == datetime(2026, 9, 23, 9, 0)
    assert mutated == datetime(2026, 9, 23, 12, 0)


def test_stats_and_daily_series_read_the_new_table(pg):
    import db

    sync([export_row(availability_start_date="2026-09-01", availability_end_date="2099-12-31",
                     mutation_date_time="2026-09-01 03:00:00")])
    stats = db.get_bi_stats()
    assert stats["offer_state_count"] == 1
    assert stats["offers_online_today"] == 1
    series = db.get_bi_offers_online_daily_series(3)
    assert [p["count"] for p in series] == [1, 1, 1]
    assert float(series[-1]["avg_price"]) == 0.725


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
