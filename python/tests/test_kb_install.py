#!/usr/bin/env python3
"""What installing a skill from the dashboard must never do.

    python python/tests/test_kb_install.py

Two groups of scenarios.

The first needs no database: the four conditions that decide whether the
Install button can be pressed, how one press is named for the laptop, which
decisions an installable item still takes, and that the route is behind
`knowledge:review`. The most important of these is that a
missing heartbeat blocks the press — that is the Run now failure mode, a button
that queued work nobody collected, and it must be impossible here.

The second group stores things, so it needs Postgres. Point KB_TEST_POSTGRES_URL
(or POSTGRES_URL) at one and it runs inside a temporary schema that is dropped
afterwards, so it never touches the real kb_* tables. Without a URL that group
is skipped and the run says so.

`jose` is stubbed: these tests check the permission ladder, which reads a
payload dict, and never decode a token.

Exit code: 0 everything that could run passed, 1 something failed, 2 could not
run at all.

When the laptop turns out to report something not assumed here, add the case as
a new scenario rather than only fixing the code — that is what keeps this file
worth having.
"""
from __future__ import annotations

import contextlib
import os
import sys
import types
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PYTHON_DIR))


def _stub_jose() -> None:
    """auth_middleware imports python-jose at module level; nothing here decodes
    a token, so a stand-in is enough to reach the permission checks."""
    if "jose" in sys.modules:
        return
    try:
        import jose  # noqa: F401
        return
    except ImportError:
        pass
    module = types.ModuleType("jose")
    module.JWTError = type("JWTError", (Exception,), {})
    module.jwt = types.SimpleNamespace(decode=lambda *a, **k: {})
    sys.modules["jose"] = module


_stub_jose()

try:
    from fastapi import HTTPException

    import kb_routes
    import knowledge_base as kb
except Exception as exc:  # pragma: no cover - nothing to test without these
    print(f"Could not import the Knowledge base module: {exc}")
    sys.exit(2)


RESULTS: list[tuple[bool, str, str]] = []
REPO = "freshportal-dashboard"


def check(label: str, passed: bool, detail: object = "") -> None:
    RESULTS.append((passed, label, "" if passed else str(detail)))


def raises(fn, *args, **kwargs) -> Exception | None:
    """The exception a call produced, or None if it did not produce one."""
    try:
        fn(*args, **kwargs)
    except Exception as exc:
        return exc
    return None


def heartbeat_state(minutes_ago: float = 1, present: bool = True,
                    branch: str = kb.SKILL_BRANCH, clean: bool = True) -> dict:
    return {
        "repo": REPO, "present": present, "branch": branch, "clean": clean,
        "seen_at": datetime.now(timezone.utc) - timedelta(minutes=minutes_ago),
    }


# ── the gate: when the button can be pressed ────────────────────────────────

def test_a_press_is_impossible_without_a_fresh_heartbeat():
    """Run now queued work nobody collected. This button must refuse instead."""
    check("no heartbeat at all reads as the laptop being offline",
          kb.install_block_reason(None) == kb.BLOCK_OFFLINE)
    check("a heartbeat with no seen_at reads as offline",
          kb.install_block_reason({"present": True, "branch": kb.SKILL_BRANCH,
                                   "clean": True, "seen_at": None}) == kb.BLOCK_OFFLINE)
    stale = heartbeat_state(minutes_ago=16)
    check("a heartbeat older than 15 minutes is offline, however good it looked",
          kb.install_block_reason(stale) == kb.BLOCK_OFFLINE, stale)
    check("14 minutes old is still fresh",
          kb.install_block_reason(heartbeat_state(minutes_ago=14)) is None)


def test_each_condition_names_itself():
    check("a repository the laptop cannot find is 'absent'",
          kb.install_block_reason(heartbeat_state(present=False)) == kb.BLOCK_ABSENT)
    check("another branch is 'branch'",
          kb.install_block_reason(heartbeat_state(branch="main")) == kb.BLOCK_BRANCH)
    check("a dirty working tree is 'dirty'",
          kb.install_block_reason(heartbeat_state(clean=False)) == kb.BLOCK_DIRTY)
    check("present, on test_1 and clean lets the press through",
          kb.install_block_reason(heartbeat_state()) is None)


