#!/usr/bin/env python3
"""Pre-push checks for freshportal-dashboard.

Stands in for what the Vercel build and the Railway start would reject, so a
push to test_1 does not come back as a pasted build error.

  python .claude/skills/ship-to-test/scripts/verify.py

Exit code 1 if any check FAILs. SKIP means the check could not run here.
"""
from __future__ import annotations

import argparse
import importlib.util
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
PAGE = ROOT / "src" / "app" / "page.tsx"
I18N = ROOT / "src" / "lib" / "i18n.ts"
I18N_CHECK = ROOT / ".claude" / "skills" / "i18n-sweep" / "scripts" / "i18n_check.py"
TEXT_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".css", ".py", ".md", ".json", ".toml", ".txt", ".yml", ".yaml", ".sql"}

results: list[tuple[str, str, str]] = []


def report(status: str, check: str, detail: str = "") -> None:
    results.append((status, check, detail))


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True).stdout


def comparison_base() -> str:
    """Compare against what test_1 already has on GitHub, so unpushed commits count too."""
    return "origin/test_1" if git("rev-parse", "--verify", "--quiet", "origin/test_1").strip() else "HEAD"


def changed_files(base: str) -> list[str]:
    names = set(git("diff", "--name-only", base).splitlines())
    names |= set(git("ls-files", "--others", "--exclude-standard").splitlines())
    return sorted(name for name in names if name)


def check_branch() -> None:
    branch = git("rev-parse", "--abbrev-ref", "HEAD").strip()
    if branch == "test_1":
        report("PASS", "Branch", "test_1")
    else:
        report("FAIL", "Branch", f"on '{branch}'; this skill only ships to test_1")


def check_python(files: list[str]) -> None:
    python_files = [f for f in files if f.endswith(".py") and (ROOT / f).is_file()]
    errors = []
    for name in python_files:
        try:
            compile((ROOT / name).read_bytes(), name, "exec")
        except SyntaxError as exc:
            errors.append(f"{name}:{exc.lineno}: {exc.msg}")
    if errors:
        report("FAIL", "Python syntax", "\n".join(errors))
    else:
        report("PASS", "Python syntax", f"{len(python_files)} changed file(s)")


def _line_ending_style(data: bytes) -> str:
    lines, crlf = data.count(b"\n"), data.count(b"\r\n")
    if lines == 0:
        return "none"
    if crlf == 0:
        return "LF"
    return "CRLF" if crlf >= 0.9 * lines else "mixed"


def check_line_endings(files: list[str], base: str) -> None:
    flips, checked = [], 0
    for name in files:
        path = ROOT / name
        if path.suffix not in TEXT_SUFFIXES or not path.is_file():
            continue
        old = subprocess.run(["git", "-C", str(ROOT), "show", f"{base}:{name}"], capture_output=True)
        if old.returncode != 0:
            continue  # new file, nothing to keep consistent with
        checked += 1
        before, after = _line_ending_style(old.stdout), _line_ending_style(path.read_bytes())
        if "none" not in (before, after) and before != after:
            flips.append(f"{name}: {before} -> {after} (restore {before}; a flip rewrites every line of the diff)")
    if flips:
        report("FAIL", "Line endings", "\n".join(flips))
    else:
        report("PASS", "Line endings", f"{checked} changed file(s) keep their style")


