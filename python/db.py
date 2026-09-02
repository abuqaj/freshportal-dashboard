"""PostgreSQL product mirror.

Connects to Vercel Postgres (Neon) via POSTGRES_URL env var — the same
database the Next.js frontend uses.  psycopg2-binary is used for
synchronous access from Railway background threads.
"""
from __future__ import annotations

import json
import logging
import os
import re
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Generator

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

_ALL_PERMISSIONS = ["vbn:check", "vbn:fix", "products:create", "photos:upload", "admin:manage"]
_DEFAULT_GROUPS: dict[str, list[str]] = {
    "admin":    _ALL_PERMISSIONS,
    "operator": ["vbn:check", "vbn:fix", "products:create", "photos:upload"],
    "viewer":   ["vbn:check"],
}


def ensure_auth_tables() -> None:
    """Create auth tables and seed default groups/admin user if empty."""
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS auth_users (
                    id            SERIAL PRIMARY KEY,
                    username      TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    is_active     BOOLEAN DEFAULT TRUE,
                    created_at    TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS auth_groups (
                    id          SERIAL PRIMARY KEY,
                    name        TEXT UNIQUE NOT NULL,
                    description TEXT DEFAULT ''
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS auth_permissions (
                    id   SERIAL PRIMARY KEY,
                    name TEXT UNIQUE NOT NULL
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS auth_user_groups (
                    user_id  INT REFERENCES auth_users(id)  ON DELETE CASCADE,
                    group_id INT REFERENCES auth_groups(id) ON DELETE CASCADE,
                    PRIMARY KEY (user_id, group_id)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS auth_group_permissions (
                    group_id      INT REFERENCES auth_groups(id)      ON DELETE CASCADE,
                    permission_id INT REFERENCES auth_permissions(id) ON DELETE CASCADE,
                    PRIMARY KEY (group_id, permission_id)
                )
            """)

            # Seed permissions
            for perm in _ALL_PERMISSIONS:
                cur.execute("""
                    INSERT INTO auth_permissions (name) VALUES (%s)
                    ON CONFLICT (name) DO NOTHING
                """, (perm,))

            # Seed default groups
            for group_name, group_perms in _DEFAULT_GROUPS.items():
                cur.execute("""
                    INSERT INTO auth_groups (name) VALUES (%s)
                    ON CONFLICT (name) DO NOTHING RETURNING id
                """, (group_name,))
                row = cur.fetchone()
                if row:
                    gid = row[0]
                    for perm in group_perms:
                        cur.execute("""
                            INSERT INTO auth_group_permissions (group_id, permission_id)
                            SELECT %s, id FROM auth_permissions WHERE name = %s
                            ON CONFLICT DO NOTHING
                        """, (gid, perm))

            # Seed default admin user (password: "admin") if no users exist
            cur.execute("SELECT COUNT(*) FROM auth_users")
            if cur.fetchone()[0] == 0:
                from passlib.hash import bcrypt as pw_bcrypt
                import os as _os
                default_pw = _os.getenv("ADMIN_DEFAULT_PASSWORD", "admin")
                hashed = pw_bcrypt.hash(default_pw)
                cur.execute("""
                    INSERT INTO auth_users (username, password_hash)
                    VALUES ('admin', %s) RETURNING id
                """, (hashed,))
                uid = cur.fetchone()[0]
                cur.execute("SELECT id FROM auth_groups WHERE name = 'admin'")
                gid_row = cur.fetchone()
                if gid_row:
                    cur.execute("""
                        INSERT INTO auth_user_groups (user_id, group_id) VALUES (%s, %s)
                        ON CONFLICT DO NOTHING
                    """, (uid, gid_row[0]))


def get_user_by_username(username: str) -> dict | None:
    try:
        ensure_auth_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, username, password_hash, is_active
                    FROM auth_users WHERE username = %s
                """, (username,))
                row = cur.fetchone()
                return dict(row) if row else None
    except Exception as exc:
        logger.warning("get_user_by_username: %s", exc)
        return None


def get_user_permissions(user_id: int) -> list[str]:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT DISTINCT p.name
                    FROM auth_user_groups ug
                    JOIN auth_group_permissions gp ON gp.group_id = ug.group_id
                    JOIN auth_permissions p ON p.id = gp.permission_id
                    WHERE ug.user_id = %s
                """, (user_id,))
                return [row[0] for row in cur.fetchall()]
    except Exception:
        return []


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

            # FFS Ecuador's own product list (system-local — a product only appearing
            # in Stamgegevens' `products` may not be provisioned in Ecuador at all,
            # which the DFG API rejects at delivery-creation time). Delivery import
            # matches against this table instead of `products`, so a match is only
            # ever suggested if it's actually usable. external_id links back to the
            # Stamgegevens product_id (2026-08-26) — kept as-is, no dedup: every row
            # FreshPortal Ecuador shows is retained so matching has full visibility.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS ecuador_products (
                    product_id        TEXT PRIMARY KEY,
                    external_id       TEXT,
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
                CREATE INDEX IF NOT EXISTS ecuador_products_fts_idx ON ecuador_products
                USING gin(to_tsvector('simple',
                    coalesce(name,'') || ' ' || coalesce(short_name,'')
                ))
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS ecuador_products_vbn_idx    ON ecuador_products(vbn_number)")
            cur.execute("CREATE INDEX IF NOT EXISTS ecuador_products_number_idx ON ecuador_products(product_number)")
            cur.execute("CREATE INDEX IF NOT EXISTS ecuador_products_extid_idx  ON ecuador_products(external_id)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS ecuador_sync_log (
                    id            SERIAL PRIMARY KEY,
                    started_at    TIMESTAMPTZ DEFAULT NOW(),
                    finished_at   TIMESTAMPTZ,
                    product_count INT,
                    status        TEXT DEFAULT 'running',
                    error         TEXT,
                    messages      JSONB DEFAULT '[]'::jsonb
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS sync_log (
                    id            SERIAL PRIMARY KEY,
                    started_at    TIMESTAMPTZ DEFAULT NOW(),
                    finished_at   TIMESTAMPTZ,
                    product_count INT,
                    status        TEXT DEFAULT 'running',
                    error         TEXT,
                    messages      JSONB DEFAULT '[]'::jsonb
                )
            """)
            cur.execute("""
                ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS messages JSONB DEFAULT '[]'::jsonb
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS vbn_auto_log (
                    id            SERIAL PRIMARY KEY,
                    started_at    TIMESTAMPTZ DEFAULT NOW(),
                    finished_at   TIMESTAMPTZ,
                    checked_count INT,
                    fixed_count   INT,
                    status        TEXT DEFAULT 'running',
                    error         TEXT,
                    fixes         JSONB DEFAULT '[]'::jsonb,
                    messages      JSONB DEFAULT '[]'::jsonb
                )
            """)
            cur.execute("""
                ALTER TABLE vbn_auto_log ADD COLUMN IF NOT EXISTS messages JSONB DEFAULT '[]'::jsonb
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


_ECUADOR_UPSERT_SQL = """
    INSERT INTO ecuador_products (
        product_id, external_id, product_number, name, short_name, vbn_number,
        color, product_gtin, product_group_code, product_group,
        application, vat_rate, cbs_group_code, main_group,
        origin, creation_moment, change_moment, synced_at
    ) VALUES %s
    ON CONFLICT (product_id) DO UPDATE SET
        external_id        = EXCLUDED.external_id,
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


def upsert_ecuador_products(products: list[dict]) -> int:
    """Bulk upsert into ecuador_products. Returns number of rows processed.

    No dedup by external_id — every row FreshPortal Ecuador shows is kept
    as-is, keyed only by its own product_id (2026-08-26 decision: delivery
    matching needs full visibility into what Ecuador actually has)."""
    if not products:
        return 0
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
                        p.get("external_id", ""),
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
                psycopg2.extras.execute_values(cur, _ECUADOR_UPSERT_SQL, rows)
                conn.commit()
                total += len(batch)

    return total


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

_FTS_SELECT = """
    SELECT product_id, product_number, name, short_name,
           vbn_number, color, origin, product_group, change_moment, product_gtin,
           ts_rank(
               to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(short_name,'')),
               to_tsquery('simple', %s)
           ) AS rank
    FROM products
    WHERE to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(short_name,''))
          @@ to_tsquery('simple', %s)
    ORDER BY rank DESC, (product_gtin IS NOT NULL AND product_gtin <> '') DESC, product_number ASC
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
                    f"vbn_number, color, origin, product_group, change_moment, product_gtin, "
                    f"0.3 AS rank FROM products WHERE {conditions} "
                    f"ORDER BY (product_gtin IS NOT NULL AND product_gtin <> '') DESC, name, product_number LIMIT %s",
                    params,
                )
                rows = cur.fetchall()
                return [dict(r) for r in rows]
    except Exception as exc:
        logger.warning("search_products_db failed: %s", exc)
        return []


_ECUADOR_FTS_SELECT = """
    SELECT product_id, external_id, product_number, name, short_name,
           vbn_number, color, origin, product_group, change_moment, product_gtin,
           ts_rank(
               to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(short_name,'')),
               to_tsquery('simple', %s)
           ) AS rank
    FROM ecuador_products
    WHERE to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(short_name,''))
          @@ to_tsquery('simple', %s)
    ORDER BY rank DESC, (product_gtin IS NOT NULL AND product_gtin <> '') DESC, product_number ASC
    LIMIT %s
"""


def search_ecuador_products_db(query: str, limit: int = 20) -> list[dict]:
    """Same progressive FTS/ILIKE strategy as search_products_db(), against
    ecuador_products instead of products — used for delivery-import matching
    so a suggested match is only ever one FreshPortal Ecuador actually has."""
    try:
        ensure_tables()
        words = [w.strip() for w in query.strip().split() if len(w.strip()) >= 2]
        if not words:
            return []

        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                tsq = " & ".join(f"{w}:*" for w in words)
                cur.execute(_ECUADOR_FTS_SELECT, (tsq, tsq, limit))
                rows = cur.fetchall()
                if rows:
                    return [dict(r) for r in rows]

                if len(words) > 2:
                    tsq2 = " & ".join(f"{w}:*" for w in words[:2])
                    cur.execute(_ECUADOR_FTS_SELECT, (tsq2, tsq2, limit))
                    rows = cur.fetchall()
                    if rows:
                        return [dict(r) for r in rows]

                conditions = " OR ".join(
                    "name ILIKE %s OR short_name ILIKE %s" for _ in words
                )
                params = [p for w in words for p in (f"%{w}%", f"%{w}%")]
                params.append(limit)
                cur.execute(
                    f"SELECT product_id, external_id, product_number, name, short_name, "
                    f"vbn_number, color, origin, product_group, change_moment, product_gtin, "
                    f"0.3 AS rank FROM ecuador_products WHERE {conditions} "
                    f"ORDER BY (product_gtin IS NOT NULL AND product_gtin <> '') DESC, name, product_number LIMIT %s",
                    params,
                )
                rows = cur.fetchall()
                return [dict(r) for r in rows]
    except Exception as exc:
        logger.warning("search_ecuador_products_db failed: %s", exc)
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


def append_sync_message(sync_id: int, message: str) -> None:
    """Append a status message to sync_log.messages (non-fatal)."""
    if sync_id < 0:
        return
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE sync_log SET messages = messages || %s::jsonb WHERE id = %s",
                    (json.dumps([message]), sync_id),
                )
    except Exception as exc:
        logger.warning("append_sync_message: %s", exc)


def get_sync_history(limit: int = 20, offset: int = 0) -> list[dict]:
    """Return last N sync_log rows, newest first, with optional offset."""
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, started_at, finished_at, product_count, status, error, messages
                    FROM sync_log ORDER BY id DESC LIMIT %s OFFSET %s
                """, (limit, offset))
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.error("get_sync_history: %s", exc)
        return []


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