def test_the_branch_reason_says_which_branch():
    state = heartbeat_state(branch="main")
    message = kb.install_block_message(kb.BLOCK_BRANCH, state)
    check("the reason names the branch found and the branch wanted",
          "main" in message and kb.SKILL_BRANCH in message, message)
    check("a missing branch still produces a sentence",
          "another branch" in kb.install_block_message(kb.BLOCK_BRANCH, None))


# ── what a published item carries, and how a press is named ─────────────────

def test_only_a_skill_item_naming_a_repository_installs_anything():
    skill = {"kind": "new-skill", "target_repo": REPO, "target_path": ".claude/skills/ship-to-main/"}
    check("a new-skill item installs where it says",
          kb._install_target(skill) == (REPO, ".claude/skills/ship-to-main/"))
    check("a skill-edit naming this repository updates where it says",
          kb._install_target(dict(skill, kind="skill-edit")) == (REPO, ".claude/skills/ship-to-main/"))
    check("another kind installs nothing, whatever fields it carries",
          kb._install_target(dict(skill, kind="wiki-proposal")) == (None, None))
    check("a new-skill item with no target installs nothing",
          kb._install_target({"kind": "new-skill"}) == (None, None))
    check("a skill-edit for a knowledge-base skill names no repository and installs nothing",
          kb._install_target({"kind": "skill-edit", "target_path": ".claude/skills/improve-system/"})
          == (None, None))
    check("the install_-prefixed spelling is accepted too",
          kb._install_target({"kind": "new-skill", "install_target_repo": REPO,
                              "install_target_path": "x/"}) == (REPO, "x/"))


def test_a_press_is_named_for_the_laptop():
    candidates = [
        {"id": "2026-09-22-skill-ship-to-main", "name": "ship-to-main",
         "target_repo": REPO, "target_path": ".claude/skills/ship-to-main/"},
        {"id": "2026-09-22-skill-other", "name": "other",
         "target_repo": REPO, "target_path": ".claude/skills/other/"},
    ]
    by_id = kb._install_request(
        {"id": "2026-09-22-skill-ship-to-main", "install_target_repo": REPO,
         "install_target_path": ".claude/skills/ship-to-main/"}, candidates)
    check("an item named after its candidate is matched by id",
          by_id["candidate"] == "2026-09-22-skill-ship-to-main" and by_id["name"] == "ship-to-main", by_id)

    by_path = kb._install_request(
        {"id": "some-other-id", "install_target_repo": REPO,
         "install_target_path": ".claude/skills/other"}, candidates)
    check("otherwise it is matched by the folder it installs into, trailing slash or not",
          by_path["candidate"] == "2026-09-22-skill-other", by_path)

    unknown = kb._install_request(
        {"id": "x", "install_target_repo": REPO,
         "install_target_path": ".claude/skills/ship-to-test/"}, candidates)
    check("with no candidate to match, the name still comes from the folder",
          unknown["candidate"] is None and unknown["name"] == "ship-to-test", unknown)


# ── Install is the decision ─────────────────────────────────────────────────

def installable(install_state: str = "available", status: str = "pending", kind: str = "new-skill") -> dict:
    return {"kind": kind, "install_target_repo": REPO,
            "install_state": install_state, "status": status}


def test_install_is_the_only_decision_on_an_installable_item():
    """Nothing installs an approved candidate, so Approve would be a dead end."""
    for state in ("available", "blocked", "failed"):
        check(f"approve is refused at {state}",
              kb.decision_refusal(installable(state), "approve") is not None)
        check(f"reject is allowed at {state}",
              kb.decision_refusal(installable(state), "reject") is None)
    check("approve-always is refused as well",
          kb.decision_refusal(installable(), "approve_always") is not None)
    check("a rejection can still be undone",
          kb.decision_refusal(installable(status="rejected"), "undo") is None)
    check("an item that installs nothing keeps its Approve",
          kb.decision_refusal({"kind": "skill-edit", "install_target_repo": None,
                               "install_state": None, "status": "pending"}, "approve") is None)


def test_an_installed_skill_cannot_be_decided_again():
    """A Reject here would mark the pattern declined while the skill is in use."""
    for decision in ("approve", "reject", "undo", "approve_always"):
        refusal = kb.decision_refusal(installable("installed", status="approved"), decision)
        check(f"{decision} is refused once installed", refusal is not None and "installed" in refusal, refusal)
    check("reject is refused while the laptop is on it",
          kb.decision_refusal(installable("requested"), "reject") is not None)


