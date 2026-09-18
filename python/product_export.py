"""A system's product list read straight from its BI Sync export, in memory.

Why: the Postgres copy mirrors one FreshPortal, so on any other system its
ids, names and numbers belong to a different portal. Reading that other portal
through the browser costs a page load per search term, which is why the
browser path searches only three terms. The export hands over the whole
product table of any system that has an export key of its own.

Nothing here is written to the database. That is deliberate: a second system's
products must not end up in the copy that mirrors the first one. The rows live
in this process only.

product.csv carries id, group_id, number, vbn_number, application_id, a name
per language, vat_id, barcode and the two timestamps. Group, application and
VAT names come from the export's own lookup tables. Colour is NOT in there —
the form still offers Floricode's colour list, and a saved product's colour is
read back from the portal.

Cost, and what follows from it: /v2/export is a delta feed, so catching every
product means asking for a window of years, and FreshPortal then assembles
every other table for that window too. That download is far too slow to sit in
front of a search, so it never does: a list is only ever served from memory,
and a missing or stale one is fetched in a background thread while the caller
falls back to reading the portal. Each process restart pays for one download.

A list is a snapshot, so it answers "what is there roughly now" and is never
the last word before saving — copy_and_create re-checks the number and the
name in the portal itself.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import date, timedelta

from config import Config
from i18n import msg

logger = logging.getLogger(__name__)

# How far back to ask. A product only appears in the export when it was
# mutated inside the window, so this has to cover "long enough ago that
# everything has been touched once" — around two years in practice. Widen it
# with PRODUCT_EXPORT_SINCE_DAYS if a product is missing.
SINCE_DAYS = int(os.getenv("PRODUCT_EXPORT_SINCE_DAYS", "760"))
# Products change rarely and one download is expensive, so a list is kept for
# a long time and refreshed in the background, never on a waiting request.
DEFAULT_MAX_AGE_S = float(os.getenv("PRODUCT_EXPORT_MAX_AGE_S", str(12 * 3600)))
# A years-wide window takes FreshPortal a while to assemble.
EXPORT_URL_TIMEOUT_S = 300.0
# Per term, so a three-letter n-gram matching half the catalogue cannot make
# one search rank tens of thousands of names.
MATCHES_PER_TERM = 500

_NAME_COLUMNS = ("name_en", "name_nl", "name_es", "name")
_ALL_NAME_COLUMNS = ("name_en", "name_nl", "name_es", "name_ru", "name_zh", "name")
_LOOKUP_ID_COLUMNS = ("id", "group_id", "application_id", "vat_id", "code")
_LOOKUP_NAME_COLUMNS = ("name_en", "name_nl", "name", "description", "label", "percentage", "rate")


def since_date() -> str:
    return (date.today() - timedelta(days=SINCE_DAYS)).strftime("%Y-%m-%d")


@dataclass(slots=True)
class ExportProducts:
    """One system's product list, as read from its export."""

    system_id: str
    rows: list[dict]
    fetched_at: float
    since: str = ""
    zip_size_bytes: int = 0
    source_files: list[str] = field(default_factory=list)

    @property
    def age_s(self) -> float:
        return time.time() - self.fetched_at

    def search(self, term: str, limit: int = MATCHES_PER_TERM) -> list[dict]:
        """Rows whose name contains *term* — the copy's ILIKE, in memory."""
        needle = (term or "").strip().lower()
        if not needle:
            return []
        out: list[dict] = []
        for row in self.rows:
            if needle in row["_name_lower"]:
                out.append(row)
                if len(out) >= limit:
                    break
        return out

    def number_taken(self, number: str) -> bool:
        wanted = (number or "").strip().upper()
        if not wanted:
            return False
        return any(row["product_number"].upper() == wanted for row in self.rows)

    def by_exact_name(self, name: str, limit: int = 10) -> list[dict]:
        """Rows named exactly *name*, ignoring case and repeated spaces.

        Every language's name counts: a product the portal shows under its
        Dutch name is still the same product.
        """
        wanted = " ".join((name or "").split()).lower()
        if not wanted:
            return []
        return [row for row in self.rows if wanted in row["_names_lower"]][:limit]


_Key = tuple[str, str]
_cache: dict[_Key, ExportProducts] = {}
_loading: set[_Key] = set()
_last_error: dict[_Key, str] = {}
_lock = threading.Lock()


def _first_value(row: dict, columns: tuple[str, ...]) -> str:
    for column in columns:
        value = (row.get(column) or "").strip()
        if value:
            return value
    return ""


def _lookup_labels(zip_bytes: bytes, table_names: tuple[str, ...]) -> dict[str, str]:
    """id → label from the first of *table_names* the export actually has.

    Tolerant on purpose: these labels only decorate a template on screen, so
    an export that names its columns differently should leave them blank
    rather than break a search.
    """
    from bi_sync_client import read_table

    for table in table_names:
        try:
            rows = read_table(zip_bytes, table)
        except Exception as exc:
            logger.warning("export lookup %s failed: %s", table, exc)
            continue
        if not rows:
            continue
        id_column = next((c for c in _LOOKUP_ID_COLUMNS if c in rows[0]), "")
        name_column = next((c for c in _LOOKUP_NAME_COLUMNS if c in rows[0]), "")
        if not id_column or not name_column:
            logger.info("export lookup %s has no id/name pair in %s", table, list(rows[0]))
            continue
        labels = {
            (r.get(id_column) or "").strip(): (r.get(name_column) or "").strip()
            for r in rows if (r.get(id_column) or "").strip()
        }
        if labels:
            logger.info("export lookup %s: %d labels from %s/%s", table, len(labels), id_column, name_column)
            return labels
    return {}