def search_products_ilike_term(term: str, limit: int = 100) -> list[dict]:
    """Return products whose name or short_name contains *term* (ILIKE).

    Mirrors the name_adjustable= URL filter used in FreshPortal scraping,
    so product_creator._similarity() can rank results identically.
    """
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                like = f"%{term}%"
                cur.execute("""
                    SELECT product_id, product_number, name, short_name,
                           vbn_number, color, origin, product_group, application
                    FROM products
                    WHERE name ILIKE %s OR short_name ILIKE %s
                    ORDER BY name
                    LIMIT %s
                """, (like, like, limit))
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.warning("search_products_ilike_term failed: %s", exc)
        return []


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


def get_ecuador_product_count() -> int:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM ecuador_products")
                return cur.fetchone()[0]
    except Exception:
        return -1


def log_ecuador_sync_start() -> int:
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO ecuador_sync_log (started_at, status) VALUES (NOW(), 'running') RETURNING id"
                )
                return cur.fetchone()[0]
    except Exception as exc:
        logger.error("log_ecuador_sync_start: %s", exc)
        return -1


def append_ecuador_sync_message(sync_id: int, message: str) -> None:
    if sync_id < 0:
        return
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE ecuador_sync_log SET messages = messages || %s::jsonb WHERE id = %s",
                    (json.dumps([message]), sync_id),
                )
    except Exception as exc:
        logger.warning("append_ecuador_sync_message: %s", exc)


def get_ecuador_sync_history(limit: int = 20, offset: int = 0) -> list[dict]:
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, started_at, finished_at, product_count, status, error, messages
                    FROM ecuador_sync_log ORDER BY id DESC LIMIT %s OFFSET %s
                """, (limit, offset))
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.error("get_ecuador_sync_history: %s", exc)
        return []


def log_ecuador_sync_finish(sync_id: int, product_count: int, error: str = "") -> None:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE ecuador_sync_log
                    SET finished_at   = NOW(),
                        product_count = %s,
                        status        = %s,
                        error         = %s
                    WHERE id = %s
                """, (product_count, "error" if error else "ok", error or None, sync_id))
    except Exception as exc:
        logger.error("log_ecuador_sync_finish: %s", exc)


def get_last_successful_ecuador_sync_date() -> str | None:
    """Return ISO string of finished_at for the last successful Ecuador sync, or None."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT finished_at FROM ecuador_sync_log
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


def get_distinct_colors() -> list[dict]:
    """Return distinct non-empty color names from products table as {id, name} pairs.

    Used as a fallback when the Floricode FLC/Color API is unavailable.
    id == name so the form-fill code can match by label text.
    """
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT DISTINCT color FROM products
                    WHERE color IS NOT NULL AND color != ''
                    ORDER BY color
                """)
                return [{"id": row[0], "name": row[0]} for row in cur.fetchall()]
    except Exception as exc:
        logger.warning("get_distinct_colors failed: %s", exc)
        return []


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


# ---------------------------------------------------------------------------
# Settings (key-value store)
# ---------------------------------------------------------------------------

def get_setting(key: str, default: str = "") -> str:
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM settings WHERE key = %s", (key,))
                row = cur.fetchone()
                return row[0] if row else default
    except Exception:
        return default


def set_setting(key: str, value: str) -> None:
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO settings (key, value) VALUES (%s, %s)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                """, (key, value))
    except Exception as exc:
        logger.error("set_setting: %s", exc)


# ---------------------------------------------------------------------------
# VBN auto-check log
# ---------------------------------------------------------------------------

def get_recent_created_products(limit: int = 500) -> list[dict]:
    """Products with a VBN created today or yesterday. creation_moment stored as TEXT in 'DD-MM-YYYY HH:MM' format."""
    import datetime
    try:
        ensure_tables()
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT product_id, product_number, name, short_name,
                           vbn_number, color, product_gtin, product_group_code,
                           product_group, application, vat_rate, cbs_group_code,
                           main_group, origin, creation_moment, change_moment
                    FROM products
                    WHERE TO_DATE(SPLIT_PART(creation_moment, ' ', 1), 'DD-MM-YYYY') >= %s
                      AND vbn_number IS NOT NULL AND vbn_number != ''
                    ORDER BY creation_moment DESC
                    LIMIT %s
                """, (yesterday, limit))
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.warning("get_recent_created_products failed: %s", exc)
        return []


def log_vbn_auto_start() -> int:
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO vbn_auto_log (started_at, status) VALUES (NOW(), 'running') RETURNING id"
                )
                return cur.fetchone()[0]
    except Exception as exc:
        logger.error("log_vbn_auto_start: %s", exc)
        return -1


def log_vbn_auto_finish(run_id: int, checked: int, fixed: int, fixes: list, error: str = "", messages: list | None = None) -> None:
    if run_id < 0:
        return
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE vbn_auto_log
                    SET finished_at   = NOW(),
                        checked_count = %s,
                        fixed_count   = %s,
                        fixes         = %s::jsonb,
                        messages      = %s::jsonb,
                        status        = %s,
                        error         = %s
                    WHERE id = %s
                """, (checked, fixed, json.dumps(fixes), json.dumps(messages or []), "error" if error else "ok", error or None, run_id))
    except Exception as exc:
        logger.error("log_vbn_auto_finish: %s", exc)


# ---------------------------------------------------------------------------
# Supplier registry  (fp_suppliers)
# ---------------------------------------------------------------------------

def ensure_suppliers_table() -> None:
    """One row per (fp_url, fp_supplier_id) — the list of known suppliers."""
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS fp_suppliers (
                    fp_url         TEXT NOT NULL,
                    fp_supplier_id TEXT NOT NULL,
                    nm_supplier    TEXT,
                    discovered_at  TIMESTAMPTZ DEFAULT NOW(),
                    updated_at     TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (fp_url, fp_supplier_id)
                )
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS fp_suppliers_url_idx
                ON fp_suppliers(fp_url)
            """)


def upsert_suppliers(fp_url: str, suppliers: list[dict]) -> int:
    """Upsert scraped supplier list for a given FP system. Returns row count."""
    if not suppliers:
        return 0
    ensure_suppliers_table()
    now = datetime.now(timezone.utc)
    with _conn() as conn:
        with conn.cursor() as cur:
            for s in suppliers:
                cur.execute("""
                    INSERT INTO fp_suppliers (fp_url, fp_supplier_id, nm_supplier, discovered_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (fp_url, fp_supplier_id) DO UPDATE SET
                        nm_supplier = EXCLUDED.nm_supplier,
                        updated_at  = EXCLUDED.updated_at
                """, (fp_url, s["fp_supplier_id"], s.get("nm_supplier", ""), now, now))
        conn.commit()
    return len(suppliers)


