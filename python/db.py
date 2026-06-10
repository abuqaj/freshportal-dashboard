"""PostgreSQL product mirror.

Connects to Vercel Postgres (Neon) via POSTGRES_URL env var — the same
database the Next.js frontend uses.  psycopg2-binary is used for
synchronous access from Railway background threads.
"""
from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Generator

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)

_POSTGRES_URL = os.getenv("POSTGRES_URL", "")


@contextmanager
def _conn() -> Generator[psycopg2.extensions.connection, None, None]:
    if not _POSTGRES_URL:
        raise RuntimeError("POSTGRES_URL env var not set on Railway")
    conn = psycopg2.connect(_POSTGRES_URL, sslmode="require")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def ensure_tables() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS products (
                    product_id        TEXT PRIMARY KEY,
                    product_number    TEXT,
                    name              TEXT,
                    short_name        TEXT,
                    vbn_number        TEXT,
                    color             TEXT,
                    product_gtin      TEXT,
                    product_group_code TEXT,
                    product_group     TEXT,
                    application       TEXT,
                    vat_rate          TEXT,
                    cbs_group_code    TEXT,
                    main_group        TEXT,
                    origin            TEXT,
                    creation_moment   TEXT,
                    change_moment     TEXT,
                    synced_at         TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS products_fts_idx ON products
                USING gin(to_tsvector('simple',
                    coalesce(name,'') || ' ' || coalesce(short_name,'')
                ))
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS products_vbn_idx    ON products(vbn_number)")
            cur.execute("CREATE INDEX IF NOT EXISTS products_number_idx ON products(product_number)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS sync_log (
                    id            SERIAL PRIMARY KEY,
                    started_at    TIMESTAMPTZ DEFAULT NOW(),
                    finished_at   TIMESTAMPTZ,
                    product_count INT,
                    status        TEXT DEFAULT 'running',
                    error         TEXT
                )
            """)


# ---------------------------------------------------------------------------
# Upsert
# ---------------------------------------------------------------------------

_UPSERT_SQL = """
    INSERT INTO products (
        product_id, product_number, name, short_name, vbn_number,
        color, product_gtin, product_group_code, product_group,
        application, vat_rate, cbs_group_code, main_group,
        origin, creation_moment, change_moment, synced_at
    ) VALUES %s
    ON CONFLICT (product_id) DO UPDATE SET
        product_number     = EXCLUDED.product_number,
        name               = EXCLUDED.name,
        short_name         = EXCLUDED.short_name,
        vbn_number         = EXCLUDED.vbn_number,
        color              = EXCLUDED.color,
        product_gtin       = EXCLUDED.product_gtin,
        product_group_code = EXCLUDED.product_group_code,
        product_group      = EXCLUDED.product_group,
        application        = EXCLUDED.application,
        vat_rate           = EXCLUDED.vat_rate,
        cbs_group_code     = EXCLUDED.cbs_group_code,
        main_group         = EXCLUDED.main_group,
        origin             = EXCLUDED.origin,
        creation_moment    = EXCLUDED.creation_moment,
        change_moment      = EXCLUDED.change_moment,
        synced_at          = EXCLUDED.synced_at
"""

_BATCH_SIZE = 500


def upsert_products(products: list[dict]) -> int:
    """Bulk upsert. Returns number of rows processed."""
    if not products:
        return 0
    # Deduplicate by product_id — ON CONFLICT can't touch the same row twice
    seen: dict[str, dict] = {}
    for p in products:
        pid = p.get("product_id", "")
        if pid:
            seen[pid] = p
    products = list(seen.values())
    ensure_tables()
    now = datetime.now(timezone.utc).isoformat()
    total = 0

    with _conn() as conn:
        with conn.cursor() as cur:
            for i in range(0, len(products), _BATCH_SIZE):
                batch = products[i : i + _BATCH_SIZE]
                rows = [
                    (
                        p.get("product_id", ""),
                        p.get("product_number", ""),
                        p.get("name", ""),
                        p.get("short_name", ""),
                        p.get("vbn_number", ""),
                        p.get("color", ""),
                        p.get("product_gtin", ""),
                        p.get("product_group_code", ""),
                        p.get("product_group", ""),
                        p.get("application", ""),
                        p.get("vat_rate", ""),
                        p.get("cbs_group_code", ""),
                        p.get("main_group", ""),
                        p.get("origin", ""),
                        p.get("creation_moment", ""),
                        p.get("change_moment", ""),
                        now,
                    )
                    for p in batch
                ]
                psycopg2.extras.execute_values(cur, _UPSERT_SQL, rows)
                conn.commit()
                total += len(batch)

    return total


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

_FTS_SELECT = """
    SELECT product_id, product_number, name, short_name,
           vbn_number, color, origin, product_group, change_moment,
           ts_rank(
               to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(short_name,'')),
               to_tsquery('simple', %s)
           ) AS rank
    FROM products
    WHERE to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(short_name,''))
          @@ to_tsquery('simple', %s)
    ORDER BY rank DESC
    LIMIT %s
