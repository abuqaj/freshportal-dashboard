#!/usr/bin/env python3
"""FastAPI server — exposes VBN check, VBN fix, and photo upload over HTTP.
Deployed on Railway; called directly by the browser (CORS allowed)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import uuid
from pathlib import Path
from queue import Empty, Queue

import uvicorn
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent))

from config import Config, ALLOWED_FP_URLS
from i18n import msg as i18n_msg
from scraper_fp import fetch_products, fix_vbn_batch, FPProduct, _debug_fetch, _debug_rendered
from product_creator import ProductMatch, search_products, find_best_template, copy_and_create, generate_product_number, find_available_number
from scraper_vbn import lookup_vbn_codes, get_colour_vbn_table, invalidate_colour_table, search_vbn_by_name, get_floricode_colors, invalidate_colors_cache
from verifier import verify_products, KNOWN_VBN
from photo_uploader import run as run_photo_uploader
from ai_helper import ai_analyze_product
from db import (search_products_db, get_products_by_vbn, get_product_count, get_last_sync,
               get_distinct_colors, get_setting, set_setting, get_recent_created_products,
               log_vbn_auto_start, log_vbn_auto_finish, get_vbn_auto_history,
               upsert_catalogue_items, get_catalogue, get_catalogue_count, get_catalogue_last_sync,
               sync_supplier_catalogue, get_supplier_catalogue, get_all_catalogue_meta,
               get_supplier_meta_one,
               upsert_suppliers, get_suppliers, get_suppliers_count,
               find_supplier_fp_id,
               get_delivery_matches, save_delivery_matches, approve_delivery_matches,
               set_delivery_match, delete_delivery_match, clear_delivery_matches,
               create_delivery_import_log, update_delivery_import_log, get_delivery_import_logs,
               upsert_fust_entries, get_all_fust, get_fust_count)
from sync import run_full_sync, run_incremental_sync, is_sync_running, get_sync_message
from auth_middleware import require_permission, require_any_permission, get_token_payload
from parser_delivery import parse_delivery_json, order_to_dict, match_order, delivery_key
from scraper_catalogue import fetch_supplier_catalogue, fetch_supplier_list
from scraper_delivery import add_delivery, explore_delivery_form, explore_stock_add_form
from scraper_fust import fetch_fust_catalogue

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def get_cfg(request: Request, payload: dict = Depends(get_token_payload)) -> Config:
    """Return a Config instance, overriding freshportal_url for admin requests with X-FP-URL header."""
    cfg = Config()
    if "admin:manage" in payload.get("permissions", []):
        fp_url = request.headers.get("X-FP-URL", "").strip().rstrip("/")
        if fp_url in ALLOWED_FP_URLS:
            cfg.freshportal_url = fp_url
    return cfg


def get_stamgegevens_cfg() -> Config:
    """Always returns Config with the Stamgegevens (default env) FreshPortal URL.

    Used for VBN check/fix and sync endpoints which must only ever run against
    the central Stamgegevens system, regardless of which system the admin has selected.
    """
    return Config()
log = logging.getLogger(__name__)

# Temp directory for photo upload sessions (cleaned up after execute)
_PHOTO_SESSIONS_DIR = Path(tempfile.gettempdir()) / "fp_photo_sessions"
_PHOTO_SESSIONS_DIR.mkdir(exist_ok=True)


class PhotoConfirmedItem(BaseModel):
    filename: str
    product_id: str
    product_name: str


class PhotoExecuteRequest(BaseModel):
    session_id: str
    confirmed: list[PhotoConfirmedItem]
    lang: str = "en"

app = FastAPI(title="FreshPortal API", version="1.0.0")


_scheduler = BackgroundScheduler(timezone="UTC")
_AUTO_VBN_JOB_ID = "auto_vbn_check"


def _hourly_sync() -> None:
    cfg = Config()
    log.info("Hourly sync started")
    result = run_incremental_sync(cfg)
    log.info("Hourly sync finished: %s", result)


def _auto_vbn_check() -> None:
    """Background task: verify VBN codes of products created today and auto-fix deterministic errors."""
    import datetime
    log.info("Auto VBN check started")
    run_id = log_vbn_auto_start()
    messages: list[str] = []
    try:
        cfg = Config()

        product_rows = get_recent_created_products()
        if not product_rows:
            log.info("Auto VBN check: no products created today or yesterday — nothing to do")
            messages.append("No products created today or yesterday — nothing to check")
            log_vbn_auto_finish(run_id, 0, 0, [], messages=messages)
            set_setting("vbn_auto_last_check", datetime.datetime.now(datetime.timezone.utc).isoformat())
            return

        messages.append(f"Found {len(product_rows)} products created today or yesterday")
        products = [_db_row_to_fp(r) for r in product_rows]
        data = _build_result(products, cfg, auto_mode=True)

        # Log per-product verification result
        for r in data["results"]:
            name = r.get("name") or r.get("product_id", "?")
            vbn = r.get("current_vbn", "")
            status = r.get("status", "")
            if status == "OK":
                messages.append(f"OK — {name} (VBN {vbn})")
            else:
                reason = r.get("reason", "")
                proposed = r.get("proposed_vbn", "")
                proposed_name = r.get("proposed_vbn_name", "")
                msg = f"{status} — {name} (VBN {vbn}): {reason}"
                if proposed:
                    pname = f" ({proposed_name})" if proposed_name else ""
                    msg += f" → propose VBN {proposed}{pname}"
                messages.append(msg)

        to_fix = [
            (r["product_id"], r["proposed_vbn"])
            for r in data["results"]
            if r["status"] in ("ERROR", "WARNING") and r.get("proposed_vbn")
        ]

        fixes_log: list[dict] = []
        fixed_count = 0

        if to_fix:
            log.info("Auto VBN check: fixing %d products", len(to_fix))
            fix_results = fix_vbn_batch(to_fix, cfg, on_status=messages.append)
            result_map = {r["product_id"]: r for r in data["results"]}
            for product_id, new_vbn in to_fix:
                ok = fix_results.get(product_id, False)
                if ok:
                    fixed_count += 1
                orig = result_map.get(product_id, {})
                old_vbn = orig.get("current_vbn", "")
                name = orig.get("name", product_id)
                fixes_log.append({
                    "product_id": product_id,
                    "name": name,
                    "old_vbn": old_vbn,
                    "new_vbn": new_vbn,
                    "ok": ok,
                })
                fix_label = "fixed" if ok else "FAILED"
                messages.append(f"Fix {fix_label} — {name}: VBN {old_vbn} → {new_vbn}")

        messages.append(f"Done: {len(products)} checked, {fixed_count} fixed")
        log_vbn_auto_finish(run_id, len(products), fixed_count, fixes_log, messages=messages)
        set_setting("vbn_auto_last_check", datetime.datetime.now(datetime.timezone.utc).isoformat())
        log.info("Auto VBN check finished: checked=%d fixed=%d", len(products), fixed_count)

    except Exception as exc:
        log.exception("Auto VBN check failed")
        messages.append(f"ERROR: {exc}")
        log_vbn_auto_finish(run_id, 0, 0, [], str(exc), messages=messages)


@app.on_event("startup")
async def _on_startup() -> None:
    """Warm colour VBN table + schedule hourly product sync."""
    def _warm():
        cfg = Config()
        if cfg.floricode_username and cfg.floricode_password:
            log.info("Warming colour VBN table on startup…")
            table = get_colour_vbn_table(cfg.floricode_username, cfg.floricode_password)
            log.info("Colour VBN table ready: %d genera", len(table))
    threading.Thread(target=_warm, daemon=True).start()

    import datetime
    first_run = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=60)
    _scheduler.add_job(_hourly_sync, "date", run_date=first_run, id="initial_sync")
    _scheduler.add_job(_hourly_sync, "interval", hours=1, id="hourly_sync")

    # Restore auto VBN scheduler state from DB
    if get_setting("vbn_auto_enabled") == "1":
        now = datetime.datetime.now(datetime.timezone.utc)
        last_check_str = get_setting("vbn_auto_last_check")
        enabled_at_str = get_setting("vbn_auto_enabled_at")

        # Use last successful run as reference; fall back to when it was first enabled
        if last_check_str:
            try:
                reference_dt = datetime.datetime.fromisoformat(last_check_str)
            except ValueError:
                reference_dt = now
        elif enabled_at_str:
            try:
                reference_dt = datetime.datetime.fromisoformat(enabled_at_str)
            except ValueError:
                reference_dt = now
        else:
            reference_dt = now

        elapsed = (now - reference_dt).total_seconds()

        if elapsed >= 23 * 3600:
            # Run was overdue (missed during downtime) — catch up within 60 s
            next_run = now + datetime.timedelta(seconds=60)
            log.info("Auto VBN: overdue by %.1f h — catch-up run in 60 s", elapsed / 3600)
        else:
            # Not yet due — keep original daily schedule (reference + 1 day)
            next_run = reference_dt + datetime.timedelta(days=1)
            log.info("Auto VBN: %.1f h since reference — next run at %s", elapsed / 3600, next_run.isoformat())

        _scheduler.add_job(_auto_vbn_check, "interval", days=1, id=_AUTO_VBN_JOB_ID, next_run_time=next_run)
        log.info("Auto VBN check scheduler restored (daily)")

    _scheduler.start()
    log.info("APScheduler started — first product sync in 60 s, then every hour")

_raw_origins = os.getenv("ALLOWED_ORIGINS", "")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()] or ["*"]
if _allowed_origins == ["*"]:
    log.warning(
        "ALLOWED_ORIGINS is not set — CORS is open to all origins. "
        "Set ALLOWED_ORIGINS=https://your-app.vercel.app on Railway."
    )
else:
    log.info("CORS allowed origins: %s", _allowed_origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-FP-URL"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class VbnCheckRequest(BaseModel):
    vbn: str
    lang: str = "en"
    cancel_token: str | None = None


class FixItem(BaseModel):
    product_id: str
    new_vbn: str


class VbnFixRequest(BaseModel):
    fixes: list[FixItem]
    lang: str = "en"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_vbn_codes(vbn_str: str) -> list[str]:
    """Split '580, 595 580' → ['580', '595', '580'] and deduplicate."""
    codes = re.split(r"[,\s;]+", vbn_str.strip())
    seen: set[str] = set()
    result = []
    for c in codes:
        c = c.strip()
        if c and c not in seen:
            seen.add(c)
            result.append(c)
    return result


def _db_row_to_fp(row: dict) -> FPProduct:
    return FPProduct(
        product_id=row.get("product_id", ""),
        name=row.get("name", ""),
        short_name=row.get("short_name", ""),
        vbn_number=row.get("vbn_number", ""),
        origin=row.get("origin", ""),
        product_number=row.get("product_number", ""),
        color=row.get("color", ""),
        product_gtin=row.get("product_gtin", ""),
        product_group_code=row.get("product_group_code", ""),
        product_group=row.get("product_group", ""),
        application=row.get("application", ""),
        vat_rate=row.get("vat_rate", ""),
        cbs_group_code=row.get("cbs_group_code", ""),
        main_group=row.get("main_group", ""),
        creation_moment=row.get("creation_moment", ""),
        change_moment=row.get("change_moment", ""),
    )


def _fetch_all_products(vbn_codes: list[str], cfg: Config, on_status=None, lang: str = "en") -> list:
    """Fetch products for all VBN codes — DB first, Playwright fallback."""
    def _s(key: str, progress: int, **kwargs) -> None:
        if on_status:
            on_status(i18n_msg(lang, key, **kwargs), progress)

    if get_product_count() > 0:
        _s("vbn_searching_db", 5)
        rows = get_products_by_vbn(vbn_codes)
        if rows:
            _s("vbn_found_in_db", 15, count=len(rows))
            return [_db_row_to_fp(r) for r in rows]
        _s("vbn_db_empty_fallback", 10)

    # Fallback: Playwright scrape (DB empty or VBN not found)
    all_products = []
    seen_ids: set[str] = set()
    total = len(vbn_codes)
    for i, code in enumerate(vbn_codes, 1):
        if on_status and total > 1:
            progress = 10 + int((i - 1) / total * 62)
            on_status(i18n_msg(lang, "vbn_fetching_code", code=code, i=i, total=total), progress)
        products = fetch_products(code, cfg, on_status=on_status if total == 1 else None)
        for p in products:
            if p.product_id not in seen_ids:
                seen_ids.add(p.product_id)
                all_products.append(p)
    return all_products


def _build_result(products, cfg: Config, queue: Queue | None = None, lang: str = "en", auto_mode: bool = False, cancel_event: threading.Event | None = None) -> dict:
    """Run VBN lookup + verification and return result dict."""
    def _status(message: str, progress: int | None = None) -> None:
        if queue:
            event: dict = {"type": "status", "message": message}
            if progress is not None:
                event["progress"] = progress
            queue.put(event)

    if not products:
        return {"results": [], "stats": {"total": 0, "errors": 0, "warnings": 0, "ok": 0}}

    unique_vbns = sorted({p.vbn_number for p in products if p.vbn_number})
    _status(i18n_msg(lang, "vbn_verifying", count=len(unique_vbns)), 75)

    vbn_data = lookup_vbn_codes(
        unique_vbns,
        request_timeout=cfg.request_timeout,
        floricode_username=cfg.floricode_username,
        floricode_password=cfg.floricode_password,
    )

    _status(i18n_msg(lang, "vbn_analyzing"), 88)

    def _on_analyze(i: int, total: int) -> None:
        progress = 88 + int((i - 1) / total * 5)  # 88 → 93 %
        _status(i18n_msg(lang, "vbn_analyzing_product", i=i, total=total), progress)

    results = verify_products(products, vbn_data, cfg, auto_mode=auto_mode, on_progress=_on_analyze, cancel_event=cancel_event)

    # Fetch names for proposed VBN codes not already in vbn_data
    proposed_codes = {
        r.proposed_vbn for r in results
        if r.proposed_vbn and r.proposed_vbn not in vbn_data
    }
    if proposed_codes:
        _status(i18n_msg(lang, "vbn_fetching_proposed"), 93)
        extra = lookup_vbn_codes(
            list(proposed_codes),
            request_timeout=cfg.request_timeout,
            floricode_username=cfg.floricode_username,
            floricode_password=cfg.floricode_password,
        )
        vbn_data.update(extra)

    # Discard proposed VBNs that don't exist in Floricode (AI hallucinations).
    # Only check codes we actually looked up; KNOWN_VBN codes are trusted as-is.
    for r in results:
        if r.proposed_vbn and r.proposed_vbn in vbn_data:
            if not vbn_data[r.proposed_vbn].found:
                r.proposed_vbn = ""
                r.status = "OK"
                r.reason = ""

    def _proposed_name(code: str) -> str:
        if not code:
            return ""
        # Try live lookup first, then hardcoded table
        info = vbn_data.get(code)
        if info and info.found and info.official_name:
            return info.official_name
        return KNOWN_VBN.get(code, "")

    out = [
        {
            "product_id": r.product.product_id,
            "short_name": r.product.short_name,
            "name": r.product.name,
            "current_vbn": r.product.vbn_number,
            "official_name": r.vbn_info.official_name if r.vbn_info else "",
            "status": r.status,
            "reason": r.reason,
            "proposed_vbn": r.proposed_vbn,
            "proposed_vbn_name": _proposed_name(r.proposed_vbn),
        }
        for r in results
    ]

    stats = {
        "total": len(results),
        "errors": sum(1 for r in results if r.status == "ERROR"),
        "warnings": sum(1 for r in results if r.status == "WARNING"),
        "ok": sum(1 for r in results if r.status == "OK"),
    }
    return {"results": out, "stats": stats}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Product mirror — sync control
# ---------------------------------------------------------------------------

@app.get("/sync/status")
def sync_status(_: dict = Depends(get_token_payload)):
    """Current sync state + last sync info."""
    last = get_last_sync()
    return {
        "running": is_sync_running(),
        "current_message": get_sync_message() if is_sync_running() else "",
        "product_count": get_product_count(),
        "last_sync": last,
    }


@app.get("/sync/history")
def sync_history_endpoint(limit: int = 10, offset: int = 0, _: dict = Depends(require_permission("admin:manage"))):
    """Last N sync runs with their full message logs, with pagination."""
    from db import get_sync_history
    rows = get_sync_history(limit + 1, offset)
    has_more = len(rows) > limit
    return {"history": rows[:limit], "hasMore": has_more}


@app.get("/sync/debug-page")
def sync_debug_page(page: int = 180, _: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_stamgegevens_cfg)):
    """Fetch a specific page of the unfiltered product list and report what's there.

    Use this to diagnose why the full sync stops at ~44 K:
      - If page 180 returns 0 products → FreshPortal has a server-side limit.
      - If page 180 returns products → the scraper is stopping too early (bug).

    Returns the row count, the final URL after navigation, and up to 5 product names.
    """
    from playwright.sync_api import sync_playwright
    from scraper_fp import _launch_browser, _login, _block_resources, _goto_and_wait, _detect_columns_html, _parse_rows_html, _get_last_page_html
    from bs4 import BeautifulSoup

    url = f"{cfg.freshportal_url}/product/index/index/?1=1&page={page}"

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        fp = context.new_page()
        _block_resources(fp)
        try:
            _login(fp, cfg)
            _goto_and_wait(fp, url, cfg)
            final_url = fp.url
            soup = BeautifulSoup(fp.content(), "lxml")
            col_map = _detect_columns_html(soup)
            products = _parse_rows_html(soup, col_map)
            last_page_detected = _get_last_page_html(soup)
            return {
                "page_requested": page,
                "final_url": final_url,
                "redirected_to_login": "login" in final_url.lower(),
                "last_page_detected": last_page_detected,
                "product_count_on_page": len(products),
                "first_5_products": [p.name for p in products[:5]],
            }
        finally:
            context.close()
            browser.close()


@app.get("/vbn-auto/status")
def vbn_auto_status(_: dict = Depends(get_token_payload)):
    """Return auto-VBN-check enabled flag + last run info."""
    enabled = get_setting("vbn_auto_enabled") == "1"
    last = get_vbn_auto_history(1, 0)
    next_run = None
    if enabled:
        job = _scheduler.get_job(_AUTO_VBN_JOB_ID)
        if job and job.next_run_time:
            next_run = job.next_run_time.isoformat()
    return {"enabled": enabled, "lastRun": last[0] if last else None, "nextRun": next_run}


class VbnAutoToggleRequest(BaseModel):
    enabled: bool


@app.post("/vbn-auto/toggle")
def vbn_auto_toggle(req: VbnAutoToggleRequest, _: dict = Depends(require_permission("admin:manage"))):
    """Enable or disable the hourly auto VBN check."""
    import datetime as _dt
    set_setting("vbn_auto_enabled", "1" if req.enabled else "0")
    if req.enabled:
        if not _scheduler.get_job(_AUTO_VBN_JOB_ID):
            now = _dt.datetime.now(_dt.timezone.utc)
            set_setting("vbn_auto_enabled_at", now.isoformat())
            _scheduler.add_job(_auto_vbn_check, "interval", days=1, id=_AUTO_VBN_JOB_ID)
    else:
        job = _scheduler.get_job(_AUTO_VBN_JOB_ID)
        if job:
            _scheduler.remove_job(_AUTO_VBN_JOB_ID)
    return {"enabled": req.enabled}


@app.get("/vbn-auto/history")
def vbn_auto_history_endpoint(limit: int = 10, offset: int = 0, _: dict = Depends(require_permission("vbn:check"))):
    rows = get_vbn_auto_history(limit + 1, offset)
    has_more = len(rows) > limit
    return {"history": rows[:limit], "hasMore": has_more}


@app.post("/vbn-auto/run-now")
def vbn_auto_run_now(_: dict = Depends(require_permission("admin:manage"))):
    """Manually trigger an immediate Auto VBN check in a background thread."""
    thread = threading.Thread(target=_auto_vbn_check, daemon=True)
    thread.start()
    return {"ok": True}


@app.post("/sync/run")
def sync_run(full: bool = False, _: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_stamgegevens_cfg)):
    """Manually trigger product sync (non-blocking).

    ?full=true forces a full rescan of all 64 K products.
    Default (no param) runs incremental sync from last sync date.
    """
    if is_sync_running():
        raise HTTPException(409, "Sync already running")
    if full:
        threading.Thread(target=run_full_sync, args=(cfg,), daemon=True).start()
        return {"ok": True, "message": "Full sync started in background"}
    threading.Thread(target=run_incremental_sync, args=(cfg,), daemon=True).start()
    return {"ok": True, "message": "Incremental sync started in background"}


def _colors_with_db_fallback(cfg) -> tuple[list[dict], str]:
    """Try Floricode API first; fall back to distinct colors from the products DB.

    Returns (colors, source) where source is "floricode" or "db".
    """
    try:
        colors = get_floricode_colors(cfg.floricode_username, cfg.floricode_password)
        return colors, "floricode"
    except Exception as exc:
        log.warning("Floricode FLC/Color unavailable (%s) — using DB fallback", exc)
        return get_distinct_colors(), "db"


@app.get("/floricode/colors")
def floricode_colors_endpoint(_: dict = Depends(require_permission("products:create")), cfg: Config = Depends(get_cfg)):
    """Return color list from Floricode API, or DB fallback if API unavailable."""
    colors, source = _colors_with_db_fallback(cfg)
    if not colors:
        raise HTTPException(status_code=500, detail="No colors available: Floricode API returned 401 and products DB is empty")
    return {"colors": colors, "source": source}


@app.get("/floricode/colors/refresh")
def floricode_colors_refresh(_: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_cfg)):
    """Clear all color + token caches and re-fetch."""
    invalidate_colors_cache()
    colors, source = _colors_with_db_fallback(cfg)
    if not colors:
        raise HTTPException(status_code=500, detail="No colors available after refresh")
    return {"colors": colors, "source": source, "refreshed": True}


@app.post("/vbn-check")
def vbn_check(req: VbnCheckRequest, _: dict = Depends(require_permission("vbn:check")), cfg: Config = Depends(get_stamgegevens_cfg)):
    """Non-streaming VBN check (kept for backwards compat)."""
    cfg.vbn_to_check = req.vbn
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        products = fetch_products(req.vbn, cfg)
        return _build_result(products, cfg, lang=req.lang)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/vbn-check/stream")
async def vbn_check_stream(req: VbnCheckRequest, _: dict = Depends(require_permission("vbn:check")), cfg: Config = Depends(get_stamgegevens_cfg)):
    """Streaming SSE endpoint — pushes progress messages then final result."""
    cfg.vbn_to_check = req.vbn
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    queue: Queue = Queue()

    vbn_codes = _parse_vbn_codes(req.vbn)

    check_cancel_event: threading.Event | None = None
    if req.cancel_token:
        check_cancel_event = threading.Event()
        _cancel_tokens[req.cancel_token] = check_cancel_event

    def run() -> None:
        try:
            def on_status(message: str, progress: int | None = None) -> None:
                event: dict = {"type": "status", "message": message}
                if progress is not None:
                    event["progress"] = progress
                queue.put(event)

            products = _fetch_all_products(vbn_codes, cfg, on_status=on_status, lang=req.lang)
            data = _build_result(products, cfg, queue, lang=req.lang, cancel_event=check_cancel_event)
            queue.put({"type": "result", "data": data})
        except Exception as e:
            log.exception("vbn-check/stream failed")
            queue.put({"type": "error", "message": str(e)})
        finally:
            if req.cancel_token:
                _cancel_tokens.pop(req.cancel_token, None)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    async def generate():
        # Initial event forces proxy to flush headers and establish SSE connection
        yield ": connected\n\n"

        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                # Keepalive comment flushes nginx/Railway proxy buffers every 200 ms
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue

            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

            if item.get("type") in ("result", "error"):
                break

        thread.join(timeout=10)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/vbn-fix")
def vbn_fix(req: VbnFixRequest, _: dict = Depends(require_permission("vbn:fix")), cfg: Config = Depends(get_stamgegevens_cfg)):
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    fixes = [(f.product_id, f.new_vbn) for f in req.fixes]
    try:
        results = fix_vbn_batch(fixes, cfg)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    fixed = sum(1 for ok in results.values() if ok)
    failed = len(results) - fixed
    return {"results": results, "fixed": fixed, "failed": failed}


@app.post("/vbn-fix/stream")
async def vbn_fix_stream(req: VbnFixRequest, _: dict = Depends(require_permission("vbn:fix")), cfg: Config = Depends(get_stamgegevens_cfg)):
    """Streaming SSE endpoint for VBN fix — pushes per-product progress."""
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    queue: Queue = Queue()
    fixes = [(f.product_id, f.new_vbn) for f in req.fixes]

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            results = fix_vbn_batch(fixes, cfg, on_status=on_status, lang=req.lang)
            fixed = sum(1 for ok in results.values() if ok)
            failed = len(results) - fixed
            queue.put({"type": "result", "data": {
                "results": results,
                "fixed": fixed,
                "failed": failed,
            }})
        except Exception as e:
            log.exception("vbn-fix/stream failed")
            queue.put({"type": "error", "message": str(e)})

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    async def generate():
        yield ": connected\n\n"
        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            if item.get("type") in ("result", "error"):
                break
        thread.join(timeout=10)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.post("/photo-upload/analyze/stream")
async def photo_analyze_stream(files: list[UploadFile] = File(...), _: dict = Depends(require_permission("photos:upload")), cfg: Config = Depends(get_stamgegevens_cfg)):
    """Save uploaded images then stream per-photo match results via SSE.

    Events emitted:
      {type: "session", session_id, total}          — first, after files are saved
      {type: "match", filename, normalized_name, matches}  — one per photo
      {type: "done"}                                 — all photos matched
      {type: "error", message}                       — on failure
    """
    from photo_matcher import IMAGE_EXTENSIONS, match_single_photo, normalize_filename
    from db import get_product_count

    session_id = str(uuid.uuid4())
    session_dir = _PHOTO_SESSIONS_DIR / session_id
    session_dir.mkdir(parents=True)

    saved: list[str] = []
    for f in files:
        if not f.filename:
            continue
        if Path(f.filename).suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        dest = session_dir / f.filename
        dest.write_bytes(await f.read())
        saved.append(f.filename)

    if not saved:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(400, "No valid image files (jpg/png/webp/gif/bmp) received")

    queue: Queue = Queue()

    def run() -> None:
        try:
            if get_product_count() == 0:
                log.warning("DB empty — photo matching unavailable")
                for fn in saved:
                    queue.put({
                        "type": "match",
                        "filename": fn,
                        "normalized_name": normalize_filename(fn),
                        "matches": [],
                    })
            else:
                for fn in saved:
                    queue.put({"type": "match", **match_single_photo(fn, cfg, top_k=5)})
        except Exception as exc:
            log.exception("photo analyze failed")
            queue.put({"type": "error", "message": str(exc)})
        finally:
            queue.put({"type": "done"})

    threading.Thread(target=run, daemon=True).start()

    async def event_stream():
        yield f"data: {json.dumps({'type': 'session', 'session_id': session_id, 'total': len(saved)})}\n\n"
        while True:
            try:
                ev = queue.get_nowait()
            except Empty:
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            if ev.get("type") in ("done", "error"):
                break

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.post("/photo-upload/execute/stream")
def photo_execute_stream(req: PhotoExecuteRequest, _: dict = Depends(require_permission("photos:upload"))):
    """Run Playwright upload for confirmed matches, stream progress via SSE."""
    session_dir = _PHOTO_SESSIONS_DIR / req.session_id
    if not session_dir.exists():
        raise HTTPException(404, "Session expired or not found — re-upload your photos")
    if not req.confirmed:
        raise HTTPException(400, "No confirmed items")

    queue: Queue = Queue()

    def run() -> None:
        try:
            from photo_uploader import run_from_list
            run_from_list(
                session_dir=str(session_dir),
                confirmed_items=[c.model_dump() for c in req.confirmed],
                on_progress=queue.put,
                lang=req.lang,
            )
        except Exception as e:
            log.exception("photo execute failed")
            queue.put({"type": "error", "message": str(e)})
        finally:
            shutil.rmtree(str(session_dir), ignore_errors=True)

    threading.Thread(target=run, daemon=True).start()

    def event_stream():
        while True:
            try:
                event = queue.get(timeout=120)
            except Empty:
                yield "data: {\"type\":\"error\",\"message\":\"timeout\"}\n\n"
                break
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("type") in ("result", "error"):
                break

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/photo-upload")
async def photo_upload(xlsx: UploadFile = File(...), _: dict = Depends(require_permission("photos:upload"))):
    photo_dir = os.getenv("PHOTO_DIR", "./photos")
    content = await xlsx.read()
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    try:
        run_photo_uploader(excel_path=tmp_path, photo_dir=photo_dir, headless=True)
    except Exception as e:
        log.exception("Photo upload failed")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    return {"success": True, "message": "Photo upload completed."}


@app.get("/vbn-search")
def vbn_search_endpoint(q: str, limit: int = 8, _: dict = Depends(require_permission("vbn:check")), cfg: Config = Depends(get_cfg)):
    """Search VBN codes by name words. q='dianthus solex' finds VBNs containing both words."""
    results = search_vbn_by_name(q, cfg.floricode_username, cfg.floricode_password, limit=limit)
    return {"results": results}


@app.get("/vbn-name/{code}")
def get_vbn_name(code: str, _: dict = Depends(require_any_permission("vbn:check", "products:create")), cfg: Config = Depends(get_cfg)):
    """Return the official Floricode name for a single VBN code."""
    # Check hardcoded table first (instant, no API call)
    if code in KNOWN_VBN:
        return {"code": code, "name": KNOWN_VBN[code], "found": True}
    # Query Floricode
    result = lookup_vbn_codes(
        [code],
        request_timeout=cfg.request_timeout,
        floricode_username=cfg.floricode_username,
        floricode_password=cfg.floricode_password,
    )
    info = result.get(code)
    if info and info.found and info.official_name:
        return {"code": code, "name": info.official_name, "found": True}
    return {"code": code, "name": None, "found": False}


# ---------------------------------------------------------------------------
# Product creation
# ---------------------------------------------------------------------------

class ProductSearchRequest(BaseModel):
    name: str
    lang: str = "en"


class ProductCreateRequest(BaseModel):
    template_id: str
    new_name: str
    product_number: str | None = None
    lang: str = "en"
    vbn_code: str | None = None
    color_id: str | None = None


class AIAnalyzeRequest(BaseModel):
    name: str
    candidates: list[dict]
    preferred_vbn: str | None = None  # template's VBN — validate first, skip AI if valid
    cancel_token: str | None = None  # UUID from frontend; POST /cancel/{token} to abort


# Maps cancel_token → threading.Event; set the event to abort the Anthropic stream.
_cancel_tokens: dict[str, threading.Event] = {}


@app.post("/cancel/{token}")
def cancel_task(token: str, _: dict = Depends(get_token_payload)):
    """Signal the server-side Anthropic stream to stop immediately."""
    event = _cancel_tokens.get(token)
    if event:
        event.set()
    return {"ok": True, "found": token in _cancel_tokens}


@app.post("/product-search")
def product_search(req: ProductSearchRequest, _: dict = Depends(require_permission("products:create")), cfg: Config = Depends(get_cfg)):
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(400, str(e))
    matches = search_products(req.name, cfg)
    return {
        "results": [
            {
                "product_id": m.product_id,
                "name": m.name,
                "short_name": m.short_name,
                "vbn_number": m.vbn_number,
                "similarity": round(m.similarity, 3),
            }
            for m in matches
        ]
    }


def _matches_to_results(matches) -> list[dict]:
    return [
        {
            "product_id": m.product_id,
            "name": m.name,
            "short_name": m.short_name,
            "vbn_number": m.vbn_number,
            "similarity": round(m.similarity, 3),
            "color": getattr(m, "color", ""),
        }
        for m in matches
    ]


@app.post("/product-search/stream")
async def product_search_stream(req: ProductSearchRequest, _: dict = Depends(require_permission("products:create")), cfg: Config = Depends(get_cfg)):
    """SSE stream: DB search first (instant), Playwright fallback if DB empty."""
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(400, str(e))

    queue: Queue = Queue()

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            # Use the variety-aware search (typo-resistant ILIKE substrings + genus).
            # Falls back to Playwright automatically when DB is not yet populated.
            matches = search_products(req.name, cfg, on_status=on_status, lang=req.lang)
            source = "db" if get_product_count() > 0 else "scrape"
            queue.put({"type": "result", "data": {
                "results": _matches_to_results(matches),
                "source": source,
            }})
        except Exception as e:
            log.exception("product-search/stream failed")
            queue.put({"type": "error", "message": str(e)})

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    async def generate():
        yield ": connected\n\n"
        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            if item.get("type") in ("result", "error"):
                break
        thread.join(timeout=10)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ---------------------------------------------------------------------------
# VBN color-conflict helpers
# ---------------------------------------------------------------------------

_COLOR_NORMALIZER: dict[str, str] = {
    # English
    "lavender": "lavender",
    "yellow": "yellow",
    "red": "red",
    "pink": "pink",
    "white": "white",
    "blue": "blue",
    "purple": "purple",
    "orange": "orange",
    "green": "green",
    "salmon": "salmon",
    "cream": "cream",
    "violet": "violet",
    "lilac": "lilac",
    "burgundy": "burgundy",
    "magenta": "magenta",
    "coral": "coral",
    "bicolor": "bicolor",
    # Dutch
    "lavendel": "lavender",
    "geel": "yellow",
    "rood": "red",
    "roze": "pink",
    "wit": "white",
    "blauw": "blue",
    "paars": "purple",
    "oranje": "orange",
    "groen": "green",
    "zalm": "salmon",
    "bordeaux": "burgundy",
    "lila": "lilac",
    "bicolour": "bicolor",
}


def _extract_color(name: str) -> str | None:
    """Return the first normalized color word found in *name*, or None."""
    for word in re.findall(r"[a-z]+", name.lower()):
        color = _COLOR_NORMALIZER.get(word)
        if color:
            return color
    return None


_GENERIC_TERMS = frozenset({"other", "overig", "overige", "andere", "misc", "general", "overig."})


def _is_generic(name: str) -> bool:
    words = set(re.findall(r"[a-z]+", name.lower()))
    return bool(words & _GENERIC_TERMS)


def _find_fallback_vbn(product_name: str, cfg: Config) -> dict | None:
    """Find a generic (colorless) VBN when the specific one has a color conflict.

    Search order (EN + NL):
      1. "{genus} other"   — e.g. "Callistephus other"
      2. "{genus} overig"  — Dutch equivalent
      3. "cut flowers other"
      4. "snijbloemen overig"
    Matches any result whose name contains a generic term (other/overig/…).
    """
    genus = product_name.strip().split()[0] if product_name.strip() else ""
    queries: list[str] = []
    if genus:
        queries += [f"{genus} other", f"{genus} overig", genus]
    queries += ["cut flowers other", "snijbloemen overig", "cut flowers"]
    seen_codes: set[str] = set()
    for q in queries:
        results = search_vbn_by_name(
            q,
            cfg.floricode_username,
            cfg.floricode_password,
            limit=10,
        )
        for r in results:
            name = r.get("name", "")
            code = str(r.get("id", ""))
            if code in seen_codes:
                continue
            seen_codes.add(code)
            if _is_generic(name):
                log.info("Fallback VBN found: %s — %s", code, name)
                return {"code": code, "name": name}
    log.warning("No fallback VBN found for '%s'", product_name)
    return None


@app.post("/product-ai-analyze")
def product_ai_analyze(req: AIAnalyzeRequest, _: dict = Depends(require_permission("products:create")), cfg: Config = Depends(get_cfg)):
    """Duplicate check + VBN suggestion via Claude Haiku (single call)."""
    if not cfg.anthropic_api_key:
        return {
            "duplicate": {"found": False, "reason": "ANTHROPIC_API_KEY not configured"},
            "vbn": {"code": None, "explanation": "ANTHROPIC_API_KEY not configured"},
        }
    candidates = [
        ProductMatch(
            product_id=c.get("product_id", ""),
            name=c.get("name", ""),
            short_name=c.get("short_name", ""),
            vbn_number=c.get("vbn_number", ""),
            similarity=float(c.get("similarity", 0)),
        )
        for c in req.candidates[:6]
    ]

    cancel_event: threading.Event | None = None
    if req.cancel_token:
        cancel_event = threading.Event()
        _cancel_tokens[req.cancel_token] = cancel_event

    try:
        result = ai_analyze_product(req.name, candidates, cfg, cancel_event=cancel_event)
    finally:
        if req.cancel_token:
            _cancel_tokens.pop(req.cancel_token, None)

    if result is None:
        return {
            "duplicate": {"found": False, "reason": "AI analysis failed"},
            "vbn": {"code": None, "explanation": "AI analysis failed"},
        }

    preferred = str(req.preferred_vbn or "").strip()

    # AI also returns dutch_name (Dutch translation of the product name).
    # We use it for color-conflict comparison against Floricode's Dutch VBN names,
    # and for fallback VBN searches (Floricode uses Dutch).
    dutch_name: str = str(result.get("dutch_name") or "").strip() or req.name

    # Validate AI-suggested VBN against Floricode before returning.
    # AI hallucinates codes — never show a suggestion that doesn't exist.
    vbn_info = result.get("vbn") or {}
    ai_code = str(vbn_info.get("code") or "").strip()
    if ai_code:
        if ai_code in KNOWN_VBN:
            vbn_info["name"] = KNOWN_VBN[ai_code]
        else:
            lookup = lookup_vbn_codes(
                [ai_code],
                request_timeout=cfg.request_timeout,
                floricode_username=cfg.floricode_username,
                floricode_password=cfg.floricode_password,
            )
            info = lookup.get(ai_code)
            if info and info.found and info.official_name:
                vbn_info["name"] = info.official_name
            else:
                vbn_info["code"] = None
                vbn_info["name"] = None
                vbn_info["explanation"] = (
                    f"AI suggested code {ai_code} but it was not found in Floricode"
                )

        # Color-conflict guard: compare the Dutch product name against the Floricode
        # VBN name (also Dutch) so that EN↔NL translations don't cause false conflicts.
        # "Rosa Spray Royal Blush" → dutch_name → "Rosa Tros Royal Blush"
        # vs VBN name "Rosa Tros Royal Blush" → same color (no conflict) ✓
        if vbn_info.get("code") and vbn_info.get("name"):
            product_color = _extract_color(dutch_name)
            vbn_color = _extract_color(vbn_info["name"])
            if product_color and vbn_color and product_color != vbn_color:
                log.info(
                    "VBN color conflict: '%s' (%s) vs VBN '%s' (%s) — searching fallback",
                    dutch_name, product_color, vbn_info["name"], vbn_color,
                )
                fallback = _find_fallback_vbn(dutch_name, cfg)
                if fallback:
                    vbn_info["code"] = fallback["code"]
                    vbn_info["name"] = fallback["name"]
                    vbn_info["explanation"] = (
                        f"Color mismatch ({vbn_color} ≠ {product_color}) — "
                        f"using generic: {fallback['name']}"
                    )
                else:
                    vbn_info["code"] = None
                    vbn_info["name"] = None
                    vbn_info["explanation"] = (
                        f"Color mismatch ({vbn_color} ≠ {product_color}) — "
                        "no generic VBN found"
                    )

        result["vbn"] = vbn_info

    # Preferred-VBN override: if AI suggested something different, try to restore
    # the template's VBN.  FreshPortal codes may not be in Floricode — trust them
    # unconditionally (they're already in production use, not AI hallucinations).
    if preferred and result.get("vbn", {}).get("code") != preferred:
        pref_name = KNOWN_VBN.get(preferred)
        if pref_name is None:
            pref_lookup = lookup_vbn_codes(
                [preferred],
                request_timeout=cfg.request_timeout,
                floricode_username=cfg.floricode_username,
                floricode_password=cfg.floricode_password,
            )
            pref_info = pref_lookup.get(preferred)
            if pref_info and pref_info.found and pref_info.official_name:
                pref_name = pref_info.official_name

        if pref_name:
            # Compare Dutch product name against Floricode's Dutch VBN name.
            # "Rosa Spray Royal Blush" → dutch_name "Rosa Tros Royal Blush"
            # vs pref_name "Rosa Tros Royal Blush" → same color → no conflict ✓
            p_color = _extract_color(dutch_name)
            v_color = _extract_color(pref_name)
            if not (p_color and v_color and p_color != v_color):
                log.info(
                    "Restoring template VBN %s (%s) over AI suggestion %s",
                    preferred, pref_name, result.get("vbn", {}).get("code"),
                )
                result["vbn"] = {
                    "code": preferred,
                    "name": pref_name,
                    "explanation": "Template VBN validated — no color conflict",
                }
            else:
                log.info(
                    "Template VBN %s has color conflict (%s ≠ %s) — keeping AI suggestion",
                    preferred, v_color, p_color,
                )

    return result


@app.get("/product-number-suggest")
def product_number_suggest(name: str = "", number: str = "", _: dict = Depends(require_permission("products:create")), cfg: Config = Depends(get_cfg)):
    """Return first available product number for given name or base number.

    Called by the frontend immediately when the create-confirmation form opens,
    so the user sees a validated, free number before clicking Create.
    """
    base = number.strip() or (generate_product_number(name.strip()) if name.strip() else "")
    if not base:
        raise HTTPException(400, "Provide 'name' or 'number' query param")
    result = find_available_number(base, cfg, name=name.strip())
    if result is None:
        return {"available_number": None, "original_number": base, "changed": False}
    return {"available_number": result, "original_number": base, "changed": result != base}


@app.post("/product-create/stream")
async def product_create_stream(req: ProductCreateRequest, _: dict = Depends(require_permission("products:create")), cfg: Config = Depends(get_cfg)):
    """SSE stream: copies template product, renames it, returns result."""
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(400, str(e))

    queue: Queue = Queue()

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            result = copy_and_create(req.template_id, req.new_name, cfg, on_status=on_status, product_number=req.product_number, lang=req.lang, vbn_code=req.vbn_code, color_id=req.color_id)
            queue.put({"type": "result", "data": result})
        except Exception as e:
            log.exception("product-create/stream failed")
            queue.put({"type": "error", "message": str(e)})

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    async def generate():
        yield ": connected\n\n"
        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            if item.get("type") in ("result", "error"):
                break
        thread.join(timeout=10)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.get("/debug/colour-table")
def debug_colour_table(_: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_cfg)):
    """Show the colour VBN table (genera and their kleurbehandeld codes)."""
    table = get_colour_vbn_table(cfg.floricode_username, cfg.floricode_password)
    return {
        "genera_count": len(table),
        "total_entries": sum(len(v) for v in table.values()),
        "table": {
            genus: [{"id": e["id"], "name": e["name"], "is_spray": e["is_spray"]} for e in entries]
            for genus, entries in sorted(table.items())
        },
    }


@app.post("/debug/colour-table/refresh")
def refresh_colour_table(_: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_cfg)):
    """Force rebuild of colour VBN table from Floricode API."""
    invalidate_colour_table()
    table = get_colour_vbn_table(cfg.floricode_username, cfg.floricode_password)
    return {"ok": True, "genera_count": len(table), "total_entries": sum(len(v) for v in table.values())}


@app.get("/debug/product-row/{product_id}")
def debug_product_row(product_id: str, _: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_cfg)):
    """Return every link and button found in a product row — used to discover copy UI."""
    from scraper_fp import _launch_browser, _block_resources, _login, _goto_and_wait
    from playwright.sync_api import sync_playwright

    result: dict = {"product_id": product_id, "links": [], "buttons": [], "row_html": ""}

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        _block_resources(page)
        try:
            _login(page, cfg)
            url = f"{cfg.freshportal_url}/product/index/index/?1=1&id={product_id}&page=1"
            page.goto(url, wait_until="load", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector("table tbody tr", timeout=15_000)
            except Exception:
                pass

            rows = page.query_selector_all("table tbody tr")
            if rows:
                row = rows[0]
                for a in row.query_selector_all("a"):
                    result["links"].append({
                        "text": (a.inner_text() or "").strip()[:60],
                        "href": a.get_attribute("href"),
                        "title": a.get_attribute("title"),
                        "data_action": a.get_attribute("data-action"),
                        "class": a.get_attribute("class"),
                    })
                for btn in row.query_selector_all("button"):
                    result["buttons"].append({
                        "text": (btn.inner_text() or "").strip()[:60],
                        "data_action": btn.get_attribute("data-action"),
                        "class": btn.get_attribute("class"),
                    })
                result["row_html"] = row.inner_html()[:5000]
            else:
                result["error"] = "No rows found — check product_id"
        except Exception as exc:
            result["error"] = str(exc)
        finally:
            context.close()
            browser.close()

    return result


@app.get("/debug/product-copy-flow/{product_id}")
def debug_product_copy_flow(product_id: str, _: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_cfg)):
    """Simulate clicking the copy button and return what's on the page afterwards."""
    from scraper_fp import _launch_browser, _login
    from playwright.sync_api import sync_playwright
    import time as _time

    result: dict = {
        "url_before": "",
        "url_after": "",
        "navigated": False,
        "fps_buttons_after": [],
        "visible_inputs_after": [],
        "html_snippet": "",
        "steps": [],
    }

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        page.route("**/*", lambda route: route.abort()
            if route.request.resource_type in ("image", "font", "media")
            else route.continue_())
        try:
            _login(page, cfg)
            url = f"{cfg.freshportal_url}/product/index/index/?1=1&id={product_id}&page=1"
            page.goto(url, wait_until="load", timeout=cfg.request_timeout)
            page.wait_for_selector("table tbody tr", timeout=15_000)
            result["steps"].append("navigated to product list")
            result["url_before"] = page.url

            rows = page.query_selector_all("table tbody tr")
            if not rows:
                result["steps"].append("ERROR: no rows found")
                return result

            # Capture JS console errors
            console_errors = []
            page.on("console", lambda msg: console_errors.append(f"{msg.type}: {msg.text}") if msg.type in ("error", "warning") else None)

            # Try several selection methods
            row = rows[0]
            box = row.bounding_box()
            if box:
                # Physical mouse click at center of first cell (most reliable for Angular)
                page.mouse.click(box["x"] + 20, box["y"] + box["height"] / 2)
                result["steps"].append(f"mouse.click on row at ({box['x']+20}, {box['y']+box['height']/2})")
            else:
                row.click()
                result["steps"].append("clicked row (no bounding box)")
            _time.sleep(1.5)

            # Check row selected state
            row_class = row.get_attribute("class") or ""
            first_cell_class = (row.query_selector("td:first-child") or row).get_attribute("class") or ""
            result["steps"].append(f"row class after click: '{row_class}', first cell: '{first_cell_class}'")

            copy_loc = None
            for sel in ["fps-button[name='button_copy']", "#btn_product_index_index_button_copy", "fps-button[type='copy']"]:
                loc = page.locator(sel)
                if loc.count() > 0:
                    copy_loc = loc
                    result["steps"].append(f"found copy button: {sel}, aria-disabled={loc.get_attribute('aria-disabled')}")
                    break
            if not copy_loc:
                result["steps"].append("ERROR: copy button not found")
                return result

            inner = copy_loc.locator("button")
            if inner.count() > 0:
                inner.click()
                result["steps"].append("clicked inner shadow-dom button")
            else:
                copy_loc.click(force=True)
                result["steps"].append("clicked outer fps-button (force)")
            _time.sleep(6)

            result["console_errors"] = console_errors[-20:]  # last 20 errors

            # Also try direct copy URLs
            result["steps"].append("trying direct copy URLs…")
            copy_urls_tried = []
            for copy_url in [
                f"{cfg.freshportal_url}/product/index/copy/id/{product_id}/",
                f"{cfg.freshportal_url}/product/index/copy/PRO_ID/{product_id}/",
                f"{cfg.freshportal_url}/product/index/add/?copy={product_id}",
            ]:
                page.goto(copy_url, wait_until="load", timeout=30_000)
                landed = page.url
                has_form = bool(page.query_selector("#product_index_form_submit"))
                copy_urls_tried.append({"url": copy_url, "landed": landed, "has_form": has_form})
                if has_form or "add" in landed:
                    result["steps"].append(f"DIRECT URL WORKS: {copy_url} → {landed}")
                    break
            result["copy_urls_tried"] = copy_urls_tried

            result["url_after"] = page.url
            result["navigated"] = page.url != result["url_before"]
            result["steps"].append(f"navigated={result['navigated']}")

            # Collect all fps-buttons on page
            for btn in page.query_selector_all("fps-button"):
                result["fps_buttons_after"].append({
                    "id": btn.get_attribute("id"),
                    "name": btn.get_attribute("name"),
                    "type": btn.get_attribute("type"),
                    "submit": btn.get_attribute("submit"),
                    "aria_disabled": btn.get_attribute("aria-disabled"),
                })

            # Collect all visible inputs
            for inp in page.query_selector_all("input"):
                if inp.is_visible():
                    result["visible_inputs_after"].append({
                        "type": inp.get_attribute("type"),
                        "placeholder": inp.get_attribute("placeholder"),
                        "name": inp.get_attribute("name"),
                        "id": inp.get_attribute("id"),
                    })

            result["html_snippet"] = page.content()[3000:7000]  # middle section

        except Exception as exc:
            result["steps"].append(f"ERROR: {exc}")
        finally:
            context.close()
            browser.close()

    return result


