---
name: new-module
description: Adds a new module (hub tile and screen) to freshportal-dashboard end to end - tab, permission in Admin > Groups under its system, API guards, translations in four languages, screen rules - and audits that nothing was missed. Use when the user asks for a new module ("nowy modul", "dodajmy modul") or to check how an existing module is wired.
---

# new-module

## Decide first

Take these from the request and ask only about what it leaves open:
- **System:** `stamgegevens`, `ecuador` or `kenya`.
- **Names:** tab id, short and lowercase (`supplier`); permission as
  `noun:verb` (`supplier:add`); translation key in camelCase (`kenyaSupplier`).
- **Stages?** If yes, it is a wizard with a step bar.
- **Changes data in FreshPortal?** If yes, it logs to History.
- **Calls the Claude API?** If yes, it streams progress and can be cancelled.

## Wire it in

1. `src/components/<Name>.tsx`:
   `export default function <Name>({ lang }: { lang: Lang })` with
   `const t = translations[lang].<key>`.
2. `src/app/page.tsx`, in this order:
   - `import <Name> from "@/components/<Name>"`
   - add the id to `type Tab`
   - add it to the system list: `STAMGEGEVENS_ONLY_TABS`, `ECUADOR_ONLY_TABS`
     or `KENYA_ONLY_TABS`
   - `NAV_TABS_ALL`: `{ id, gradient, perm }`, with a gradient no other module
     uses
   - `tabLabel` chain: `tab === "<id>" ? t.nav.<key>`
   - `MODULE_WIDTH`: this is `Record<Tab, string>`, so a missing entry breaks
     the build
   - `allTiles`: `id, perm, label: t.nav.<key>, desc: t.hub.<x>Desc,
     gradient, stat, statColor, icon`
   - `navTabs` label chain: `nt.id === "<id>" ? t.nav.<key>`
   - inside `<ModuleCard>`: `{tab === "<id>" && <Name lang={lang}/>}`
   - Add no padding of your own; `ModuleCard` applies `p-4 sm:p-6`. Only a
     screen that must reach the card edge goes in `UNPADDED_TABS`.
3. `src/lib/i18n.ts`, in **each** of `en`, `nl`, `pl`, `es`: `nav.<key>`,
   `hub.<x>Desc`, `hub.<x>Stat`, and the module block `<key>: { … }`. The file
   uses CRLF; keep it.
4. `src/lib/auth-db.ts`: add the permission to `ALL_PERMISSIONS`.
5. `src/components/AdminTab.tsx`: add a module entry under the right system in
   `SYSTEM_DEFS[].modules`, and add the label to `PERM_LABELS`. Access has two
   levels: a group needs `system:<id>` **and** the module permission.
6. `python/api_server.py`: guard every endpoint with
   `Depends(require_any_permission("admin:manage", "<perm>"))`, so admins keep
   access. `_ALL_PERMISSIONS` in `python/db.py` is a legacy seed list; newer
   modules are not in it and do not need to be.
7. **If it changes FreshPortal data:**
   - a log table in `python/db.py`, created lazily with
     `CREATE TABLE IF NOT EXISTS` like `kenya_box_weight_log`
   - a history read function and a log endpoint
   - a sub-tab in `src/components/HistoryTab.tsx`: the `HistSubTab` union,
     loader, tab list and panel

## Audit

```
python .claude/skills/new-module/scripts/audit_module.py <tab> <perm> --system <system> [--history]
```

Fix every ✗. Run it on an existing module, e.g. `supplier supplier:add --system
kenya`, to see what complete looks like.

## Screen rules

Users asked for each of these more than once:
- **No cut-off content.** Content longer than the card scrolls inside the
  card, and action buttons stay reachable, never pushed out of view.
- **Dropdowns** open right under their field and may extend beyond the card;
  do not let the card clip them.
- **Popups** have a solid background and a backdrop.
- **Loading** shows a placeholder or spinner, never a default value that may be
  wrong.
- **Buttons** show a pressed state.
- **Several stages** get a step bar like `DeliveryImporter` (`Stage` type,
  `step-enter` / `step-dot-pop` classes in `globals.css`). `KenyaSupplier`
  keeps a local copy; if a third module needs the bar, extract a shared
  component.
- **Progress:** regular users see readable statuses; only admins see raw logs.
- **Text:** no hardcoded text. Every string exists in all four languages (see
  `i18n-sweep`).
- **Claude API calls** stream progress, and cancel stops the work on the
  server, not only in the browser.

## Finish

Run the audit, then `ship-to-test`.
