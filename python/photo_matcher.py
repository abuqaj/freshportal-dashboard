"""Match photo filenames to products in the database.

normalize_filename  — strip extension, replace separators with spaces
match_photos        — batch match filenames → fuzzy product search results
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'}


def normalize_filename(filename: str) -> str:
    """'Rosa_Spray_Be-Amazing.jpg' → 'Rosa Spray Be Amazing'"""
    stem = Path(filename).stem
    name = re.sub(r'[_\-\.]+', ' ', stem)
    return ' '.join(name.split()).strip()


def match_single_photo(filename: str, cfg, top_k: int = 3) -> dict:
    """Match one photo filename → top_k product candidates.

    Returns {filename, normalized_name, matches: [{product_id, name, vbn_number, similarity}]}
    """
    from product_creator import search_products

    normalized = normalize_filename(filename)
    try:
        raw_matches = search_products(normalized, cfg)
        match_list = [
            {
                "product_id": m.product_id,
                "name": m.name,
                "vbn_number": m.vbn_number or "",
                "similarity": round(m.similarity, 3),
            }
            for m in raw_matches[:top_k]
        ]
    except Exception as exc:
        logger.error("Search failed for %r: %s", filename, exc)
        match_list = []

    logger.info(
        "Photo %r → %s (sim=%.0f%%)",
        filename,
        match_list[0]["name"] if match_list else "—",
        (match_list[0]["similarity"] * 100) if match_list else 0,
    )
    return {"filename": filename, "normalized_name": normalized, "matches": match_list}


def match_photos(filenames: list[str], top_k: int = 3) -> list[dict]:
    """Match a batch of photo filenames to products in the DB.

    Returns list of:
      {filename, normalized_name, matches: [{product_id, name, vbn_number, similarity}]}
    """
    from config import Config
    from db import get_product_count

    if get_product_count() == 0:
        logger.warning("DB is empty — photo matching unavailable, run a full sync first")
        return [
            {"filename": fn, "normalized_name": normalize_filename(fn), "matches": []}
            for fn in filenames
        ]

    cfg = Config()
    return [match_single_photo(fn, cfg, top_k) for fn in filenames]