def test_update_follows_the_same_rules_as_install():
    """A skill-edit for this repository is decided by Update, exactly as a
    new-skill is by Install; one for the knowledge base keeps Approve."""
    for state in ("available", "blocked", "failed"):
        refusal = kb.decision_refusal(installable(state, kind="skill-edit"), "approve")
        check(f"approve is refused on an update at {state}, naming Update",
              refusal is not None and "Update" in refusal, refusal)
        check(f"reject is allowed on an update at {state}",
              kb.decision_refusal(installable(state, kind="skill-edit"), "reject") is None)
    for decision in ("approve", "reject", "undo"):
        for state in ("requested", "installed"):
            check(f"{decision} is refused on an update at {state}",
                  kb.decision_refusal(installable(state, kind="skill-edit"), decision) is not None)
    check("an update already committed says so in its own words",
          "already committed" in (kb.install_refusal(installable("installed", kind="skill-edit")) or ""))
    kb_skill = {"kind": "skill-edit", "install_target_repo": None, "install_state": None, "status": "pending"}
    check("a knowledge-base skill-edit keeps Approve",
          kb.decision_refusal(kb_skill, "approve") is None)
    check("and cannot be pressed as an update",
          kb.install_refusal(kb_skill) is not None)


def test_a_rejected_item_is_not_installed():
    check("a rejected item cannot be installed",
          kb.install_refusal(installable(status="rejected")) is not None)
    check("nor one whose rejection the laptop already recorded",
          kb.install_refusal(installable(status="closed")) is not None)
    check("available, blocked and failed can be pressed",
          all(kb.install_refusal(installable(s)) is None for s in ("available", "blocked", "failed")))
    check("an approval from before Install decided these can still be installed",
          kb.install_refusal(installable(status="applied")) is None)


# ── who may press it ────────────────────────────────────────────────────────

def _route(path: str, method: str = "POST"):
    return next((r for r in kb_routes.router.routes
                 if getattr(r, "path", None) == path and method in getattr(r, "methods", set())), None)


def _dependency_calls(route) -> list:
    return [d.call for d in route.dependant.dependencies]


def test_install_is_behind_knowledge_review():
    route = _route("/kb/review/{item_id}/install")
    check("the install route exists", route is not None)
    if route is None:
        return
    check("it is guarded by the same reviewer dependency as the rest of the module",
          kb_routes._reviewer in _dependency_calls(route), _dependency_calls(route))

    refused = raises(kb_routes._reviewer, payload={"permissions": ["vbn:check"]})
    check("a token without knowledge:review is refused with 403",
          isinstance(refused, HTTPException) and refused.status_code == 403, refused)
    check("knowledge:review is allowed",
          raises(kb_routes._reviewer, payload={"permissions": ["knowledge:review"]}) is None)
    check("admin:manage is allowed",
          raises(kb_routes._reviewer, payload={"permissions": ["admin:manage"]}) is None)


def test_the_laptop_routes_are_behind_the_sync_token():
    for path in ("/kb/sync/agent/heartbeat", "/kb/sync/agent/install-result"):
        route = _route(path)
        check(f"{path} exists", route is not None)
        if route is not None:
            check(f"{path} is behind the sync token",
                  kb_routes.require_kb_sync_token in _dependency_calls(route))
    was = os.environ.pop("KB_SYNC_TOKEN", None)
    try:
        refused = raises(kb_routes.require_kb_sync_token, x_kb_token="anything")
        check("with no KB_SYNC_TOKEN set, the sync routes are closed rather than open",
              isinstance(refused, HTTPException) and refused.status_code == 503, refused)
    finally:
        if was is not None:
            os.environ["KB_SYNC_TOKEN"] = was


# ── storage (needs Postgres) ────────────────────────────────────────────────

@contextlib.contextmanager
def temporary_schema(url: str):
    """A throwaway schema all the kb_* tables are created in, so a test run
    cannot touch the real ones even when pointed at a shared database."""
    import psycopg2

    import db

    schema = "kb_test_" + uuid.uuid4().hex[:12]
    admin = psycopg2.connect(url)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f'CREATE SCHEMA "{schema}"')

    @contextlib.contextmanager
    def scoped():
        conn = psycopg2.connect(url)
        try:
            with conn.cursor() as cur:
                cur.execute(f'SET search_path TO "{schema}"')
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # knowledge_base did `from db import _conn`, so it holds its own reference.
    originals = (db._conn, kb._conn)
    db._conn, kb._conn, kb._tables_ready = scoped, scoped, False
    try:
        yield
    finally:
        db._conn, kb._conn = originals
        kb._tables_ready = False
        with admin.cursor() as cur:
            cur.execute(f'DROP SCHEMA "{schema}" CASCADE')
        admin.close()