@app.get("/debug/product-copy-form/{product_id}")
def debug_product_copy_form(product_id: str, _: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_cfg)):
    """Inspect all form elements on the copy product page."""
    from scraper_fp import _launch_browser, _login
    from playwright.sync_api import sync_playwright

    result: dict = {"url": "", "all_inputs": [], "all_custom": [], "fps_inputs": [], "html": ""}

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        page.route("**/*", lambda route: route.abort()
            if route.request.resource_type in ("image", "font", "media")
            else route.continue_())
        try:
            _login(page, cfg)
            copy_url = f"{cfg.freshportal_url}/product/index/copy/PRO_ID/{product_id}/"
            page.goto(copy_url, wait_until="load", timeout=cfg.request_timeout)
            page.wait_for_selector("#product_index_form_submit", timeout=15_000)
            result["url"] = page.url

            # All standard inputs
            for inp in page.query_selector_all("input, textarea, select"):
                result["all_inputs"].append({
                    "tag": inp.evaluate("el => el.tagName"),
                    "type": inp.get_attribute("type"),
                    "name": inp.get_attribute("name"),
                    "id": inp.get_attribute("id"),
                    "placeholder": inp.get_attribute("placeholder"),
                    "value": inp.evaluate("el => el.value"),
                    "visible": inp.is_visible(),
                })

            # fps-input and other custom components
            for el in page.query_selector_all("fps-input, fps-textarea, fps-select, [fps-input], [data-input]"):
                result["fps_inputs"].append({
                    "tag": el.evaluate("el => el.tagName.toLowerCase()"),
                    "name": el.get_attribute("name"),
                    "label": el.get_attribute("label"),
                    "id": el.get_attribute("id"),
                    "placeholder": el.get_attribute("placeholder"),
                })

            # Any element with a label nearby
            result["html"] = page.evaluate("""
                () => {
                    const form = document.querySelector('form') || document.querySelector('.crud_form') || document.body;
                    return form.innerHTML.substring(0, 8000);
                }
            """)

        except Exception as exc:
            result["error"] = str(exc)
        finally:
            context.close()
            browser.close()

    return result


