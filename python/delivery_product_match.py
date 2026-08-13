"""Match delivery JSON lines against the master `products` DB (same table VBN
Checker / Nowe produkty use), for the DFG BatchV1 API path.

Replaces the old scraper_catalogue.py / supplier_catalogue matching, which
resolved to STE_ID (an internal FreshPortal stock-entry row ID meant for DOM
navigation) — not usable as the API's `product_number`.

Reuses parser_delivery.match_line_to_catalogue() — the same variety-extraction
/ similarity / floricode / cache logic already proven against the Ecuador
supplier catalogue — just fed "catalogue" rows sourced from the products DB
instead of supplier_catalogue.
"""
from __future__ import annotations

import logging

from db import search_products_db
from parser_delivery import DeliveryOrder, match_line_to_catalogue

log = logging.getLogger(__name__)


def _catalogue_rows_for_query(query: str) -> list[dict]:
    """Fetch candidate products DB rows for one variety, shaped like a catalogue entry."""
    if not query:
        return []
    rows = search_products_db(query, limit=20)
    return [
        {
            "fp_product_id": r.get("product_number") or "",
            "nm_product": r.get("name") or "",
            "id_floricode": r.get("vbn_number") or "",
        }
        for r in rows
        if r.get("product_number")
    ]


def match_order_to_products(
    order: DeliveryOrder,
    cached_matches: dict[str, dict] | None = None,
) -> tuple[int, int]:
    """In-place match every line in `order` against the products master DB.

    Sets line.fp_product_id (→ product_number for the DFG API), match_method,
    and catalogue_nm_product. One DB search per distinct variety in the order
    (not per line, not the full ~44k table) — cheap enough for delivery-sized
    orders. Returns (matched_count, unmatched_count).
    """
    matched = 0
    unmatched = 0
    query_cache: dict[str, list[dict]] = {}

    for line in order.lines:
        query = (line.nm_variety or line.nm_product or "").strip()
        if query not in query_cache:
            query_cache[query] = _catalogue_rows_for_query(query)
        candidates = query_cache[query]

        fp_id, method, cat_name = match_line_to_catalogue(line, candidates, cached_matches)
        line.fp_product_id = fp_id
        line.match_method = method
        line.catalogue_nm_product = cat_name
        if fp_id:
            matched += 1
        else:
            unmatched += 1

    return matched, unmatched