def publish(item_id: str, kind: str = "new-skill", path: str | None = None, repo: str | None = REPO) -> None:
    kb.upsert_review_items([{
        "id": item_id, "bucket": "signoff", "kind": kind, "title": f"Add {item_id}",
        "target_repo": repo, "target_path": path or f".claude/skills/{item_id}/",
    }], run_id=None)


def send_heartbeat(present=True, branch=kb.SKILL_BRANCH, clean=True, candidates=None) -> list[dict]:
    return kb.record_agent_heartbeat({
        "at": datetime.now(timezone.utc).isoformat(),
        "candidates": candidates or [],
        "repos": {REPO: {"present": present, "branch": branch, "clean": clean}},
    })


def one_item(item_id: str) -> dict:
    items, _ = kb.list_review_items("all", None, None, 50, 0)
    return next(i for i in items if i["id"] == item_id)


def test_a_heartbeat_upserts_one_row_per_repository():
    send_heartbeat()
    send_heartbeat(clean=False)
    rows = kb.agent_state()
    check("two heartbeats leave one row, not two", len(rows) == 1, rows)
    check("the row holds what the laptop last said",
          rows[0]["repo"] == REPO and rows[0]["present"] and rows[0]["branch"] == kb.SKILL_BRANCH
          and rows[0]["clean"] is False, rows[0])
    check("the stored row is fresh enough to press against",
          kb.install_block_reason(dict(rows[0], clean=True)) is None, rows[0])

    send_heartbeat(candidates=[{"id": "c1", "name": "ship-to-main", "target_repo": REPO,
                                "target_path": ".claude/skills/ship-to-main/"}])
    check("the candidates waiting are stored with it",
          kb.agent_state()[0]["candidates"][0]["name"] == "ship-to-main", kb.agent_state()[0])


def test_the_heartbeat_returns_only_what_was_pressed():
    publish("2026-09-22-skill-alpha")
    publish("2026-09-22-skill-beta")
    send_heartbeat()
    check("nothing pressed means nothing to do — the normal case", send_heartbeat() == [])

    kb.request_install("2026-09-22-skill-alpha", "tester")
    requests = send_heartbeat(candidates=[
        {"id": "2026-09-22-skill-alpha", "name": "alpha", "target_repo": REPO,
         "target_path": ".claude/skills/alpha/"}])
    check("one press comes back, and only that one",
          [r["id"] for r in requests] == ["2026-09-22-skill-alpha"], requests)
    check("it comes back named for the laptop",
          requests[0]["name"] == "alpha" and requests[0]["target_repo"] == REPO
          and requests[0]["candidate"] == "2026-09-22-skill-alpha", requests[0])


def test_an_install_result_is_written_to_the_item():
    publish("2026-09-22-skill-done")
    publish("2026-09-22-skill-stuck")
    publish("2026-09-22-skill-broken")
    send_heartbeat()
    for item_id in ("2026-09-22-skill-done", "2026-09-22-skill-stuck", "2026-09-22-skill-broken"):
        kb.request_install(item_id, "tester")

    kb.record_install_result("2026-09-22-skill-done", "installed", "a1b2c3d", None)
    done = one_item("2026-09-22-skill-done")
    check("an installed item keeps its state and short hash",
          done["install_state"] == "installed" and done["install_commit"] == "a1b2c3d", done)

    kb.record_install_result("2026-09-22-skill-stuck", "blocked", None, "Uncommitted changes on test_1")
    stuck = one_item("2026-09-22-skill-stuck")
    check("a blocked item keeps the reason it was blocked for",
          stuck["install_state"] == "blocked" and "Uncommitted" in (stuck["install_message"] or ""), stuck)

    kb.record_install_result("2026-09-22-skill-broken", "failed", "deadbee", "copy failed")
    broken = one_item("2026-09-22-skill-broken")
    check("a failed install never shows a commit, because it committed nothing",
          broken["install_state"] == "failed" and broken["install_commit"] is None, broken)

    check("an unknown state is refused",
          isinstance(raises(kb.record_install_result, "2026-09-22-skill-done", "done", None, None), ValueError))
    check("a result for an item that does not exist is refused",
          isinstance(raises(kb.record_install_result, "nope", "installed", "abc", None), LookupError))


