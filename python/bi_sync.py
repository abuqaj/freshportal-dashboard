"""Daily ingestion of the FreshPortal BI Sync export into the analytics
mirror tables (bi_stock_entry_dim / bi_stock_entry_daily / bi_order_lines).

Usage:
    from bi_sync import run_bi_sync
    run_bi_sync(cfg, mutation_datetime="2026-08-20")   # blocking — call from a background thread

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
"""
from __future__ import annotations

import logging
import threading
from datetime import date

from bi_sync_client import get_export_url, download_export_zip, read_table
from config import Config
from db import (
    upsert_bi_stock_entry_dim, upsert_bi_stock_entry_daily, upsert_bi_order_lines,
    upsert_bi_invoice_customer, get_bi_invoice_customer_map,
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


def run_bi_sync(cfg: Config, mutation_datetime: str, on_status=None) -> dict:
    """Pull one BI Sync export and upsert stock_entry / order_lines into the
    mirror tables. Returns {"ok": bool, "stock_entries": int, "order_lines": int, "error": str}.
    """
    global _sync_running

    if _sync_running:
        return {"ok": False, "error": "BI sync already running", "stock_entries": 0, "order_lines": 0}

    with _sync_lock:
        _sync_running = True

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

        _s("Reading stock_entry table…")
        all_stock_entries = read_table(zip_bytes, "stock_entry")
        # visible=1 means the row is an old, already-used/soft-deleted entry —
        # visible=0 is the actual "still live" state (confirmed by the user
        # 2026-08-31, correcting an earlier 2026-08-27 assumption that visible=1
        # meant "exists"). Dropping soft-deleted rows here — rather than storing
        # them and filtering at query time — is what significantly shrinks the
        # mirror tables, per the user's explicit request.
        # stock_entry_type_id=1 rows are "default lots" — not real, individually
        # offered stock — so they're irrelevant to this analyzer and dropped too
        # (confirmed by the user 2026-08-31).
        stock_entries = [
            r for r in all_stock_entries
            if str(r.get("visible") or "0").strip() not in ("1", "true", "True")
            and str(r.get("stock_entry_type_id") or "").strip() != "1"
        ]
        _s(f"Read {len(all_stock_entries)} stock_entry rows, {len(stock_entries)} still live "
           f"(visible=0, stock_entry_type_id≠1) after dropping soft-deleted/default-lots — upserting…")
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
            reference_lines.append(line)
        _s(f"Read {len(all_order_lines)} order_lines, {len(reference_lines)} for customer {REFERENCE_CUSTOMER_ID} "
           f"(OZEDS) created on {mutation_datetime} ({skipped_wrong_day} skipped — different creation day) — upserting…")
        upsert_bi_order_lines(reference_lines)

        log_bi_sync_finish(sync_id, len(stock_entries), len(reference_lines))
        _s(f"Sync complete — {len(stock_entries)} stock_entries, {len(reference_lines)} order_lines")
        return {"ok": True, "stock_entries": len(stock_entries), "order_lines": len(reference_lines), "error": ""}

    except Exception as exc:
        error = str(exc)
        logger.exception("BI sync failed")
        log_bi_sync_finish(sync_id, 0, 0, error)
        return {"ok": False, "stock_entries": 0, "order_lines": 0, "error": error}

    finally:
        _sync_running = False
