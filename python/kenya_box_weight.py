"""Box-weight correction for the Kenya system (850254).

Goal: an invoice's per-box weight in FreshPortal is an estimate, but the
air waybill carries the weight actually shipped. This module divides that
real weight by the number of boxes on the invoice and writes the result
back onto every line, so the invoice reflects what was really flown.

Pipeline, in the order it runs:
  1. BI Sync export (Kenya key/host) for the last 14 days -> open invoices
     (printed = 0) for the configured customers.
  2. customer_stock_item -> the invoice's first line -> stock_entry ->
     supplier_id must not be 200 or 72. An invoice carries exactly one
     supplier (confirmed by the user 2026-09-09), so any one line settles
     it and "first" is a representative sample, not an arbitrary pick.
  3. Playwright on the portal: read the air waybill total weight and the
     invoice's total box count, divide, write to each line's box_weight.

Only step 1-2 exist so far. The column names of customer_stock_item are
NOT yet verified against a real Kenya export — that table has never been
ingested by this project — which is what debug_pull() is for. Building the
selection logic on assumed column names is how this codebase previously
lost an entire table silently (order_line vs order_lines, 2026-08-31).
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from bi_sync_client import (
    get_export_url, download_export_zip, read_table,
    find_table_files, list_export_files,
)
from config import Config

logger = logging.getLogger(__name__)

# Tables this module needs, and the ones debug_pull() reports on.
_TABLES = ("invoice", "customer_stock_item", "stock_entry")

# Suppliers whose invoices must never be touched (user, 2026-09-09).
EXCLUDED_SUPPLIER_IDS = {"200", "72"}

# How far back to pull. The export is a "since" cursor, so this is both the
# API anchor and the window we care about.
LOOKBACK_DAYS = 14


def _sample(rows: list[dict], n: int = 2) -> list[dict]:
    return rows[:n]


def debug_pull(cfg: Config, lookback_days: int = LOOKBACK_DAYS) -> dict:
    """One Kenya export pull, reported rather than ingested.

    Answers the questions the rest of this module is blocked on: which
    files the export actually contains, what columns invoice /
    customer_stock_item / stock_entry really have, and which customer_ids
    currently have open invoices. Nothing is written anywhere.
    """
    if not cfg.bi_sync_api_key:
        raise RuntimeError(
            "No Kenya BI Sync key configured — set KENYA_BI_SYNC_API_KEY "
            "(and KENYA_BI_SYNC_API_BASE_URL if the host differs from the default)"
        )

    anchor = (date.today() - timedelta(days=lookback_days)).isoformat()
    logger.info("[kenya-box-weight] requesting export since %s from %s",
                anchor, cfg.bi_sync_api_base_url)
    zip_bytes = download_export_zip(get_export_url(cfg, anchor))

    contents = [{"file": name, "bytes": size} for name, size in list_export_files(zip_bytes)]

    tables: dict[str, dict] = {}
    for table in _TABLES:
        files = find_table_files(zip_bytes, table)
        rows = read_table(zip_bytes, table) if files else []
        tables[table] = {
            "files": files,
            "row_count": len(rows),
            "columns": sorted(rows[0].keys()) if rows else [],
            "sample": _sample(rows),
        }

    # Which customers actually have open invoices right now — the list the
    # admin picker will be choosing from.
    invoices = read_table(zip_bytes, "invoice")
    open_by_customer: dict[str, int] = {}
    printed_values: dict[str, int] = {}
    for inv in invoices:
        printed = str(inv.get("printed", "")).strip()
        printed_values[printed] = printed_values.get(printed, 0) + 1
        if printed == "0":
            cid = str(inv.get("customer_id", "")).strip()
            open_by_customer[cid] = open_by_customer.get(cid, 0) + 1

    return {
        "anchor": anchor,
        "base_url": cfg.bi_sync_api_base_url,
        "portal_url": cfg.freshportal_url,
        "export_files": contents,
        "tables": tables,
        # Distinct values seen in `printed`, so "0 means open" can be
        # confirmed rather than assumed.
        "printed_value_counts": printed_values,
        "open_invoices_by_customer": dict(
            sorted(open_by_customer.items(), key=lambda kv: kv[1], reverse=True)
        ),
    }
