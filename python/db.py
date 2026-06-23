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
                    nm_variety     TEXT,
                    nm_species     TEXT,
                    nu_length      INTEGER,
                    nu_stems_bunch INTEGER,
                    id_floricode   TEXT,
                    extra          JSONB DEFAULT '{{}}'::jsonb,
                    synced_at      TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute(f"CREATE INDEX IF NOT EXISTS {table}_floricode_idx ON {table}(id_floricode)")


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

    with _conn() as conn:
        with conn.cursor() as cur:
            # Clear old data
            cur.execute(f"DELETE FROM {table}")

            # Bulk insert
            count = 0
            for item in items:
                cur.execute(f"""
                    INSERT INTO {table}
                        (fp_product_id, nm_product, nm_variety, nm_species,
                         nu_length, nu_stems_bunch, id_floricode, synced_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (fp_product_id) DO UPDATE SET
                        nm_product     = EXCLUDED.nm_product,
                        nm_variety     = EXCLUDED.nm_variety,
                        nm_species     = EXCLUDED.nm_species,
                        nu_length      = EXCLUDED.nu_length,
                        nu_stems_bunch = EXCLUDED.nu_stems_bunch,
                        id_floricode   = EXCLUDED.id_floricode,
                        synced_at      = EXCLUDED.synced_at
                """, (
                    item.get("fp_product_id", ""),
                    item.get("nm_product"),
                    item.get("nm_variety"),
                    item.get("nm_species"),
                    item.get("nu_length"),
                    item.get("nu_stems_bunch"),
                    item.get("id_floricode"),
                    now,
                ))
                count += 1

            # Update meta
            cur.execute("""
                INSERT INTO catalogue_meta (supplier_id, nm_supplier, fp_url, item_count, synced_at)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (supplier_id) DO UPDATE SET
                    nm_supplier = EXCLUDED.nm_supplier,
                    fp_url      = EXCLUDED.fp_url,
                    item_count  = EXCLUDED.item_count,
                    synced_at   = EXCLUDED.synced_at
            """, (supplier_id, nm_supplier, fp_url, count, now))

        conn.commit()

    return count


def get_supplier_catalogue(supplier_id: str) -> list[dict]:
    """Return all catalogue items for supplier from its own table."""
    table = _cat_table(supplier_id)
    try:
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(f"""
                    SELECT fp_product_id, nm_product, nm_variety, nm_species,
                           nu_length, nu_stems_bunch, id_floricode, synced_at
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
