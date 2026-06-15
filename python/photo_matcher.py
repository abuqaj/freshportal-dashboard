"""Match photo filenames to products in the database.

normalize_filename  — strip extension, replace separators with spaces
match_single_photo  — fast single-photo match using one AND-ILIKE DB query
match_photos        — batch match filenames → fuzzy product search results

Photo filenames are real product names (no typos), so we skip the
n-gram / AI-fallback path from search_products and use a direct
multi-word AND ILIKE query (~10-15x fewer DB round-trips).
"""
from __future__ import annotations

import difflib
import logging
import re
import unicodedata
from pathlib import Path

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'}

# Origin tokens to strip before matching (same set as product_creator)
_ORIGIN_TOKENS = {"ec", "col", "co", "ke", "ken", "nl", "et", "zim", "sa", "tz", "be", "de"}


def normalize_filename(filename: str) -> str:
    """'Rosa_Spray_Be-Amazing.jpg' → 'Rosa Spray Be Amazing'"""
    stem = Path(filename).stem
    stem = unicodedata.normalize('NFC', stem)  # ensure ñ (NFD) → ñ (NFC) etc.
    name = re.sub(r'[_\-\.]+', ' ', stem)
    return ' '.join(name.split()).strip()


def _photo_similarity(normalized: str, product_name: str) -> float:
    """Similarity score tuned for photo-to-product matching.

    Unlike _similarity() from product_creator (which boosts products in the same
    named series to aid template search), this function uses word overlap + character
    similarity with NO series floor-boost. This prevents generic shared words like
    "Garden" or "Spray" from inflating scores when the variety names are different.

    Score = 0.55 * char_sim + 0.45 * word_jaccard
    """
    from product_creator import _extract_parts

    genus_a, variety_a = _extract_parts(normalized)
    genus_b, variety_b = _extract_parts(product_name)

    if genus_a and genus_b and genus_a != genus_b:
        if difflib.SequenceMatcher(None, genus_a, genus_b).ratio() < 0.85:
            return 0.0

    if not variety_a and not variety_b:
        return 1.0 if genus_a == genus_b else 0.5
    if not variety_a or not variety_b:
        return 0.3

    char_sim = difflib.SequenceMatcher(None, variety_a, variety_b).ratio()

    # Word-level Jaccard with fuzzy tolerance (≥3 chars per word).
    # Two words count as matching when char similarity ≥ 0.75 so minor typos
    # like "chillis"/"chilis" (sim=0.92) don't zero out the score.
    words_a = {w for w in variety_a.split() if len(w) >= 3}
    words_b = {w for w in variety_b.split() if len(w) >= 3}
    union = words_a | words_b
    if not union:
        word_jaccard = 0.0
    else:
        matched: set[str] = set()
        for wa in words_a:
            for wb in words_b:
                if difflib.SequenceMatcher(None, wa, wb).ratio() >= 0.75:
                    matched.add(wa)
                    matched.add(wb)
        word_jaccard = len(matched) / len(union)

    return char_sim * 0.55 + word_jaccard * 0.45


def _fast_candidates(normalized: str, limit: int = 300) -> list[dict]:
    """One AND-ILIKE query covering all meaningful words in the name.

    "Rosa Ec Atomic" → WHERE name ILIKE '%Rosa%' AND name ILIKE '%Atomic%'
    (origin tokens like 'Ec' are stripped so they don't over-restrict results)

    Falls back to genus-only query if the AND query returns nothing.
    """
    import psycopg2.extras
    from db import _conn, ensure_tables, search_products_ilike_term

    tokens = normalized.lower().split()
    # Keep genus (first token) + variety words ≥3 chars excluding origin tokens
    genus = tokens[0] if tokens else ""
    variety_words = [t for t in tokens[1:] if t not in _ORIGIN_TOKENS and len(t) >= 3]
    search_words = ([genus] + variety_words) if genus else variety_words
    if not search_words:
        return []

    try:
        ensure_tables()
        with _conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                conditions = " AND ".join("name ILIKE %s" for _ in search_words)
                params = [f"%{w}%" for w in search_words]
                cur.execute(
                    f"SELECT product_id, name, short_name, vbn_number "
                    f"FROM products WHERE {conditions} ORDER BY name LIMIT %s",
                    params + [limit],
                )
                rows = [dict(r) for r in cur.fetchall()]

                # Prefix fallback: use first 4 chars of each variety word.
                # Handles typos ("chillis"→"chilis") and unicode variants
                # ("españa" NFD/NFC). More lenient than AND but still specific.
                if not rows and variety_words:
                    prefixes = [genus] + [t[:4] for t in variety_words]
                    prefix_conds = " AND ".join("name ILIKE %s" for _ in prefixes)
                    cur.execute(
                        f"SELECT product_id, name, short_name, vbn_number "
                        f"FROM products WHERE {prefix_conds} ORDER BY name LIMIT %s",
                        [f"%{p}%" for p in prefixes] + [limit],
                    )
                    rows = [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.error("Fast candidate query failed: %s", exc)
        rows = []

    # If the strict AND match returns nothing, fall back to genus-only
    if not rows and genus:
        rows = search_products_ilike_term(genus, limit=limit)

    return rows


def match_single_photo(filename: str, cfg=None, top_k: int = 5) -> dict:  # noqa: ARG001
    """Match one photo filename → top_k product candidates.

    Uses a fast single AND-ILIKE query instead of the multi-query n-gram
    path in search_products — photo filenames don't need typo resistance.

    Returns {filename, normalized_name, matches: [{product_id, name, vbn_number, similarity}]}
    """
    normalized = normalize_filename(filename)
    try:
        rows = _fast_candidates(normalized)
        scored = sorted(
            (
                {
                    "product_id": r["product_id"],
                    "name": r["name"],
                    "vbn_number": r.get("vbn_number") or "",
                    "similarity": round(_photo_similarity(normalized, r["name"]), 3),
                }
                for r in rows
            ),
            key=lambda x: x["similarity"],
            reverse=True,
        )
        match_list = scored[:top_k]
    except Exception as exc:
        logger.error("Match failed for %r: %s", filename, exc)
        match_list = []

    logger.info(
        "Photo %r → %s (sim=%.0f%%)",
        filename,
        match_list[0]["name"] if match_list else "—",
        (match_list[0]["similarity"] * 100) if match_list else 0,
    )
    return {"filename": filename, "normalized_name": normalized, "matches": match_list}


def match_photos(filenames: list[str], top_k: int = 5) -> list[dict]:
    """Match a batch of photo filenames to products in the DB."""
    from db import get_product_count

    if get_product_count() == 0:
        logger.warning("DB is empty — photo matching unavailable, run a full sync first")
        return [
            {"filename": fn, "normalized_name": normalize_filename(fn), "matches": []}
            for fn in filenames
        ]

    return [match_single_photo(fn, top_k=top_k) for fn in filenames]
