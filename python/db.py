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
                           vbn_number, color, origin, product_group
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
    """Return all suppliers for fp_url joined with catalogue sync status."""
    try:
        ensure_suppliers_table()
        ensure_catalogue_meta_table()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT
                        s.fp_supplier_id,
                        s.nm_supplier,
                        s.discovered_at,
                        s.updated_at,
                        m.item_count,
                        m.synced_at,
                        (m.synced_at IS NOT NULL) AS synced
                    FROM fp_suppliers s
                    LEFT JOIN catalogue_meta m
                        ON m.supplier_id = s.fp_supplier_id
                       AND m.fp_url      = s.fp_url
                    WHERE s.fp_url = %s
                    ORDER BY s.nm_supplier
                """, (fp_url,))
                rows = []
                for r in cur.fetchall():
                    d = dict(r)
                    for k in ("discovered_at", "updated_at", "synced_at"):
                        if d.get(k) and hasattr(d[k], "isoformat"):
                            d[k] = d[k].isoformat()
                    d["synced"] = bool(d.get("synced"))
                    d["item_count"] = d.get("item_count") or 0
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

def find_supplier_fp_id(fp_url: str, company_name: str) -> str:
    """Return fp_supplier_id for the best name match in fp_suppliers.

    Tries:
    1. Exact nm_supplier match (case-insensitive)
    2. Each significant word (>3 chars, not a legal suffix) in nm_supplier (ILIKE)
       e.g. 'FLORICULTURA JOSARFLOR S.A.' → tries 'floricultura', then 'josarflor'
    Returns "" if not found.
    """
    if not company_name:
        return ""
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
# Supplier catalogue
# ---------------------------------------------------------------------------

def ensure_catalogue_table() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS supplier_catalogue (
                    id             SERIAL PRIMARY KEY,
                    supplier_id    TEXT NOT NULL,
                    fp_product_id  TEXT NOT NULL,
                    nm_product     TEXT,
                    nm_variety     TEXT,
                    nm_species     TEXT,
                    nu_length      INT,
                    nu_stems_bunch INT,
                    id_floricode   TEXT,
                    extra          JSONB DEFAULT '{}'::jsonb,
                    synced_at      TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(supplier_id, fp_product_id)
                )
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS catalogue_supplier_idx
                ON supplier_catalogue(supplier_id)
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS catalogue_floricode_idx
                ON supplier_catalogue(id_floricode)
            """)


def upsert_catalogue_items(supplier_id: str, items: list[dict]) -> int:
    """Bulk upsert catalogue items. Returns number of rows processed."""
    if not items:
        return 0
    ensure_catalogue_table()
    now = datetime.now(timezone.utc).isoformat()
    total = 0
    with _conn() as conn:
        with conn.cursor() as cur:
            for item in items:
                cur.execute("""
                    INSERT INTO supplier_catalogue
                        (supplier_id, fp_product_id, nm_product, nm_variety,
                         nm_species, nu_length, nu_stems_bunch, id_floricode, synced_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (supplier_id, fp_product_id) DO UPDATE SET
                        nm_product     = EXCLUDED.nm_product,
                        nm_variety     = EXCLUDED.nm_variety,
                        nm_species     = EXCLUDED.nm_species,
                        nu_length      = EXCLUDED.nu_length,
                        nu_stems_bunch = EXCLUDED.nu_stems_bunch,
                        id_floricode   = EXCLUDED.id_floricode,
                        synced_at      = EXCLUDED.synced_at
                """, (
                    supplier_id,
                    item.get("fp_product_id", ""),
                    item.get("nm_product"),
                    item.get("nm_variety"),
                    item.get("nm_species"),
                    item.get("nu_length"),
                    item.get("nu_stems_bunch"),
                    item.get("id_floricode"),
                    now,
                ))
                total += 1
        conn.commit()
    return total