def get_suppliers(fp_url: str) -> list[dict]:
    """Return all suppliers for fp_url."""
    try:
        ensure_suppliers_table()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT
                        s.fp_supplier_id,
                        s.nm_supplier,
                        s.discovered_at,
                        s.updated_at
                    FROM fp_suppliers s
                    WHERE s.fp_url = %s
                    ORDER BY s.nm_supplier
                """, (fp_url,))
                rows = []
                for r in cur.fetchall():
                    d = dict(r)
                    for k in ("discovered_at", "updated_at"):
                        if d.get(k) and hasattr(d[k], "isoformat"):
                            d[k] = d[k].isoformat()
                    rows.append(d)
                return rows
    except Exception as exc:
        logger.warning("get_suppliers failed: %s", exc)
        return []


def get_suppliers_count(fp_url: str) -> int:
    """Return number of known suppliers for this FP system (0 if table empty)."""
    try:
        ensure_suppliers_table()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM fp_suppliers WHERE fp_url = %s", (fp_url,)
                )
                return cur.fetchone()[0]
    except Exception:
        return 0


_LEGAL_SUFFIXES = {"s.a.", "b.v.", "ltd", "llc", "inc", "srl", "nv", "s.a", "sa"}


# ---------------------------------------------------------------------------
# Supplier name → fp_supplier_id map  (manually confirmed JSON→FP mappings)
# ---------------------------------------------------------------------------

def ensure_supplier_name_map() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS delivery_supplier_name_map (
                    fp_url         TEXT NOT NULL,
                    tx_company     TEXT NOT NULL,
                    fp_supplier_id TEXT NOT NULL,
                    created_at     TIMESTAMPTZ DEFAULT NOW(),
                    updated_at     TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (fp_url, tx_company)
                )
            """)
        conn.commit()


def get_supplier_name_map(fp_url: str, tx_company: str) -> str:
    """Return fp_supplier_id from cached name mapping, or ''."""
    if not tx_company:
        return ""
    try:
        ensure_supplier_name_map()
        key = tx_company.lower().strip()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT fp_supplier_id FROM delivery_supplier_name_map "
                    "WHERE fp_url = %s AND tx_company = %s LIMIT 1",
                    (fp_url, key),
                )
                row = cur.fetchone()
                return row[0] if row else ""
    except Exception as exc:
        logger.warning("get_supplier_name_map failed: %s", exc)
        return ""


def save_supplier_name_map(fp_url: str, tx_company: str, fp_supplier_id: str) -> None:
    """Upsert JSON company name → fp_supplier_id mapping."""
    if not tx_company or not fp_supplier_id:
        return
    try:
        ensure_supplier_name_map()
        key = tx_company.lower().strip()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO delivery_supplier_name_map (fp_url, tx_company, fp_supplier_id, updated_at)
                    VALUES (%s, %s, %s, NOW())
                    ON CONFLICT (fp_url, tx_company) DO UPDATE SET
                        fp_supplier_id = EXCLUDED.fp_supplier_id,
                        updated_at = NOW()
                """, (fp_url, key, fp_supplier_id))
            conn.commit()
    except Exception as exc:
        logger.warning("save_supplier_name_map failed: %s", exc)


def get_supplier_name_by_id(fp_url: str, fp_supplier_id: str) -> str:
    """Return nm_supplier from fp_suppliers for the given fp_supplier_id."""
    if not fp_supplier_id:
        return ""
    try:
        ensure_suppliers_table()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT nm_supplier FROM fp_suppliers "
                    "WHERE fp_url = %s AND fp_supplier_id = %s LIMIT 1",
                    (fp_url, fp_supplier_id),
                )
                row = cur.fetchone()
                return row[0] if row else ""
    except Exception as exc:
        logger.warning("get_supplier_name_by_id failed: %s", exc)
        return ""


def find_supplier_fp_id(fp_url: str, company_name: str) -> str:
    """Return fp_supplier_id for the best name match in fp_suppliers.

    Priority:
    1. Cached delivery_supplier_name_map (manually confirmed mappings take precedence)
    2. Exact nm_supplier match (case-insensitive)
    3. Each significant word (>3 chars, not a legal suffix) via ILIKE
    Returns "" if not found.
    """
    if not company_name:
        return ""
    # Highest priority: manually confirmed mapping
    cached = get_supplier_name_map(fp_url, company_name)
    if cached:
        return cached
    try:
        ensure_suppliers_table()
        words = [
            w.lower() for w in company_name.split()
            if len(w) > 3 and w.lower().rstrip(".") not in _LEGAL_SUFFIXES
        ]
        with _conn() as conn:
            with conn.cursor() as cur:
                # Exact match
                cur.execute(
                    "SELECT fp_supplier_id FROM fp_suppliers "
                    "WHERE fp_url = %s AND LOWER(nm_supplier) = %s LIMIT 1",
                    (fp_url, company_name.lower()),
                )
                row = cur.fetchone()
                if row:
                    return row[0]
                # Each significant word as a substring
                for word in words:
                    cur.execute(
                        "SELECT fp_supplier_id FROM fp_suppliers "
                        "WHERE fp_url = %s AND LOWER(nm_supplier) LIKE %s LIMIT 1",
                        (fp_url, f"%{word}%"),
                    )
                    row = cur.fetchone()
                    if row:
                        return row[0]
    except Exception as exc:
        logger.warning("find_supplier_fp_id failed: %s", exc)
    return ""


# ---------------------------------------------------------------------------
# Delivery → catalogue product match cache
# ---------------------------------------------------------------------------

def ensure_delivery_product_map() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS delivery_product_map (
                    fp_url          TEXT NOT NULL,
                    fp_supplier_id  TEXT NOT NULL,
                    delivery_key    TEXT NOT NULL,
                    nm_variety      TEXT,
                    nu_length       INTEGER,
                    id_floricode    TEXT,
                    fp_product_id   TEXT NOT NULL,
                    nm_product      TEXT,
                    match_type      TEXT,
                    approved        BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at      TIMESTAMPTZ DEFAULT NOW(),
                    updated_at      TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (fp_url, fp_supplier_id, delivery_key)
                )
            """)
        conn.commit()
    # Migration: add approved column if missing (separate transaction for safety)
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'delivery_product_map'
                      AND column_name  = 'approved'
                """)
                if not cur.fetchone():
                    cur.execute("""
                        ALTER TABLE delivery_product_map
                        ADD COLUMN approved BOOLEAN NOT NULL DEFAULT FALSE
                    """)
            conn.commit()
    except Exception as exc:
        import logging as _log
        _log.getLogger(__name__).warning("delivery_product_map migration warning: %s", exc)


def get_delivery_matches(fp_url: str, fp_supplier_id: str) -> dict[str, dict]:
    """Return {delivery_key: match_dict} for fast lookup during parsing."""
    try:
        ensure_delivery_product_map()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT delivery_key, nm_variety, nu_length, id_floricode,
                           fp_product_id, nm_product, match_type, approved
                    FROM delivery_product_map
                    WHERE fp_url = %s AND fp_supplier_id = %s
                """, (fp_url, fp_supplier_id))
                return {r["delivery_key"]: dict(r) for r in cur.fetchall()}
    except Exception:
        return {}


def save_delivery_matches(fp_url: str, fp_supplier_id: str, matches: list[dict],
                          approved: bool = False) -> int:
    """Upsert matched delivery lines.

    approved=True marks them as user-confirmed — these are used as cache hits
    and shown with the 'cached' badge in the UI.
    Manual overrides (match_type='manual') are never downgraded.
    """
    if not matches:
        return 0
    ensure_delivery_product_map()
    now = datetime.now(timezone.utc)
    seen_keys: set[str] = set()
    rows = []
    for m in matches:
        if not m.get("fp_product_id"):
            continue
        dk = m["delivery_key"]
        if dk in seen_keys:
            continue  # deduplicate: same delivery_key appears multiple times (multi-box lines)
        seen_keys.add(dk)
        rows.append((
            fp_url, fp_supplier_id,
            dk,
            m.get("nm_variety"),
            m.get("nu_length"),
            m.get("id_floricode"),
            m["fp_product_id"],
            m.get("nm_product"),
            m.get("match_type", "auto"),
            approved,
            now, now,
        ))
    if not rows:
        return 0
    with _conn() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, """
                INSERT INTO delivery_product_map
                    (fp_url, fp_supplier_id, delivery_key, nm_variety, nu_length,
                     id_floricode, fp_product_id, nm_product, match_type,
                     approved, created_at, updated_at)
                VALUES %s
                ON CONFLICT (fp_url, fp_supplier_id, delivery_key) DO UPDATE SET
                    fp_product_id = EXCLUDED.fp_product_id,
                    nm_product    = EXCLUDED.nm_product,
                    match_type    = CASE
                        WHEN delivery_product_map.match_type = 'manual' THEN 'manual'
                        ELSE EXCLUDED.match_type END,
                    approved      = CASE
                        WHEN delivery_product_map.match_type = 'manual' THEN TRUE
                        ELSE (delivery_product_map.approved OR EXCLUDED.approved) END,
                    updated_at    = EXCLUDED.updated_at
            """, rows)
        conn.commit()
    return len(rows)


