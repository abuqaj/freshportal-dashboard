"""Storage behind the Knowledge base module: the dashboard's window onto the
Coloriginz knowledge base.

The knowledge base is a git repository on one laptop and stays the source of
truth. Its skills push documents, review items and run records here through
the /kb/sync/* routes, and pull the user's decisions back. These tables are a
view of that repository plus an inbox for decisions: the laptop applies every
change itself, then reports it as applied. Runs start only on the laptop.
"""
from __future__ import annotations

import json
import logging
import re

import psycopg2.extras

from db import _conn

logger = logging.getLogger(__name__)

SKILLS = ("data-ingestion", "improve-system")
BUCKETS = ("auto", "signoff", "context")
DOCUMENT_KINDS = ("thread_summary", "curated", "inbox", "wiki", "other")
DECIDED = ("approved", "approved_always", "rejected", "answered")
DONE = ("applied", "closed")
MAX_BATCH = 200
MAX_CONTENT_CHARS = 1_000_000
_ITEM_ID = re.compile(r"^[\w.-]{3,160}$")
_STATUS_FOR = {"approve": "approved", "approve_always": "approved_always", "reject": "rejected"}

_tables_ready = False


def ensure_kb_tables() -> None:
    global _tables_ready
    if _tables_ready:
        return
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS kb_documents (
                    path        TEXT PRIMARY KEY,
                    kind        TEXT NOT NULL,
                    title       TEXT,
                    topic       TEXT,
                    tags        TEXT[] NOT NULL DEFAULT '{}',
                    source_date DATE,
                    content     TEXT,
                    size_bytes  INTEGER,
                    synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS kb_documents_date_idx "
                        "ON kb_documents(source_date DESC NULLS LAST)")
            # Status, answer and the decision columns belong to the people in
            # the dashboard; a re-push from the laptop never resets them.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS kb_review_items (
                    id          TEXT PRIMARY KEY,
                    run_id      TEXT,
                    bucket      TEXT NOT NULL,
                    kind        TEXT NOT NULL,
                    title       TEXT NOT NULL,
                    target      TEXT,
                    body        TEXT,
                    evidence    TEXT[] NOT NULL DEFAULT '{}',
                    why         TEXT,
                    status      TEXT NOT NULL DEFAULT 'pending',
                    answer      TEXT,
                    decided_by  TEXT,
                    decided_at  TIMESTAMPTZ,
                    applied_at  TIMESTAMPTZ,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS kb_review_items_status_idx "
                        "ON kb_review_items(status, bucket)")
            cur.execute("ALTER TABLE kb_review_items ADD COLUMN IF NOT EXISTS action TEXT")
            cur.execute("ALTER TABLE kb_review_items ADD COLUMN IF NOT EXISTS verify TEXT")
            # Evidence sent as one string used to be stored a character per
            # element; join those back into the path they were.
            cur.execute("""
                UPDATE kb_review_items SET evidence = ARRAY[array_to_string(evidence, '')]
                WHERE cardinality(evidence) > 1
                  AND NOT EXISTS (SELECT 1 FROM unnest(evidence) AS e WHERE char_length(e) <> 1)
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS kb_always_rules (
                    id          SERIAL PRIMARY KEY,
                    kind        TEXT NOT NULL,
                    target      TEXT NOT NULL,
                    source_item TEXT,
                    created_by  TEXT,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (kind, target)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS kb_runs (
                    id          TEXT PRIMARY KEY,
                    skill       TEXT NOT NULL,
                    started_at  TIMESTAMPTZ,
                    finished_at TIMESTAMPTZ,
                    status      TEXT,
                    summary     TEXT,
                    details     JSONB NOT NULL DEFAULT '{}'::jsonb,
                    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            # Run now queued requests for a laptop task that was never set up;
            # the button and its queue are gone, and nothing reads this table.
            cur.execute("DROP TABLE IF EXISTS kb_run_requests")
        conn.commit()
    _tables_ready = True


def _rows(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def _text_list(value) -> list[str]:
    """A list as sent, or a single string as a one-element list, never its
    characters. A multi-line string gives one element per line."""
    if not value:
        return []
    if isinstance(value, str):
        return [line.strip() for line in value.splitlines() if line.strip()]
    return [str(v) for v in value]


# ── documents ───────────────────────────────────────────────────────────────

def upsert_documents(documents: list[dict]) -> int:
    ensure_kb_tables()
    rows: dict[str, tuple] = {}  # by path: one INSERT ... ON CONFLICT cannot touch the same row twice
    for doc in documents:
        path = str(doc.get("path") or "").strip()
        if not path:
            continue
        content = doc.get("content")
        if isinstance(content, str) and len(content) > MAX_CONTENT_CHARS:
            content = content[:MAX_CONTENT_CHARS]
        rows[path] = (
            path,
            doc.get("kind") if doc.get("kind") in DOCUMENT_KINDS else "other",
            doc.get("title"),
            doc.get("topic"),
            _text_list(doc.get("tags")),
            doc.get("source_date") or None,
            content,
            doc.get("size_bytes"),
        )
    if not rows:
        return 0
    with _conn() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, """
                INSERT INTO kb_documents (path, kind, title, topic, tags, source_date, content, size_bytes, synced_at)
                VALUES %s
                ON CONFLICT (path) DO UPDATE SET
                    kind = EXCLUDED.kind, title = EXCLUDED.title, topic = EXCLUDED.topic,
                    tags = EXCLUDED.tags, source_date = EXCLUDED.source_date,
                    content = EXCLUDED.content, size_bytes = EXCLUDED.size_bytes, synced_at = NOW()
            """, list(rows.values()), template="(%s, %s, %s, %s, %s, %s, %s, %s, NOW())")
        conn.commit()
    return len(rows)


def list_documents(query: str | None, kind: str | None, topic: str | None,
                   limit: int, offset: int) -> tuple[list[dict], bool]:
    ensure_kb_tables()
    where, params = [], []
    if kind:
        where.append("kind = %s")
        params.append(kind)
    if topic:
        where.append("topic = %s")
        params.append(topic)
    if query:
        where.append("(title ILIKE %s OR content ILIKE %s OR path ILIKE %s)")
        params += [f"%{query}%"] * 3
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                SELECT path, kind, title, topic, tags, source_date, size_bytes, synced_at,
                       LEFT(content, 280) AS snippet
                FROM kb_documents {clause}
                ORDER BY source_date DESC NULLS LAST, path
                LIMIT %s OFFSET %s
            """, params + [limit + 1, offset])
            rows = _rows(cur)
    return rows[:limit], len(rows) > limit


