"""Daily ingestion of the FreshPortal BI Sync export into the analytics
mirror tables (bi_stock_entry_dim / bi_stock_entry_daily / bi_order_lines).

Usage:
    from bi_sync import run_bi_sync, run_bi_sync_range
    run_bi_sync(cfg, mutation_datetime="2026-08-20")            # one day
    run_bi_sync_range(cfg, "2026-08-01", "2026-08-20")          # backfill a range
    # both blocking — call from a background thread

order_lines is filtered to a single reference customer (OZ-Hami Direct
Sales / OZEDS, customer_id=12) at ingest time: webshop sale price is
customer-specific, so mixing customers would make price/sell-through
comparisons meaningless. The invoice table (in the same export) is read
to resolve invoice_id -> customer_id for that filter, and also persisted
into the standing bi_invoice_customer map (db.py) so older invoices not
included in a given day's delta export can still be resolved.

order_lines is additionally filtered to rows whose creation_date_time falls
on mutation_datetime itself — /v2/export returns everything *mutated* since
that date, which is broader than "created that day".

order_lines is also enriched with manufacturer_id/length/supplier_id via
created_from_stock_entry_id, looked up against *every* stock_entry row in
that day's export (not just the offer/limited-offer ones kept in
bi_stock_entry_dim) — a sold line's created_from_stock_entry_id points to a
"standard" (physical) stock_entry, a different type than the
offer/limited-offer lots bi_stock_entry_dim is scoped to, so this lookup
can't reuse that table (confirmed 2026-09-02).

The "supplier" table (id, name — the FreshPortal-registered supplier list,
confirmed by the user 2026-09-02) is read every sync and kept in
bi_suppliers, purely as an id->name lookup for chart legends.
"""
from __future__ import annotations

import logging
import threading
from datetime import date, timedelta

from bi_sync_client import get_export_url, download_export_zip, read_table
from config import Config
from db import (
    upsert_bi_stock_entry_dim, upsert_bi_stock_entry_daily, upsert_bi_order_lines,
    upsert_bi_invoice_customer, get_bi_invoice_customer_map,
    upsert_bi_suppliers,
    log_bi_sync_start, log_bi_sync_finish, append_bi_sync_message,
)

logger = logging.getLogger(__name__)

# OZ-Hami Direct Sales — same customer_id as the "OZ-Hami - Direct Sales"
# entry in the dfg_customers table (db.py). The only customer this
# analytics tool cares about (see module docstring).
REFERENCE_CUSTOMER_ID = "12"

_sync_lock = threading.Lock()
_sync_running = False
_sync_message = ""


def is_bi_sync_running() -> bool:
    return _sync_running


def get_bi_sync_message() -> str:
    return _sync_message