def approve_delivery_matches(fp_url: str, fp_supplier_id: str,
                             delivery_keys: list[str]) -> int:
    """Mark existing cached matches as approved. Returns number of rows updated."""
    if not delivery_keys:
        return 0
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE delivery_product_map
                    SET approved = TRUE, updated_at = NOW()
                    WHERE fp_url = %s AND fp_supplier_id = %s
                      AND delivery_key = ANY(%s)
                """, (fp_url, fp_supplier_id, delivery_keys))
                updated = cur.rowcount
            conn.commit()
        return updated
    except Exception:
        return 0


def set_delivery_match(fp_url: str, fp_supplier_id: str, delivery_key: str,
                       nm_variety: str | None, nu_length: int | None,
                       fp_product_id: str, nm_product: str | None) -> None:
    """Manually override (or create) a single cached match — always approved."""
    ensure_delivery_product_map()
    now = datetime.now(timezone.utc)
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO delivery_product_map
                    (fp_url, fp_supplier_id, delivery_key, nm_variety, nu_length,
                     fp_product_id, nm_product, match_type, approved,
                     created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 'manual', TRUE, %s, %s)
                ON CONFLICT (fp_url, fp_supplier_id, delivery_key) DO UPDATE SET
                    fp_product_id = EXCLUDED.fp_product_id,
                    nm_product    = EXCLUDED.nm_product,
                    match_type    = 'manual',
                    approved      = TRUE,
                    updated_at    = EXCLUDED.updated_at
            """, (fp_url, fp_supplier_id, delivery_key, nm_variety, nu_length,
                  fp_product_id, nm_product, now, now))
        conn.commit()


def delete_delivery_match(fp_url: str, fp_supplier_id: str, delivery_key: str) -> bool:
    """Remove a cached match. Returns True if a row was deleted."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    DELETE FROM delivery_product_map
                    WHERE fp_url = %s AND fp_supplier_id = %s AND delivery_key = %s
                """, (fp_url, fp_supplier_id, delivery_key))
                deleted = cur.rowcount > 0
            conn.commit()
        return deleted
    except Exception:
        return False


def clear_delivery_matches(fp_url: str, fp_supplier_id: str) -> int:
    """Delete ALL cached matches for a supplier. Returns number of rows deleted."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    DELETE FROM delivery_product_map
                    WHERE fp_url = %s AND fp_supplier_id = %s
                """, (fp_url, fp_supplier_id))
                deleted = cur.rowcount
            conn.commit()
        return deleted
    except Exception:
        return 0