def get_catalogue(supplier_id: str) -> list[dict]:
    """Return all catalogue entries for a supplier.

    Prefers the per-supplier table (catalogue_sup_{id}); falls back to the
    legacy shared supplier_catalogue table if the per-supplier table is empty.
    """
    # Try new per-supplier table first
    per_sup = get_supplier_catalogue(supplier_id)
    if per_sup:
        return per_sup
    # Fall back to legacy shared table
    try:
        ensure_catalogue_table()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT fp_product_id, nm_product, nm_variety, nm_species,
                           nu_length, nu_stems_bunch, id_floricode, synced_at
                    FROM supplier_catalogue
                    WHERE supplier_id = %s
                    ORDER BY nm_product
                """, (supplier_id,))
                rows = []
                for r in cur.fetchall():
                    d = dict(r)
                    if d.get("synced_at") and hasattr(d["synced_at"], "isoformat"):
                        d["synced_at"] = d["synced_at"].isoformat()
                    rows.append(d)
                return rows
    except Exception as exc:
        logger.warning("get_catalogue failed: %s", exc)
        return []


def get_catalogue_count(supplier_id: str) -> int:
    try:
        ensure_catalogue_table()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM supplier_catalogue WHERE supplier_id = %s",
                    (supplier_id,),
                )
                return cur.fetchone()[0]
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Per-supplier catalogue tables  (catalogue_sup_{id} + catalogue_meta)
# ---------------------------------------------------------------------------

def _safe_sup_id(supplier_id: str) -> str:
    """Return a safe identifier usable as part of a table name."""
    return re.sub(r"[^a-zA-Z0-9]", "_", str(supplier_id))


def _cat_table(supplier_id: str) -> str:
    return f"catalogue_sup_{_safe_sup_id(supplier_id)}"


def ensure_catalogue_meta_table() -> None:
    """Create the supplier registry table that tracks sync state per supplier."""
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS catalogue_meta (
                    supplier_id   TEXT PRIMARY KEY,
                    nm_supplier   TEXT,
                    fp_url        TEXT,
                    item_count    INTEGER DEFAULT 0,
                    synced_at     TIMESTAMPTZ,
                    created_at    TIMESTAMPTZ DEFAULT NOW()
                )
            """)


def ensure_supplier_catalogue_table(supplier_id: str) -> None:
    """Create catalogue_sup_{id} table if it does not exist yet."""
    table = _cat_table(supplier_id)
    ensure_catalogue_meta_table()
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {table} (
                    fp_product_id  TEXT PRIMARY KEY,
                    nm_product     TEXT,
                    nu_length      INTEGER,
                    nu_stems_bunch INTEGER,
                    nu_stems_pack  INTEGER,
                    nm_packaging   TEXT,
                    nm_maturity    TEXT,
                    id_floricode   TEXT,
                    extra          JSONB DEFAULT '{{}}'::jsonb,
                    synced_at      TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute(f"CREATE INDEX IF NOT EXISTS {table}_floricode_idx ON {table}(id_floricode)")
            # Migrate existing tables that predate these columns
            for col, coltype in [
                ("nu_stems_pack", "INTEGER"),
                ("nm_packaging",  "TEXT"),
                ("nm_maturity",   "TEXT"),
            ]:
                cur.execute(f"""
                    ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {coltype}
                """)


def clear_supplier_catalogue(supplier_id: str) -> int:
    """Delete all rows for this supplier. Returns rows deleted."""
    table = _cat_table(supplier_id)
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(f"DELETE FROM {table}")
                return cur.rowcount
    except Exception:
        return 0


def sync_supplier_catalogue(supplier_id: str, nm_supplier: str, fp_url: str, items: list[dict]) -> int:
    """Full re-sync: clear existing rows then bulk insert. Returns items saved."""
    table = _cat_table(supplier_id)
    ensure_supplier_catalogue_table(supplier_id)
    ensure_catalogue_meta_table()

    now = datetime.now(timezone.utc)
    # Deduplicate by fp_product_id — keep last occurrence (most complete data)
    seen: dict[str, dict] = {}
    for item in items:
        pid = item.get("fp_product_id", "")
        if pid:
            seen[pid] = item
    rows = [
        (
            item.get("fp_product_id", ""),
            item.get("nm_product"),
            item.get("nu_length"),
            item.get("nu_stems_bunch"),
            item.get("nu_stems_pack"),
            item.get("nm_packaging"),
            item.get("nm_maturity"),
            item.get("id_floricode"),
            now,
        )
        for item in seen.values()
    ]

    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"DELETE FROM {table}")
            psycopg2.extras.execute_values(cur, f"""
                INSERT INTO {table}
                    (fp_product_id, nm_product,
                     nu_length, nu_stems_bunch, nu_stems_pack,
                     nm_packaging, nm_maturity, id_floricode, synced_at)
                VALUES %s
                ON CONFLICT (fp_product_id) DO UPDATE SET
                    nm_product     = EXCLUDED.nm_product,
                    nu_length      = EXCLUDED.nu_length,
                    nu_stems_bunch = EXCLUDED.nu_stems_bunch,
                    nu_stems_pack  = EXCLUDED.nu_stems_pack,
                    nm_packaging   = EXCLUDED.nm_packaging,
                    nm_maturity    = EXCLUDED.nm_maturity,
                    id_floricode   = EXCLUDED.id_floricode,
                    synced_at      = EXCLUDED.synced_at
            """, rows, page_size=100)

            cur.execute("""
                INSERT INTO catalogue_meta (supplier_id, nm_supplier, fp_url, item_count, synced_at)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (supplier_id) DO UPDATE SET
                    nm_supplier = EXCLUDED.nm_supplier,
                    fp_url      = EXCLUDED.fp_url,
                    item_count  = EXCLUDED.item_count,
                    synced_at   = EXCLUDED.synced_at
            """, (supplier_id, nm_supplier, fp_url, len(rows), now))

        conn.commit()

    return len(rows)


