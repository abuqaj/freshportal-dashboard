"""Every delivery file delivery import parses, and the files for a while.

The user (2026-10-01) wants each parse on record with the kind of file it
was - a PDF, a .txt or a .json - and the file itself kept for two months.

A parse is one row of delivery_parse_log, kept for good: a few hundred
bytes. A file is kept once however often it is parsed (by its sha256, in
delivery_parse_files) and dropped once nobody has parsed it for
RETENTION_DAYS, or sooner, oldest first, when the files kept pass
MAX_FILES_MB together: the database has little room to spare, and the cap
holds whatever the volume turns out to be.
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from typing import Any

import psycopg2
import psycopg2.extras

from db import _conn

log = logging.getLogger(__name__)

KINDS = ("pdf", "json", "txt")
READ, UNKNOWN_FORMAT, ERROR = "read", "unknown_format", "error"
RETENTION_DAYS = int(os.getenv("DELIVERY_FILE_RETENTION_DAYS", "60"))
MAX_FILES_MB = float(os.getenv("DELIVERY_FILES_MAX_MB", "50"))
# Pruning is a couple of DELETEs; once an hour per worker is plenty.
_PRUNE_EVERY_SECONDS = 3600

_table_ready = False
_last_prune = 0.0
_prune_lock = threading.Lock()


def ensure_tables() -> None:
    global _table_ready
    if _table_ready:
        return
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS delivery_parse_log (
                    id          SERIAL PRIMARY KEY,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    nm_user     TEXT,
                    file_kind   TEXT NOT NULL,
                    file_name   TEXT,
                    file_bytes  INTEGER,
                    file_sha256 TEXT,
                    outcome     TEXT NOT NULL,
                    tx_company  TEXT,
                    id_invoice  TEXT,
                    nu_orders   INTEGER,
                    nu_lines    INTEGER,
                    error       TEXT
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS delivery_parse_log_created_idx "
                        "ON delivery_parse_log(created_at)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS delivery_parse_files (
                    file_sha256 TEXT PRIMARY KEY,
                    file_kind   TEXT NOT NULL,
                    file_name   TEXT,
                    content     BYTEA NOT NULL,
                    file_bytes  INTEGER NOT NULL,
                    first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS delivery_parse_files_seen_idx "
                        "ON delivery_parse_files(last_seen)")
    _table_ready = True


def kind_of(file_name: str, default: str = "json") -> str:
    """pdf, txt or json, by the file's name."""
    ext = os.path.splitext(file_name or "")[1].lower().lstrip(".")
    return ext if ext in KINDS else default


def record(username: str, kind: str, file_name: str, content: bytes, outcome: str,
           orders: list | None = None, error: str | None = None) -> None:
    """One parse on record, and its file kept. Never raises: a parse does not
    fail for its log."""
    try:
        _record(username, kind, file_name, content, outcome, orders or [], error)
    except Exception as exc:
        log.warning("[parse-log] could not record %r: %s", file_name, exc)
    try:
        prune()
    except Exception as exc:
        log.warning("[parse-log] could not prune kept files: %s", exc)


def _record(username: str, kind: str, file_name: str, content: bytes, outcome: str,
            orders: list, error: str | None) -> None:
    ensure_tables()
    sha = hashlib.sha256(content).hexdigest()
    companies = sorted({o.tx_company for o in orders if o.tx_company})
    invoices = [o.id_invoice for o in orders if o.id_invoice]
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO delivery_parse_log (nm_user, file_kind, file_name, file_bytes,
                    file_sha256, outcome, tx_company, id_invoice, nu_orders, nu_lines, error)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (username, kind, file_name, len(content), sha, outcome,
                  ", ".join(companies)[:500] or None, ", ".join(invoices)[:500] or None,
                  len(orders), sum(len(o.lines) for o in orders),
                  (error or "")[:1000] or None))
            if RETENTION_DAYS > 0 and len(content) <= MAX_FILES_MB * 1024 * 1024:
                cur.execute("""
                    INSERT INTO delivery_parse_files (file_sha256, file_kind, file_name, content,
                                                      file_bytes)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (file_sha256) DO UPDATE SET last_seen = NOW()
                """, (sha, kind, file_name, psycopg2.Binary(content), len(content)))


def prune(force: bool = False) -> int:
    """Drop the files nobody has parsed for RETENTION_DAYS, then the oldest
    while those kept pass MAX_FILES_MB. Returns how many went."""
    global _last_prune
    with _prune_lock:
        if not force and time.monotonic() - _last_prune < _PRUNE_EVERY_SECONDS:
            return 0
        _last_prune = time.monotonic()
    ensure_tables()
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM delivery_parse_files WHERE last_seen < NOW() - %s * INTERVAL '1 day'",
                        (max(RETENTION_DAYS, 0),))
            gone = cur.rowcount
            cur.execute("""
                DELETE FROM delivery_parse_files WHERE file_sha256 IN (
                    SELECT file_sha256 FROM (
                        SELECT file_sha256,
                               SUM(file_bytes) OVER (ORDER BY last_seen DESC, file_sha256) AS kept
                        FROM delivery_parse_files) newest_first
                    WHERE kept > %s)
            """, (int(MAX_FILES_MB * 1024 * 1024),))
            gone += cur.rowcount
    if gone:
        log.info("[parse-log] dropped %d kept file(s)", gone)
    return gone


def recent(limit: int = 10, offset: int = 0) -> dict[str, Any]:
    """A page of the latest parses, newest first, each saying whether its
    file is still kept, and what the files kept take. Shown in History, next
    to the delivery imports (user, 2026-10-01)."""
    ensure_tables()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT l.id, l.created_at, l.nm_user, l.file_kind, l.file_name, l.file_bytes,
                       l.outcome, l.tx_company, l.id_invoice, l.nu_orders, l.nu_lines, l.error,
                       f.file_sha256 IS NOT NULL AS file_kept
                FROM delivery_parse_log l
                LEFT JOIN delivery_parse_files f ON f.file_sha256 = l.file_sha256
                ORDER BY l.id DESC LIMIT %s OFFSET %s
            """, (limit + 1, offset))
            rows = [dict(r) for r in cur.fetchall()]
            has_more = len(rows) > limit
            rows = rows[:limit]
            cur.execute("""
                SELECT COUNT(*) AS files, COALESCE(SUM(file_bytes), 0) AS bytes,
                       COALESCE(pg_total_relation_size('delivery_parse_files'), 0) AS on_disk
                FROM delivery_parse_files
            """)
            kept = dict(cur.fetchone())
    for row in rows:
        row["created_at"] = row["created_at"].isoformat()
    return {
        "parses": rows,
        "hasMore": has_more,
        "files_kept": int(kept["files"]),
        "files_bytes": int(kept["bytes"]),
        "files_on_disk_bytes": int(kept["on_disk"]),
        "retention_days": RETENTION_DAYS,
        "max_files_mb": MAX_FILES_MB,
    }


def get_file(log_id: int) -> tuple[str, str, bytes] | None:
    """(name, kind, content) of a parse's file, while it is kept."""
    ensure_tables()
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT l.file_name, l.file_kind, f.content
                FROM delivery_parse_log l
                JOIN delivery_parse_files f ON f.file_sha256 = l.file_sha256
                WHERE l.id = %s
            """, (log_id,))
            row = cur.fetchone()
    if not row:
        return None
    return row[0] or f"delivery-{log_id}.{row[1]}", row[1], bytes(row[2])