def test_a_press_is_refused_when_it_would_do_nothing():
    publish("2026-09-22-skill-guard")
    publish("2026-09-22-note", kind="wiki-proposal")

    without = raises(kb.request_install, "2026-09-22-skill-guard", "tester")
    check("with no heartbeat at all, the press is refused rather than queued",
          isinstance(without, ValueError) and "offline" in str(without).lower(), without)

    send_heartbeat(clean=False)
    dirty = raises(kb.request_install, "2026-09-22-skill-guard", "tester")
    check("a dirty working tree is refused, and the refusal names it",
          isinstance(dirty, ValueError) and "Uncommitted" in str(dirty), dirty)

    send_heartbeat(branch="main")
    branch = raises(kb.request_install, "2026-09-22-skill-guard", "tester")
    check("the wrong branch is refused, and the refusal names both branches",
          isinstance(branch, ValueError) and "main" in str(branch) and kb.SKILL_BRANCH in str(branch), branch)

    send_heartbeat()
    check("an item that installs nothing is refused",
          isinstance(raises(kb.request_install, "2026-09-22-note", "tester"), ValueError))
    check("an item that does not exist is a lookup failure",
          isinstance(raises(kb.request_install, "nope", "tester"), LookupError))

    kb.request_install("2026-09-22-skill-guard", "tester")
    check("pressing twice is refused",
          isinstance(raises(kb.request_install, "2026-09-22-skill-guard", "tester"), ValueError))
    kb.record_install_result("2026-09-22-skill-guard", "installed", "a1b2c3d", None)
    already = raises(kb.request_install, "2026-09-22-skill-guard", "tester")
    check("installing what is already installed is refused",
          isinstance(already, ValueError) and "already installed" in str(already), already)


def test_the_gate_reopens_once_the_heartbeat_clears():
    publish("2026-09-22-skill-retry")
    send_heartbeat(clean=False)
    check("blocked while the tree is dirty",
          isinstance(raises(kb.request_install, "2026-09-22-skill-retry", "tester"), ValueError))
    send_heartbeat(clean=True)
    check("pressable again as soon as the laptop reports it clean",
          raises(kb.request_install, "2026-09-22-skill-retry", "tester") is None)
    item = one_item("2026-09-22-skill-retry")
    check("and the item is waiting for the laptop",
          item["install_state"] == "requested" and item["install_requested_at"] is not None, item)


def test_a_retry_after_a_failure_starts_clean():
    publish("2026-09-22-skill-again")
    send_heartbeat()
    kb.request_install("2026-09-22-skill-again", "tester")
    kb.record_install_result("2026-09-22-skill-again", "failed", None, "copy failed")
    kb.request_install("2026-09-22-skill-again", "tester")
    item = one_item("2026-09-22-skill-again")
    check("the old failure is not left standing as this attempt's outcome",
          item["install_state"] == "requested" and item["install_message"] is None, item)


def test_a_re_push_never_undoes_a_press():
    """The laptop re-publishes its review items on every run. How far an install
    got belongs to the dashboard, the way status already does."""
    publish("2026-09-22-skill-repush")
    send_heartbeat()
    kb.request_install("2026-09-22-skill-repush", "tester")
    publish("2026-09-22-skill-repush", path=".claude/skills/moved/")
    item = one_item("2026-09-22-skill-repush")
    check("a re-push leaves the press alone", item["install_state"] == "requested", item)
    check("but it does move the target it published",
          item["install_target_path"] == ".claude/skills/moved/", item)


def install(item_id: str, who: str = "tester", commit: str = "8f46c09") -> dict:
    send_heartbeat()
    kb.request_install(item_id, who)
    return kb.record_install_result(item_id, "installed", commit, None)


def test_a_successful_install_closes_the_decision():
    publish("2026-09-23-skill-ship-to-main")
    send_heartbeat()
    pressed = kb.request_install("2026-09-23-skill-ship-to-main", "owner")
    done = kb.record_install_result("2026-09-23-skill-ship-to-main", "installed", "8f46c09", None)
    check("the item is approved, by whoever pressed Install, when they pressed it",
          done["status"] == "approved" and done["decided_by"] == "owner"
          and done["decided_at"] == pressed["install_requested_at"], done)
    check("and applied when the result came in", done["applied_at"] is not None, done)

    entries, _ = kb.list_change_log(20, 0)
    entry = next((e for e in entries if e["id"] == "2026-09-23-skill-ship-to-main"), None)
    check("the change log shows it straight away, with who decided and the commit",
          entry is not None and entry["decided_by"] == "owner" and entry["install_commit"] == "8f46c09", entry)
    check("the laptop pulls it like any approved item, so change-log.md records it",
          "2026-09-23-skill-ship-to-main" in [d["id"] for d in kb.pending_decisions()])

    kb.mark_applied(["2026-09-23-skill-ship-to-main"])
    recorded = one_item("2026-09-23-skill-ship-to-main")
    check("recording it on the laptop does not move when it was applied",
          recorded["status"] == "applied" and recorded["applied_at"] == done["applied_at"], recorded)