def _run_bi_sync_one_day(cfg: Config, mutation_datetime: str, on_status=None) -> dict:
    """Actual single-day sync logic — no _sync_running management, callers
    (run_bi_sync / run_bi_sync_range) own that at whatever scope is
    appropriate for them (one day vs. a whole backfill range)."""
    sync_id = log_bi_sync_start(mutation_datetime)

    def _s(msg: str) -> None:
        global _sync_message
        _sync_message = msg
        logger.info("[bi-sync] %s", msg)
        if on_status:
            on_status(msg)
        append_bi_sync_message(sync_id, msg)

    try:
        _s(f"Requesting export (mutation_datetime={mutation_datetime})…")
        export_url = get_export_url(cfg, mutation_datetime)
        zip_bytes = download_export_zip(export_url)
        _s(f"Downloaded export ({len(zip_bytes):,} bytes)")

        _s("Reading invoice table…")
        invoices = read_table(zip_bytes, "invoice")
        customer_by_invoice = {inv["id"]: inv.get("customer_id") for inv in invoices if inv.get("id")}
        # Persist into the standing invoice->customer map forever, not just for
        # this run — /v2/export is a delta feed scoped to mutation_datetime, so
        # today's invoice.csv only covers invoices mutated today. An order_line
        # synced today can reference an older, unmutated invoice that won't be
        # in today's export at all; the accumulated map is what lets that
        # order_line still resolve its customer below (found 2026-08-31).
        upsert_bi_invoice_customer(invoices)
        _s(f"Loaded {len(customer_by_invoice)} invoice→customer mappings from this export "
           f"(accumulated map used as fallback for older invoices)")

        _s("Reading supplier table…")
        suppliers = read_table(zip_bytes, "supplier")
        # Diagnostic sample — supplier names not showing up in the picker
        # despite a successful-looking upsert count; need to see the raw
        # parsed (id, name) pairs to tell whether "name" is actually
        # populated or empty/None for these rows (found 2026-09-02).
        _s(f"Supplier columns: {list(suppliers[0].keys()) if suppliers else '(no rows)'}")
        _s(f"Supplier sample (id, name): {[(s.get('id'), s.get('name')) for s in suppliers[:8]]}")
        upsert_bi_suppliers(suppliers)
        _s(f"Upserted {len(suppliers)} supplier names (id→name lookup for the price/supplier charts)")

        _s("Reading stock_entry table…")
        all_stock_entries = read_table(zip_bytes, "stock_entry")
        # Full, unfiltered lookup by id — used below to enrich order_lines with
        # manufacturer_id/length regardless of stock_entry_type_id, since a
        # sold line's created_from_stock_entry_id points to a "standard" type
        # row, not an offer/limited-offer one (see module docstring).
        stock_entry_by_id = {r["id"]: r for r in all_stock_entries if r.get("id")}

        # Only "offer" (4) and "limited offer" (5) stock_entry_type_id rows are
        # the virtual/temporary-offer lots this analyzer cares about — created
        # once (sometimes years ago) and only ever mutated in place (price,
        # quantity, webshop_visible, available_from/until, ...), never
        # soft-deleted (confirmed by the user 2026-09-02). Every other type —
        # "default lot" (1) and "standard" (physical stock, created per order
        # and consumed/soft-deleted via visible=1 on fulfillment) — has
        # completely different lifecycle semantics (high-churn, order-driven)
        # and would otherwise dominate/skew any "how much is offered" count.
        # The visible=0 check is kept as a defensive no-op belt-and-suspenders
        # filter — offer/limited-offer rows are never expected to have
        # visible=1 in the first place.
        stock_entries = [
            r for r in all_stock_entries
            if str(r.get("visible") or "0").strip() not in ("1", "true", "True")
            and str(r.get("stock_entry_type_id") or "").strip() in ("4", "5")
        ]
        _s(f"Read {len(all_stock_entries)} stock_entry rows, {len(stock_entries)} offer/limited-offer "
           f"lots (type 4/5, visible=0) after dropping other types — upserting…")
        upsert_bi_stock_entry_dim(stock_entries)
        snapshot_date = date.today().isoformat()
        upsert_bi_stock_entry_daily(stock_entries, snapshot_date)
        _s(f"Upserted {len(stock_entries)} stock_entry rows (snapshot_date={snapshot_date})")

        _s("Reading order_lines table…")
        # The export file is literally "order_line.csv" (singular) — confirmed
        # 2026-08-31 by listing the zip's file names — not "order_lines", so the
        # substring match in find_table_file() was silently matching nothing and
        # returning [] every single sync (root cause of the 0 order_lines bug).
        all_order_lines = read_table(zip_bytes, "order_line")

        # Resolve customer_id: prefer this run's own invoice table, fall back to
        # the accumulated bi_invoice_customer map for invoices not mutated today
        # (see the upsert_bi_invoice_customer call above for why that's needed).
        unresolved_ids = {
            line.get("invoice_id") or line.get("main_invoice_id")
            for line in all_order_lines
            if (line.get("invoice_id") or line.get("main_invoice_id"))
            and (line.get("invoice_id") not in customer_by_invoice and line.get("main_invoice_id") not in customer_by_invoice)
        }
        fallback_customer_by_invoice = get_bi_invoice_customer_map(list(unresolved_ids))
        if fallback_customer_by_invoice:
            _s(f"Resolved {len(fallback_customer_by_invoice)} additional invoice→customer "
               f"mappings from accumulated history")

        # Only lines actually created on the selected day — order_lines pulled by
        # /v2/export are everything *mutated* since mutation_datetime, which is
        # broader than "created on this day" (e.g. a line created earlier but
        # touched again later would also come back).
        reference_lines = []
        skipped_wrong_day = 0
        unresolved_stock_entry = 0
        for line in all_order_lines:
            customer_id = (
                customer_by_invoice.get(line.get("invoice_id"))
                or customer_by_invoice.get(line.get("main_invoice_id"))
                or fallback_customer_by_invoice.get(line.get("invoice_id"))
                or fallback_customer_by_invoice.get(line.get("main_invoice_id"))
            )
            if customer_id != REFERENCE_CUSTOMER_ID:
                continue
            created = line.get("creation_date_time") or ""
            if not created.startswith(mutation_datetime):
                skipped_wrong_day += 1
                continue
            line["customer_id"] = customer_id
            source_entry = stock_entry_by_id.get(line.get("created_from_stock_entry_id"))
            if source_entry:
                line["manufacturer_id"] = source_entry.get("manufacturer_id")
                line["length"] = source_entry.get("length")
                line["supplier_id"] = source_entry.get("supplier_id")
            else:
                unresolved_stock_entry += 1
            reference_lines.append(line)
        _s(f"Read {len(all_order_lines)} order_lines, {len(reference_lines)} for customer {REFERENCE_CUSTOMER_ID} "
           f"(OZEDS) created on {mutation_datetime} ({skipped_wrong_day} skipped — different creation day, "
           f"{unresolved_stock_entry} missing farm/length — source stock_entry not in this export) — upserting…")
        upsert_bi_order_lines(reference_lines)

        log_bi_sync_finish(sync_id, len(stock_entries), len(reference_lines))
        _s(f"Sync complete — {len(stock_entries)} stock_entries, {len(reference_lines)} order_lines")
        return {"ok": True, "stock_entries": len(stock_entries), "order_lines": len(reference_lines), "error": ""}

    except Exception as exc:
        error = str(exc)
        logger.exception("BI sync failed")
        log_bi_sync_finish(sync_id, 0, 0, error)
        return {"ok": False, "stock_entries": 0, "order_lines": 0, "error": error}


