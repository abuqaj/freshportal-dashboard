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
from scraper_vbn import lookup_vbn_codes, get_colour_vbn_table, invalidate_colour_table, search_vbn_by_name
from verifier import verify_products, KNOWN_VBN
from photo_uploader import run as run_photo_uploader

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="FreshPortal API", version="1.0.0")

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
