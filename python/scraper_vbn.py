"""VBN code lookup via Floricode REST API."""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

CACHE_FILE = Path(__file__).parent / ".vbn_cache.json"
TOKEN_FILE = Path(__file__).parent / ".floricode_token.json"
COLOUR_TABLE_FILE = Path(__file__).parent / ".colour_vbn_table.json"
API_BASE = "https://api.floricode.com/v2"
TOKEN_URL = "https://api.floricode.com/oauth/token"

_colour_vbn_table: dict[str, list[dict]] | None = None  # genus -> [{id, name, is_spray}]


@dataclass
class VBNInfo:
    code: str
    official_name: str
    product_group: str
    found: bool = True


def _load_cache() -> dict[str, dict]:
    if CACHE_FILE.exists():
        try:
            return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_cache(cache: dict[str, dict]) -> None:
    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def _get_token(client_id: str, client_secret: str) -> str:
    """Return a valid bearer token, reusing cached token if not yet expired."""
    if TOKEN_FILE.exists():
        try:
            data = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
            if data.get("expires_at", 0) > time.time() + 60:
                logger.debug("Reusing cached Floricode token")
                return data["access_token"]
        except Exception:
            pass

    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "vbn_product:read",
        },
        timeout=30,
    )
    resp.raise_for_status()
    token_data = resp.json()
    access_token = token_data["access_token"]
    expires_in = token_data.get("expires_in", 3600)

    TOKEN_FILE.write_text(
        json.dumps({"access_token": access_token, "expires_at": time.time() + expires_in}, indent=2),
        encoding="utf-8",
    )
    logger.info("Floricode token obtained (expires in %ds)", expires_in)
    return access_token


