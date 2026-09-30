"""Mirror of the Floricode VBN catalogue into Postgres.

Usage:
    from vbn_catalog import run_vbn_catalog_sync
    run_vbn_catalog_sync(cfg)                 # delta, or full when empty
    run_vbn_catalog_sync(cfg, mode="full")    # re-read everything
    # blocking - call from a background thread

What lands in the mirror, and why each piece is needed:

  VBN/Product      id, Dutch name, short name, application_id, product_group_id,
                   expiry_date. product_group_id and application_id sit in the
                   same row and were simply never requested by the live lookup,
                   which asked for id/name/short_name only.
  VBN/Name         the English name (involved_code_list_id 1 for products, 16
                   for groups; name_type_id 1 = Vertaling; language_id EN).
                   This is the one that matters: FreshPortal names are English
                   and VBN/Product.name is Dutch, so matching them meant
                   translating first. Mirroring the English name removes that
                   step from the matching path entirely.
  VBN/ProductGroup the group description, so a code can be shown and filtered
                   by its group rather than by a bare number.

Measured against the live API (2026-09-21): 25 981 cut-flower products in
3.6 s, 2 184 groups in 0.5 s, 51 070 English product names in 7.4 s. The
mirror costs about 3.2 MB of table plus ~4.4 MB of trigram index.

Deletion: nothing is ever deleted here. Floricode retires a code by setting
expiry_date rather than removing the row, and that field is mirrored, so the
search filters retired codes out while old products that still carry one can
still resolve its name. A code that vanished from Floricode outright would
linger, which is the harmless direction to be wrong in.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone

import requests

from config import Config
from db import (get_vbn_catalog_status, log_vbn_catalog_finish,
                log_vbn_catalog_start, get_setting, set_setting,
                update_vbn_product_names_en, upsert_vbn_product_groups,
                upsert_vbn_products, vbn_catalog_cursor)
# Private by name only - token caching lives in scraper_vbn and must not be
# duplicated here, or the two modules would race for the same token file.
# verifier.py imports from scraper_vbn the same way.
from scraper_vbn import API_BASE, _get_token

logger = logging.getLogger(__name__)

# Which applications to mirror. 1 = Snijbloemen (cut flowers), 2 = Kamerplanten,
# 3 = Tuinplanten. Cut flowers alone is 26k of the 51.5k rows; widen it here if
# house/garden plants ever matter.
APPLICATIONS = [
    int(a) for a in os.getenv("VBN_CATALOG_APPLICATIONS", "1").split(",") if a.strip().isdigit()
]

CODELIST_PRODUCT = 1
CODELIST_GROUP = 16
NAME_TYPE_TRANSLATION = 1
LANGUAGE_EN = "EN"

# 5000 is what the API serves in ~1 s; larger pages were not accepted reliably.
PAGE_SIZE = 5000
# Codes per `in (...)` filter. 100 six-digit codes make a ~1.5 KB URL and are
# answered fine; 200 make 2.8 KB and IIS replies 404. 80 leaves clear headroom.
_NAME_ID_CHUNK = 80
# Above this many codes needing a name, one unfiltered pull of every English
# name (7.4 s measured) beats dozens of chunked round-trips.
_NAME_REPAIR_MAX_TARGETED = 400
# A delta re-reads a couple of days it has already seen. Upserts are
# idempotent, so overlap is free, and it absorbs both clock skew and rows
# written by Floricode while the previous run was in flight.
OVERLAP_DAYS = 2
_CURSOR_KEY = "vbn_catalog_cursor"


def _page(token: str, path: str, select: str, order: str, flt: str | None = None) -> list[dict]:
    """Read one OData collection whole, paging on $skip.

    $orderby is mandatory rather than cosmetic: $skip over an unordered
    collection may repeat or drop rows between pages.
    """
    rows: list[dict] = []
    skip = 0
    while True:
        params = {"$select": select, "$orderby": order, "$top": str(PAGE_SIZE), "$skip": str(skip)}
        if flt:
            params["$filter"] = flt
        resp = requests.get(
            f"{API_BASE}/{path}",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
            timeout=180,
        )
        resp.raise_for_status()
        page = resp.json().get("value", [])
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        skip += PAGE_SIZE


def _app_filter() -> str:
    if not APPLICATIONS:
        return ""
    return "(" + " or ".join(f"application_id eq {a}" for a in APPLICATIONS) + ")"


def _and(*parts: str) -> str:
    return " and ".join(p for p in parts if p)


def _since_filter(cursor: str) -> str:
    return f"change_date_time gt {cursor}" if cursor else ""


def fetch_products(token: str, cursor: str = "") -> list[dict]:
    return _page(
        token, "VBN/Product",
        select="id,name,short_name,application_id,product_group_id,expiry_date,change_date_time",
        order="id",
        flt=_and(_app_filter(), _since_filter(cursor)) or None,
    )


def fetch_groups(token: str, cursor: str = "") -> list[dict]:
    return _page(
        token, "VBN/ProductGroup",
        select="id,description,expiry_date",
        order="id",
        flt=_since_filter(cursor) or None,
    )


def _names_base_filter(codelist: int) -> str:
    return (
        f"involved_code_list_id eq {codelist} and "
        f"name_type_id eq {NAME_TYPE_TRANSLATION} and "
        f"language_id eq '{LANGUAGE_EN}'"
    )


def _names_to_map(rows: list[dict]) -> dict[str, str]:
    return {
        str(r["code_list_item_id"]): (r.get("name_or_translation") or "")
        for r in rows if r.get("code_list_item_id") is not None
    }


def fetch_names_en(token: str, codelist: int, cursor: str = "") -> dict[str, str]:
    """English translations for one code list, as {code_list_item_id: name}."""
    return _names_to_map(_page(
        token, "VBN/Name",
        select="code_list_item_id,name_or_translation",
        order="id",
        flt=_and(_names_base_filter(codelist), _since_filter(cursor)),
    ))


def fetch_names_en_for(token: str, codelist: int, ids: list[str]) -> dict[str, str]:
    """English translations for specific codes only.

    Uses `in` rather than a chain of `or`: the server rejects a filter of more
    than ~15 `or` terms with a 400, while `in` is limited only by URL length
    (200 six-digit codes make a 2.8 KB URL, which IIS answers with a 404).
    Chunked well under that. code_list_item_id is a string column here, hence
    the quoted literals.
    """
    out: dict[str, str] = {}
    for i in range(0, len(ids), _NAME_ID_CHUNK):
        chunk = ids[i:i + _NAME_ID_CHUNK]
        in_list = ",".join(f"'{c}'" for c in chunk)
        out.update(_names_to_map(_page(
            token, "VBN/Name",
            select="code_list_item_id,name_or_translation",
            order="id",
            flt=_and(_names_base_filter(codelist), f"code_list_item_id in ({in_list})"),
        )))
    return out


def _resolve_cursor(mode: str) -> tuple[str, str]:
    """Return (effective_mode, cursor).

    A delta is only honoured when the mirror already holds something and a
    previous run left a cursor; otherwise it silently becomes a full read,
    because a delta against an empty table would mirror only the handful of
    codes Floricode happened to touch this week.
    """
    if mode == "full":
        return "full", ""

    status = get_vbn_catalog_status()
    if not status.get("products"):
        logger.info("VBN catalogue empty - promoting delta to a full sync")
        return "full", ""

    stored = get_setting(_CURSOR_KEY, "")
    if not stored:
        # Populated by some earlier route with no cursor recorded: fall back to
        # the newest change actually mirrored.
        stored = vbn_catalog_cursor()
    if not stored:
        return "full", ""

    try:
        anchor = datetime.strptime(stored, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        logger.warning("Unparseable VBN cursor %r - doing a full sync", stored)
        return "full", ""
    anchor -= timedelta(days=OVERLAP_DAYS)
    return "delta", anchor.strftime("%Y-%m-%dT%H:%M:%SZ")


def run_vbn_catalog_sync(cfg: Config, mode: str = "delta", on_status=None) -> dict:
    """Pull the catalogue into Postgres. Blocking; returns a summary dict."""
    messages: list[str] = []

    def say(msg: str) -> None:
        messages.append(msg)
        logger.info("VBN catalogue: %s", msg)
        if on_status:
            on_status(msg)

    if not cfg.floricode_username or not cfg.floricode_password:
        raise RuntimeError("FLORICODE_USERNAME / FLORICODE_PASSWORD not set")

    mode, cursor = _resolve_cursor(mode)
    run_id = log_vbn_catalog_start(mode, cursor)
    # Stamped before any fetching, so rows Floricode writes during this run are
    # re-read by the next delta instead of falling into the gap between them.
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t0 = time.time()

    try:
        token = _get_token(cfg.floricode_username, cfg.floricode_password)

        say(f"{mode} sync" + (f" since {cursor}" if cursor else " (everything)"))

        groups = fetch_groups(token, cursor)
        group_names = fetch_names_en(token, CODELIST_GROUP, cursor)
        for g in groups:
            g["name_en"] = group_names.get(str(g.get("id")), "")
        n_groups = upsert_vbn_product_groups(groups)
        say(f"{n_groups} product groups")

        products = fetch_products(token, cursor)
        product_names = fetch_names_en(token, CODELIST_PRODUCT, cursor)
        for p in products:
            p["name_nl"] = p.get("name") or ""
            p["name_en"] = product_names.get(str(p.get("id")), "")
        n_products = upsert_vbn_products(products)
        say(f"{n_products} products")

        n_names = 0
        if mode == "delta":
            # A name can move without its product moving, since VBN/Name keeps
            # its own change_date_time. Only worth doing on a delta: a full run
            # already merged the current name into every row it wrote.
            #
            # Skipping it on a full run is not a micro-optimisation. The full
            # name pull covers every application, so ~25k of its rows belong to
            # products this mirror does not hold, and pushing them through the
            # UPDATE would be 50 round-trips that can only ever match nothing.
            seen = {str(p.get("id")) for p in products}
            stale = [(int(c), n) for c, n in product_names.items()
                     if c not in seen and c.isdigit() and n]
            n_names = update_vbn_product_names_en(stale)
            if n_names:
                say(f"{n_names} English names refreshed on unchanged products")

            # A product entering the mirror during a delta (newly created, or
            # moved into a mirrored application) can have an English name older
            # than the cursor, which this delta's name pull would not carry. Ask
            # for exactly those codes rather than re-reading all 51k names.
            gaps = [str(p["id"]) for p in products if p.get("id") and not p.get("name_en")]
            if gaps:
                if len(gaps) > _NAME_REPAIR_MAX_TARGETED:
                    # A wide delta leaves thousands of these, and asking for
                    # them 80 at a time would cost more round-trips than simply
                    # reading the whole name table once.
                    repaired = fetch_names_en(token, CODELIST_PRODUCT)
                    wanted = set(gaps)
                    repaired = {c: n for c, n in repaired.items() if c in wanted}
                else:
                    repaired = fetch_names_en_for(token, CODELIST_PRODUCT, gaps)
                fixed = update_vbn_product_names_en(
                    [(int(c), n) for c, n in repaired.items() if c.isdigit() and n]
                )
                n_names += fixed
                say(f"{len(gaps)} codes carried no English name in this delta, {fixed} filled in")

        set_setting(_CURSOR_KEY, started)
        log_vbn_catalog_finish(run_id, n_products, n_groups, n_names, messages=messages)
        say(f"done in {time.time() - t0:.1f}s")
        return {
            "mode": mode, "cursor": cursor, "products": n_products,
            "groups": n_groups, "names": n_names,
            "seconds": round(time.time() - t0, 1), "messages": messages,
        }
    except Exception as exc:
        logger.exception("VBN catalogue sync failed")
        log_vbn_catalog_finish(run_id, 0, 0, 0, str(exc), messages)
        raise
