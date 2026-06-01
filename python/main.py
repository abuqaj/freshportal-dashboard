#!/usr/bin/env python3
"""VBN Checker — verifies VBN product codes in FreshPortal against vbn.nl."""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

# Force UTF-8 output on Windows to avoid cp1252 encoding errors
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from config import Config, config
from reporter import generate_report
from scraper_fp import fetch_products, fix_vbn_batch
from scraper_vbn import lookup_vbn_codes
from verifier import verify_products

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("main")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Verify VBN codes in FreshPortal")
    p.add_argument(
        "--vbn",
        default=None,
        help="VBN code to check (overrides .env VBN_TO_CHECK)",
    )
    p.add_argument(
        "--fix",
        action="store_true",
        help="Automatically fix incorrect VBN codes in FreshPortal",
    )
    p.add_argument(
        "--output",
        default=None,
        help="Output Excel path (default: vbn_report_<VBN>_<datetime>.xlsx)",
    )
    p.add_argument(
        "--headless",
        action="store_true",
        default=True,
        help="Run browsers in headless mode (default: True)",
    )
    p.add_argument(
        "--visible",
        action="store_true",
        default=False,
        help="Run browsers in visible mode (useful for debugging)",
    )
    p.add_argument(
        "--fix-from-excel",
        default=None,
        metavar="XLSX",
        help="Read fixes from 'Proponowany VBN' column in an Excel report and apply them",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    cfg = Config()
    if args.vbn:
        cfg.vbn_to_check = args.vbn

    try:
        cfg.validate()
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        print("Please fill in the .env file in the vbn_checker directory.", file=sys.stderr)
        return 1

    if args.fix_from_excel:
        import pandas as pd
        df = pd.read_excel(args.fix_from_excel, sheet_name="Błędy")
        fixable = []
        for _, row in df.iterrows():
            proposed = row.get("Proponowany VBN")
            product_id = row.get("ID produktu")
            if pd.notna(proposed) and str(proposed).strip() and pd.notna(product_id):
                fixable.append((str(int(float(product_id))), str(int(float(proposed)))))
        if not fixable:
            print("Brak poprawek w Excel (kolumna 'Proponowany VBN' jest pusta).")
            return 1
        print(f"\n[FIX] Applying {len(fixable)} fixes from {args.fix_from_excel}...")
        for pid, vbn in fixable:
            print(f"  id={pid} -> {vbn}")
        fix_results = fix_vbn_batch(fixable, cfg)
        fixed = sum(1 for ok in fix_results.values() if ok)
        failed = len(fix_results) - fixed
        print()
        for short_name, ok in fix_results.items():
            print(f"  [{'OK' if ok else 'FAILED'}] {short_name}")
        print(f"\n[FIX] Done: {fixed} fixed, {failed} failed")
        return 0 if not failed else 3

    vbn_filters = [v.strip() for v in cfg.vbn_to_check.split(",") if v.strip()]
    total_errors = 0

    for vbn_filter in vbn_filters:
        if len(vbn_filters) > 1:
            print(f"\n{'='*50}")
        try:
            n_errors = _check_vbn(vbn_filter, args, cfg)
            total_errors += n_errors
        except Exception as exc:
            logger.error("Failed processing VBN filter '%s': %s", vbn_filter, exc)
            total_errors += 1

    if len(vbn_filters) > 1:
        print(f"\n{'='*50}")
        print(f"SUMMARY: checked {len(vbn_filters)} VBN filters, total errors: {total_errors}")

    return 0 if not total_errors else 2


def _check_vbn(vbn_filter: str, args, cfg) -> int:
    """Run the full check for one VBN filter. Returns number of errors found."""
    print(f"\n=== VBN Checker ===")
    print(f"Checking VBN filter: {vbn_filter}")
    print(f"FreshPortal: {cfg.freshportal_url}\n")

    print("[1/4] Fetching products from FreshPortal...")
    products = fetch_products(vbn_filter, cfg)

    if not products:
        print("No products found. Check your VBN filter and credentials.")
        return 0

    print(f"      Found {len(products)} products")

    unique_vbns = sorted({p.vbn_number for p in products if p.vbn_number})
    print(f"\n[2/4] Found {len(unique_vbns)} unique VBN codes: {', '.join(unique_vbns)}")

    print("\n[3/4] Looking up VBN codes on vbn.nl (with cache)...")
    vbn_data = lookup_vbn_codes(
        unique_vbns,
        request_timeout=cfg.request_timeout,
        floricode_username=cfg.floricode_username,
        floricode_password=cfg.floricode_password,
    )

    for code, info in vbn_data.items():
        if info.found:
            print(f"      VBN {code:>7} -> {info.official_name} ({info.product_group})")
        else:
            print(f"      VBN {code:>7} -> NOT FOUND")

    print("\n[4/4] Verifying products...")
    results = verify_products(products, vbn_data, cfg)

    errors = [r for r in results if r.status == "ERROR"]
    warnings = [r for r in results if r.status == "WARNING"]
    ok = [r for r in results if r.status == "OK"]

    print(f"      OK:       {len(ok)}")
    print(f"      Warnings: {len(warnings)}")
    print(f"      Errors:   {len(errors)}")

    if errors:
        print("\n--- ERRORS ---")
        for r in errors:
            print(f"  [{r.product.short_name}] {r.product.name}")
            print(f"    Current VBN: {r.product.vbn_number}  |  Proposed: {r.proposed_vbn or '?'}")
            print(f"    Reason: {r.reason}")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path(args.output) if args.output else Path(f"vbn_report_{vbn_filter}_{ts}.xlsx")
    generate_report(results, output_path)

    if args.fix and errors:
        fixable = [(r.product.product_id, r.proposed_vbn) for r in errors if r.proposed_vbn]
        print(f"\n[FIX] Attempting to fix {len(fixable)} products in one browser session...")
        fix_results = fix_vbn_batch(fixable, cfg)
        fixed = sum(1 for ok in fix_results.values() if ok)
        failed = len(fix_results) - fixed
        for pid, ok in fix_results.items():
            print(f"  [{'OK' if ok else 'FAILED'}] {pid}")
        print(f"[FIX] Done: {fixed} fixed, {failed} failed")

    return len(errors)


if __name__ == "__main__":
    sys.exit(main())