@app.get("/debug/product-add-page")
def debug_product_add_page(_: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_cfg)):
    """Return the HTML of the add-product page so we can see its form fields."""
    from scraper_fp import _launch_browser, _block_resources, _login
    from playwright.sync_api import sync_playwright

    result: dict = {"url": "", "form_fields": [], "buttons": [], "html_snippet": ""}

    candidate_urls = [
        f"{cfg.freshportal_url}/product/index/add/",
        f"{cfg.freshportal_url}/product/index/new/",
        f"{cfg.freshportal_url}/product/add/",
    ]

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        # Don't block stylesheets — form rendering may depend on them
        page.route("**/*", lambda route: route.abort()
            if route.request.resource_type in ("image", "font", "media")
            else route.continue_())
        try:
            _login(page, cfg)

            # Try each candidate URL
            for url in candidate_urls:
                page.goto(url, wait_until="load", timeout=cfg.request_timeout)
                result["url"] = page.url
                if page.url != f"{cfg.freshportal_url}/product/index/index/":
                    break  # Didn't get redirected back to list — probably the right URL

            # Collect all inputs / selects
            for inp in page.query_selector_all("input, select, textarea"):
                result["form_fields"].append({
                    "tag": inp.evaluate("el => el.tagName.toLowerCase()"),
                    "name": inp.get_attribute("name"),
                    "type": inp.get_attribute("type"),
                    "placeholder": inp.get_attribute("placeholder"),
                    "id": inp.get_attribute("id"),
                    "value": inp.get_attribute("value"),
                })
            for btn in page.query_selector_all("button, input[type=submit]"):
                result["buttons"].append({
                    "text": (btn.inner_text() or "").strip()[:60],
                    "type": btn.get_attribute("type"),
                    "name": btn.get_attribute("name"),
                })
            result["html_snippet"] = page.content()[:8000]
        except Exception as exc:
            result["error"] = str(exc)
        finally:
            context.close()
            browser.close()

    return result