def run_bi_sync(cfg: Config, mutation_datetime: str, on_status=None) -> dict:
    """Pull one BI Sync export and upsert stock_entry / order_lines into the
    mirror tables. Returns {"ok": bool, "stock_entries": int, "order_lines": int, "error": str}.
    """
    global _sync_running

    if _sync_running:
        return {"ok": False, "error": "BI sync already running", "stock_entries": 0, "order_lines": 0}

    with _sync_lock:
        _sync_running = True
    try:
        return _run_bi_sync_one_day(cfg, mutation_datetime, on_status)
    finally:
        _sync_running = False


def run_bi_sync_range(cfg: Config, start_date: str, end_date: str, on_status=None) -> dict:
    """Backfill every day in [start_date, end_date] (inclusive), sequentially
    — one export pull per day, since order_lines is scoped to exactly one
    creation day per run. _sync_running is held for the whole range (not
    released between days) so the UI's "is a sync running" status stays
    accurate throughout a multi-day backfill instead of flickering between
    each day's individual run.
    """
    global _sync_running

    if _sync_running:
        return {"ok": False, "error": "BI sync already running", "days": [], "stock_entries": 0, "order_lines": 0}

    try:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
    except ValueError as exc:
        return {"ok": False, "error": f"Invalid date: {exc}", "days": [], "stock_entries": 0, "order_lines": 0}
    if end < start:
        return {"ok": False, "error": "end_date is before start_date", "days": [], "stock_entries": 0, "order_lines": 0}

    with _sync_lock:
        _sync_running = True
    try:
        days_results = []
        d = start
        while d <= end:
            day_str = d.isoformat()
            if on_status:
                on_status(f"Backfill: day {day_str}…")
            result = _run_bi_sync_one_day(cfg, day_str, on_status)
            days_results.append({"date": day_str, **result})
            d += timedelta(days=1)

        ok = all(r["ok"] for r in days_results)
        total_stock_entries = sum(r.get("stock_entries", 0) for r in days_results)
        total_order_lines = sum(r.get("order_lines", 0) for r in days_results)
        return {
            "ok": ok,
            "days": days_results,
            "stock_entries": total_stock_entries,
            "order_lines": total_order_lines,
            "error": "" if ok else "One or more days failed — see individual day results",
        }
    finally:
        _sync_running = False
