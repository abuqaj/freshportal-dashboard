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
5. `SKIP Python names` means pyflakes is not installed, so nothing looked
   for a name used but never defined: the `NameError` that stopped Railway's
   start on 2026-09-25, fixed in `af35ff1`. Ask the user once whether to
   install it (`python -m pip install --user pyflakes`); until then, say so
   in the final message.
6. **Tests that need Postgres** run only their other half here, and their
   line in `Python tests` says so (`storage scenarios skipped` from
   `test_kb_install.py`, `skipped` in pytest's count from the other two).
   When this work changes what those scenarios store, run them on a
   throwaway Postgres before pushing: see "A throwaway Postgres" below.
7. Look at what goes in: `git status` and `git diff --stat`. Commit only the
   files that belong to this work. Leave unrelated changes alone and mention
   them. Never revert changes the user made. Other sessions often work in
   this tree at the same time, so one file can hold two pieces of work
   (`src/lib/i18n.ts` most often): stage only this work's lines, for example
   by writing just those hunks to a patch and running `git apply --cached`
   on it, and read `git diff --cached` before committing.
8. Commit with a message that says what changed and why, ending with the
   co-author line the session requires.
9. `git log --oneline origin/test_1..HEAD` lists every commit the push will
   carry, other sessions' included. Then `git push origin test_1`. Never
   force-push.
10. Report the commit hash, what was shipped (another session's commits
    named as such), and every `SKIP` or `WARN`.

## What the checks catch

| Check | Why it exists |
|---|---|
| Branch | Work ships from `test_1` only |
| Python syntax | A syntax error stops the Railway backend from starting |
| Python names | A name used but never defined passes the syntax check and stops the start as well. Runs only when pyflakes is installed |
| Line endings | Every file keeps its own style; `src/lib/i18n.ts` is CRLF, most files are LF. A flip turns the diff into the whole file |
| Translation keys | `nl`, `pl` and `es` are typed `typeof en`, so any missing or extra key breaks the build |
| Tab maps | Every `Record<Tab, …>` in `page.tsx` (e.g. `MODULE_WIDTH`) must list every tab; forgetting one was a repeated build break |
| Python tests | `python/tests/test_*.py`, each run as a script — scenario tests that run without a browser. `test_product_create.py` guards what New Products must never do: save a duplicate, or report success when the values did not land. The storage halves of `test_kb_install.py`, `test_bi_offer_states.py` and `test_pdf_layout_drafts.py` need Postgres |
| TypeScript | `tsc --noEmit` rejects what `next build` rejects. Runs only when Node.js and `node_modules` exist |

## A throwaway Postgres

This laptop has no Postgres and no Docker. The `pgserver` wheel, which
bundles the Postgres binaries, works:

1. pip fails on the full scratchpad path (Windows' 260-character path
   limit), so first map the scratchpad to a free drive letter:
   `subst Q: <scratchpad>`. Run `subst` alone first to see which letters are
   taken: other sessions map their own (on 2026-09-28 `R:` was another
   session's), and theirs are left alone.
2. Make a `--system-site-packages` venv under that letter and install
   `pgserver` into it.
3. Start it with `pgserver.get_server(<dir>, cleanup_mode="stop")` and pass
   `srv.get_uri()` as `KB_TEST_POSTGRES_URL`, which all three storage tests
   read; each works in a throwaway schema of its own. Run the test file as a
   script: under a bare `pytest` run, `test_kb_install.py` fails without a
   database instead of skipping.
4. To prove a new check really catches the bug, run it once against the old
   module (`git show HEAD:<module>`).
5. Remove the mapping with `subst Q: /d` from PowerShell: Git Bash rewrites
   `/d` into a path and leaves the mapping in place. Keep `subst` and any
   `Remove-Item` in separate commands; a safety check refused a command that
   held both (2026-09-24).