def get_document(path: str) -> dict | None:
    ensure_kb_tables()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM kb_documents WHERE path = %s", (path,))
            row = cur.fetchone()
    return dict(row) if row else None


# ── review items ────────────────────────────────────────────────────────────

def upsert_review_items(items: list[dict], run_id: str | None) -> tuple[int, list[str]]:
    """Returns (stored, rejected ids). Items applied automatically on the
    laptop arrive already applied; everything else starts as pending."""
    ensure_kb_tables()
    stored, rejected = 0, []
    with _conn() as conn:
        with conn.cursor() as cur:
            for item in items:
                item_id = str(item.get("id") or "")
                bucket = item.get("bucket")
                if not _ITEM_ID.match(item_id) or bucket not in BUCKETS or not item.get("title") or not item.get("kind"):
                    rejected.append(item_id or "(no id)")
                    continue
                auto = bucket == "auto"
                cur.execute("""
                    INSERT INTO kb_review_items
                        (id, run_id, bucket, kind, title, target, body, action, verify, evidence, why, status, applied_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CASE WHEN %s THEN NOW() END)
                    ON CONFLICT (id) DO UPDATE SET
                        run_id = EXCLUDED.run_id, bucket = EXCLUDED.bucket, kind = EXCLUDED.kind,
                        title = EXCLUDED.title, target = EXCLUDED.target, body = EXCLUDED.body,
                        action = EXCLUDED.action, verify = EXCLUDED.verify,
                        evidence = EXCLUDED.evidence, why = EXCLUDED.why, updated_at = NOW()
                """, (
                    item_id, run_id or item.get("run_id"), bucket, str(item["kind"]), str(item["title"]),
                    item.get("target"), item.get("body"), item.get("action"), item.get("verify"),
                    _text_list(item.get("evidence")),
                    item.get("why"), "applied" if auto else "pending", auto,
                ))
                stored += 1
        conn.commit()
    return stored, rejected