def _lookup_via_api(code: str, token: str) -> VBNInfo:
    """VBN codes are the `id` field in the Floricode product catalog."""
    resp = requests.get(
        f"{API_BASE}/VBN/Product",
        params={"$filter": f"id eq {code}", "$select": "id,name,short_name"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    resp.raise_for_status()
    items = resp.json().get("value", [])

    if items:
        official_name = items[0].get("name", "")
        logger.info("VBN %s -> %s", code, official_name)
        return VBNInfo(code=code, official_name=official_name, product_group="", found=True)

    logger.warning("VBN %s not found in Floricode API", code)
    return VBNInfo(code=code, official_name="", product_group="", found=False)


_specific_vbn_cache: dict[str, str] = {}


def find_specific_vbn(
    genus: str,
    treatment: str,
    client_id: str,
    client_secret: str,
    product_name_hint: str = "",
) -> str:
    """Search Floricode for the most specific VBN matching '{genus} {treatment}'.

    When multiple candidates are returned, pick the one whose name best
    overlaps with *product_name_hint* (the full FreshPortal product name).
    Returns VBN id string, or '' if nothing useful found.
    """
    key = f"{genus.lower()}|{treatment.lower()}"
    if key in _specific_vbn_cache:
        return _specific_vbn_cache[key]

    if not client_id or not client_secret:
        return ""

    token = _get_token(client_id, client_secret)
    try:
        resp = requests.get(
            f"{API_BASE}/VBN/Product",
            params={
                "$filter": (
                    f"contains(tolower(name), '{genus.lower()}') and "
                    f"contains(tolower(name), '{treatment.lower()}')"
                ),
                "$select": "id,name,short_name",
            },
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        resp.raise_for_status()
        items = resp.json().get("value", [])
    except Exception as exc:
        logger.warning("find_specific_vbn failed for %s/%s: %s", genus, treatment, exc)
        _specific_vbn_cache[key] = ""
        return ""

    if not items:
        _specific_vbn_cache[key] = ""
        return ""

    if len(items) == 1:
        result = str(items[0]["id"])
        logger.info("Specific VBN for %s %s -> %s (%s)", genus, treatment, result, items[0]["name"])
    else:
        # Multiple candidates — pick the one with most word overlap with the product name
        hint_words = set(product_name_hint.lower().split()) if product_name_hint else set()
        def _score(item: dict) -> int:
            vbn_words = set(item.get("name", "").lower().split())
            return len(hint_words & vbn_words)

        logger.debug("Multiple VBNs for %s %s: %s", genus, treatment, [(i["id"], i["name"]) for i in items])

        if hint_words:
            best = max(items, key=_score)
            result = str(best["id"])
            logger.info(
                "Best VBN for '%s' among %d candidates -> %s (%s)",
                product_name_hint, len(items), result, best["name"],
            )
        else:
            result = ""

    # Only cache definitive results — empty string means "not found yet"
    # so re-trying with a hint later would still work
    if result:
        _specific_vbn_cache[key] = result
    return result


# ---------------------------------------------------------------------------
# Colour-treated VBN table — fetches ALL kleurbehandeld/coloured VBNs once
# ---------------------------------------------------------------------------

def _fetch_all_colour_vbns(token: str) -> list[dict]:
    """Fetch all VBN entries whose name contains a colour-treatment keyword."""
    seen_ids: set = set()
    results: list[dict] = []

    for keyword in ("kleurbehandeld", "colour treated", "coloured"):
        skip = 0
        while True:
            try:
                resp = requests.get(
                    f"{API_BASE}/VBN/Product",
                    params={
                        "$filter": f"contains(tolower(name), '{keyword}')",
                        "$select": "id,name",
                        "$top": "500",
                        "$skip": str(skip),
                    },
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=30,
                )
                resp.raise_for_status()
                items = resp.json().get("value", [])
            except Exception as exc:
                logger.warning("Colour VBN fetch failed (kw=%s, skip=%d): %s", keyword, skip, exc)
                break

            for item in items:
                if item["id"] not in seen_ids:
                    seen_ids.add(item["id"])
                    results.append(item)

            if len(items) < 500:
                break
            skip += 500

    logger.info("Fetched %d unique colour-treated VBNs from Floricode", len(results))
    return results


def _build_colour_table(raw: list[dict]) -> dict[str, list[dict]]:
    """Index colour VBNs by genus (first word of VBN name, lowercase)."""
    table: dict[str, list[dict]] = {}
    for item in raw:
        name = item.get("name", "")
        words = name.lower().split()
        if not words:
            continue
        genus = words[0]
        is_spray = any(kw in name.lower() for kw in ("spray", "tros"))
        table.setdefault(genus, []).append({
            "id": str(item["id"]),
            "name": name,
            "is_spray": is_spray,
        })
    return table


def get_colour_vbn_table(client_id: str, client_secret: str) -> dict[str, list[dict]]:
    """Return colour VBN table — loads from file cache or fetches from Floricode."""
    global _colour_vbn_table

    if _colour_vbn_table is not None:
        return _colour_vbn_table

    if COLOUR_TABLE_FILE.exists():
        try:
            _colour_vbn_table = json.loads(COLOUR_TABLE_FILE.read_text(encoding="utf-8"))
            logger.info("Loaded colour VBN table from cache (%d genera)", len(_colour_vbn_table))
            return _colour_vbn_table
        except Exception:
            pass

    if not client_id or not client_secret:
        _colour_vbn_table = {}
        return _colour_vbn_table

    try:
        token = _get_token(client_id, client_secret)
        raw = _fetch_all_colour_vbns(token)
        _colour_vbn_table = _build_colour_table(raw)
        COLOUR_TABLE_FILE.write_text(
            json.dumps(_colour_vbn_table, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logger.info("Saved colour VBN table (%d genera)", len(_colour_vbn_table))
    except Exception as exc:
        logger.error("Failed to build colour VBN table: %s", exc)
        _colour_vbn_table = {}

    return _colour_vbn_table


# Words to strip before botanical matching — treatment terms and common
# codes that appear in FreshPortal names but never in VBN species names.
_NOISE_WORDS = frozenset({
    "painted", "absorbed", "tinted", "colour", "treated", "color",
    "kleurbehandeld", "coloured", "colored", "bleached", "dried",
    "preserved", "ec", "hk", "sp", "cv",
    # common color words that don't appear in VBN species names
    "red", "blue", "yellow", "white", "pink", "purple", "orange",
    "green", "black", "mixed", "bicolor",
    # Dutch equivalents
    "rood", "blauw", "geel", "wit", "roze", "paars", "oranje",
})

# Generic "other/remaining" words in VBN names — preferred when no
# specific species match is found in the product name.
_GENERIC_WORDS = frozenset({"overig", "other", "overige", "sonstiges"})


def find_best_colour_vbn(
    product_name: str,
    is_spray: bool,
    client_id: str,
    client_secret: str,
) -> str:
    """Find the most specific colour-treated VBN for *product_name*.

    Scoring logic:
    - Strip treatment/color noise words from both sides.
    - If product name contains a species word present in a specific VBN
      (e.g. "sinuatum"), prefer that VBN (overlap > 1).
    - If no species word matches, prefer the "overig/other" VBN — it is
      the correct generic code for unspecified species.
    """
    table = get_colour_vbn_table(client_id, client_secret)
    if not table:
        return ""

    words = product_name.lower().split()
    genus = words[0] if words else ""

    # Botanical keywords only — exclude treatment/color noise
    product_botanical = {w for w in words if w not in _NOISE_WORDS and len(w) > 2}

    # Gather candidates for this genus
    candidates = list(table.get(genus, []))
    if not candidates:
        for key, entries in table.items():
            if key[:4] == genus[:4]:
                candidates.extend(entries)

    if not candidates:
        return ""

    # Prefer spray/non-spray alignment
    spray_matched = [c for c in candidates if c["is_spray"] == is_spray]
    pool = spray_matched if spray_matched else candidates

    def _score(c: dict) -> tuple[int, int]:
        vbn_botanical = {
            w for w in c["name"].lower().split()
            if w not in _NOISE_WORDS and len(w) > 2
        }
        overlap = len(product_botanical & vbn_botanical)
        is_generic = int(bool(_GENERIC_WORDS & vbn_botanical))

        if overlap > 1:
            # Specific species match found → prefer specific over generic
            return (overlap, 1 - is_generic)
        else:
            # No species match → prefer generic "overig/other" code
            return (overlap, is_generic)

    best = max(pool, key=_score)
    score = _score(best)

    if score[0] > 0:
        logger.info(
            "Best colour VBN for '%s' -> %s (%s) [score=%s]",
            product_name, best["id"], best["name"], score,
        )
        return best["id"]

    return ""


def invalidate_colour_table() -> None:
    """Force rebuild of colour VBN table on next call (e.g. after cache clear)."""
    global _colour_vbn_table
    _colour_vbn_table = None
    if COLOUR_TABLE_FILE.exists():
        COLOUR_TABLE_FILE.unlink()


def lookup_vbn_codes(
    vbn_codes: list[str],
    request_timeout: int = 30000,
    floricode_username: str = "",
    floricode_password: str = "",
) -> dict[str, VBNInfo]:
    """Look up multiple VBN codes via Floricode REST API with file-based caching."""
    cache = _load_cache()
    results: dict[str, VBNInfo] = {}

    to_fetch = []
    for code in vbn_codes:
        if code in cache:
            results[code] = VBNInfo(**cache[code])
            logger.info("VBN %s served from cache", code)
        else:
            to_fetch.append(code)

    if not to_fetch:
        return results

    token = _get_token(floricode_username, floricode_password)

    for code in to_fetch:
        try:
            info = _lookup_via_api(code, token)
        except Exception as exc:
            logger.error("Error looking up VBN %s: %s", code, exc)
            info = VBNInfo(code=code, official_name="", product_group="", found=False)
        results[code] = info
        cache[code] = {
            "code": info.code,
            "official_name": info.official_name,
            "product_group": info.product_group,
            "found": info.found,
        }
        _save_cache(cache)

    return results
