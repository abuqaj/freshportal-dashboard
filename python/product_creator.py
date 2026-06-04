"""FreshPortal product creation via Playwright — copy-based approach.

Flow:
1. search_products(query)  → list of similar products with similarity %
2. find_best_template(target, products) → best product to copy from
3. copy_and_create(template_id, new_name) → Playwright: copy row, fill name, save
"""
from __future__ import annotations

import difflib
import logging
import re
import time
from dataclasses import dataclass
from typing import Callable

from bs4 import BeautifulSoup
from playwright.sync_api import Page, TimeoutError as PWTimeout, sync_playwright

from config import Config
from scraper_fp import (
    CHROMIUM_ARGS,
    _login,
    _block_resources,
    _goto_and_wait,
    _launch_browser,
    _detect_columns_html,
    _parse_rows_html,
    _get_last_page_html,
)

logger = logging.getLogger(__name__)

# ── similarity ──────────────────────────────────────────────────────────────

# Country/origin tokens that appear between genus and variety in FreshPortal names
# e.g. "Rosa Ec Toxic" → genus="rosa", variety="toxic"
_ORIGIN_TOKENS = {"ec", "col", "co", "ke", "ken", "nl", "et", "zim", "sa", "tz", "be", "de"}


def _extract_parts(name: str) -> tuple[str, str]:
    """Return (genus, variety) stripping known origin tokens.

    "Rosa Ec Atena"  → ("rosa", "atena")
    "Rosa Athena"    → ("rosa", "athena")
    "Rosa Ec Toxic"  → ("rosa", "toxic")
    """
    tokens = name.lower().strip().split()
    if not tokens:
        return "", ""
    genus = tokens[0]
    variety = " ".join(t for t in tokens[1:] if t not in _ORIGIN_TOKENS)
    return genus, variety


def _similarity(a: str, b: str) -> float:
    """Variety-aware similarity that ignores origin prefixes and handles typos.

    Compares only the variety portion (after stripping genus + origin tokens).
    Same genus required — different genus gets a heavy penalty.

    Examples:
      "Rosa Ec Atena"  vs "Rosa Athena"     → ~0.91  (atena ≈ athena, typo)
      "Rosa Ec Toxic"  vs "Rosa Ec Marilyn" → ~0.17  (toxic ≠ marilyn)
      "Rosa Ec Toxic"  vs "Rosa Toxic"      → 1.00   (same variety, origin stripped)
    """
    genus_a, variety_a = _extract_parts(a)
    genus_b, variety_b = _extract_parts(b)

    if genus_a and genus_b and genus_a != genus_b:
        genus_sim = difflib.SequenceMatcher(None, genus_a, genus_b).ratio()
        if genus_sim < 0.85:
            return 0.0  # Different genus (Rosa ≠ Dianthus) — never a match

    if not variety_a and not variety_b:
        return 1.0 if genus_a == genus_b else 0.5
    if not variety_a or not variety_b:
        return 0.5

    return difflib.SequenceMatcher(None, variety_a, variety_b).ratio()


@dataclass
class ProductMatch:
    product_id: str
    name: str
    short_name: str
    vbn_number: str
    similarity: float


# ── FreshPortal search ───────────────────────────────────────────────────────