def ensure_delivery_import_log() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS delivery_import_log (
                    id                   SERIAL PRIMARY KEY,
                    fp_url               TEXT NOT NULL,
                    fp_supplier_id       TEXT,
                    tx_company           TEXT,
                    id_invoice           TEXT,
                    dt_fly               TEXT,
                    tx_awb               TEXT,
                    nu_boxes             INTEGER,
                    nu_stems_total       INTEGER,
                    mny_total            NUMERIC(12,2),
                    nu_lines_total       INTEGER DEFAULT 0,
                    nu_lines_matched     INTEGER DEFAULT 0,
                    batch_id             TEXT,
                    batch_url            TEXT,
                    batch_status         TEXT DEFAULT 'pending',
                    nu_products_added    INTEGER,
                    nu_products_failed   INTEGER,
                    nu_products_skipped  INTEGER,
                    products_status      TEXT DEFAULT 'pending',
                    nm_user              TEXT,
                    details              JSONB,
                    created_at           TIMESTAMPTZ DEFAULT NOW(),
                    updated_at           TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute("ALTER TABLE delivery_import_log ADD COLUMN IF NOT EXISTS invoice_id  TEXT")
            cur.execute("ALTER TABLE delivery_import_log ADD COLUMN IF NOT EXISTS invoice_url TEXT")
        conn.commit()


# ---------------------------------------------------------------------------
# BI Sync analytics mirror — webshop stock_entry / order_lines (2026-08-27)
#
# stock_entry is long-lived and repeatedly mutated (not one-row-per-delivery),
# so it's split dim (rarely-changing descriptive fields, upserted, retained
# forever even once a stock_entry stops appearing in exports — needed so old
# order_lines can still resolve product/farm) + daily fact (one row per
# stock_entry per sync day, only the fields that actually change day to day).
# order_lines is append-only and pre-filtered to customer_id=12 (OZ-Hami
# Direct Sales / OZEDS) at ingest time — see bi_sync.py — since webshop sale
# price is customer-specific and OZEDS is the agreed reference customer.
#
# All price fields (bi_stock_entry_daily.price/price_plus/retail_price/cost,
# bi_order_lines.supplier_price/store_price) are assumed EUR for now — the
# source export doesn't carry a currency field. The `currency` column exists
# so a future switch to USD doesn't require silently reinterpreting old rows:
# it defaults to 'EUR' today and can be set explicitly once the ingestion
# code has an actual per-row currency to write (2026-08-31).
# ---------------------------------------------------------------------------

def ensure_bi_tables() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS bi_stock_entry_dim (
                    stock_entry_id     TEXT PRIMARY KEY,
                    product_id         TEXT,
                    manufacturer_id    TEXT,
                    supplier_id        TEXT,
                    location_id        TEXT,
                    fust               TEXT,
                    color_id           TEXT,
                    length             INTEGER,
                    stems_per_bunch    INTEGER,
                    cut_stage_id       TEXT,
                    pot_size           TEXT,
                    description        TEXT,
                    stock_entry_type_id TEXT,
                    first_seen_at      TIMESTAMPTZ DEFAULT NOW(),
                    last_seen_at       TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute("ALTER TABLE bi_stock_entry_dim ADD COLUMN IF NOT EXISTS stock_entry_type_id TEXT")
            cur.execute("CREATE INDEX IF NOT EXISTS bi_stock_entry_dim_product_idx ON bi_stock_entry_dim(product_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS bi_stock_entry_dim_mfr_idx     ON bi_stock_entry_dim(manufacturer_id)")

            cur.execute("""
                CREATE TABLE IF NOT EXISTS bi_stock_entry_daily (
                    stock_entry_id       TEXT NOT NULL,
                    snapshot_date        DATE NOT NULL,
                    quantity             NUMERIC,
                    quantity_per_pack    NUMERIC,
                    quantity_available   NUMERIC,
                    price                NUMERIC,
                    price_plus           NUMERIC,
                    retail_price         NUMERIC,
                    cost                 NUMERIC,
                    currency             TEXT DEFAULT 'EUR',
                    visible              BOOLEAN,
                    source_mutation_time TIMESTAMPTZ,
                    synced_at            TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (stock_entry_id, snapshot_date)
                )
            """)
            cur.execute("ALTER TABLE bi_stock_entry_daily ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EUR'")
            cur.execute("CREATE INDEX IF NOT EXISTS bi_stock_entry_daily_date_idx ON bi_stock_entry_daily(snapshot_date)")

            cur.execute("""
                CREATE TABLE IF NOT EXISTS bi_order_lines (
                    id                       TEXT PRIMARY KEY,
                    invoice_id               TEXT,
                    main_invoice_id          TEXT,
                    created_from_stock_entry_id TEXT,
                    product_id               TEXT,
                    manufacturer_id          TEXT,
                    length                   INTEGER,
                    supplier_id              TEXT,
                    customer_id              TEXT,
                    quantity                 NUMERIC,
                    quantity_per_pack        NUMERIC,
                    supplier_price           NUMERIC,
                    store_price              NUMERIC,
                    currency                 TEXT DEFAULT 'EUR',
                    creation_date_time       TIMESTAMPTZ,
                    synced_at                TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute("ALTER TABLE bi_order_lines ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EUR'")
            cur.execute("ALTER TABLE bi_order_lines ADD COLUMN IF NOT EXISTS manufacturer_id TEXT")
            cur.execute("ALTER TABLE bi_order_lines ADD COLUMN IF NOT EXISTS length INTEGER")
            cur.execute("ALTER TABLE bi_order_lines ADD COLUMN IF NOT EXISTS supplier_id TEXT")
            cur.execute("CREATE INDEX IF NOT EXISTS bi_order_lines_product_idx  ON bi_order_lines(product_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS bi_order_lines_mfr_idx      ON bi_order_lines(manufacturer_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS bi_order_lines_supplier_idx ON bi_order_lines(supplier_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS bi_order_lines_created_idx  ON bi_order_lines(creation_date_time)")
            cur.execute("CREATE INDEX IF NOT EXISTS bi_order_lines_stockent_idx ON bi_order_lines(created_from_stock_entry_id)")

            # id->name lookup for FreshPortal-registered suppliers — pure
            # denormalized cache, refreshed every sync (upsert), used only to
            # label chart legends (confirmed real columns 2026-09-02: id,
            # type_id, group_id, number, code, gln_code, name, country_id —
            # only id/name are captured here).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS bi_suppliers (
                    supplier_id TEXT PRIMARY KEY,
                    name        TEXT,
                    updated_at  TIMESTAMPTZ DEFAULT NOW()
                )
            """)

            # Accumulates invoice_id -> customer_id forever across every sync run
            # (never truncated) — the /v2/export endpoint is a delta feed scoped to
            # mutation_datetime, so an order_line synced today can reference an
            # invoice that itself wasn't mutated today and therefore isn't in
            # today's invoice.csv. Without this standing map, such an order_line's
            # customer could never be resolved and it would be silently dropped
            # from the OZEDS filter forever (found 2026-08-31: a fresh sync
            # reported 7,552 stock_entries but 0 order_lines for customer 12,
            # because the day's invoice table only covered invoices mutated that
            # day, not every invoice referenced by that day's order_lines).
            cur.execute("""
                CREATE TABLE IF NOT EXISTS bi_invoice_customer (
                    invoice_id  TEXT PRIMARY KEY,
                    customer_id TEXT,
                    updated_at  TIMESTAMPTZ DEFAULT NOW()
                )
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS bi_sync_log (
                    id             SERIAL PRIMARY KEY,
                    started_at     TIMESTAMPTZ DEFAULT NOW(),
                    finished_at    TIMESTAMPTZ,
                    mutation_from  TEXT,
                    stock_entries_seen INT,
                    order_lines_seen   INT,
                    status         TEXT DEFAULT 'running',
                    error          TEXT,
                    messages       JSONB DEFAULT '[]'::jsonb
                )
            """)
        conn.commit()


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _bool01(v: Any) -> bool | None:
    if v is None or v == "":
        return None
    return str(v).strip() not in ("0", "false", "False", "")


def _int(v: Any) -> int | None:
    n = _num(v)
    return int(n) if n is not None else None


def upsert_bi_stock_entry_dim(rows: list[dict]) -> int:
    """Upsert descriptive fields for stock_entry rows. Never deletes — a
    stock_entry that stops appearing in future exports is left as-is, so
    historical order_lines can still resolve its product/farm."""
    if not rows:
        return 0
    ensure_bi_tables()
    now = datetime.now(timezone.utc)
    with _conn() as conn:
        with conn.cursor() as cur:
            for i in range(0, len(rows), _BATCH_SIZE):
                batch = rows[i:i + _BATCH_SIZE]
                values = [
                    (
                        r.get("id"), r.get("product_id"), r.get("manufacturer_id"),
                        r.get("supplier_id"), r.get("location_id"), r.get("fust"),
                        r.get("color_id"), _int(r.get("length")),
                        _int(r.get("stems_per_bunch")),
                        r.get("cut_stage_id"), r.get("pot_size"), r.get("description"),
                        r.get("stock_entry_type_id"),
                        now, now,
                    )
                    for r in batch if r.get("id")
                ]
                if not values:
                    continue
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO bi_stock_entry_dim (
                        stock_entry_id, product_id, manufacturer_id, supplier_id,
                        location_id, fust, color_id, length, stems_per_bunch,
                        cut_stage_id, pot_size, description, stock_entry_type_id,
                        first_seen_at, last_seen_at
                    ) VALUES %s
                    ON CONFLICT (stock_entry_id) DO UPDATE SET
                        product_id      = EXCLUDED.product_id,
                        manufacturer_id = EXCLUDED.manufacturer_id,
                        supplier_id     = EXCLUDED.supplier_id,
                        location_id     = EXCLUDED.location_id,
                        fust            = EXCLUDED.fust,
                        color_id        = EXCLUDED.color_id,
                        length          = EXCLUDED.length,
                        stems_per_bunch = EXCLUDED.stems_per_bunch,
                        cut_stage_id    = EXCLUDED.cut_stage_id,
                        pot_size        = EXCLUDED.pot_size,
                        description     = EXCLUDED.description,
                        stock_entry_type_id = EXCLUDED.stock_entry_type_id,
                        last_seen_at    = EXCLUDED.last_seen_at
                """, values)
                conn.commit()
    return len(rows)


def upsert_bi_stock_entry_daily(rows: list[dict], snapshot_date: str) -> int:
    """One row per stock_entry for snapshot_date (idempotent — safe to re-run
    the same day's sync; ON CONFLICT overwrites with the latest pulled values)."""
    if not rows:
        return 0
    ensure_bi_tables()
    now = datetime.now(timezone.utc)
    with _conn() as conn:
        with conn.cursor() as cur:
            for i in range(0, len(rows), _BATCH_SIZE):
                batch = rows[i:i + _BATCH_SIZE]
                values = [
                    (
                        r.get("id"), snapshot_date,
                        _num(r.get("quantity")), _num(r.get("quantity_per_pack")),
                        _num(r.get("quantity_available")), _num(r.get("price")),
                        _num(r.get("price_plus")), _num(r.get("retail_price")),
                        _num(r.get("cost")), _bool01(r.get("visible")),
                        r.get("mutation_date_time") or None, now,
                    )
                    for r in batch if r.get("id")
                ]
                if not values:
                    continue
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO bi_stock_entry_daily (
                        stock_entry_id, snapshot_date, quantity, quantity_per_pack,
                        quantity_available, price, price_plus, retail_price, cost,
                        visible, source_mutation_time, synced_at
                    ) VALUES %s
                    ON CONFLICT (stock_entry_id, snapshot_date) DO UPDATE SET
                        quantity             = EXCLUDED.quantity,
                        quantity_per_pack     = EXCLUDED.quantity_per_pack,
                        quantity_available    = EXCLUDED.quantity_available,
                        price                = EXCLUDED.price,
                        price_plus           = EXCLUDED.price_plus,
                        retail_price         = EXCLUDED.retail_price,
                        cost                 = EXCLUDED.cost,
                        visible              = EXCLUDED.visible,
                        source_mutation_time = EXCLUDED.source_mutation_time,
                        synced_at            = EXCLUDED.synced_at
                """, values)
                conn.commit()
    return len(rows)


def upsert_bi_order_lines(rows: list[dict]) -> int:
    """Append-only (order_lines never really change once created) — upsert
    only to make re-running a sync safe, not because rows are expected to
    change."""
    if not rows:
        return 0
    ensure_bi_tables()
    now = datetime.now(timezone.utc)
    with _conn() as conn:
        with conn.cursor() as cur:
            for i in range(0, len(rows), _BATCH_SIZE):
                batch = rows[i:i + _BATCH_SIZE]
                values = [
                    (
                        r.get("id"), r.get("invoice_id"), r.get("main_invoice_id"),
                        r.get("created_from_stock_entry_id"), r.get("product_id"),
                        r.get("manufacturer_id"), _int(r.get("length")), r.get("supplier_id"),
                        r.get("customer_id"),
                        _num(r.get("quantity")), _num(r.get("quantity_per_pack")),
                        _num(r.get("supplier_price")), _num(r.get("store_price")),
                        r.get("creation_date_time") or None, now,
                    )
                    for r in batch if r.get("id")
                ]
                if not values:
                    continue
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO bi_order_lines (
                        id, invoice_id, main_invoice_id, created_from_stock_entry_id,
                        product_id, manufacturer_id, length, supplier_id, customer_id, quantity, quantity_per_pack,
                        supplier_price, store_price, creation_date_time, synced_at
                    ) VALUES %s
                    ON CONFLICT (id) DO UPDATE SET
                        invoice_id      = EXCLUDED.invoice_id,
                        main_invoice_id = EXCLUDED.main_invoice_id,
                        created_from_stock_entry_id = EXCLUDED.created_from_stock_entry_id,
                        product_id      = EXCLUDED.product_id,
                        manufacturer_id = EXCLUDED.manufacturer_id,
                        length          = EXCLUDED.length,
                        supplier_id     = EXCLUDED.supplier_id,
                        customer_id     = EXCLUDED.customer_id,
                        quantity        = EXCLUDED.quantity,
                        quantity_per_pack = EXCLUDED.quantity_per_pack,
                        supplier_price  = EXCLUDED.supplier_price,
                        store_price     = EXCLUDED.store_price,
                        creation_date_time = EXCLUDED.creation_date_time,
                        synced_at       = EXCLUDED.synced_at
                """, values)
                conn.commit()
    return len(rows)


def upsert_bi_invoice_customer(rows: list[dict]) -> int:
    """Accumulate invoice_id -> customer_id forever (never truncated) — see
    ensure_bi_tables() docstring on bi_invoice_customer for why this standing
    map exists rather than resolving customer_id from the current sync's
    invoice table alone."""
    if not rows:
        return 0
    ensure_bi_tables()
    with _conn() as conn:
        with conn.cursor() as cur:
            for i in range(0, len(rows), _BATCH_SIZE):
                batch = rows[i:i + _BATCH_SIZE]
                values = [(r.get("id"), r.get("customer_id")) for r in batch if r.get("id")]
                if not values:
                    continue
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO bi_invoice_customer (invoice_id, customer_id, updated_at)
                    VALUES %s
                    ON CONFLICT (invoice_id) DO UPDATE SET
                        customer_id = COALESCE(NULLIF(EXCLUDED.customer_id, ''), bi_invoice_customer.customer_id),
                        updated_at  = NOW()
                """, values, template="(%s, %s, NOW())")
                conn.commit()
    return len(rows)


def get_bi_invoice_customer_map(invoice_ids: list[str]) -> dict[str, str]:
    """Batched lookup against the standing bi_invoice_customer map for ids not
    resolved from the current sync's own invoice table."""
    ids = [i for i in set(invoice_ids) if i]
    if not ids:
        return {}
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT invoice_id, customer_id FROM bi_invoice_customer WHERE invoice_id = ANY(%s)",
                    (ids,),
                )
                return {r[0]: r[1] for r in cur.fetchall() if r[1]}
    except Exception as exc:
        logger.warning("get_bi_invoice_customer_map: %s", exc)
        return {}


def log_bi_sync_start(mutation_from: str) -> int:
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO bi_sync_log (started_at, mutation_from, status) VALUES (NOW(), %s, 'running') RETURNING id",
                    (mutation_from,),
                )
                return cur.fetchone()[0]
    except Exception as exc:
        logger.error("log_bi_sync_start: %s", exc)
        return -1