@app.get("/debug/fp")
def debug_fp(vbn: str = "580", _: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_cfg)):
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _debug_fetch(cfg, vbn)


@app.get("/debug/fp-rendered")
def debug_fp_rendered(vbn: str = "580", _: dict = Depends(require_permission("admin:manage")), cfg: Config = Depends(get_cfg)):
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _debug_rendered(cfg, vbn)


# ---------------------------------------------------------------------------
# Delivery / batch import
# ---------------------------------------------------------------------------

ECUADOR_FP_URL = os.getenv("ECUADOR_FP_URL", "https://850255.freshportal.nl")


def get_ecuador_cfg() -> Config:
    """Config always targeting Ecuador FreshPortal (850255).

    Optionally uses ECUADOR_FP_USERNAME / ECUADOR_FP_PASSWORD if set;
    otherwise falls back to the main FreshPortal credentials.
    """
    cfg = Config()
    cfg.freshportal_url = ECUADOR_FP_URL
    ec_user = os.getenv("ECUADOR_FP_USERNAME", "")
    ec_pass = os.getenv("ECUADOR_FP_PASSWORD", "")
    if ec_user:
        cfg.freshportal_username = ec_user
    if ec_pass:
        cfg.freshportal_password = ec_pass
    return cfg


class DeliveryParseRequest(BaseModel):
    raw_json: dict
    supplier_id: str = ""
    with_matching: bool = True


