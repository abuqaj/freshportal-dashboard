---
name: ship-to-test
description: Checks freshportal-dashboard changes for what the Vercel build and the Railway start would reject, then commits and pushes to test_1. Use when work is ready to try on the test environment, or when the user says to push or ship to test ("pushuj na testa", "wypchnij na test").
---

# ship-to-test

Ships to `test_1` only. `main` is never touched here; merging into `main`
happens only when the user explicitly asks, and is not part of this skill.

## Steps

1. From the repository root run:
   `python .claude/skills/ship-to-test/scripts/verify.py`
2. Fix every `FAIL` and run it again. Never push with a `FAIL`.
3. Read `WARN` lines and fix them if they belong to this work.
4. `SKIP TypeScript` means no type check ran on this machine. Say so in the
   final message: Vercel's build of `test_1` is then the first type check,
   and a build error may still come back.
5. Look at what goes in: `git status` and `git diff --stat`. Commit only the
   files that belong to this work. Leave unrelated changes alone and mention
   them. Never revert changes the user made.
6. Commit with a message that says what changed and why, ending with the
   co-author line the session requires.
7. `git push origin test_1`. Never force-push.
8. Report the commit hash, what was shipped, and every `SKIP` or `WARN`.

## What the checks catch

| Check | Why it exists |
|---|---|
| Branch | Work ships from `test_1` only |
| Python syntax | A syntax error stops the Railway backend from starting |
| Line endings | Every file keeps its own style; `src/lib/i18n.ts` is CRLF, most files are LF. A flip turns the diff into the whole file |
| Translation keys | `nl`, `pl` and `es` are typed `typeof en`, so any missing or extra key breaks the build |
| Tab maps | Every `Record<Tab, …>` in `page.tsx` (e.g. `MODULE_WIDTH`) must list every tab; forgetting one was a repeated build break |
| Python tests | `python/tests/test_*.py` — scenario tests that run without a database or a browser. `test_product_create.py` guards what New Products must never do: save a duplicate, or report success when the values did not land |
| TypeScript | `tsc --noEmit` rejects what `next build` rejects. Runs only when Node.js and `node_modules` exist |