def get_supplier_catalogue(supplier_id: str) -> list[dict]:
    """Return all catalogue items for supplier from its own table."""
    table = _cat_table(supplier_id)
    try:
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""
                    SELECT fp_product_id, nm_product,
                           nu_length, nu_stems_bunch, nu_stems_pack,
                           nm_packaging, nm_maturity, id_floricode, synced_at
                    FROM {table}
                    ORDER BY nm_product
                """)
                rows = []
                for r in cur.fetchall():
                    d = dict(r)
                    if d.get("synced_at") and hasattr(d["synced_at"], "isoformat"):
                        d["synced_at"] = d["synced_at"].isoformat()
                    rows.append(d)
                return rows
    except Exception:
        return []


def get_all_catalogue_meta() -> list[dict]:
    """Return all rows from catalogue_meta (one per synced supplier)."""
    try:
        ensure_catalogue_meta_table()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT supplier_id, nm_supplier, fp_url, item_count, synced_at
                    FROM catalogue_meta
                    ORDER BY nm_supplier
                """)
                rows = []
                for r in cur.fetchall():
                    d = dict(r)
                    if d.get("synced_at") and hasattr(d["synced_at"], "isoformat"):
                        d["synced_at"] = d["synced_at"].isoformat()
                    rows.append(d)
                return rows
    except Exception:
        return []


def get_supplier_meta_one(supplier_id: str) -> dict | None:
    """Return catalogue_meta row for one supplier, or None if not synced."""
    try:
        ensure_catalogue_meta_table()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT supplier_id, nm_supplier, fp_url, item_count, synced_at
                    FROM catalogue_meta WHERE supplier_id = %s
                """, (supplier_id,))
                row = cur.fetchone()
                if not row:
                    return None
                d = dict(row)
                if d.get("synced_at") and hasattr(d["synced_at"], "isoformat"):
                    d["synced_at"] = d["synced_at"].isoformat()
                return d
    except Exception:
        return None


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
                     batch_id, batch_url, batch_status, nm_user, details,
                     created_at, updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
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
                           batch_id, batch_url, batch_status,
                           nu_products_added, nu_products_failed, nu_products_skipped,
                           products_status, nm_user, created_at
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


def get_catalogue_last_sync(supplier_id: str) -> str | None:
    try:
        ensure_catalogue_table()
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT MAX(synced_at) FROM supplier_catalogue WHERE supplier_id = %s
                """, (supplier_id,))
                row = cur.fetchone()
                if row and row[0]:
                    return row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0])
                return None
    except Exception:
        return None


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