def append_bi_sync_message(sync_id: int, message: str) -> None:
    if sync_id < 0:
        return
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE bi_sync_log SET messages = messages || %s::jsonb WHERE id = %s",
                    (json.dumps([message]), sync_id),
                )
    except Exception as exc:
        logger.warning("append_bi_sync_message: %s", exc)


def log_bi_sync_finish(sync_id: int, stock_entries_seen: int, order_lines_seen: int, error: str = "") -> None:
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE bi_sync_log
                    SET finished_at        = NOW(),
                        stock_entries_seen = %s,
                        order_lines_seen   = %s,
                        status             = %s,
                        error              = %s
                    WHERE id = %s
                """, (stock_entries_seen, order_lines_seen, "error" if error else "ok", error or None, sync_id))
        conn.commit()
    except Exception as exc:
        logger.error("log_bi_sync_finish: %s", exc)


def get_bi_sync_history(limit: int = 20, offset: int = 0) -> list[dict]:
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, started_at, finished_at, mutation_from,
                           stock_entries_seen, order_lines_seen, status, error, messages
                    FROM bi_sync_log ORDER BY id DESC LIMIT %s OFFSET %s
                """, (limit, offset))
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.error("get_bi_sync_history: %s", exc)
        return []


def get_bi_stats() -> dict:
    """Row counts for the Analysis Tool test panel."""
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM bi_stock_entry_dim")
                dim_count = cur.fetchone()[0]
                cur.execute("SELECT COUNT(*) FROM bi_stock_entry_daily")
                daily_count = cur.fetchone()[0]
                cur.execute("SELECT COUNT(DISTINCT snapshot_date) FROM bi_stock_entry_daily")
                snapshot_days = cur.fetchone()[0]
                cur.execute("SELECT COUNT(*) FROM bi_order_lines")
                order_lines_count = cur.fetchone()[0]
                cur.execute("SELECT COUNT(*) FROM bi_invoice_customer")
                invoice_customer_count = cur.fetchone()[0]
                return {
                    "stock_entry_dim_count": dim_count,
                    "stock_entry_daily_count": daily_count,
                    "snapshot_days": snapshot_days,
                    "order_lines_count": order_lines_count,
                    "invoice_customer_count": invoice_customer_count,
                }
    except Exception as exc:
        logger.warning("get_bi_stats failed: %s", exc)
        return {}


def get_bi_stock_entries_daily_series(days: int = 30) -> list[dict]:
    """Live (already-filtered, see bi_sync.py) stock_entry count per
    snapshot_date, most recent `days` snapshot days — first chart data for
    the Analysis Tool."""
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT snapshot_date::text AS day, COUNT(*) AS count,
                           AVG(price) AS avg_price
                    FROM bi_stock_entry_daily
                    GROUP BY snapshot_date
                    ORDER BY snapshot_date DESC
                    LIMIT %s
                """, (days,))
                rows = [dict(r) for r in cur.fetchall()]
                rows.reverse()
                return rows
    except Exception as exc:
        logger.warning("get_bi_stock_entries_daily_series: %s", exc)
        return []


def get_bi_order_lines_daily_series(days: int = 30) -> list[dict]:
    """order_lines (OZEDS, already filtered — see bi_sync.py) count and
    revenue per creation day, most recent `days` days with data — first
    chart data for the Analysis Tool."""
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT creation_date_time::date::text AS day,
                           COUNT(*) AS count,
                           SUM(quantity) AS total_quantity,
                           SUM(quantity * store_price) AS revenue
                    FROM bi_order_lines
                    WHERE creation_date_time IS NOT NULL
                    GROUP BY creation_date_time::date
                    ORDER BY creation_date_time::date DESC
                    LIMIT %s
                """, (days,))
                rows = [dict(r) for r in cur.fetchall()]
                rows.reverse()
                return rows
    except Exception as exc:
        logger.warning("get_bi_order_lines_daily_series: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Sales-by-supplier / sales-by-product analytics — multi-series (up to 7
# lines) time series, redesigned 2026-09-02 per user feedback: the first
# pass (product-first, static per-supplier/per-length bars) wasn't the
# angle they wanted. All series use *realized sale price*
# (bi_order_lines.store_price), customer 12 (OZEDS) only — the only sales
# data this tool collects. "Dostawca" = stock_entry.supplier_id (the
# FreshPortal-registered supplier), enriched onto bi_order_lines the same
# way as manufacturer_id/length (via created_from_stock_entry_id).
# ---------------------------------------------------------------------------

def upsert_bi_suppliers(rows: list[dict]) -> int:
    """id->name lookup, refreshed every sync — chart legend labels only."""
    if not rows:
        return 0
    ensure_bi_tables()
    with _conn() as conn:
        with conn.cursor() as cur:
            for i in range(0, len(rows), _BATCH_SIZE):
                batch = rows[i:i + _BATCH_SIZE]
                values = [(r.get("id"), r.get("name")) for r in batch if r.get("id")]
                if not values:
                    continue
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO bi_suppliers (supplier_id, name, updated_at)
                    VALUES %s
                    ON CONFLICT (supplier_id) DO UPDATE SET
                        name = COALESCE(NULLIF(EXCLUDED.name, ''), bi_suppliers.name),
                        updated_at = NOW()
                """, values, template="(%s, %s, NOW())")
                conn.commit()
    return len(rows)


def get_bi_products_only_picker(limit: int = 300) -> list[dict]:
    """Distinct products (independent of length) seen in bi_stock_entry_dim,
    most data-rich first — powers the "by product" picker."""
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT product_id, MAX(description) AS description, COUNT(*) AS row_count
                    FROM bi_stock_entry_dim
                    WHERE product_id IS NOT NULL
                    GROUP BY product_id
                    ORDER BY row_count DESC
                    LIMIT %s
                """, (limit,))
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.warning("get_bi_products_only_picker: %s", exc)
        return []


def get_bi_lengths_for_product(product_id: str) -> list[int]:
    """Distinct lengths seen for one product — populates the optional length
    refinement dropdown in the "by product" view."""
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT DISTINCT length FROM bi_stock_entry_dim
                    WHERE product_id = %s AND length IS NOT NULL
                    ORDER BY length
                """, (product_id,))
                return [r[0] for r in cur.fetchall()]
    except Exception as exc:
        logger.warning("get_bi_lengths_for_product: %s", exc)
        return []


def get_bi_suppliers_for_picker(limit: int = 200) -> list[dict]:
    """Suppliers that actually have sold lines (bi_order_lines), most
    data-rich first — powers the "by supplier" picker. Name from
    bi_suppliers, falls back to the raw id if unmatched."""
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT ol.supplier_id, COALESCE(s.name, ol.supplier_id) AS name, COUNT(*) AS row_count
                    FROM bi_order_lines ol
                    LEFT JOIN bi_suppliers s ON s.supplier_id = ol.supplier_id
                    WHERE ol.supplier_id IS NOT NULL
                    GROUP BY ol.supplier_id, s.name
                    ORDER BY row_count DESC
                    LIMIT %s
                """, (limit,))
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.warning("get_bi_suppliers_for_picker: %s", exc)
        return []