def test_a_blocked_or_failed_install_decides_nothing():
    publish("2026-09-23-skill-stuck")
    send_heartbeat()
    kb.request_install("2026-09-23-skill-stuck", "owner")
    stuck = kb.record_install_result("2026-09-23-skill-stuck", "blocked", None, "Uncommitted changes on test_1")
    check("a blocked install leaves the item waiting for a decision",
          stuck["status"] == "pending" and stuck["decided_by"] is None and stuck["applied_at"] is None, stuck)
    check("Reject is still there for it",
          kb.decide_review_item("2026-09-23-skill-stuck", "reject", None, "owner")["status"] == "rejected")


def test_the_decision_routes_refuse_an_installed_item():
    publish("2026-09-23-skill-kept")
    install("2026-09-23-skill-kept")
    for decision in ("approve", "reject", "undo"):
        refused = raises(kb_routes.kb_decide, "2026-09-23-skill-kept",
                         kb_routes.DecisionRequest(decision=decision), payload={"username": "owner"})
        check(f"POST {decision} on an installed item is refused with 409",
              isinstance(refused, HTTPException) and refused.status_code == 409, refused)
    item = one_item("2026-09-23-skill-kept")
    check("and the item is still approved by whoever installed it",
          item["status"] == "approved" and item["decided_by"] == "tester", item)


def test_approve_is_refused_and_reject_blocks_install():
    publish("2026-09-23-skill-maybe")
    refused = raises(kb.decide_review_item, "2026-09-23-skill-maybe", "approve", None, "owner")
    check("approving an installable item is refused",
          isinstance(refused, ValueError) and "Install" in str(refused), refused)
    kb.decide_review_item("2026-09-23-skill-maybe", "reject", None, "owner")
    send_heartbeat()
    rejected = raises(kb.request_install, "2026-09-23-skill-maybe", "owner")
    check("a rejected item cannot be installed",
          isinstance(rejected, ValueError) and "rejected" in str(rejected), rejected)
    kb.decide_review_item("2026-09-23-skill-maybe", "undo", None, "owner")
    check("until the rejection is undone",
          raises(kb.request_install, "2026-09-23-skill-maybe", "owner") is None)