def list_review_items(view: str, kind: str | None, exclude_kind: str | None,
                      limit: int, offset: int) -> tuple[list[dict], bool]:
    """Sign-off items and questions only; automatic changes are in the change log."""
    ensure_kb_tables()
    where, params = ["bucket IN ('signoff', 'context')"], []
    if view == "pending":
        where.append("status = 'pending'")
        order = "created_at ASC"
    elif view == "decided":
        where.append("status = ANY(%s)")
        params.append(list(DECIDED))
        order = "decided_at DESC NULLS LAST"
    elif view == "done":
        where.append("status = ANY(%s)")
        params.append(list(DONE))
        order = "applied_at DESC NULLS LAST"
    else:
        order = "updated_at DESC"
    if kind:
        where.append("kind = %s")
        params.append(kind)
    if exclude_kind:
        where.append("kind <> %s")
        params.append(exclude_kind)
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                SELECT * FROM kb_review_items WHERE {' AND '.join(where)}
                ORDER BY {order}, id LIMIT %s OFFSET %s
            """, params + [limit + 1, offset])
            rows = _rows(cur)
    return rows[:limit], len(rows) > limit


def list_change_log(limit: int, offset: int) -> tuple[list[dict], bool]:
    """Every change already applied on the laptop, as change-log.md records it:
    automatic fixes, and approved items once applied. An automatic fix names
    the run that pushed it; an approved item names the improve-system run
    whose start and finish bracket the moment it was reported applied, since
    the laptop does not send that run's id."""
    ensure_kb_tables()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT i.id, i.bucket, i.kind, i.title, i.target, i.body, i.action, i.verify,
                       i.evidence, i.why, i.decided_by, i.decided_at, i.applied_at,
                       CASE WHEN i.bucket = 'auto' THEN i.run_id ELSE r.id END AS applied_by_run
                FROM kb_review_items i
                LEFT JOIN LATERAL (
                    SELECT id FROM kb_runs
                    WHERE i.bucket <> 'auto' AND skill = 'improve-system'
                      AND started_at <= i.applied_at AND finished_at >= i.applied_at
                    ORDER BY started_at DESC LIMIT 1
                ) r ON TRUE
                WHERE i.bucket = 'auto' OR i.status = 'applied'
                ORDER BY i.applied_at DESC NULLS LAST, i.id
                LIMIT %s OFFSET %s
            """, (limit + 1, offset))
            rows = _rows(cur)
    return rows[:limit], len(rows) > limit


def decide_review_item(item_id: str, decision: str, answer: str | None, username: str) -> dict:
    """Record a person's decision. It stays changeable until the laptop has
    applied it; after that the item is history."""
    ensure_kb_tables()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM kb_review_items WHERE id = %s FOR UPDATE", (item_id,))
            item = cur.fetchone()
            if not item:
                raise LookupError(item_id)
            if item["status"] in DONE:
                raise ValueError("This item has already been handled on the laptop.")
            if item["bucket"] == "auto":
                raise ValueError("Changes applied automatically cannot be decided.")
            if decision == "undo":
                cur.execute("DELETE FROM kb_always_rules WHERE source_item = %s", (item_id,))
                cur.execute("""
                    UPDATE kb_review_items SET status = 'pending', answer = NULL, decided_by = NULL,
                        decided_at = NULL, updated_at = NOW()
                    WHERE id = %s RETURNING *
                """, (item_id,))
                return _commit_row(conn, cur)
            if decision == "answer":
                if item["bucket"] != "context":
                    raise ValueError("Only questions take an answer.")
                if not (answer or "").strip():
                    raise ValueError("The answer is empty.")
                cur.execute("""
                    UPDATE kb_review_items SET status = 'answered', answer = %s, decided_by = %s,
                        decided_at = NOW(), updated_at = NOW()
                    WHERE id = %s RETURNING *
                """, (answer.strip(), username, item_id))
                return _commit_row(conn, cur)
            if decision not in _STATUS_FOR:
                raise ValueError(f"Unknown decision: {decision}")
            if item["bucket"] != "signoff":
                raise ValueError("Questions are answered, not approved.")
            if item["status"] == "approved_always":
                cur.execute("DELETE FROM kb_always_rules WHERE source_item = %s", (item_id,))
            cur.execute("""
                UPDATE kb_review_items SET status = %s, answer = NULL, decided_by = %s,
                    decided_at = NOW(), updated_at = NOW()
                WHERE id = %s RETURNING *
            """, (_STATUS_FOR[decision], username, item_id))
            updated = dict(cur.fetchone())
            if decision == "approve_always" and item["target"]:
                cur.execute("""
                    INSERT INTO kb_always_rules (kind, target, source_item, created_by)
                    VALUES (%s, %s, %s, %s) ON CONFLICT (kind, target) DO NOTHING
                """, (item["kind"], item["target"], item_id, username))
        conn.commit()
    return updated


def _commit_row(conn, cur) -> dict:
    row = dict(cur.fetchone())
    conn.commit()
    return row


def pending_decisions() -> list[dict]:
    """Decided in the dashboard, not yet applied on the laptop."""
    ensure_kb_tables()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, run_id, bucket, kind, title, target, body, evidence, why,
                       status, answer, decided_by, decided_at
                FROM kb_review_items WHERE status = ANY(%s) ORDER BY decided_at
            """, (list(DECIDED),))
            return _rows(cur)