def get_bi_sales_by_supplier(supplier_id: str, days: int = 90, max_series: int = 7) -> dict:
    """Multi-series sale-price-over-time for one supplier — one line per
    product (top `max_series` by row count), x=day, y=avg store_price."""
    try:
        ensure_bi_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT product_id, COUNT(*) AS cnt
                    FROM bi_order_lines
                    WHERE supplier_id = %s AND creation_date_time >= CURRENT_DATE - %s * INTERVAL '1 day'
                    GROUP BY product_id
                    ORDER BY cnt DESC
                    LIMIT %s
                """, (supplier_id, days, max_series))
                top_products = [r["product_id"] for r in cur.fetchall()]
                if not top_products:
                    return {"series": []}

                cur.execute("""
                    SELECT product_id, creation_date_time::date::text AS day, AVG(store_price) AS avg_price
                    FROM bi_order_lines
                    WHERE supplier_id = %s AND product_id = ANY(%s)
                      AND creation_date_time >= CURRENT_DATE - %s * INTERVAL '1 day'
                    GROUP BY product_id, creation_date_time::date
                    ORDER BY product_id, day
                """, (supplier_id, top_products, days))
                rows = cur.fetchall()

                cur.execute("""
                    SELECT product_id, MAX(description) AS description
                    FROM bi_stock_entry_dim
                    WHERE product_id = ANY(%s)
                    GROUP BY product_id
                """, (top_products,))
                labels = {r["product_id"]: r["description"] for r in cur.fetchall()}

        by_product: dict[str, list[dict]] = {pid: [] for pid in top_products}
        for r in rows:
            by_product[r["product_id"]].append({"day": r["day"], "value": float(r["avg_price"])})

        return {
            "series": [
                {"key": pid, "label": labels.get(pid) or pid, "points": by_product.get(pid, [])}
                for pid in top_products
            ]
        }
    except Exception as exc:
        logger.warning("get_bi_sales_by_supplier: %s", exc)
        return {"series": []}


def get_bi_sales_by_product(product_id: str, length: int | None = None, days: int = 90, max_series: int = 7) -> dict:
    """Multi-series sale-price-over-time for one product (optionally scoped
    to one length — otherwise averaged across every length sold) — one line
    per supplier (top `max_series` by row count), x=day, y=avg store_price."""
    try:
        ensure_bi_tables()
        length_clause = "AND length = %s" if length is not None else ""
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                params_top: list = [product_id]
                if length is not None:
                    params_top.append(length)
                params_top += [days, max_series]
                cur.execute(f"""
                    SELECT supplier_id, COUNT(*) AS cnt
                    FROM bi_order_lines
                    WHERE product_id = %s {length_clause} AND supplier_id IS NOT NULL
                      AND creation_date_time >= CURRENT_DATE - %s * INTERVAL '1 day'
                    GROUP BY supplier_id
                    ORDER BY cnt DESC
                    LIMIT %s
                """, params_top)
                top_suppliers = [r["supplier_id"] for r in cur.fetchall()]
                if not top_suppliers:
                    return {"series": []}

                params_rows: list = [product_id]
                if length is not None:
                    params_rows.append(length)
                params_rows += [top_suppliers, days]
                cur.execute(f"""
                    SELECT supplier_id, creation_date_time::date::text AS day, AVG(store_price) AS avg_price
                    FROM bi_order_lines
                    WHERE product_id = %s {length_clause} AND supplier_id = ANY(%s)
                      AND creation_date_time >= CURRENT_DATE - %s * INTERVAL '1 day'
                    GROUP BY supplier_id, creation_date_time::date
                    ORDER BY supplier_id, day
                """, params_rows)
                rows = cur.fetchall()

                cur.execute("SELECT supplier_id, name FROM bi_suppliers WHERE supplier_id = ANY(%s)", (top_suppliers,))
                labels = {r["supplier_id"]: r["name"] for r in cur.fetchall()}

        by_supplier: dict[str, list[dict]] = {sid: [] for sid in top_suppliers}
        for r in rows:
            by_supplier[r["supplier_id"]].append({"day": r["day"], "value": float(r["avg_price"])})

        return {
            "series": [
                {"key": sid, "label": labels.get(sid) or sid, "points": by_supplier.get(sid, [])}
                for sid in top_suppliers
            ]
        }
    except Exception as exc:
        logger.warning("get_bi_sales_by_product: %s", exc)
        return {"series": []}


# ---------------------------------------------------------------------------
# DFG customers — the fixed customer list an order can be invoiced to via the
# DFG BatchV1 API (delivery-import). Was a hardcoded 4-entry list in
# DeliveryImporter.tsx (DFG_CUSTOMERS); moved to DB so an admin can enable
# more of the full FreshPortal customer list via AdminTab's Customers tab.
# used_in_delivery_import is its own column rather than a single is_active
# flag since the same master list may end up used elsewhere later
# (2026-09-01).
# ---------------------------------------------------------------------------

_DFG_CUSTOMER_SEED: list[tuple[str, str]] = [
    ("198", "Florca (Doha)"),
    ("196", "OZ-Hami - PROMO"),
    ("192", "Van den Bergh (Colombia - Qatar)"),
    ("191", "DEEP FLOWERS TRADING LLC SPC"),
    ("189", "Coloriginz - Colombia Direct"),
    ("186", "The Parfum Flower Company (DS)"),
    ("185", "The Parfum Flower Company-Colombia (DS)"),
    ("184", "OZ-Hami - Colombia (DS)"),
    ("183", "Waterdrinker"),
    ("180", "Trade Fair 2025"),
    ("179", "Coloriginz - Summerflowers (Sea)"),
    ("177", "Kosten berekening EC-NL Holiday OZH"),
    ("176", "Fresh From Source Kenya"),
    ("175", "Transportgemeinschaft Wangen FT"),
    ("174", "Willem Jan Dollar"),
    ("173", "Willem Jan"),
    ("168", "Kostenberekening Ecuador Coloriginz - Summerflowers 5 %"),
    ("167", "Transportgemeinschaft Wangen (TGW04)"),
    ("163", "My Peony"),
    ("162", "Van Dijk Flora B.V. (Biedronka)"),
    ("161", "Kosten berekening EC-NL DS"),
    ("160", "OZ-Hami - Growers Offer"),
    ("159", "OZ-Hami - Product bought"),
    ("158", "MFO Holland B.V."),
    ("148", "OZ-Hami - Holiday availability"),
    ("147", "OZ-Hami (sea)"),
    ("142", "The Parfum Flower Company (2TRC)"),
    ("141", "The Parfum Flower Company (1TRC)"),
    ("140", "Gebr. Barendsen B.V. - Direct Sales"),
    ("133", "Coloriginz - OZ-Hami"),
    ("132", "Kosten berekening EC-NL COL (CONS)"),
    ("130", "A. Heemskerk - Direct Sales"),
    ("118", "Fresh From Source Netherlands (CIF)"),
    ("117", "Fresh From Source Netherlands"),
    ("111", "Kosten berekening EC-NL COL (Fairtrade)"),
    ("109", "Coloriginz - (DS Magic)"),
    ("105", "Kosten berekening EC-NL (RSDR)"),
    ("82",  "OZ-Hami (DS inc)"),
    ("68",  "OZ-Hami (DS Magic)"),
    ("67",  "Kosten berekening EC-NL (FFS)"),
    ("65",  "OZ-Hami - Colombia"),
    ("55",  "Coloriginz - Roses (Sea)"),
    ("41",  "Coloriginz - Barendsen"),
    ("40",  "Gebr. Barendsen B.V."),
    ("38",  "Coloriginz - Roses (Fairtrade)"),
    ("34",  "Parfum Flower Company - Roses Water"),
    ("32",  "Kosten berekening EC-NL OZI"),
    ("31",  "Kosten berekening EC-NL"),
    ("29",  "FFSE OFFER"),
    ("28",  "OZ-Hami - Weekly availability"),
    ("22",  "Coloriginz"),
    ("19",  "Coloriginz - (Direct Sales)"),
    ("17",  "Coloriginz - Latitude Consignment"),
    ("16",  "Coloriginz - Summerflowers"),
    ("15",  "Coloriginz - Colombia (DS)"),
    ("14",  "OZ-Hami - Gypso"),
    ("12",  "OZ-Hami - Direct Sales"),
    ("8",   "The Parfum Flower Company-Colombia"),
    ("7",   "The Parfum Flower Company"),
    ("6",   "Coloriginz - Roses"),
    ("5",   "OZ-Hami - TFPO"),
    ("2",   "OZ-Hami - Actual weight"),
]

# The 4 previously hardcoded in DFG_CUSTOMERS — seeded as
# used_in_delivery_import=True so existing behavior doesn't change until an
# admin explicitly enables more via the Customers tab.
_DFG_CUSTOMER_SEED_DEFAULT_USED = {"2", "12", "14", "16"}


def ensure_dfg_customers_table() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS dfg_customers (
                    customer_id              TEXT PRIMARY KEY,
                    nm_customer               TEXT NOT NULL,
                    used_in_delivery_import   BOOLEAN NOT NULL DEFAULT FALSE,
                    updated_at                TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute("SELECT COUNT(*) FROM dfg_customers")
            if cur.fetchone()[0] == 0:
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO dfg_customers (customer_id, nm_customer, used_in_delivery_import)
                    VALUES %s
                """, [
                    (cid, name, cid in _DFG_CUSTOMER_SEED_DEFAULT_USED)
                    for cid, name in _DFG_CUSTOMER_SEED
                ])
        conn.commit()


def get_dfg_customers() -> list[dict]:
    try:
        ensure_dfg_customers_table()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT customer_id, nm_customer, used_in_delivery_import
                    FROM dfg_customers
                    ORDER BY nm_customer
                """)
                return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.warning("get_dfg_customers: %s", exc)
        return []


def set_dfg_customer_flag(customer_id: str, used_in_delivery_import: bool) -> None:
    ensure_dfg_customers_table()
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE dfg_customers
                SET used_in_delivery_import = %s, updated_at = NOW()
                WHERE customer_id = %s
            """, (used_in_delivery_import, customer_id))
        conn.commit()