class DeliveryCreateRequest(BaseModel):
    order: dict
    supplier_id: str = ""
    supplier_fp_id: str = ""
    lang: str = "en"


@app.post("/delivery/parse")
def delivery_parse(req: DeliveryParseRequest, _: dict = Depends(require_permission("admin:manage"))):
    """Parse delivery JSON, aggregate products, match against supplier catalogue.

    Request body:
      { raw_json: <the full delivery JSON>, supplier_id: "27", with_matching: true }

    Returns aggregated DeliveryOrder(s) with match results per line.
    """
    log.info("[delivery/parse] starting — supplier=%s with_matching=%s", req.supplier_id, req.with_matching)
    try:
        try:
            orders = parse_delivery_json(req.raw_json)
        except Exception as exc:
            log.exception("[delivery/parse] parse_delivery_json failed")
            raise HTTPException(400, f"Invalid delivery JSON: {exc}")

        if not orders:
            raise HTTPException(400, "No invoices found in JSON")

        log.info("[delivery/parse] parsed %d order(s), loading catalogue…", len(orders))

        # Resolve supplier_id from the parsed order's company name.
        # This ensures we never rely on a hardcoded value from the UI.
        fp_url = get_ecuador_cfg().freshportal_url
        supplier_id = req.supplier_id
        if orders:
            resolved = find_supplier_fp_id(fp_url, orders[0].tx_company)
            if resolved:
                supplier_id = resolved
                log.info("[delivery/parse] resolved supplier_id=%s from tx_company=%r", supplier_id, orders[0].tx_company)
            elif not supplier_id:
                log.warning("[delivery/parse] could not resolve supplier from tx_company=%r", orders[0].tx_company)

        catalogue = []
        cached_matches: dict = {}
        if req.with_matching and supplier_id:
            catalogue = get_catalogue(supplier_id)
            cached_matches = get_delivery_matches(fp_url, supplier_id)
            log.info("[delivery/parse] supplier=%s catalogue=%d items, cached_matches=%d", supplier_id, len(catalogue), len(cached_matches))

        matched_count = 0
        unmatched_count = 0
        new_matches: list[dict] = []

        result_orders = []
        for order in orders:
            if catalogue:
                match_order(order, catalogue, cached_matches)
            d = order_to_dict(order)
            for line in d["lines"]:
                if line.get("fp_product_id"):
                    matched_count += 1
                    key = delivery_key(line.get("nm_variety"), line.get("nu_length"))
                    if key not in cached_matches:
                        new_matches.append({
                            "delivery_key": key,
                            "nm_variety":   line.get("nm_variety"),
                            "nu_length":    line.get("nu_length"),
                            "id_floricode": line.get("id_floricode"),
                            "fp_product_id": line["fp_product_id"],
                            "nm_product":   line.get("catalogue_nm_product"),
                            "match_type":   line.get("match_method", "auto"),
                        })
                else:
                    unmatched_count += 1
            result_orders.append(d)

        log.info("[delivery/parse] done — matched=%d unmatched=%d", matched_count, unmatched_count)
        # Catalogue sent to frontend for inline-edit search (fp_product_id + nm_product only)
        catalogue_slim = [
            {"fp_product_id": e["fp_product_id"], "nm_product": e.get("nm_product") or ""}
            for e in catalogue
            if e.get("fp_product_id") and e.get("nm_product")
        ]
        return {
            "orders": result_orders,
            "supplier_id": supplier_id,
            "catalogue_count": len(catalogue),
            "catalogue": catalogue_slim,
            "matched_count": matched_count,
            "unmatched_count": unmatched_count,
            "cached_matches_used": len(cached_matches),
        }
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("[delivery/parse] unexpected error")
        raise HTTPException(500, f"Internal error: {exc}")


