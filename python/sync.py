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
from db import upsert_products, log_sync_start, log_sync_finish, get_product_count

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
        products = scrape_all_products(cfg, on_status=_s)
        _s(f"Scraped {len(products)} products — upserting to DB…")

        product_dicts = [asdict(p) for p in products]
        upserted = upsert_products(product_dicts)

        count = get_product_count()
        log_sync_finish(sync_id, count)
        _s(f"Sync complete — {upserted} upserted, {count} total in DB")
        return {"ok": True, "product_count": count, "upserted": upserted, "error": ""}

    except Exception as exc:
        error = str(exc)
        logger.exception("Full sync failed")
        log_sync_finish(sync_id, 0, error)
        return {"ok": False, "product_count": 0, "upserted": 0, "error": error}

    finally:
        _sync_running = False
