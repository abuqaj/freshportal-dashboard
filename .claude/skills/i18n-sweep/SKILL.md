---
name: i18n-sweep
description: Finds text written straight into freshportal-dashboard screens and moves it into translations for English, Dutch, Polish and Spanish, keeping the four languages' keys identical. Use when text does not change with the selected language, when the user asks to check hardcoded strings or translations ("hardcoded stringi", "tlumaczenia"), or after building UI.
---

# i18n-sweep

The app has four languages: `en` (default), `nl`, `pl`, `es`, all in
`src/lib/i18n.ts`. Every string a user can see must go through it: buttons,
statuses, logs, popups, tooltips, module descriptions. A popup written in one
language only is a bug.

## Steps

1. **Find.** Run the checker on the files in scope. "The whole module" means
   every component it renders:
   `python .claude/skills/i18n-sweep/scripts/i18n_check.py hardcoded src/components/<File>.tsx`
   It is a heuristic, so read every hit. Skip CSS classes, ids, units, product
   and brand names, and values that are data rather than text.
2. **Add keys.** Put each string in the component's own block (the one it reads
   with `translations[lang].<block>`), in **all four** languages, with real
   translations rather than English copies. Use a function value for
   interpolation, e.g. ``codeTaken: (wanted: string, used: string) => `…${wanted}…` ``.
   Match the tone of the neighbouring entries: short and plain.
3. **Replace** the literal in the component with `t.<key>`.
4. **Check.**
   - `i18n_check.py parity` must print OK.
   - `i18n_check.py untranslated` lists values identical to English. Review
     them; codes and brand names may rightly stay the same.
5. **Keep CRLF.** `src/lib/i18n.ts` uses CRLF line endings; preserve them
   (`ship-to-test` verifies it).
6. **Report** how many strings moved and in which files, anything left on
   purpose, and any text produced by the Python backend. Backend text is out
   of scope unless asked.