def test_an_install_reported_before_this_rule_is_closed_on_start():
    """8f46c09 was installed while an install still left its item pending."""
    publish("2026-09-23-skill-earlier")
    send_heartbeat()
    kb.request_install("2026-09-23-skill-earlier", "owner")
    with kb._conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE kb_review_items SET install_state = 'installed', install_commit = '8f46c09',
                    install_requested_by = NULL, status = 'pending'
                WHERE id = '2026-09-23-skill-earlier'
            """)
        conn.commit()
    kb._tables_ready = False
    kb.ensure_kb_tables()
    item = one_item("2026-09-23-skill-earlier")
    check("it is approved, with no Approve or Reject left to press",
          item["status"] == "approved" and item["applied_at"] is not None
          and item["decided_at"] == item["install_requested_at"], item)


def test_an_update_is_decided_by_pressing_update():
    """The first Update item: a change to new-delivery-json-format, which lives here."""
    item_id = "2026-09-24-skill-edit-new-delivery-json-format"
    publish(item_id, kind="skill-edit", path=".claude/skills/new-delivery-json-format/")
    check("a skill-edit naming this repository arrives ready to update",
          one_item(item_id)["install_state"] == "available", one_item(item_id))
    approve = raises(kb_routes.kb_decide, item_id, kb_routes.DecisionRequest(decision="approve"),
                     payload={"username": "owner"})
    check("approving it is refused with 409",
          isinstance(approve, HTTPException) and approve.status_code == 409, approve)

    send_heartbeat()
    pressed = kb.request_install(item_id, "owner")
    requests = send_heartbeat()
    check("the press reaches the laptop through the same heartbeat",
          [r["id"] for r in requests] == [item_id], requests)
    for decision in ("approve", "reject"):
        refused = raises(kb_routes.kb_decide, item_id, kb_routes.DecisionRequest(decision=decision),
                         payload={"username": "owner"})
        check(f"{decision} is refused with 409 while the laptop is on it",
              isinstance(refused, HTTPException) and refused.status_code == 409, refused)

    done = kb.record_install_result(item_id, "installed", "c0ffee1", None)
    check("a committed update is approved, by whoever pressed Update, when they pressed it",
          done["status"] == "approved" and done["decided_by"] == "owner"
          and done["decided_at"] == pressed["install_requested_at"] and done["applied_at"] is not None, done)
    for decision in ("approve", "reject", "undo"):
        refused = raises(kb_routes.kb_decide, item_id, kb_routes.DecisionRequest(decision=decision),
                         payload={"username": "owner"})
        check(f"{decision} on an updated item is refused with 409",
              isinstance(refused, HTTPException) and refused.status_code == 409, refused)
    again = raises(kb.request_install, item_id, "owner")
    check("updating again is refused, in the update's own words",
          isinstance(again, ValueError) and "already committed" in str(again), again)

    entries, _ = kb.list_change_log(20, 0)
    entry = next((e for e in entries if e["id"] == item_id), None)
    check("the change log shows it as a skill-edit, with who decided and the commit",
          entry is not None and entry["kind"] == "skill-edit" and entry["decided_by"] == "owner"
          and entry["install_commit"] == "c0ffee1", entry)


def test_the_laptop_sees_an_update_was_carried_out():
    publish("2026-09-24-skill-edit-done", kind="skill-edit")
    publish("2026-09-24-skill-edit-kb", kind="skill-edit", repo=None)
    kb.decide_review_item("2026-09-24-skill-edit-kb", "approve", None, "owner")
    fields = ("install_state", "install_commit", "install_target_repo", "install_target_path")
    decisions = kb.pending_decisions()
    check("every decision carries the four install fields, installed or not",
          decisions and all(all(f in d for f in fields) for d in decisions), decisions)

    install("2026-09-24-skill-edit-done", who="owner", commit="c0ffee1")
    decisions = {d["id"]: d for d in kb.pending_decisions()}
    done = decisions.get("2026-09-24-skill-edit-done") or {}
    check("an update already committed is handed back saying so",
          done.get("install_state") == "installed" and done.get("install_commit") == "c0ffee1"
          and done.get("install_target_repo") == REPO
          and done.get("install_target_path") == ".claude/skills/2026-09-24-skill-edit-done/", done)
    kb_edit = decisions.get("2026-09-24-skill-edit-kb") or {}
    check("a knowledge-base skill-edit is handed back as a plain approval, for improve-system to apply",
          kb_edit.get("status") == "approved" and kb_edit.get("install_state") is None, kb_edit)


def test_a_knowledge_base_skill_edit_keeps_approve_and_reject():
    """The trap: this one is applied by improve-system in the knowledge base."""
    publish("2026-09-24-skill-edit-improve", kind="skill-edit", repo=None)
    item = one_item("2026-09-24-skill-edit-improve")
    check("it arrives with nothing to install",
          item["install_state"] is None and item["install_target_repo"] is None, item)
    send_heartbeat()
    check("Update cannot be pressed on it",
          isinstance(raises(kb.request_install, "2026-09-24-skill-edit-improve", "owner"), ValueError))
    check("Approve works as it always has",
          kb.decide_review_item("2026-09-24-skill-edit-improve", "approve", None, "owner")["status"] == "approved")
    kb.decide_review_item("2026-09-24-skill-edit-improve", "undo", None, "owner")
    check("and so does Reject",
          kb.decide_review_item("2026-09-24-skill-edit-improve", "reject", None, "owner")["status"] == "rejected")


def test_an_update_written_against_an_older_file_is_rejected_not_retried():
    """Someone edited the skill after the update was written; the laptop will
    not overwrite it, so the way forward is Reject."""
    publish("2026-09-24-skill-edit-stale", kind="skill-edit")
    send_heartbeat()
    kb.request_install("2026-09-24-skill-edit-stale", "owner")
    stale = kb.record_install_result("2026-09-24-skill-edit-stale", "blocked", None,
                                     "SKILL.md has changed since this update was written")
    check("a blocked update decides nothing and keeps its reason",
          stale["status"] == "pending" and "has changed since" in (stale["install_message"] or ""), stale)
    check("pressing Update again is only refused by the laptop, so it is harmless here",
          raises(kb.request_install, "2026-09-24-skill-edit-stale", "owner") is None)
    kb.record_install_result("2026-09-24-skill-edit-stale", "blocked", None,
                             "SKILL.md has changed since this update was written")
    check("and Reject is there for it",
          kb.decide_review_item("2026-09-24-skill-edit-stale", "reject", None, "owner")["status"] == "rejected")


def test_a_re_push_gives_an_update_published_too_early_its_button():
    """An update published before this deployment was stored as installing
    nothing; pushing the same item again fills the empty install_state."""
    publish("2026-09-24-skill-edit-early", kind="skill-edit")
    with kb._conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE kb_review_items SET install_state = NULL
                WHERE id = '2026-09-24-skill-edit-early'
            """)
        conn.commit()
    publish("2026-09-24-skill-edit-early", kind="skill-edit")
    item = one_item("2026-09-24-skill-edit-early")
    check("the re-push makes it updatable",
          item["install_state"] == "available" and item["install_target_repo"] == REPO, item)


