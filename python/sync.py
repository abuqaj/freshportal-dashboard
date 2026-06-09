"""Full product sync: scrape all FreshPortal products → upsert to Postgres.

Usage:
    from sync import run_full_sync, is_sync_running
    run_full_sync(cfg)              # blocking — call from a background thread
"""
from __future__ import annotations

import logging
import threading
from dataclasses import asdict

from config import Config
from scraper_fp import scrape_all_products
from db import upsert_products, log_sync_start, log_sync_finish, get_product_count, get_last_successful_sync_date

logger = logging.getLogger(__name__)

_sync_lock = threading.Lock()
_sync_running = False


def is_sync_running() -> bool:
    return _sync_running


def run_full_sync(cfg: Config, on_status=None) -> dict:
    """Scrape all FreshPortal products and upsert to Postgres.

    Thread-safe: returns immediately with {"ok": False} if already running.
    Returns {"ok": bool, "product_count": int, "upserted": int, "error": str}.
    """
    global _sync_running

    if _sync_running:
        return {"ok": False, "error": "Sync already running", "product_count": 0, "upserted": 0}

    with _sync_lock:
        _sync_running = True

    sync_id = log_sync_start()

    def _s(msg: str) -> None:
        logger.info("[sync] %s", msg)
        if on_status:
            on_status(msg)

    try:
        _s("Starting full product sync from FreshPortal…")
        total_upserted = 0

        def _on_batch(batch: list) -> None:
            nonlocal total_upserted
            n = upsert_products([asdict(p) for p in batch])
            total_upserted += n
            _s(f"Upserted {total_upserted} products so far…")

        scrape_all_products(cfg, on_status=_s, on_batch=_on_batch)

        count = get_product_count()
        log_sync_finish(sync_id, count)
        _s(f"Sync complete — {total_upserted} upserted, {count} total in DB")
        return {"ok": True, "product_count": count, "upserted": total_upserted, "error": ""}

    except Exception as exc:
        error = str(exc)
        logger.exception("Full sync failed")
        log_sync_finish(sync_id, 0, error)
        return {"ok": False, "product_count": 0, "upserted": 0, "error": error}

    finally:
        _sync_running = False


def run_incremental_sync(cfg: Config, on_status=None) -> dict:
    """Sync only products changed since the last successful sync date.

    Falls back to run_full_sync when the DB is empty or no successful sync
    exists yet (e.g. first Railway boot).
    """
    from datetime import datetime, timedelta, timezone

    count = get_product_count()
    if count <= 0:
        return run_full_sync(cfg, on_status)

    last_date = get_last_successful_sync_date()
    if not last_date:
        return run_full_sync(cfg, on_status)

    last_dt = datetime.fromisoformat(last_date.replace("Z", "+00:00"))
    # 1-day buffer so products changed just before midnight are not missed
    from_date = (last_dt - timedelta(days=1)).strftime("%Y-%m-%d")
    to_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    global _sync_running
    if _sync_running:
        return {"ok": False, "error": "Sync already running", "product_count": 0, "upserted": 0}

    with _sync_lock:
        _sync_running = True

    sync_id = log_sync_start()

    def _s(msg: str) -> None:
        logger.info("[sync] %s", msg)
        if on_status:
            on_status(msg)

    try:
        _s(f"Incremental sync: mutation_date_time_from={from_date} to={to_date}…")
        products = scrape_all_products(cfg, on_status=_s, from_date=from_date, to_date=to_date)
        _s(f"Scraped {len(products)} changed products — upserting…")

        product_dicts = [asdict(p) for p in products]
        upserted = upsert_products(product_dicts)

        total = get_product_count()
        log_sync_finish(sync_id, total)
        _s(f"Incremental sync complete — {upserted} upserted, {total} total in DB")
        return {"ok": True, "product_count": total, "upserted": upserted, "error": ""}

    except Exception as exc:
        error = str(exc)
        logger.exception("Incremental sync failed")
        log_sync_finish(sync_id, 0, error)
        return {"ok": False, "product_count": 0, "upserted": 0, "error": error}

    finally:
        _sync_running = False
