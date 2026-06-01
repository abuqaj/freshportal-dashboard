#!/usr/bin/env python3
"""
Bridge script called by Next.js API.
Accepts CLI args and outputs JSON to stdout.
Usage: python vbn_runner.py --vbn 580
"""
from __future__ import annotations
import argparse, json, logging, os, sys
from pathlib import Path

# ensure imports from same directory
sys.path.insert(0, str(Path(__file__).parent))

from config import Config
from scraper_fp import fetch_products, fix_vbn_batch
from scraper_vbn import lookup_vbn_codes
from verifier import verify_products

logging.basicConfig(level=logging.WARNING)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--vbn", required=True)
    args = p.parse_args()

    cfg = Config()
    cfg.vbn_to_check = args.vbn

    try:
        cfg.validate()
    except ValueError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    try:
        products = fetch_products(args.vbn, cfg)
    except Exception as e:
        print(json.dumps({"error": f"FreshPortal fetch failed: {e}"}))
        sys.exit(1)

    if not products:
        print(json.dumps({"products": [], "results": [], "stats": {"total": 0, "errors": 0, "ok": 0}}))
        return

    unique_vbns = sorted({p.vbn_number for p in products if p.vbn_number})
    try:
        vbn_data = lookup_vbn_codes(
            unique_vbns,
            request_timeout=cfg.request_timeout,
            floricode_username=cfg.floricode_username,
            floricode_password=cfg.floricode_password,
        )
    except Exception as e:
        print(json.dumps({"error": f"VBN lookup failed: {e}"}))
        sys.exit(1)

    results = verify_products(products, vbn_data, cfg)

    out = []
    for r in results:
        out.append({
            "product_id": r.product.product_id,
            "short_name": r.product.short_name,
            "name": r.product.name,
            "current_vbn": r.product.vbn_number,
            "official_name": r.vbn_info.official_name if r.vbn_info else "",
            "status": r.status,
            "reason": r.reason,
            "proposed_vbn": r.proposed_vbn,
        })

    stats = {
        "total": len(results),
        "errors": sum(1 for r in results if r.status == "ERROR"),
        "warnings": sum(1 for r in results if r.status == "WARNING"),
        "ok": sum(1 for r in results if r.status == "OK"),
    }

    print(json.dumps({"results": out, "stats": stats}))

if __name__ == "__main__":
    main()