NO_DATABASE = [
    test_a_press_is_impossible_without_a_fresh_heartbeat,
    test_each_condition_names_itself,
    test_the_branch_reason_says_which_branch,
    test_only_a_skill_item_naming_a_repository_installs_anything,
    test_a_press_is_named_for_the_laptop,
    test_install_is_the_only_decision_on_an_installable_item,
    test_an_installed_skill_cannot_be_decided_again,
    test_update_follows_the_same_rules_as_install,
    test_a_rejected_item_is_not_installed,
    test_install_is_behind_knowledge_review,
    test_the_laptop_routes_are_behind_the_sync_token,
]

NEEDS_DATABASE = [
    test_a_heartbeat_upserts_one_row_per_repository,
    test_the_heartbeat_returns_only_what_was_pressed,
    test_an_install_result_is_written_to_the_item,
    test_a_press_is_refused_when_it_would_do_nothing,
    test_the_gate_reopens_once_the_heartbeat_clears,
    test_a_retry_after_a_failure_starts_clean,
    test_a_re_push_never_undoes_a_press,
    test_a_successful_install_closes_the_decision,
    test_a_blocked_or_failed_install_decides_nothing,
    test_the_decision_routes_refuse_an_installed_item,
    test_approve_is_refused_and_reject_blocks_install,
    test_an_install_reported_before_this_rule_is_closed_on_start,
    test_an_update_is_decided_by_pressing_update,
    test_the_laptop_sees_an_update_was_carried_out,
    test_a_knowledge_base_skill_edit_keeps_approve_and_reject,
    test_an_update_written_against_an_older_file_is_rejected_not_retried,
    test_a_re_push_gives_an_update_published_too_early_its_button,
]


def run(test) -> None:
    start = len(RESULTS)
    try:
        test()
    except Exception as exc:
        check(f"{test.__name__} raised", False, f"{type(exc).__name__}: {exc}")
    if len(RESULTS) == start:
        check(f"{test.__name__} checked nothing", False)


def main() -> int:
    import logging
    logging.disable(logging.CRITICAL)
    for test in NO_DATABASE:
        run(test)

    url = os.getenv("KB_TEST_POSTGRES_URL") or os.getenv("POSTGRES_URL") or ""
    skipped = ""
    if not url:
        skipped = (f" ({len(NEEDS_DATABASE)} storage scenarios skipped: "
                   "set KB_TEST_POSTGRES_URL to a Postgres to run them)")
    else:
        try:
            with temporary_schema(url):
                for test in NEEDS_DATABASE:
                    # Each scenario gets the tables to itself, so ids cannot collide.
                    kb.ensure_kb_tables()
                    run(test)
                    _truncate()
        except Exception as exc:
            check("the storage scenarios could not reach Postgres", False, f"{type(exc).__name__}: {exc}")

    failed = [r for r in RESULTS if not r[0]]
    for passed, label, detail in RESULTS:
        if not passed:
            print(f"FAIL  {label}\n      {detail}")
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed{skipped}")
    return 1 if failed else 0


def _truncate() -> None:
    with kb._conn() as conn:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE kb_review_items, kb_agent_state, kb_always_rules, kb_runs")
        conn.commit()


if __name__ == "__main__":
    sys.exit(main())