def set_all_dfg_customer_flags(used_in_delivery_import: bool) -> None:
    """Bulk set — backs the Customers tab's "select all" header checkbox."""
    ensure_dfg_customers_table()
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE dfg_customers
                SET used_in_delivery_import = %s, updated_at = NOW()
            """, (used_in_delivery_import,))
        conn.commit()


def create_delivery_import_log(entry: dict) -> int:
    """Insert a new delivery import log entry. Returns the new row id."""
    ensure_delivery_import_log()
    import json as _json
    now = datetime.now(timezone.utc)
    details = entry.get("details")
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO delivery_import_log
                    (fp_url, fp_supplier_id, tx_company, id_invoice, dt_fly, tx_awb,
                     nu_boxes, nu_stems_total, mny_total, nu_lines_total, nu_lines_matched,
                     batch_id, batch_url, batch_status, invoice_id, invoice_url, nm_user, details,
                     created_at, updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                entry.get("fp_url"), entry.get("fp_supplier_id"),
                entry.get("tx_company"), entry.get("id_invoice"),
                entry.get("dt_fly"), entry.get("tx_awb"),
                entry.get("nu_boxes"), entry.get("nu_stems_total"),
                entry.get("mny_total"),
                entry.get("nu_lines_total", 0), entry.get("nu_lines_matched", 0),
                entry.get("batch_id"), entry.get("batch_url"),
                entry.get("batch_status", "ok"),
                entry.get("invoice_id"), entry.get("invoice_url"),
                entry.get("nm_user"),
                _json.dumps(details) if details is not None else None,
                now, now,
            ))
            row_id = cur.fetchone()[0]
        conn.commit()
    return row_id


def update_delivery_import_log(log_id: int, update: dict) -> None:
    """Patch a delivery import log entry after add-products completes."""
    ensure_delivery_import_log()
    now = datetime.now(timezone.utc)
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE delivery_import_log
                SET nu_products_added   = %s,
                    nu_products_failed  = %s,
                    nu_products_skipped = %s,
                    products_status     = %s,
                    updated_at          = %s
                WHERE id = %s
            """, (
                update.get("nu_products_added"),
                update.get("nu_products_failed"),
                update.get("nu_products_skipped"),
                update.get("products_status", "ok"),
                now, log_id,
            ))
        conn.commit()


def get_delivery_import_logs(fp_url: str, limit: int = 20, offset: int = 0) -> tuple[list[dict], bool]:
    """Return paginated delivery import log rows and hasMore flag."""
    try:
        ensure_delivery_import_log()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, fp_supplier_id, tx_company, id_invoice, dt_fly, tx_awb,
                           nu_boxes, nu_stems_total, mny_total,
                           nu_lines_total, nu_lines_matched,
                           batch_id, batch_url, batch_status, invoice_id, invoice_url,
                           nu_products_added, nu_products_failed, nu_products_skipped,
                           products_status, nm_user, details, created_at
                    FROM delivery_import_log
                    WHERE fp_url = %s
                    ORDER BY created_at DESC
                    LIMIT %s OFFSET %s
                """, (fp_url, limit + 1, offset))
                rows = [dict(r) for r in cur.fetchall()]
        has_more = len(rows) > limit
        return rows[:limit], has_more
    except Exception:
        return [], False



# ---------------------------------------------------------------------------
# Fust (packaging) catalogue  (fp_fust)
# ---------------------------------------------------------------------------

def ensure_fust_table() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS fp_fust (
                    fp_url       TEXT NOT NULL,
                    fust_id      TEXT NOT NULL,
                    nm_fust_code TEXT,
                    nm_fust_desc TEXT,
                    synced_at    TIMESTAMPTZ DEFAULT NOW(),
                    PRIMARY KEY (fp_url, fust_id)
                )
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS fp_fust_code_idx
                ON fp_fust(fp_url, UPPER(nm_fust_code))
            """)


def upsert_fust_entries(fp_url: str, entries: list[dict]) -> int:
    """Full re-sync: replace all fust rows for this fp_url. Returns row count."""
    if not entries:
        return 0
    ensure_fust_table()
    now = datetime.now(timezone.utc)
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM fp_fust WHERE fp_url = %s", (fp_url,))
            rows = [
                (fp_url, e["fust_id"], e.get("nm_fust_code"), e.get("nm_fust_desc"), now)
                for e in entries
                if e.get("fust_id")
            ]
            psycopg2.extras.execute_values(cur, """
                INSERT INTO fp_fust (fp_url, fust_id, nm_fust_code, nm_fust_desc, synced_at)
                VALUES %s
                ON CONFLICT (fp_url, fust_id) DO UPDATE SET
                    nm_fust_code = EXCLUDED.nm_fust_code,
                    nm_fust_desc = EXCLUDED.nm_fust_desc,
                    synced_at    = EXCLUDED.synced_at
            """, rows)
        conn.commit()
    return len(rows)


def get_fust_id_for_box(fp_url: str, nm_box: str) -> str:
    """Return fust_id (numeric string) for a delivery box type code.

    nm_box: "HB", "QB", "HBE", "MB1", "MB2" etc.
    Priority:
      1. Exact match on nm_fust_code (MB1 → fust_id 782)
      2. Strip trailing digits, exact match (HBE → HB fallback)
      3. ILIKE contains stripped code
    Returns "" if not found or fust table not synced.
    """
    if not nm_box:
        return ""
    raw = nm_box.strip().upper()
    stripped = re.sub(r"\d+$", "", raw)
    try:
        ensure_fust_table()
        with _conn() as conn:
            with conn.cursor() as cur:
                # 1. Exact match (handles MB1, MB2, HB, QB directly)
                cur.execute(
                    "SELECT fust_id FROM fp_fust "
                    "WHERE fp_url = %s AND UPPER(nm_fust_code) = %s LIMIT 1",
                    (fp_url, raw),
                )
                row = cur.fetchone()
                if row:
                    return row[0]
                # 2. Stripped exact match (e.g. HBE → HB, HBTE → HBT)
                if stripped and stripped != raw:
                    cur.execute(
                        "SELECT fust_id FROM fp_fust "
                        "WHERE fp_url = %s AND UPPER(nm_fust_code) = %s LIMIT 1",
                        (fp_url, stripped),
                    )
                    row = cur.fetchone()
                    if row:
                        return row[0]
                # 3. ILIKE on stripped code (broadest fallback)
                if stripped:
                    cur.execute(
                        "SELECT fust_id FROM fp_fust "
                        "WHERE fp_url = %s AND nm_fust_code ILIKE %s "
                        "ORDER BY LENGTH(nm_fust_code), fust_id LIMIT 1",
                        (fp_url, f"{stripped}%"),
                    )
                    row = cur.fetchone()
                    if row:
                        return row[0]
    except Exception as exc:
        logger.warning("get_fust_id_for_box(%s): %s", nm_box, exc)
    return ""


def get_all_fust(fp_url: str) -> list[dict]:
    try:
        ensure_fust_table()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT fust_id, nm_fust_code, nm_fust_desc, synced_at
                    FROM fp_fust WHERE fp_url = %s
                    ORDER BY nm_fust_code
                """, (fp_url,))
                rows = []
                for r in cur.fetchall():
                    d = dict(r)
                    if d.get("synced_at") and hasattr(d["synced_at"], "isoformat"):
                        d["synced_at"] = d["synced_at"].isoformat()
                    rows.append(d)
                return rows
    except Exception as exc:
        logger.warning("get_all_fust failed: %s", exc)
        return []


def get_fust_count(fp_url: str) -> int:
    try:
        ensure_fust_table()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM fp_fust WHERE fp_url = %s", (fp_url,))
                return cur.fetchone()[0]
    except Exception:
        return 0


# ── User flags ──────────────────────────────────────────────────────────────

def ensure_user_flags() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_flags (
                    username TEXT NOT NULL,
                    flag     TEXT NOT NULL,
                    value    BOOLEAN NOT NULL DEFAULT FALSE,
                    PRIMARY KEY (username, flag)
                )
            """)
        conn.commit()


def get_user_flag(username: str, flag: str) -> bool:
    try:
        ensure_user_flags()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT value FROM user_flags WHERE username = %s AND flag = %s",
                    (username, flag)
                )
                row = cur.fetchone()
                return bool(row[0]) if row else False
    except Exception as exc:
        logger.error("get_user_flag: %s", exc)
        return False


def set_user_flag(username: str, flag: str, value: bool) -> None:
    try:
        ensure_user_flags()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO user_flags (username, flag, value)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (username, flag) DO UPDATE SET value = EXCLUDED.value
                """, (username, flag, value))
            conn.commit()
    except Exception as exc:
        logger.error("set_user_flag: %s", exc)


def get_vbn_auto_history(limit: int = 10, offset: int = 0) -> list[dict]:
    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, started_at, finished_at, checked_count, fixed_count,
                           status, error, fixes, messages
                    FROM vbn_auto_log ORDER BY id DESC LIMIT %s OFFSET %s
                """, (limit, offset))
                rows = []
                for r in cur.fetchall():
                    d = dict(r)
                    for k in ("started_at", "finished_at"):
                        if d.get(k) and hasattr(d[k], "isoformat"):
                            d[k] = d[k].isoformat()
                    rows.append(d)
                return rows
    except Exception as exc:
        logger.error("get_vbn_auto_history: %s", exc)
        return []