def mark_applied(ids: list[str]) -> list[str]:
    """Approved items become applied; rejected and answered ones are closed."""
    ensure_kb_tables()
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE kb_review_items SET
                    status = CASE WHEN status IN ('approved', 'approved_always') THEN 'applied' ELSE 'closed' END,
                    applied_at = NOW(), updated_at = NOW()
                WHERE id = ANY(%s) AND status = ANY(%s)
                RETURNING id
            """, (list(ids), list(DECIDED)))
            done = [r[0] for r in cur.fetchall()]
        conn.commit()
    return done


def list_rules() -> list[dict]:
    ensure_kb_tables()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM kb_always_rules ORDER BY created_at DESC")
            return _rows(cur)


def delete_rule(rule_id: int) -> bool:
    ensure_kb_tables()
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM kb_always_rules WHERE id = %s", (rule_id,))
            deleted = cur.rowcount > 0
        conn.commit()
    return deleted


# ── runs ────────────────────────────────────────────────────────────────────

def record_run(run: dict) -> None:
    ensure_kb_tables()
    run_id, skill = str(run.get("id") or ""), run.get("skill")
    if not run_id or skill not in SKILLS:
        raise ValueError("A run needs an id and a known skill.")
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO kb_runs (id, skill, started_at, finished_at, status, summary, details)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    skill = EXCLUDED.skill, started_at = EXCLUDED.started_at,
                    finished_at = EXCLUDED.finished_at, status = EXCLUDED.status,
                    summary = EXCLUDED.summary, details = EXCLUDED.details, received_at = NOW()
            """, (run_id, skill, run.get("started_at"), run.get("finished_at"), run.get("status"),
                  run.get("summary"), json.dumps(run.get("details") or {})))
        conn.commit()


def list_runs(limit: int, offset: int) -> tuple[list[dict], bool]:
    ensure_kb_tables()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT * FROM kb_runs ORDER BY COALESCE(started_at, received_at) DESC, id DESC LIMIT %s OFFSET %s
            """, (limit + 1, offset))
            rows = _rows(cur)
    return rows[:limit], len(rows) > limit


def overview() -> dict:
    ensure_kb_tables()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE status = 'pending' AND bucket = 'signoff' AND kind <> 'wiki-proposal') AS pending_review,
                    COUNT(*) FILTER (WHERE status = 'pending' AND bucket = 'signoff' AND kind = 'wiki-proposal') AS pending_proposals,
                    COUNT(*) FILTER (WHERE status = 'pending' AND bucket = 'context') AS pending_questions,
                    COUNT(*) FILTER (WHERE status = ANY(%s)) AS decided_waiting
                FROM kb_review_items
            """, (list(DECIDED),))
            counts = dict(cur.fetchone())
            cur.execute("SELECT COUNT(*) AS n FROM kb_documents")
            counts["documents"] = cur.fetchone()["n"]
            cur.execute("""
                SELECT DISTINCT ON (skill) skill, status, started_at, finished_at
                FROM kb_runs ORDER BY skill, COALESCE(started_at, received_at) DESC
            """)
            counts["last_runs"] = _rows(cur)
    return counts
