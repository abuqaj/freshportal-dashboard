#!/usr/bin/env python3
"""FastAPI server — exposes VBN check, VBN fix, and photo upload over HTTP.
Deployed on Railway; called by Next.js API routes on Vercel."""
from __future__ import annotations

import logging
import os
import sys
import tempfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent))

from config import Config
from scraper_fp import fetch_products, fix_vbn_batch
from scraper_vbn import lookup_vbn_codes
from verifier import verify_products
from photo_uploader import run as run_photo_uploader

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="FreshPortal API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
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
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/vbn-check")
def vbn_check(req: VbnCheckRequest):
    cfg = Config()
    cfg.vbn_to_check = req.vbn
    try:
        cfg.validate()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        products = fetch_products(req.vbn, cfg)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"FreshPortal fetch failed: {e}")

    if not products:
        return {"results": [], "stats": {"total": 0, "errors": 0, "warnings": 0, "ok": 0}}

    unique_vbns = sorted({p.vbn_number for p in products if p.vbn_number})
    try:
        vbn_data = lookup_vbn_codes(
            unique_vbns,
            request_timeout=cfg.request_timeout,
            floricode_username=cfg.floricode_username,
            floricode_password=cfg.floricode_password,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VBN lookup failed: {e}")

    results = verify_products(products, vbn_data, cfg)

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

    return {"success": True, "message": "Photo upload completed. Sprawdź logi serwera po szczegóły."}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