def check_translations(i18n: Path) -> None:
    if not i18n.is_file() or not I18N_CHECK.is_file():
        report("SKIP", "Translation keys", "i18n.ts or the i18n-sweep checker not found")
        return
    sys.dont_write_bytecode = True  # no __pycache__ inside the skill folder
    spec = importlib.util.spec_from_file_location("i18n_check", I18N_CHECK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    problems = module.check_parity(i18n)
    if problems:
        report("FAIL", "Translation keys", "\n".join(problems[:30]))
    else:
        report("PASS", "Translation keys", "en, nl, pl and es have identical keys")


def check_tab_maps(page: Path) -> None:
    text = page.read_text(encoding="utf-8")
    union = re.search(r"^type Tab\s*=\s*([^;]+);", text, re.M)
    if not union:
        report("FAIL", "Tab maps", "`type Tab` not found in page.tsx")
        return
    tabs = set(re.findall(r'"([\w-]+)"', union.group(1)))
    problems, warnings = [], []
    for block in re.finditer(r"^const (\w+)\s*:\s*Record<Tab,[^=]*=\s*\{(.*?)^\};", text, re.M | re.S):
        keys = set(re.findall(r"^\s*([\w-]+)\s*:", block.group(2), re.M))
        problems += [f"{block.group(1)} is missing '{tab}'" for tab in sorted(tabs - keys)]
        problems += [f"{block.group(1)} has '{key}', which is not a Tab" for key in sorted(keys - tabs)]
    for block in re.finditer(r"^const (\w+)\s*:\s*Tab\[\]\s*=\s*\[([^\]]*)\]", text, re.M):
        problems += [f"{block.group(1)} lists '{tab}', which is not a Tab"
                     for tab in re.findall(r'"([\w-]+)"', block.group(2)) if tab not in tabs]
    nav = re.search(r"^const NAV_TABS_ALL[^=]*=\s*\[(.*?)^\];", text, re.M | re.S)
    if nav:
        problems += [f"NAV_TABS_ALL has '{tab}', which is not a Tab"
                     for tab in re.findall(r'id:\s*"([\w-]+)"', nav.group(1)) if tab not in tabs]
    warnings += [f"no screen renders tab '{tab}'" for tab in sorted(tabs)
                 if not re.search(rf'tab === "{re.escape(tab)}"\s*&&', text)]
    if problems:
        report("FAIL", "Tab maps", "\n".join(problems + warnings))
    elif warnings:
        report("WARN", "Tab maps", "\n".join(warnings))
    else:
        report("PASS", "Tab maps", f"{len(tabs)} tabs, every Record<Tab, …> complete")


def check_python_tests() -> None:
    """Run the scenario tests under python/tests (they need nothing installed)."""
    tests = sorted((ROOT / "python" / "tests").glob("test_*.py"))
    if not tests:
        report("SKIP", "Python tests", "no python/tests/test_*.py found")
        return
    failures, skipped, summaries = [], [], []
    for test in tests:
        run = subprocess.run([sys.executable, str(test)], cwd=ROOT, capture_output=True, text=True)
        tail = (run.stdout + run.stderr).strip().splitlines()
        summaries.append(f"{test.name}: {tail[-1] if tail else 'no output'}")
        if run.returncode == 2:
            skipped.append(test.name)
        elif run.returncode != 0:
            failures.append(f"{test.name}\n" + "\n".join(tail[-25:]))
    if failures:
        report("FAIL", "Python tests", "\n".join(failures))
    elif skipped:
        report("WARN", "Python tests", "could not run: " + ", ".join(skipped) + "\n" + "\n".join(summaries))
    else:
        report("PASS", "Python tests", "\n".join(summaries))


def check_typescript() -> None:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        report("SKIP", "TypeScript",
               "Node.js is not installed here, so no type check ran.\n"
               "Vercel's build of test_1 will be the first type check.")
        return
    if not (ROOT / "node_modules").is_dir():
        report("SKIP", "TypeScript", "node_modules missing; run `npm install` once in the repo root")
        return
    run = subprocess.run([npx, "tsc", "--noEmit", "-p", str(ROOT / "tsconfig.json")],
                         cwd=ROOT, capture_output=True, text=True)
    if run.returncode == 0:
        report("PASS", "TypeScript", "tsc --noEmit")
    else:
        errors = [line for line in run.stdout.splitlines() if "error TS" in line] or run.stdout.splitlines()
        report("FAIL", "TypeScript", "\n".join(errors[:25]))


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--page", type=Path, default=PAGE, help="page.tsx to check (for testing)")
    parser.add_argument("--i18n", type=Path, default=I18N, help="i18n.ts to check (for testing)")
    args = parser.parse_args(argv)

    base = comparison_base()
    files = changed_files(base)
    check_branch()
    check_python(files)
    check_line_endings(files, base)
    check_translations(args.i18n)
    check_tab_maps(args.page)
    check_python_tests()
    check_typescript()

    print(f"Changed since {base}: {len(files)} file(s)")
    for status, check, detail in results:
        print(f"{status:<5} {check}")
        for line in detail.splitlines():
            print(f"      {line}")
    failed = [check for status, check, _ in results if status == "FAIL"]
    skipped = [check for status, check, _ in results if status == "SKIP"]
    print(f"\nResult: {'FAIL (' + ', '.join(failed) + ')' if failed else 'OK'}"
          + (f"; not checked here: {', '.join(skipped)}" if skipped else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
