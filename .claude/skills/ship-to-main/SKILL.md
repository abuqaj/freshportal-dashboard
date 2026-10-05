---
name: ship-to-main
description: Sends work from test_1 to main - the whole branch by merging, or only the ready part in a separate worktree - without disturbing unfinished work on test_1. Use only when the user explicitly asks for main ("pushuj na maina", "wypchnij to na maina", "daj to na maina", "zmerguj test do maina", "wrzuc to na produkcje").
---

# ship-to-main

`main` is production. Nothing reaches it except when the user asks for it in
so many words. `ship-to-test` never touches it; this skill is the only route.

Ask which case this is before doing anything, unless the user already said:

| Case | What is wanted |
|---|---|
| **Whole branch** | everything waiting on `test_1` is ready |
| **Part of it** | only some of the work is ready, the rest stays on `test_1` |

## Before either case

1. `git fetch origin`, then `git log --oneline main..test_1` and show the
   user exactly which commits are waiting. Do not guess what is ready.
2. `git status` on `test_1`. Uncommitted work is left alone and never
   stashed away silently; say what is there before going on.

## Whole branch: merge

Done once so far, on 2026-09-30 (`46dcade`): 79 commits were waiting, and
the merge conflicted in 10 files.

1. `git worktree add ../main-ship main`, as for a part (below); the main
   checkout stays on `test_1`.
2. In the worktree, `git merge --no-commit --no-ff test_1`. `--no-commit`
   matters most when nothing conflicts: a plain `git merge` would then
   commit at once, with `.claude/` in it (step 4).
3. Resolve nothing blind. Read every conflict first: usually an earlier
   cherry-pick put an older form of the change on `main` and `test_1` holds
   the newer one, and then `test_1`'s side is right (all 10 files on
   2026-09-30; see the caution below). It can also be a product decision: on
   2026-09-22 `main` kept "Stock" without the invoice picker on purpose, and
   `test_1` had the picker. Ask the user which should win; never pick a
   side. Ask as well, before going on, about anything on `test_1` that
   production would meet for the first time: a paid call, a module that
   writes to the real portal, a path never tried on real data.
   `git merge --abort` undoes the attempt.
4. **Take `.claude/` out before committing.** The merge brings the skills
   along, and they must not reach `main`: `git rm -r -f .claude` (`-f`,
   because the merge added the files). It has to be done at every merge.
5. **Compare with `test_1`:** `git diff --stat test_1` should now list only
   `.claude/`. An automatic merge can double a block that both branches
   added: on 2026-09-30 `globals.css` came out 7 lines longer that way and
   was taken from `test_1` (`git checkout test_1 -- <file>`). Any other
   difference is something only `main` had; say what it is and ask whether
   it stays.
6. Run the checks as in step 3 of "Part of it" below: both scripts copied
   back in, left uncommitted, the **Branch** check failing by design.
7. `git commit`, then `git push origin main`. **Never force-push.** `main`
   is not a fast-forward of `test_1`, so a force-push drops commits.
8. Delete the two copied scripts, `git worktree remove ../main-ship`, and
   confirm `test_1` is unchanged.
9. Report the merge commit, what the user decided in step 3, what was taken
   from `test_1` by hand, and **the environment variables production may
   lack** for what just arrived: `git diff main^1 main -- .env.example`
   shows the ones the merge brought. Say which the code requires and which
   are only recommended. When the user shares a service's variable list,
   also name what must not be there: `DEV_ALLOW_TOKEN_ENDPOINT` hands out an
   admin token without a login (`.env.example`: "Never set on Railway").

## Part of it: a separate worktree

Work in a worktree, never by switching the branch of the main checkout: that
would carry uncommitted `test_1` work across, or refuse to switch at all.

1. `git worktree add ../main-ship main`
2. Bring the ready part over, either by `git cherry-pick -x <sha>` for whole
   commits that are ready as they are (`-x` writes the original's hash into
   the message, so the commit on `main` says where it came from), or by
   making the change again as its own commit when only part of a commit is
   ready. On 2026-09-22 the Stock option went over this way as `049b6a5`,
   without the invoice picker it had been built with, because that API still
   needed rework.

   A `test_1` commit often carries files `main` does not have: anything under
   `.claude/` (a skill updated in the same commit), or a test of code that is
   still on `test_1` only (the PDF parser's test on 2026-09-24). The
   cherry-pick then stops on exactly those files, as changed on one side and
   missing on the other. Take them out with `git rm <those paths>` and
   `git cherry-pick --continue`; the rest of the commit goes in as it is.
   Name what was left out in the report.
3. Run the checks before pushing. **`.claude/` does not exist on `main`**, so
   `ship-to-test`'s checks are not there, and `verify.py` checks the tree it
   sits in, so it has to be copied in. Copy two files into the worktree, at
   the same paths, and leave both uncommitted:
   `.claude/skills/ship-to-test/scripts/verify.py`, and
   `.claude/skills/i18n-sweep/scripts/i18n_check.py`, which `verify.py` looks
   for at that path. With only `verify.py` copied, its translation check says
   `SKIP` and the four languages have to be compared by hand, as happened on
   2026-09-24. In the worktree its **Branch** check fails by design (it
   passes only on `test_1`); every other result counts. Never commit either
   to `main`.
4. `git push origin main`, then `git worktree remove ../main-ship`.
5. Report which commits went and which stayed, as a table: the commit on
   `test_1`, the commit on `main`, and what it is.

## The caution that catches people later

After a cherry-pick, the same change exists on `main` and on `test_1` as two
different commits. The next merge of `test_1` into `main` can conflict in
exactly those files. Say so in the report every time part of a change is
shipped, so whoever merges later knows why the conflict is there.

A whole-branch merge clears it: afterwards `main` is `test_1` without
`.claude/`, and shipments stop conflicting until the next partial one.

## Never

- Touch `main` without an explicit request for it.
- Force-push any branch.
- Switch the main checkout's branch to `main`; use a worktree.
- Commit `.claude/`, or a copied `verify.py` or `i18n_check.py`, to `main`.
- Change anything on `test_1` as part of shipping.