"""


def search_products_db(query: str, limit: int = 20) -> list[dict]:
    """Full-text search with progressive fallback. Returns [] if DB unavailable.

    Strategy (stops at first non-empty result):
    1. FTS all words AND  — e.g. Callistephus:* & Matsumoto:* & Lavender:*
    2. FTS first 2 words  — e.g. Callistephus:* & Matsumoto:* (finds whole series)
    3. ILIKE on each word separately with OR
    """
    try:
        ensure_tables()
        words = [w.strip() for w in query.strip().split() if len(w.strip()) >= 2]
        if not words:
            return []

        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                # 1. All words (strict)
                tsq = " & ".join(f"{w}:*" for w in words)
                cur.execute(_FTS_SELECT, (tsq, tsq, limit))
                rows = cur.fetchall()
                if rows:
                    return [dict(r) for r in rows]

                # 2. First 2 words only (genus + series — broader template search)
                if len(words) > 2:
                    tsq2 = " & ".join(f"{w}:*" for w in words[:2])
                    cur.execute(_FTS_SELECT, (tsq2, tsq2, limit))
                    rows = cur.fetchall()
                    if rows:
                        return [dict(r) for r in rows]

                # 3. ILIKE per word with OR (catches anything containing any word)
                conditions = " OR ".join(
                    "name ILIKE %s OR short_name ILIKE %s" for _ in words
                )
                params = [p for w in words for p in (f"%{w}%", f"%{w}%")]
                params.append(limit)
                cur.execute(
                    f"SELECT product_id, product_number, name, short_name, "
                    f"vbn_number, color, origin, product_group, change_moment, "
                    f"0.3 AS rank FROM products WHERE {conditions} "
                    f"ORDER BY name LIMIT %s",
                    params,
                )
                rows = cur.fetchall()
                return [dict(r) for r in rows]
    except Exception as exc:
        logger.warning("search_products_db failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Stats / sync log
# ---------------------------------------------------------------------------

def get_product_count() -> int:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM products")
                return cur.fetchone()[0]
    except Exception:
        return -1


def log_sync_start() -> int:
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO sync_log (started_at, status) VALUES (NOW(), 'running') RETURNING id"
                )
                return cur.fetchone()[0]
    except Exception as exc:
        logger.error("log_sync_start: %s", exc)
        return -1


def log_sync_finish(sync_id: int, product_count: int, error: str = "") -> None:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE sync_log
                    SET finished_at   = NOW(),
                        product_count = %s,
                        status        = %s,
                        error         = %s
                    WHERE id = %s
                """, (product_count, "error" if error else "ok", error or None, sync_id))
    except Exception as exc:
        logger.error("log_sync_finish: %s", exc)


def is_product_number_taken(number: str) -> bool:
    """Return True if the exact product_number exists in the DB mirror."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM products WHERE product_number = %s LIMIT 1",
                    (number.upper(),),
                )
                return cur.fetchone() is not None
    except Exception:
        return False  # on DB error assume free — Playwright will verify


def get_products_by_vbn(vbn_codes: list[str]) -> list[dict]:
    """Return all products whose vbn_number is in vbn_codes."""
    if not vbn_codes:
        return []
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT product_id, product_number, name, short_name,
                           vbn_number, color, product_gtin, product_group_code,
                           product_group, application, vat_rate, cbs_group_code,
                           main_group, origin, creation_moment, change_moment
                    FROM products
                    WHERE vbn_number = ANY(%s)
                    ORDER BY name
                """, (vbn_codes,))
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.warning("get_products_by_vbn failed: %s", exc)
        return []


def get_last_successful_sync_date() -> str | None:
    """Return ISO string of finished_at for the last successful sync, or None."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT finished_at FROM sync_log
                    WHERE status = 'ok'
                    ORDER BY id DESC LIMIT 1
                """)
                row = cur.fetchone()
                if not row or not row[0]:
                    return None
                dt = row[0]
                return dt.isoformat() if hasattr(dt, "isoformat") else str(dt)
    except Exception:
        return None


def get_last_sync() -> dict | None:
    try:
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT started_at, finished_at, product_count, status, error
                    FROM sync_log ORDER BY id DESC LIMIT 1
                """)
                row = cur.fetchone()
                if not row:
                    return None
                d = dict(row)
                # Convert datetimes to ISO strings for JSON serialisation
                for k in ("started_at", "finished_at"):
                    if d.get(k) and hasattr(d[k], "isoformat"):
                        d[k] = d[k].isoformat()
                return d
    except Exception:
        return None