def _map_row(row: dict, groups: dict[str, str], applications: dict[str, str], vats: dict[str, str]) -> dict | None:
    """One product.csv row in the shape the search and the form expect."""
    product_id = (row.get("id") or "").strip()
    if not product_id:
        return None
    name = _first_value(row, _NAME_COLUMNS)
    names = {" ".join(v.split()).lower()
             for v in ((row.get(c) or "").strip() for c in _ALL_NAME_COLUMNS) if v}
    return {
        "product_id": product_id,
        "product_number": (row.get("number") or "").strip(),
        "name": name,
        # Not in the export — better empty than guessed.
        "short_name": "",
        "vbn_number": (row.get("vbn_number") or "").strip(),
        "color": "",
        "product_group": groups.get((row.get("group_id") or "").strip(), ""),
        "application": applications.get((row.get("application_id") or "").strip(), ""),
        "vat_rate": vats.get((row.get("vat_id") or "").strip(), ""),
        "creation_moment": (row.get("creation_date_time") or "").strip(),
        "change_moment": (row.get("mutation_date_time") or "").strip(),
        # Prepared once, because every search term tests every row.
        "_name_lower": name.lower(),
        "_names_lower": names,
    }


def _download(system_id: str, cfg: Config) -> ExportProducts:
    """Fetch and parse one system's product list. Raises on failure."""
    from bi_sync_client import download_export_zip, get_export_url, list_export_files, read_table

    since = since_date()
    started = time.time()
    zip_bytes = download_export_zip(get_export_url(cfg, since, timeout=EXPORT_URL_TIMEOUT_S))
    files = [name for name, _ in list_export_files(zip_bytes)]
    raw = read_table(zip_bytes, "product")
    if not raw:
        raise RuntimeError(f"export has no product table (files: {', '.join(files) or 'none'})")

    groups = _lookup_labels(zip_bytes, ("product_group", "group"))
    applications = _lookup_labels(zip_bytes, ("application",))
    vats = _lookup_labels(zip_bytes, ("vat", "vat_rate"))
    rows = [m for m in (_map_row(r, groups, applications, vats) for r in raw) if m]

    logger.info("product export for %s: %d products from %d rows since %s in %.0fs (zip %.1f MB)",
                system_id, len(rows), len(raw), since, time.time() - started, len(zip_bytes) / 1e6)
    return ExportProducts(system_id=system_id, rows=rows, fetched_at=time.time(), since=since,
                          zip_size_bytes=len(zip_bytes), source_files=files)


def _load_now(key: _Key, system_id: str, cfg: Config) -> ExportProducts | None:
    try:
        products = _download(system_id, cfg)
    except Exception as exc:
        logger.exception("could not read the product export for %s", system_id)
        with _lock:
            _last_error[key] = str(exc)[:300]
            _loading.discard(key)
        return None
    with _lock:
        _cache[key] = products
        _last_error.pop(key, None)
        _loading.discard(key)
    return products


def load(
    system_id: str,
    cfg: Config,
    on_status=None,
    lang: str = "en",
    max_age_s: float = DEFAULT_MAX_AGE_S,
    wait: bool = False,
    force: bool = False,
) -> ExportProducts | None:
    """*system_id*'s product list from memory, fetching it when needed.

    The download is slow, so by default it happens in a background thread and
    this returns what is in memory — a list that is merely stale, or None when
    there is nothing yet and the caller should read the portal instead.
    wait=True downloads in the caller's thread. Never raises.
    """
    def _s(key_name: str, **kwargs: object) -> None:
        m = msg(lang, key_name, **kwargs)
        logger.info(m)
        if on_status:
            on_status(m)

    key = (system_id, cfg.bi_sync_api_base_url)
    with _lock:
        cached = _cache.get(key)
        fresh = cached is not None and not force and cached.age_s <= max_age_s
        already_loading = key in _loading
        if not fresh and not already_loading:
            _loading.add(key)
            start = True
        else:
            start = False

    if fresh:
        return cached

    if not start:
        # Someone else is already fetching it.
        if cached is not None:
            _s("export_using_stale", minutes=int(cached.age_s // 60))
        else:
            _s("export_downloading_background")
        return cached

    if wait:
        _s("export_downloading")
        products = _load_now(key, system_id, cfg)
        if products is not None:
            _s("export_loaded", count=len(products.rows))
        else:
            _s("export_failed", error=_last_error.get(key, "")[:120])
        return products

    threading.Thread(target=_load_now, args=(key, system_id, cfg),
                     name=f"product-export-{system_id}", daemon=True).start()
    if cached is not None:
        _s("export_using_stale", minutes=int(cached.age_s // 60))
    else:
        _s("export_downloading_background")
    return cached


def invalidate(system_id: str | None = None) -> None:
    """Drop a cached list, so the next read fetches again."""
    with _lock:
        for key in [k for k in _cache if system_id is None or k[0] == system_id]:
            del _cache[key]


def state() -> list[dict]:
    """What is held in memory right now — for the status endpoint."""
    with _lock:
        keys = set(_cache) | _loading | set(_last_error)
        out = []
        for key in sorted(keys):
            products = _cache.get(key)
            out.append({
                "system": key[0],
                "base_url": key[1],
                "products": len(products.rows) if products else 0,
                "age_seconds": round(products.age_s) if products else None,
                "since": products.since if products else since_date(),
                "zip_size_bytes": products.zip_size_bytes if products else None,
                "files_in_export": products.source_files if products else [],
                "loading": key in _loading,
                "last_error": _last_error.get(key),
            })
        return out