def _variety_search_terms(variety: str) -> list[str]:
    """Generate FreshPortal search terms that survive single-character typos.

    Works by using substrings common to the mistyped and correct spelling:
      "Atena"  → ["Atena", "Aten", "ena"]   — "ena" is in both Atena & Athena
      "Toxic"  → ["Toxic", "Toxi", "xic"]
      "portal" → ["portal", "porta", "tal"]

    Strategy per word:
      1. exact word
      2. word[:-1]      (drop last char  — handles extra char at end)
      3. word[n//2:]    (second half     — handles insertion/deletion in first half)
    """
    if not variety:
        return []
    terms = [variety]
    for word in variety.split():
        n = len(word)
        if n >= 5:
            terms.append(word[:-1])
        if n >= 5:
            terms.append(word[n // 2:])
    return list(dict.fromkeys(terms))


def _search_page(page: Page, url: str, query: str, cfg: Config) -> list[ProductMatch]:
    """Fetch one FreshPortal URL and return matching rows with similarity scores."""
    try:
        _goto_and_wait(page, url, cfg)
    except Exception:
        return []

    soup = BeautifulSoup(page.content(), "lxml")
    cols = _detect_columns_html(soup)
    rows = _parse_rows_html(soup, cols)

    results = []
    for r in rows:
        sim = _similarity(query, r.name)
        if sim > 0.1 or query.lower().split()[0] in r.name.lower():
            results.append(ProductMatch(
                product_id=r.product_id,
                name=r.name,
                short_name=r.short_name,
                vbn_number=r.vbn_number,
                similarity=sim,
            ))
    return results


def search_products(
    query: str,
    cfg: Config,
    on_status: Callable | None = None,
) -> list[ProductMatch]:
    """Search FreshPortal for products with names similar to *query*.

    Searches name_adjustable first (more reliable), then short_name_adjustable.
    Fetches all pages up to a per-term limit.
    Skips broad fallback terms once enough high-similarity matches are found.
    """
    def _s(msg: str) -> None:
        logger.info(msg)
        if on_status:
            on_status(msg)

    words = query.strip().split()
    genus = words[0].lower() if words else ""
    _, variety = _extract_parts(query)
    variety_terms = set(_variety_search_terms(variety))

    search_terms = list(dict.fromkeys(filter(None, [
        query.strip(),
        *_variety_search_terms(variety),
        " ".join(words[:2]) if len(words) >= 2 else None,
        words[0] if words else None,
    ])))

    def _max_pages(term: str) -> int:
        n = len(term.replace(" ", ""))
        if n <= 3:  return 3   # "ena" — broad, keep short
        if n <= 5:  return 10  # "atena" — fairly specific
        return 15              # longer terms

    seen_ids: set[str] = set()
    all_matches: list[ProductMatch] = []

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        _block_resources(page)

        try:
            _s("Logowanie do FreshPortal…")
            _login(page, cfg)

            for term in search_terms:
                # Skip broad fallbacks once we have enough strong matches
                good = sum(1 for m in all_matches if m.similarity >= 0.8)
                if good >= 3 and term not in variety_terms and term != query.strip():
                    _s(f"Pomijam '{term}' — mamy już {good} dopasowań ≥80%")
                    continue

                encoded = term.replace(" ", "+")
                max_p = _max_pages(term)

                # name_adjustable first — product names are more reliable than short names
                for param in ("name_adjustable", "short_name_adjustable"):
                    last_page: int | None = None
                    for page_num in range(1, max_p + 1):
                        url = (
                            f"{cfg.freshportal_url}/product/index/index/"
                            f"?1=1&{param}={encoded}&page={page_num}"
                        )
                        try:
                            _goto_and_wait(page, url, cfg)
                        except Exception:
                            break

                        soup = BeautifulSoup(page.content(), "lxml")

                        if last_page is None:
                            last_page = min(_get_last_page_html(soup), max_p)
                            _s(f"Szukam '{term}' — {last_page} stron…")

                        cols = _detect_columns_html(soup)
                        rows = _parse_rows_html(soup, cols)
                        if not rows:
                            break

                        for r in rows:
                            if r.product_id not in seen_ids:
                                sim = _similarity(query, r.name)
                                if sim > 0.05 or genus in r.name.lower():
                                    seen_ids.add(r.product_id)
                                    all_matches.append(ProductMatch(
                                        product_id=r.product_id,
                                        name=r.name,
                                        short_name=r.short_name,
                                        vbn_number=r.vbn_number,
                                        similarity=sim,
                                    ))

                        _s(
                            f"Strona {page_num}/{last_page} ({param})"
                            f" — {len(all_matches)} produktów łącznie"
                        )

                        if page_num >= (last_page or 1):
                            break
        finally:
            context.close()
            browser.close()

    all_matches.sort(key=lambda m: m.similarity, reverse=True)
    best = f", najlepsze: {all_matches[0].similarity:.0%}" if all_matches else ""
    _s(f"Zakończono — {len(all_matches)} produktów{best}")
    return all_matches


# ── template selection ───────────────────────────────────────────────────────

def find_best_template(
    target_name: str,
    products: list[ProductMatch],
    high_threshold: float = 0.80,
) -> tuple[ProductMatch | None, bool]:
    """Return (best_template, already_exists).

    already_exists=True when similarity >= high_threshold (product probably
    already exists, show warning to user).
    """
    if not products:
        return None, False
    best = products[0]
    return best, best.similarity >= high_threshold


# ── copy product via Playwright ───────────────────────────────────────────────

def _find_copy_button(page: Page, product_id: str):
    """Try to locate the copy/duplicate button for a product row."""
    # Navigate directly to the product row
    selectors = [
        # data-action patterns
        f"tr:has(td:text-is('{product_id}')) a[data-action*='copy']",
        f"tr:has(td:text-is('{product_id}')) a[data-action*='duplicate']",
        f"tr:has(td:text-is('{product_id}')) a[data-action*='clone']",
        # title/aria patterns
        f"tr:has(td:text-is('{product_id}')) a[title*='opy']",
        f"tr:has(td:text-is('{product_id}')) a[title*='uplic']",
        f"tr:has(td:text-is('{product_id}')) a[title*='loon']",
        # href patterns
        f"tr:has(td:text-is('{product_id}')) a[href*='copy']",
        f"tr:has(td:text-is('{product_id}')) a[href*='duplic']",
        # class patterns
        f"tr:has(td:text-is('{product_id}')) .copy-btn",
        f"tr:has(td:text-is('{product_id}')) .btn-copy",
    ]
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el:
                logger.info("Copy button found: %s", sel)
                return el
        except Exception:
            continue
    return None


def _fill_name_fields(page: Page, name: str) -> None:
    """Fill all name/short-name text inputs on the product form with *name*."""
    # FreshPortal product form has language-flagged inputs
    # Try to fill English name field first, then all visible text inputs in name sections
    filled = False

    # Look for the English (EN) name input specifically
    for sel in [
        "input[name*='name'][lang='en'], input[name*='Name'][lang='en']",
        "input[placeholder*='Name'][lang='en']",
        # Generic: fill all name inputs
        "input[name*='PRO_Name']",
        "input[name*='product_name']",
    ]:
        try:
            els = page.query_selector_all(sel)
            for el in els:
                if el.is_visible():
                    el.fill(name)
                    filled = True
        except Exception:
            continue

    if not filled:
        # Fallback: fill all visible text inputs that look like name fields
        try:
            all_inputs = page.query_selector_all("input[type='text']:visible")
            for inp in all_inputs:
                inp_name = (inp.get_attribute("name") or "").lower()
                inp_placeholder = (inp.get_attribute("placeholder") or "").lower()
                if "name" in inp_name or "name" in inp_placeholder:
                    inp.fill(name)
                    filled = True
        except Exception:
            pass

    logger.info("Name fields filled (%s): %s", "ok" if filled else "uncertain", name)


def copy_and_create(
    template_id: str,
    new_name: str,
    cfg: Config,
    on_status: Callable | None = None,
) -> dict:
    """Copy *template_id* in FreshPortal and save it as *new_name*.

    Returns {"ok": True, "product_id": "...", "message": "..."}
    or      {"ok": False, "message": "..."}.
    """
    def _s(msg: str) -> None:
        logger.info(msg)
        if on_status:
            on_status(msg)

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        # Don't block stylesheets here — form may need them to render correctly
        page.route("**/*", lambda route: route.abort()
            if route.request.resource_type in ("image", "font", "media")
            else route.continue_())

        try:
            _s("Logowanie do FreshPortal…")
            _login(page, cfg)

            _s(f"Nawigacja do produktu {template_id}…")
            list_url = (
                f"{cfg.freshportal_url}/product/index/index/"
                f"?1=1&id={template_id}&page=1"
            )
            page.goto(list_url, wait_until="load", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector("table tbody tr", timeout=15_000)
            except PWTimeout:
                time.sleep(2)

            # ── Find and click copy button ──────────────────────────────────
            copy_btn = _find_copy_button(page, template_id)

            if copy_btn:
                _s("Kopiowanie produktu…")
                copy_btn.click()
            else:
                # Fallback: try direct copy URL
                _s("Próba bezpośredniego URL kopiowania…")
                for copy_url_pattern in [
                    f"{cfg.freshportal_url}/product/index/copy/id/{template_id}/",
                    f"{cfg.freshportal_url}/product/index/duplicate/{template_id}/",
                    f"{cfg.freshportal_url}/product/index/add/?copy={template_id}",
                ]:
                    page.goto(copy_url_pattern, wait_until="load", timeout=cfg.request_timeout)
                    current = page.url
                    if "add" in current or "copy" in current or "edit" in current:
                        break

            # Wait for form to appear
            time.sleep(1.5)
            try:
                page.wait_for_selector("input[type='text']", timeout=10_000)
            except PWTimeout:
                return {"ok": False, "message": "Formularz nie otworzył się po kliknięciu kopiuj"}

            _s(f"Wypełnianie nazwy: {new_name}…")
            _fill_name_fields(page, new_name)
            time.sleep(0.5)

            # ── Submit form ─────────────────────────────────────────────────
            _s("Zapisywanie produktu…")
            for save_sel in [
                "button[type='submit']:has-text('Save')",
                "button[type='submit']:has-text('Opslaan')",
                "button[type='submit']:has-text('Zapisz')",
                "input[type='submit']",
                "button[type='submit']",
                ".btn-primary[type='submit']",
            ]:
                btn = page.query_selector(save_sel)
                if btn and btn.is_visible():
                    btn.click()
                    break

            try:
                page.wait_for_load_state("networkidle", timeout=15_000)
            except PWTimeout:
                time.sleep(3)

            new_url = page.url
            _s(f"Produkt zapisany. URL: {new_url}")

            # Try to extract new product ID from URL
            id_match = re.search(r"/(\d+)/?$", new_url)
            new_id = id_match.group(1) if id_match else "?"

            return {
                "ok": True,
                "product_id": new_id,
                "url": new_url,
                "message": f"Produkt '{new_name}' utworzony (ID: {new_id})",
            }

        except Exception as exc:
            logger.exception("copy_and_create failed")
            return {"ok": False, "message": str(exc)}
        finally:
            context.close()
            browser.close()
