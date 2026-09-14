#!/usr/bin/env python3
"""Trace an Analysis Tool chart from the screen to the SQL behind it.

  python .claude/skills/verify-analysis-chart/scripts/trace_chart.py event-impact

Prints where the screen calls the endpoint, which API function serves it,
which python/db.py functions build the data (with line ranges, one level of
private helpers) and which bi_* tables they read.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
API = ROOT / "python" / "api_server.py"
DB = ROOT / "python" / "db.py"


def _top_level_ranges(text: str) -> dict[str, tuple[int, int]]:
    """Function name -> (first line, last line) for every top-level def."""
    lines = text.splitlines()
    starts = [(i, m.group(1)) for i, line in enumerate(lines) if (m := re.match(r"def (\w+)\(", line))]
    boundaries = [i for i, line in enumerate(lines) if re.match(r"(def |class |@|[A-Za-z_]\w* = )", line)]
    ranges = {}
    for index, name in starts:
        end = next((b for b in boundaries if b > index), len(lines))
        while end - 1 > index and not lines[end - 1].strip():
            end -= 1
        ranges[name] = (index + 1, end)
    return ranges


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    # Accepts "event-impact" or "/bi-sync/event-impact". Git Bash rewrites a
    # leading "/" into a Windows path, so keep only what follows "bi-sync/".
    name = sys.argv[1].strip().replace("\\", "/").split("bi-sync/")[-1].strip("/")
    endpoint = f"/bi-sync/{name}"
    pattern = re.compile(re.escape(endpoint) + r"(?![\w-])")

    print(f"== Screen: calls to {endpoint}")
    for path in sorted((ROOT / "src").rglob("*.tsx")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if pattern.search(line):
                print(f"   {path.relative_to(ROOT).as_posix()}:{number}  {line.strip()[:140]}")

    api_text = API.read_text(encoding="utf-8")
    route = re.search(rf'^@app\.(get|post)\("{re.escape(endpoint)}"\)\s*\ndef (\w+)\(', api_text, re.M)
    if not route:
        print(f"\nNo route {endpoint} in python/api_server.py")
        return 1
    api_ranges = _top_level_ranges(api_text)
    function = route.group(2)
    start, end = api_ranges[function]
    body = "\n".join(api_text.splitlines()[start - 1:end])
    print(f"\n== API: {route.group(1).upper()} {endpoint}")
    print(f"   python/api_server.py:{start}-{end}  def {function}")

    db_text = DB.read_text(encoding="utf-8")
    db_lines = db_text.splitlines()
    db_ranges = _top_level_ranges(db_text)
    called = [n for n in dict.fromkeys(re.findall(r"\b(\w+)\s*\(", body)) if n in db_ranges]
    print("\n== Data: python/db.py")
    shown: set[str] = set()
    for db_function in called:
        first, last = db_ranges[db_function]
        segment = "\n".join(db_lines[first - 1:last])
        helpers = [n for n in dict.fromkeys(re.findall(r"\b(_\w+)\s*\(", segment)) if n in db_ranges]
        tables = sorted(set(re.findall(r"\b(bi_\w+)\b", segment)) - set(db_ranges))
        print(f"   python/db.py:{first}-{last}  def {db_function}  ({last - first + 1} lines)")
        print(f"      tables: {', '.join(tables) or '(none named directly)'}")
        for helper in helpers:
            if helper in shown:
                continue
            shown.add(helper)
            h_first, h_last = db_ranges[helper]
            print(f"      helper: python/db.py:{h_first}-{h_last}  def {helper}")
    if not called:
        print("   (the API function calls no db.py function directly; read it)")
    print("\nRead every range above in full before explaining the formula.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
