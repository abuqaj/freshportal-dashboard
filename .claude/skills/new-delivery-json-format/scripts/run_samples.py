#!/usr/bin/env python3
"""Run delivery import's real parser over sample files and summarise the result.

  python .claude/skills/new-delivery-json-format/scripts/run_samples.py PATH [PATH…]
         [--save-baseline FILE] [--compare FILE]

PATH is a .json/.txt file or a folder of them. --save-baseline writes the
summary; a later --compare against it shows what a parser change did to
samples that already worked. Exit code 1 on a parse error or a changed sample.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "python"))

import parser_delivery  # noqa: E402  (needs the path above)


def detect_format(data: object) -> str:
    """Mirror of parse_delivery_json's detection order, for the report only."""
    if isinstance(data, dict) and len(data) == 1:
        key, value = next(iter(data.items()))
        if isinstance(key, str) and value is None and "\n" in key and "INVOICE" in key.upper():
            return "text-invoice"
    if isinstance(data, dict):
        if "invoices" in data:
            return "invoices"
        if "id_factura" in data or "detalles" in data:
            return "factura"
        if "detalle" in data:
            return "etiqueta"
    return "unknown"


def _number(value: object) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def summarise(path: Path) -> dict:
    text = path.read_bytes().decode("utf-8-sig", errors="replace")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return {"error": f"not JSON: {exc.msg} (line {exc.lineno})"}
    entry: dict = {"format": detect_format(data)}
    try:
        orders = parser_delivery.parse_delivery_json(data)
    except Exception as exc:  # the report must show every failure, whatever its type
        entry["error"] = f"{type(exc).__name__}: {exc}"
        return entry
    entry["orders"] = []
    for order in orders:
        d = parser_delivery.order_to_dict(order)
        lines = d.get("lines") or []
        entry["orders"].append({
            "company": d.get("tx_company"),
            "invoice": d.get("id_invoice"),
            "fly_date": d.get("dt_fly"),
            "lines": len(lines),
            "boxes": d.get("nu_boxes"),
            "stems": d.get("nu_stems_total"),
            "stems_in_lines": int(sum(_number(line.get("nu_stems_total")) for line in lines)),
            "total": d.get("mny_total"),
            "total_in_lines": round(sum(_number(line.get("mny_total")) for line in lines), 2),
        })
    return entry


def collect(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            files += sorted(p for p in path.iterdir() if p.suffix.lower() in (".json", ".txt"))
        elif path.is_file():
            files.append(path)
        else:
            print(f"not found: {raw}")
    return files


def describe(name: str, entry: dict) -> list[str]:
    if "error" in entry:
        return [f"{name}: [{entry.get('format', '?')}] ERROR {entry['error']}"]
    out = [f"{name}: [{entry['format']}] {len(entry['orders'])} order(s)"]
    for o in entry["orders"]:
        flags = []
        if _number(o["stems"]) and int(_number(o["stems"])) != o["stems_in_lines"]:
            flags.append(f"stems header {o['stems']} != lines {o['stems_in_lines']}")
        if _number(o["total"]) and abs(_number(o["total"]) - o["total_in_lines"]) > 0.05:
            flags.append(f"total header {o['total']} != lines {o['total_in_lines']}")
        out.append(f"   {o['company']} | invoice {o['invoice']} | fly {o['fly_date']} | {o['lines']} line(s) | "
                   f"{o['boxes']} box(es) | {o['stems']} stems | total {o['total']}"
                   + (f"   <- {'; '.join(flags)}" if flags else ""))
    return out


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--save-baseline", type=Path)
    parser.add_argument("--compare", type=Path)
    args = parser.parse_args(argv)

    summary = {path.name: summarise(path) for path in collect(args.paths)}
    for name, entry in summary.items():
        print("\n".join(describe(name, entry)))
    failed = any("error" in entry for entry in summary.values())

    if args.save_baseline:
        args.save_baseline.write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"\nbaseline saved: {args.save_baseline} ({len(summary)} sample(s))")
    if args.compare:
        baseline = json.loads(args.compare.read_text(encoding="utf-8"))
        changed = [name for name in summary if name in baseline and summary[name] != baseline[name]]
        print(f"\ncompared with {args.compare}:")
        for name in changed:
            print(f"CHANGED {name}\n   before: {json.dumps(baseline[name], ensure_ascii=False)}"
                  f"\n   after:  {json.dumps(summary[name], ensure_ascii=False)}")
        for name in sorted(set(summary) - set(baseline)):
            print(f"NEW     {name}")
        for name in sorted(set(baseline) - set(summary)):
            print(f"MISSING {name} (in baseline, not given now)")
        print("OK: no existing sample changed" if not changed else f"{len(changed)} existing sample(s) changed")
        failed = failed or bool(changed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