# ---------------------------------------------------------------------------
# Delivery import log  (/delivery/import-log)
# ---------------------------------------------------------------------------

class DeliveryImportLogCreate(BaseModel):
    fp_supplier_id: str | None = None
    tx_company: str | None = None
    id_invoice: str | None = None
    dt_fly: str | None = None
    tx_awb: str | None = None
    nu_boxes: int | None = None
    nu_stems_total: int | None = None
    mny_total: float | None = None
    nu_lines_total: int = 0
    nu_lines_matched: int = 0
    batch_id: str | None = None
    batch_url: str | None = None
    batch_status: str = "ok"
    nm_user: str | None = None
    details: dict | None = None


class DeliveryImportLogUpdate(BaseModel):
    nu_products_added: int | None = None
    nu_products_failed: int | None = None
    nu_products_skipped: int | None = None
    products_status: str = "ok"


@app.post("/delivery/import-log", tags=["delivery"])
def delivery_import_log_create(
    req: DeliveryImportLogCreate,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Log a new delivery import (after batch creation)."""
    fp_url = get_ecuador_cfg().freshportal_url
    entry = req.model_dump()
    entry["fp_url"] = fp_url
    log_id = create_delivery_import_log(entry)
    return {"id": log_id}


@app.patch("/delivery/import-log/{log_id}", tags=["delivery"])
def delivery_import_log_update(
    log_id: int,
    req: DeliveryImportLogUpdate,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Update a delivery import log entry with add-products result."""
    update_delivery_import_log(log_id, req.model_dump())
    return {"ok": True}


@app.get("/delivery/import-log", tags=["delivery"])
def delivery_import_log_list(
    limit: int = 20,
    offset: int = 0,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Paginated delivery import history."""
    fp_url = get_ecuador_cfg().freshportal_url
    rows, has_more = get_delivery_import_logs(fp_url, limit=limit, offset=offset)
    # Serialize datetime fields
    for r in rows:
        if r.get("created_at") and hasattr(r["created_at"], "isoformat"):
            r["created_at"] = r["created_at"].isoformat()
    return {"history": rows, "hasMore": has_more}


@app.post("/dev/token", tags=["dev"])
def dev_token():
    """Generate a short-lived JWT with all permissions for local/API testing.

    Only works when DEV_ALLOW_TOKEN_ENDPOINT=true is set in the environment.
    Never enable this on production without that guard.
    """
    if os.getenv("DEV_ALLOW_TOKEN_ENDPOINT", "").lower() != "true":
        raise HTTPException(403, "DEV_ALLOW_TOKEN_ENDPOINT is not enabled")
    secret = os.getenv("AUTH_SECRET", "")
    if not secret:
        raise HTTPException(500, "AUTH_SECRET is not set")
    from jose import jwt as _jwt
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc)
    payload = {
        "sub": "dev",
        "username": "dev",
        "permissions": ["vbn:check", "vbn:fix", "products:create", "photos:upload", "admin:manage"],
        "iat": int(now.timestamp()),
        "exp": int((now + _dt.timedelta(hours=1)).timestamp()),
    }
    token = _jwt.encode(payload, secret, algorithm="HS256")
    return {"access_token": token, "token_type": "bearer", "expires_in": 3600}


@app.post("/delivery/catalogue/sync")
def delivery_catalogue_sync(
    supplier_id: str = "27",
    _: dict = Depends(require_permission("admin:manage")),
):
    """Trigger synchronous scrape of supplier catalogue from Ecuador FP.

    Stores results in supplier_catalogue table in DB.
    """
    cfg = get_ecuador_cfg()
    try:
        cfg.validate()
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    messages: list[str] = []

    def on_status(msg: str) -> None:
        log.info("[catalogue sync] %s", msg)
        messages.append(msg)

    try:
        items = fetch_supplier_catalogue(int(supplier_id), cfg, on_status=on_status)
        saved = upsert_catalogue_items(supplier_id, items)
        return {
            "ok": True,
            "items_scraped": len(items),
            "items_saved": saved,
            "supplier_id": supplier_id,
            "messages": messages,
        }
    except Exception as exc:
        log.exception("catalogue sync failed")
        raise HTTPException(500, str(exc))


@app.post("/delivery/catalogue/sync/stream")
async def delivery_catalogue_sync_stream(
    supplier_id: str = "27",
    _: dict = Depends(require_permission("admin:manage")),
):
    """SSE-streaming version of catalogue sync."""
    cfg = get_ecuador_cfg()
    try:
        cfg.validate()
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    queue: Queue = Queue()

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            items = fetch_supplier_catalogue(int(supplier_id), cfg, on_status=on_status)
            saved = upsert_catalogue_items(supplier_id, items)
            queue.put({"type": "result", "data": {
                "ok": True,
                "items_scraped": len(items),
                "items_saved": saved,
                "supplier_id": supplier_id,
            }})
        except Exception as exc:
            log.exception("catalogue sync stream failed")
            queue.put({"type": "error", "message": str(exc)})

    threading.Thread(target=run, daemon=True).start()

    async def generate():
        yield ": connected\n\n"
        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            if item.get("type") in ("result", "error"):
                break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.get("/delivery/catalogue/{supplier_id}")
def delivery_catalogue_get(
    supplier_id: str,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Return stored catalogue for a supplier from DB."""
    items = get_catalogue(supplier_id)
    return {
        "supplier_id": supplier_id,
        "count": len(items),
        "last_sync": get_catalogue_last_sync(supplier_id),
        "items": items,
    }


class BatchCreateRequest(BaseModel):
    order: dict
    supplier_id: str = ""
    supplier_fp_id: str = ""


@app.post("/delivery/create-batch")
async def delivery_create_batch(
    req: BatchCreateRequest,
    _: dict = Depends(require_permission("admin:manage")),
):
    """SSE stream: create a FreshPortal batch header via direct HTTP POST.

    Much faster than the Playwright UI path — logs in once with Playwright to
    get session cookies, then POSTs form data directly with httpx.

    Request body:
      { order: <order dict from /delivery/parse>,
        supplier_id: "27",        # used for batch-list lookup
        supplier_fp_id: "27"      # value sent as supplier[] in the form POST
      }

    Returns SSE events: data: <status line>  +  data: DONE <json result>
    """
    from scraper_delivery import create_batch_header
    from parser_delivery import DeliveryOrder, DeliveryLine

    cfg = get_ecuador_cfg()
    try:
        cfg.validate()
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    raw = req.order
    try:
        lines = [
            DeliveryLine(
                gu_product=l.get("gu_product", ""),
                nm_variety=l.get("nm_variety", ""),
                nm_species=l.get("nm_species", ""),
                nu_length=int(l.get("nu_length") or 0),
                nu_stems_bunch=int(l.get("nu_stems_bunch") or 0),
                nu_bunches=int(l.get("nu_bunches") or 0),
                mny_rate_stem=float(l.get("mny_rate_stem") or 0),
                id_floricode=l.get("id_floricode", ""),
                nm_product=l.get("nm_product", ""),
                nm_box=l.get("nm_box", ""),
                fp_product_id=l.get("fp_product_id", ""),
                match_method=l.get("match_method", "none"),
                catalogue_nm_product=l.get("catalogue_nm_product", ""),
            )
            for l in raw.get("lines", [])
        ]
        order = DeliveryOrder(
            tx_company=raw.get("tx_company", ""),
            nm_location=raw.get("nm_location", ""),
            id_invoice=raw.get("id_invoice", ""),
            id_purchaseorder=raw.get("id_purchaseorder", ""),
            dt_fly=raw.get("dt_fly", ""),
            dt_invoice=raw.get("dt_invoice", ""),
            nm_ship=raw.get("nm_ship", ""),
            nm_cargo=raw.get("nm_cargo", ""),
            tx_awb=raw.get("tx_awb", ""),
            tx_hawb=raw.get("tx_hawb", ""),
            nu_boxes=int(raw.get("nu_boxes") or 0),
            nu_stems_total=int(raw.get("nu_stems_total") or 0),
            mny_total=float(raw.get("mny_total") or 0),
            lines=lines,
        )
    except Exception as exc:
        raise HTTPException(400, f"Invalid order data: {exc}")

    # Resolve supplier_fp_id: explicit → DB lookup by tx_company → fallback to request default
    supplier_fp_id = req.supplier_fp_id
    if not supplier_fp_id:
        supplier_fp_id = find_supplier_fp_id(cfg.freshportal_url, order.tx_company)
    if not supplier_fp_id:
        supplier_fp_id = req.supplier_id

    q: Queue = Queue()

    def _run():
        try:
            result = create_batch_header(
                order=order,
                cfg=cfg,
                supplier_fp_id=supplier_fp_id,
                on_status=lambda msg: q.put({"type": "status", "message": msg}),
            )
            q.put({"type": "result", "data": result})
        except Exception as exc:
            log.exception("delivery/create-batch failed")
            q.put({"type": "error", "message": str(exc)})

    threading.Thread(target=_run, daemon=True).start()

    async def _generate():
        yield ": connected\n\n"
        while True:
            try:
                item = q.get_nowait()
            except Empty:
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            if item.get("type") in ("result", "error"):
                break

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


class AddProductsRequest(BaseModel):
    batch_id: str
    order: dict


@app.post("/delivery/add-products")
async def delivery_add_products(
    req: AddProductsRequest,
    _: dict = Depends(require_permission("admin:manage")),
):
    """SSE stream: add matched product lines to an existing FreshPortal batch.

    Request body:
      { batch_id: "12345", order: <order dict with matched lines> }

    Each line in order.lines must have: fp_product_id, catalogue_nm_product,
    nu_length, nu_stems_bunch, nu_bunches, mny_rate_stem.
    Lines without fp_product_id are skipped (unmatched).
    """
    from scraper_delivery import add_products_to_batch

    cfg = get_ecuador_cfg()
    try:
        cfg.validate()
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    raw = req.order
    matched_lines = [
        {
            "fp_product_id":        l.get("fp_product_id", ""),
            "nm_variety":           l.get("nm_variety", ""),
            "catalogue_nm_product": l.get("catalogue_nm_product", ""),
            "nu_length":            int(l.get("nu_length") or 0),
            "nu_stems_bunch":       int(l.get("nu_stems_bunch") or 0),
            "nu_bunches":           int(l.get("nu_bunches") or 0),
            "mny_rate_stem":        float(l.get("mny_rate_stem") or 0),
            "nm_box":               l.get("nm_box", ""),
        }
        for l in raw.get("lines", [])
    ]

    q: Queue = Queue()

    def _run():
        try:
            result = add_products_to_batch(
                batch_id=req.batch_id,
                matched_lines=matched_lines,
                cfg=cfg,
                on_status=lambda msg: q.put({"type": "status", "message": msg}),
            )
            q.put({"type": "result", "data": result})
        except Exception as exc:
            log.exception("delivery/add-products failed")
            q.put({"type": "error", "message": str(exc)})

    threading.Thread(target=_run, daemon=True).start()

    async def _generate():
        yield ": connected\n\n"
        while True:
            try:
                item = q.get_nowait()
            except Empty:
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            if item.get("type") in ("result", "error"):
                break

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.post("/delivery/create/stream")
async def delivery_create_stream(
    req: DeliveryCreateRequest,
    _: dict = Depends(require_permission("admin:manage")),
):
    """SSE stream: create batch + add product lines in Ecuador FreshPortal.

    Request body:
      { order: <order dict from /delivery/parse>, supplier_id: "27",
        supplier_fp_id: "<select value>", lang: "en" }

    The order.lines must include fp_product_id for matched lines.
    """
    cfg = get_ecuador_cfg()
    try:
        cfg.validate()
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    # Reconstruct DeliveryOrder from dict for the scraper
    from parser_delivery import DeliveryOrder, DeliveryLine
    raw = req.order
    try:
        lines = [
            DeliveryLine(
                gu_product=l.get("gu_product", ""),
                nm_variety=l.get("nm_variety", ""),
                nm_species=l.get("nm_species", ""),
                nu_length=int(l.get("nu_length") or 0),
                nu_stems_bunch=int(l.get("nu_stems_bunch") or 0),
                nu_bunches=int(l.get("nu_bunches") or 0),
                mny_rate_stem=float(l.get("mny_rate_stem") or 0),
                id_floricode=l.get("id_floricode", ""),
                nm_product=l.get("nm_product", ""),
                nm_box=l.get("nm_box", ""),
                fp_product_id=l.get("fp_product_id", ""),
                match_method=l.get("match_method", "none"),
                catalogue_nm_product=l.get("catalogue_nm_product", ""),
            )
            for l in raw.get("lines", [])
        ]
        order = DeliveryOrder(
            tx_company=raw.get("tx_company", ""),
            nm_location=raw.get("nm_location", ""),
            id_invoice=raw.get("id_invoice", ""),
            id_purchaseorder=raw.get("id_purchaseorder", ""),
            dt_fly=raw.get("dt_fly", ""),
            dt_invoice=raw.get("dt_invoice", ""),
            nm_ship=raw.get("nm_ship", ""),
            nm_cargo=raw.get("nm_cargo", ""),
            tx_awb=raw.get("tx_awb", ""),
            tx_hawb=raw.get("tx_hawb", ""),
            nu_boxes=int(raw.get("nu_boxes") or 0),
            nu_stems_total=int(raw.get("nu_stems_total") or 0),
            mny_total=float(raw.get("mny_total") or 0),
            lines=lines,
        )
    except Exception as exc:
        raise HTTPException(400, f"Invalid order payload: {exc}")

    matched_lines = [
        {
            "fp_product_id": l.fp_product_id,
            "nu_bunches": l.nu_bunches,
            "nu_stems_bunch": l.nu_stems_bunch,
            "mny_rate_stem": l.mny_rate_stem,
            "nm_variety": l.nm_variety,
            "nu_length": l.nu_length,
        }
        for l in lines
    ]

    queue: Queue = Queue()

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            result = add_delivery(
                order=order,
                matched_lines=matched_lines,
                cfg=cfg,
                supplier_fp_id=req.supplier_fp_id,
                on_status=on_status,
            )
            queue.put({"type": "result", "data": result})
        except Exception as exc:
            log.exception("delivery/create/stream failed")
            queue.put({"type": "error", "message": str(exc)})

    threading.Thread(target=run, daemon=True).start()

    async def generate():
        yield ": connected\n\n"
        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            if item.get("type") in ("result", "error"):
                break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.get("/delivery/debug-match")
def delivery_debug_match(
    variety: str,
    nu_length: int = 0,
    supplier_id: str = "27",
    _: dict = Depends(require_permission("admin:manage")),
):
    """Debug matching for a single variety name against the catalogue.

    Returns top 5 catalogue entries with their _variety_sim() scores so you
    can see why something matches or doesn't.

    Example: GET /delivery/debug-match?variety=Veggie&nu_length=60&supplier_id=27
    """
    from parser_delivery import _variety_sim, _extract_variety, _norm

    catalogue = get_catalogue(supplier_id)
    if not catalogue:
        return {"error": f"No catalogue for supplier_id={supplier_id}"}

    scored = []
    for e in catalogue:
        nm = e.get("nm_product") or ""
        s = _variety_sim(variety, nm)
        scored.append({
            "fp_product_id": e.get("fp_product_id"),
            "nm_product": nm,
            "nu_length": e.get("nu_length"),
            "extracted_variety": _extract_variety(nm),
            "delivery_norm": _norm(variety),
            "sim": round(s, 4),
        })

    scored.sort(key=lambda x: -x["sim"])
    top = scored[:10]
    exact_len = [x for x in top if x["nu_length"] == nu_length]

    return {
        "delivery_variety": variety,
        "nu_length": nu_length,
        "catalogue_size": len(catalogue),
        "top_10_by_sim": top,
        "top_10_at_length": [x for x in scored if x["nu_length"] == nu_length][:10],
        "would_match": exact_len[0] if exact_len and exact_len[0]["sim"] >= 0.80 else None,
    }


@app.get("/delivery/debug-form")
def delivery_debug_form(_: dict = Depends(require_permission("admin:manage"))):
    """Explore /batch_v2/form/add/ form structure in Ecuador FP."""
    cfg = get_ecuador_cfg()
    return explore_delivery_form(cfg)


@app.get("/delivery/debug-stock/{batch_id}")
def delivery_debug_stock(batch_id: str, _: dict = Depends(require_permission("admin:manage"))):
    """Explore /company_product_add_stock/index/index/BAT_ID/{batch_id}/ structure."""
    cfg = get_ecuador_cfg()
    return explore_stock_add_form(batch_id, cfg)


# ---------------------------------------------------------------------------
# Catalogue module  (/catalogue/...)
# ---------------------------------------------------------------------------

@app.get("/catalogue/{supplier_id}/matches")
def catalogue_get_matches(
    supplier_id: str,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Return all cached delivery→catalogue product matches for a supplier."""
    fp_url = get_ecuador_cfg().freshportal_url
    matches = get_delivery_matches(fp_url, supplier_id)
    return {"matches": list(matches.values()), "count": len(matches)}


class DeliveryMatchRequest(BaseModel):
    delivery_key: str
    nm_variety: str | None = None
    nu_length: int | None = None
    fp_product_id: str
    nm_product: str | None = None


@app.put("/catalogue/{supplier_id}/matches")
def catalogue_set_match(
    supplier_id: str,
    req: DeliveryMatchRequest,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Manually create or override a cached match (marks as 'manual', never auto-overwritten)."""
    fp_url = get_ecuador_cfg().freshportal_url
    set_delivery_match(fp_url, supplier_id, req.delivery_key,
                       req.nm_variety, req.nu_length, req.fp_product_id, req.nm_product)
    return {"ok": True}


class ApproveMatchesRequest(BaseModel):
    matches: list[dict]  # [{delivery_key, nm_variety, nu_length, id_floricode, fp_product_id, nm_product, match_type}]


@app.post("/catalogue/{supplier_id}/matches/approve")
def catalogue_approve_matches(
    supplier_id: str,
    req: ApproveMatchesRequest,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Save a batch of user-approved delivery→product matches to cache.

    Called after user reviews the preview table and approves individual rows or
    after a successful add-products import. Approved matches are used as cache
    hits in future parses (shown with 'cached' badge, skip algorithm).
    """
    fp_url = get_ecuador_cfg().freshportal_url
    saved = save_delivery_matches(fp_url, supplier_id, req.matches, approved=True)
    return {"saved": saved}


@app.delete("/catalogue/{supplier_id}/matches")
def catalogue_clear_all_matches(
    supplier_id: str,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Delete ALL cached delivery→catalogue matches for a supplier."""
    fp_url = get_ecuador_cfg().freshportal_url
    deleted = clear_delivery_matches(fp_url, supplier_id)
    return {"deleted": deleted}


@app.delete("/catalogue/{supplier_id}/matches/{delivery_key}")
def catalogue_delete_match(
    supplier_id: str,
    delivery_key: str,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Delete a single cached match so the next parse re-runs live matching."""
    fp_url = get_ecuador_cfg().freshportal_url
    deleted = delete_delivery_match(fp_url, supplier_id, delivery_key)
    return {"deleted": deleted}


@app.get("/catalogue/suppliers")
def catalogue_suppliers(
    refresh: bool = False,
    debug: bool = False,
    _: dict = Depends(require_permission("admin:manage")),
    cfg: Config = Depends(get_cfg),
):
    """Return supplier list with catalogue sync status.

    Serves from DB cache by default.  Pass ?refresh=true to re-scrape
    and update the cache.  ?debug=true adds page diagnostics (same
    Playwright session — no extra memory cost).
    """
    fp_url = cfg.freshportal_url
    debug_payload: dict = {}

    if not refresh:
        cached = get_suppliers(fp_url)
        if cached:
            return {"suppliers": cached, "source": "db"}

    # Need to scrape (first load or forced refresh)
    try:
        result = fetch_supplier_list(cfg, debug=debug)
    except Exception as exc:
        raise HTTPException(502, f"Could not fetch supplier list: {exc}")

    if debug:
        scraped: list[dict] = result.get("parsed_suppliers", [])  # type: ignore[union-attr]
        debug_payload = {k: v for k, v in result.items() if k != "parsed_suppliers"}  # type: ignore[union-attr]
    else:
        scraped = result  # type: ignore[assignment]

    # Persist to DB
    upsert_suppliers(fp_url, scraped)

    # Return with catalogue sync status (from DB join)
    suppliers = get_suppliers(fp_url)

    response: dict = {"suppliers": suppliers, "source": "scraped"}
    if debug:
        response["debug"] = debug_payload
    return response


@app.get("/catalogue/{supplier_id}/status")
def catalogue_status(supplier_id: str, _: dict = Depends(require_permission("admin:manage"))):
    """Return sync status for a single supplier from DB (no scraping)."""
    meta = get_supplier_meta_one(supplier_id)
    if not meta:
        return {"supplier_id": supplier_id, "synced": False, "item_count": 0, "synced_at": None}
    return {**meta, "synced": bool(meta.get("synced_at"))}


@app.post("/catalogue/sync/{supplier_id}/stream")
def catalogue_sync_stream(
    supplier_id: str,
    nm_supplier: str = "",
    _: dict = Depends(require_permission("admin:manage")),
    cfg: Config = Depends(get_cfg),
):
    """SSE stream: scrape the full catalogue for supplier_id and save to DB.

    Query params:
      nm_supplier  — display name (stored in catalogue_meta)
    """
    queue: Queue = Queue()

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            on_status(f"Starting catalogue sync for supplier {supplier_id}…")
            items = fetch_supplier_catalogue(supplier_id, cfg, on_status=on_status)
            on_status(f"Saving {len(items)} items to database…")
            saved = sync_supplier_catalogue(
                supplier_id,
                nm_supplier or supplier_id,
                cfg.freshportal_url,
                items,
            )
            queue.put({"type": "result", "data": {
                "supplier_id": supplier_id,
                "items_saved": saved,
                "synced": True,
            }})
        except Exception as exc:
            log.exception("catalogue/sync/%s/stream failed", supplier_id)
            queue.put({"type": "error", "message": str(exc)})

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    async def generate():
        yield ": connected\n\n"
        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            if item.get("type") in ("result", "error"):
                break
        thread.join(timeout=10)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.get("/catalogue/{supplier_id}/items")
def catalogue_items(
    supplier_id: str,
    _: dict = Depends(require_permission("admin:manage")),
):
    """Return all catalogue items for a supplier from DB."""
    items = get_supplier_catalogue(supplier_id)
    return {"supplier_id": supplier_id, "items": items, "count": len(items)}




# ---------------------------------------------------------------------------
# Fust (packaging) catalogue  (/fust/...)
# ---------------------------------------------------------------------------

@app.post("/fust/sync")
async def fust_sync(
    _: dict = Depends(require_permission("admin:manage")),
    cfg: Config = Depends(get_cfg),
):
    """SSE stream: scrape all fust (packaging) entries from /fust/index/index/ and save to DB."""
    queue: Queue = Queue()

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            on_status("Scraping fust catalogue…")
            entries = fetch_fust_catalogue(cfg, on_status=on_status)
            on_status(f"Saving {len(entries)} fust entries to database…")
            saved = upsert_fust_entries(cfg.freshportal_url, entries)
            queue.put({"type": "result", "data": {
                "fp_url": cfg.freshportal_url,
                "entries_saved": saved,
            }})
        except Exception as exc:
            log.exception("fust/sync failed")
            queue.put({"type": "error", "message": str(exc)})

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    async def generate():
        yield ": connected\n\n"
        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                yield ": k\n\n"
                await asyncio.sleep(0.2)
                continue
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
            if item.get("type") in ("result", "error"):
                break
        thread.join(timeout=10)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.get("/fust/list")
def fust_list(
    _: dict = Depends(require_permission("admin:manage")),
    cfg: Config = Depends(get_cfg),
):
    """Return all fust entries for this FreshPortal instance from DB."""
    fp_url = cfg.freshportal_url
    entries = get_all_fust(fp_url)
    return {"fp_url": fp_url, "entries": entries, "count": len(entries)}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
