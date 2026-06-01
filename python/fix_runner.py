#!/usr/bin/env python3
"""
Bridge script to apply VBN fixes.
Usage: python fix_runner.py --fixes '[{"product_id":"123","new_vbn":"595"}]'
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from config import Config
from scraper_fp import fix_vbn_batch
import logging
logging.basicConfig(level=logging.WARNING)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--fixes", required=True)
    args = p.parse_args()

    cfg = Config()
    try:
        cfg.validate()
    except ValueError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    fixes_raw = json.loads(args.fixes)
    fixes = [(f["product_id"], f["new_vbn"]) for f in fixes_raw]

    try:
        results = fix_vbn_batch(fixes, cfg)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    fixed = sum(1 for ok in results.values() if ok)
    failed = len(results) - fixed
    print(json.dumps({
        "results": results,
        "fixed": fixed,
        "failed": failed,
    }))

if __name__ == "__main__":
    main()
