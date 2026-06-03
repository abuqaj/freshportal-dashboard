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
API_BASE = "https://api.floricode.com/v2"
TOKEN_URL = "https://api.floricode.com/oauth/token"


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
