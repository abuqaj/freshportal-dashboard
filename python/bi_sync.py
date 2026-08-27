"""Daily ingestion of the FreshPortal BI Sync export into the analytics
mirror tables (bi_stock_entry_dim / bi_stock_entry_daily / bi_order_lines).

Usage:
    from bi_sync import run_bi_sync
    run_bi_sync(cfg, mutation_datetime="2026-08-20")   # blocking — call from a background thread

order_lines is filtered to a single reference customer (OZ-Hami Direct
Sales / OZEDS, customer_id=12) at ingest time: webshop sale price is
customer-specific, so mixing customers would make price/sell-through
comparisons meaningless. The invoice table (in the same export) is read
first to resolve invoice_id -> customer_id for that filter.
"""
from __future__ import annotations

import logging
import threading
from datetime import date

from bi_sync_client import get_export_url, download_export_zip, read_table
from config import Config
from db import (
    upsert_bi_stock_entry_dim, upsert_bi_stock_entry_daily, upsert_bi_order_lines,
    log_bi_sync_start, log_bi_sync_finish, append_bi_sync_message,
)

logger = logging.getLogger(__name__)

# OZ-Hami Direct Sales — same customer_id as the "OZEDS" entry in
# DeliveryImporter.tsx's DFG_CUSTOMERS list. The only customer this
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
        _s(f"Loaded {len(customer_by_invoice)} invoice→customer mappings")

        _s("Reading stock_entry table…")
        stock_entries = read_table(zip_bytes, "stock_entry")
        _s(f"Read {len(stock_entries)} stock_entry rows — upserting…")
        upsert_bi_stock_entry_dim(stock_entries)
        snapshot_date = date.today().isoformat()
        upsert_bi_stock_entry_daily(stock_entries, snapshot_date)
        _s(f"Upserted {len(stock_entries)} stock_entry rows (snapshot_date={snapshot_date})")

        _s("Reading order_lines table…")
        all_order_lines = read_table(zip_bytes, "order_lines")
        reference_lines = []
        for line in all_order_lines:
            customer_id = customer_by_invoice.get(line.get("invoice_id")) or customer_by_invoice.get(line.get("main_invoice_id"))
            if customer_id == REFERENCE_CUSTOMER_ID:
                line["customer_id"] = customer_id
                reference_lines.append(line)
        _s(f"Read {len(all_order_lines)} order_lines, {len(reference_lines)} for customer {REFERENCE_CUSTOMER_ID} (OZEDS) — upserting…")
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
