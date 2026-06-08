#!/usr/bin/env python3
"""FastAPI server — exposes VBN check, VBN fix, and photo upload over HTTP.
Deployed on Railway; called directly by the browser (CORS allowed)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import tempfile
import threading
from pathlib import Path
from queue import Empty, Queue

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent))

from config import Config
from scraper_fp import fetch_products, fix_vbn_batch, _debug_fetch, _debug_rendered
from product_creator import ProductMatch, search_products, find_best_template, copy_and_create
from scraper_vbn import lookup_vbn_codes, get_colour_vbn_table, invalidate_colour_table, search_vbn_by_name
from verifier import verify_products, KNOWN_VBN
from photo_uploader import run as run_photo_uploader
from ai_helper import ai_analyze_product

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="FreshPortal API", version="1.0.0")


@app.on_event("startup")
async def _warm_colour_table() -> None:
    """Pre-build colour VBN table in background thread on startup."""
    def _build():
        cfg = Config()
        if cfg.floricode_username and cfg.floricode_password:
            log.info("Warming colour VBN table on startup…")
            table = get_colour_vbn_table(cfg.floricode_username, cfg.floricode_password)
            log.info("Colour VBN table ready: %d genera", len(table))
    import threading
    threading.Thread(target=_build, daemon=True).start()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class VbnCheckRequest(BaseModel):
    vbn: str


class FixItem(BaseModel):
    product_id: str
    new_vbn: str


class VbnFixRequest(BaseModel):
    fixes: list[FixItem]


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


def _fetch_all_products(vbn_codes: list[str], cfg: Config, on_status=None) -> list:
    """Fetch products for all VBN codes, deduplicated by product_id."""
    all_products = []
    seen_ids: set[str] = set()
    total = len(vbn_codes)
    for i, code in enumerate(vbn_codes, 1):
        if on_status and total > 1:
            on_status(f"Pobieranie VBN {code} ({i}/{total})…")
        products = fetch_products(code, cfg, on_status=on_status if total == 1 else None)
        for p in products:
            if p.product_id not in seen_ids:
                seen_ids.add(p.product_id)
                all_products.append(p)
    return all_products


def _build_result(products, cfg: Config, queue: Queue | None = None) -> dict:
    """Run VBN lookup + verification and return result dict."""
    def _status(msg: str) -> None:
        if queue:
            queue.put({"type": "status", "message": msg})

    if not products:
        return {"results": [], "stats": {"total": 0, "errors": 0, "warnings": 0, "ok": 0}}

    unique_vbns = sorted({p.vbn_number for p in products if p.vbn_number})
    _status(f"Weryfikacja {len(unique_vbns)} kodów VBN w Floricode…")

    vbn_data = lookup_vbn_codes(
        unique_vbns,
        request_timeout=cfg.request_timeout,
        floricode_username=cfg.floricode_username,
        floricode_password=cfg.floricode_password,
    )

    _status("Analiza wyników…")
    results = verify_products(products, vbn_data, cfg)

    # Fetch names for proposed VBN codes not already in vbn_data
    proposed_codes = {
        r.proposed_vbn for r in results
        if r.proposed_vbn and r.proposed_vbn not in vbn_data
    }
    if proposed_codes:
        _status("Pobieranie nazw proponowanych kodów VBN…")
        extra = lookup_vbn_codes(
            list(proposed_codes),
            request_timeout=cfg.request_timeout,
            floricode_username=cfg.floricode_username,
            floricode_password=cfg.floricode_password,
        )
        vbn_data.update(extra)

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


@app.post("/vbn-check")
def vbn_check(req: VbnCheckRequest):
    """Non-streaming VBN check (kept for backwards compat)."""
    cfg = Config()
    cfg.vbn_to_check = req.vbn
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        products = fetch_products(req.vbn, cfg)
        return _build_result(products, cfg)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/vbn-check/stream")
async def vbn_check_stream(req: VbnCheckRequest):
    """Streaming SSE endpoint — pushes progress messages then final result."""
    cfg = Config()
    cfg.vbn_to_check = req.vbn
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    queue: Queue = Queue()

    vbn_codes = _parse_vbn_codes(req.vbn)

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            products = _fetch_all_products(vbn_codes, cfg, on_status=on_status)
            data = _build_result(products, cfg, queue)
            queue.put({"type": "result", "data": data})
        except Exception as e:
            log.exception("vbn-check/stream failed")
            queue.put({"type": "error", "message": str(e)})

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
def vbn_fix(req: VbnFixRequest):
    cfg = Config()
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
async def vbn_fix_stream(req: VbnFixRequest):
    """Streaming SSE endpoint for VBN fix — pushes per-product progress."""
    cfg = Config()
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

            results = fix_vbn_batch(fixes, cfg, on_status=on_status)
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


@app.post("/photo-upload")
async def photo_upload(xlsx: UploadFile = File(...)):
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
def vbn_search_endpoint(q: str, limit: int = 8):
    """Search VBN codes by name words. q='dianthus solex' finds VBNs containing both words."""
    cfg = Config()
    results = search_vbn_by_name(q, cfg.floricode_username, cfg.floricode_password, limit=limit)
    return {"results": results}


@app.get("/vbn-name/{code}")
def get_vbn_name(code: str):
    """Return the official Floricode name for a single VBN code."""
    cfg = Config()
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


class ProductCreateRequest(BaseModel):
    template_id: str
    new_name: str


class AIAnalyzeRequest(BaseModel):
    name: str
    candidates: list[dict]


@app.post("/product-search")
def product_search(req: ProductSearchRequest):
    cfg = Config()
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
        }
        for m in matches
    ]


@app.post("/product-search/stream")
async def product_search_stream(req: ProductSearchRequest):
    """SSE stream: status messages while searching, then result."""
    cfg = Config()
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(400, str(e))

    queue: Queue = Queue()

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            matches = search_products(req.name, cfg, on_status=on_status)
            queue.put({"type": "result", "data": {"results": _matches_to_results(matches)}})
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


@app.post("/product-ai-analyze")
def product_ai_analyze(req: AIAnalyzeRequest):
    """Duplicate check + VBN suggestion via Claude Haiku (single call)."""
    cfg = Config()
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
    result = ai_analyze_product(req.name, candidates, cfg)
    if result is None:
        return {
            "duplicate": {"found": False, "reason": "AI analysis failed"},
            "vbn": {"code": None, "explanation": "AI analysis failed"},
        }
    return result


@app.post("/product-create/stream")
async def product_create_stream(req: ProductCreateRequest):
    """SSE stream: copies template product, renames it, returns result."""
    cfg = Config()
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(400, str(e))

    queue: Queue = Queue()

    def run() -> None:
        try:
            def on_status(msg: str) -> None:
                queue.put({"type": "status", "message": msg})

            result = copy_and_create(req.template_id, req.new_name, cfg, on_status=on_status)
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
def debug_colour_table():
    """Show the colour VBN table (genera and their kleurbehandeld codes)."""
    cfg = Config()
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
def refresh_colour_table():
    """Force rebuild of colour VBN table from Floricode API."""
    invalidate_colour_table()
    cfg = Config()
    table = get_colour_vbn_table(cfg.floricode_username, cfg.floricode_password)
    return {"ok": True, "genera_count": len(table), "total_entries": sum(len(v) for v in table.values())}


@app.get("/debug/product-row/{product_id}")
def debug_product_row(product_id: str):
    """Return every link and button found in a product row — used to discover copy UI."""
    from scraper_fp import _launch_browser, _block_resources, _login, _goto_and_wait
    from playwright.sync_api import sync_playwright

    cfg = Config()
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
def debug_product_copy_flow(product_id: str):
    """Simulate clicking the copy button and return what's on the page afterwards."""
    from scraper_fp import _launch_browser, _login
    from playwright.sync_api import sync_playwright
    import time as _time

    cfg = Config()
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
            rows[0].click()
            _time.sleep(0.8)
            result["steps"].append("clicked row to select")

            copy_loc = None
            for sel in ["fps-button[name='button_copy']", "#btn_product_index_index_button_copy", "fps-button[type='copy']"]:
                loc = page.locator(sel)
                if loc.count() > 0:
                    copy_loc = loc
                    result["steps"].append(f"found copy button: {sel}")
                    break
            if not copy_loc:
                result["steps"].append("ERROR: copy button not found")
                return result

            # Pierce Shadow DOM
            inner = copy_loc.locator("button")
            if inner.count() > 0:
                inner.click()
                result["steps"].append("clicked inner shadow-dom button")
            else:
                copy_loc.click(force=True)
                result["steps"].append("clicked outer fps-button (force)")
            _time.sleep(4)

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


@app.get("/debug/product-add-page")
def debug_product_add_page():
    """Return the HTML of the add-product page so we can see its form fields."""
    from scraper_fp import _launch_browser, _block_resources, _login
    from playwright.sync_api import sync_playwright

    cfg = Config()
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
def debug_fp(vbn: str = "580"):
    cfg = Config()
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _debug_fetch(cfg, vbn)


@app.get("/debug/fp-rendered")
def debug_fp_rendered(vbn: str = "580"):
    cfg = Config()
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _debug_rendered(cfg, vbn)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
