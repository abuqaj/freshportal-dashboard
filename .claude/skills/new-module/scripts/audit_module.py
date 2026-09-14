#!/usr/bin/env python3
"""Check that a freshportal-dashboard module is wired into every place it needs.

  python .claude/skills/new-module/scripts/audit_module.py TAB PERMISSION [--system kenya] [--history]

Example: audit_module.py supplier supplier:add --system kenya
Exit code 1 when a required place is missing.
"""
from __future__ import annotations

import argparse
import importlib.util
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
PAGE = ROOT / "src" / "app" / "page.tsx"
I18N = ROOT / "src" / "lib" / "i18n.ts"
AUTH = ROOT / "src" / "lib" / "auth-db.ts"
ADMIN = ROOT / "src" / "components" / "AdminTab.tsx"
HISTORY = ROOT / "src" / "components" / "HistoryTab.tsx"
API = ROOT / "python" / "api_server.py"
I18N_CHECK = ROOT / ".claude" / "skills" / "i18n-sweep" / "scripts" / "i18n_check.py"
SYSTEM_LISTS = {"stamgegevens": "STAMGEGEVENS_ONLY_TABS", "ecuador": "ECUADOR_ONLY_TABS", "kenya": "KENYA_ONLY_TABS"}

rows: list[tuple[str, str, str]] = []  # (mark, where, what)


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _line(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def expect(path: Path, what: str, pattern: str, flags: int = re.M, required: bool = True) -> re.Match | None:
    text = path.read_text(encoding="utf-8")
    match = re.search(pattern, text, flags)
    where = f"{_rel(path)}:{_line(text, match.start())}" if match else _rel(path)
    rows.append(("✓" if match else ("✗" if required else "·"), where, what))
    return match


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tab", help='tab id, e.g. "supplier"')
    parser.add_argument("permission", help='permission, e.g. "supplier:add"')
    parser.add_argument("--system", choices=sorted(SYSTEM_LISTS), help="system the module belongs to")
    parser.add_argument("--history", action="store_true", help="module logs runs to the History tab")
    args = parser.parse_args(argv)
    tab, perm = re.escape(args.tab), re.escape(args.permission)

    # page.tsx
    expect(PAGE, f'"{args.tab}" in type Tab', rf'^type Tab\s*=[^;]*"{tab}"')
    if args.system:
        name = SYSTEM_LISTS[args.system]
        expect(PAGE, f"listed in {name}", rf'^const {name}\s*:\s*Tab\[\]\s*=\s*\[[^\]]*"{tab}"')
    expect(PAGE, f"NAV_TABS_ALL entry with perm {args.permission}",
           rf'\{{\s*id:\s*"{tab}",[^}}\n]*perm:\s*"{perm}"')
    expect(PAGE, "MODULE_WIDTH entry (Record<Tab> - missing breaks the build)",
           rf"^const MODULE_WIDTH[^=]*=\s*\{{[^}}]*^\s*{tab}\s*:", re.M | re.S)
    title = expect(PAGE, "top bar title (tabLabel chain)", rf'tab === "{tab}"\s*\?\s*t\.nav\.(\w+)')
    tile = expect(PAGE, f"hub tile in allTiles with perm {args.permission}",
                  rf'id:\s*"{tab}",\s*\n\s*perm:\s*"{perm}",\s*\n\s*label:\s*t\.nav\.(\w+),\s*\n\s*desc:\s*t\.hub\.(\w+)')
    # The last tab in the navTabs chain is its fallback branch, with no `nt.id ===` test.
    fallback = rf'|:\s*t\.nav\.{re.escape(title.group(1))},\s*\n\s*\}}\)\)' if title else ""
    expect(PAGE, "module nav label (navTabs chain)", rf'nt\.id === "{tab}"\s*\?\s*t\.nav\.\w+' + fallback)
    render = expect(PAGE, "rendered inside ModuleCard", rf'tab === "{tab}"\s*&&\s*<(\w+)')
    component_block = None
    if render:
        component = render.group(1)
        expect(PAGE, f"import {component}", rf'^import {component} from "@/components/{component}"')
        component_file = ROOT / "src" / "components" / f"{component}.tsx"
        if component_file.is_file():
            used = re.search(r"translations\[lang\]\.(\w+)", component_file.read_text(encoding="utf-8"))
            component_block = used.group(1) if used else None
    padded = re.search(rf'^const UNPADDED_TABS[^\]]*"{tab}"', PAGE.read_text(encoding="utf-8"), re.M)
    rows.append(("·", _rel(PAGE), "in UNPADDED_TABS (draws to the card edge)" if padded
                 else "padded by ModuleCard (add no padding of your own)"))

    # i18n.ts, all four languages
    sys.dont_write_bytecode = True  # no __pycache__ inside the skill folder
    spec = importlib.util.spec_from_file_location("i18n_check", I18N_CHECK)
    i18n_check = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(i18n_check)
    langs = i18n_check.parse_translations(I18N)
    wanted = []
    if title:
        wanted.append((f"nav.{title.group(1)}", False))
    if tile:
        wanted.append((f"hub.{tile.group(2)}", False))
    if component_block:
        wanted.append((component_block, True))
    for key, is_block in wanted:
        missing = [lang for lang in i18n_check.LANGS
                   if not any(k == key or (is_block and k.startswith(key + ".")) for k in langs.get(lang, {}))]
        rows.append(("✗" if missing else "✓", _rel(I18N),
                     f"{key} in en/nl/pl/es" + (f" - missing in {', '.join(missing)}" if missing else "")))

    # permissions
    expect(AUTH, f"{args.permission} in ALL_PERMISSIONS", rf'^const ALL_PERMISSIONS\s*=\s*\[[^\]]*"{perm}"', re.M | re.S)
    expect(ADMIN, f"{args.permission} in PERM_LABELS", rf'^const PERM_LABELS[^=]*=\s*\{{[^}}]*"{perm}"\s*:', re.M | re.S)
    admin_text = ADMIN.read_text(encoding="utf-8")
    module_entry = re.search(rf'perm:\s*"{perm}"', admin_text)
    if module_entry:
        systems = re.findall(r'id:\s*"(\w+)"', admin_text[:module_entry.start()])
        system = systems[-1] if systems else "?"
        wrong = args.system and args.system not in system.lower()
        rows.append(("✗" if wrong else "✓", f"{_rel(ADMIN)}:{_line(admin_text, module_entry.start())}",
                     f"module in SYSTEM_DEFS under system '{system}'" + (f" - expected {args.system}" if wrong else "")))
    else:
        rows.append(("✗", _rel(ADMIN), "module in SYSTEM_DEFS (Admin > Groups)"))

    # API guards
    api_text = API.read_text(encoding="utf-8")
    guarded = len(re.findall(rf'require_any_permission\("admin:manage",\s*"{perm}"\)', api_text))
    rows.append(("✓" if guarded else "✗", _rel(API),
                 f'{guarded} endpoint(s) guarded by require_any_permission("admin:manage", "{args.permission}")'))
    without_admin = re.findall(rf'require_(?:any_)?permission\("{perm}"\)', api_text)
    if without_admin:
        rows.append(("✗", _rel(API), f"{len(without_admin)} endpoint(s) lock admins out (no admin:manage)"))

    if args.history:
        expect(HISTORY, f'"{args.tab}" sub-tab in HistoryTab', rf'^type HistSubTab\s*=[^;]*"{tab}"')

    width = max(len(where) for _, where, _ in rows)
    for mark, where, what in rows:
        print(f"{mark} {where:<{width}}  {what}")
    missing = sum(1 for mark, _, _ in rows if mark == "✗")
    print(f"\n{'OK: nothing missing' if not missing else f'{missing} place(s) missing'}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
