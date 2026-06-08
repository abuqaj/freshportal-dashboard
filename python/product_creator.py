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
)
from ai_helper import ai_suggest_spellings

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


def search_products(
    query: str,
    cfg: Config,
    on_status: Callable | None = None,
) -> list[ProductMatch]:
    """Two-phase product search — fast and typo-aware.

    Phase 1 (~8 s): search exact query + variety name via name_adjustable, 2 pages each.
    Phase 2 (~8 s): if no ≥80% matches and ANTHROPIC_API_KEY set, ask Claude for correct
                    spellings of the variety, then search each suggestion (1 page each).
    """
    def _s(msg: str) -> None:
        logger.info(msg)
        if on_status:
            on_status(msg)

    words = query.strip().split()
    genus = words[0].lower() if words else ""
    _, variety = _extract_parts(query)

    seen_ids: set[str] = set()
    all_matches: list[ProductMatch] = []

    def _fetch(fp_page: Page, term: str, pages: int = 2) -> None:
        """Fetch up to `pages` pages for `term` via name_adjustable and collect matches."""
        encoded = term.replace(" ", "+")
        for page_num in range(1, pages + 1):
            url = (
                f"{cfg.freshportal_url}/product/index/index/"
                f"?1=1&name_adjustable={encoded}&page={page_num}"
            )
            try:
                _goto_and_wait(fp_page, url, cfg)
            except Exception:
                break
            soup = BeautifulSoup(fp_page.content(), "lxml")
            rows = _parse_rows_html(soup, _detect_columns_html(soup))
            if not rows:
                break
            new = 0
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
                        new += 1
            _s(f"'{term}' strona {page_num} — {len(all_matches)} produktów łącznie")

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        fp_page = context.new_page()
        _block_resources(fp_page)

        try:
            _s("Logowanie do FreshPortal…")
            _login(fp_page, cfg)

            # Phase 1: exact query + extracted variety, 2 pages each
            phase1 = list(dict.fromkeys(filter(None, [query.strip(), variety])))
            for term in phase1:
                _s(f"Szukam '{term}'…")
                _fetch(fp_page, term, pages=2)

            # Phase 2: AI spelling correction when no good matches found
            good = sum(1 for m in all_matches if m.similarity >= 0.8)
            if good == 0 and variety:
                _s("Brak wyników ≥80% — sprawdzam pisownię z AI…")
                spellings = ai_suggest_spellings(variety, cfg)
                if spellings:
                    _s(f"AI sugeruje: {', '.join(spellings)}")
                    for spelling in spellings:
                        _s(f"Szukam '{spelling}'…")
                        _fetch(fp_page, spelling, pages=2)
                else:
                    _s("AI niedostępne — pomijam korektę pisowni")

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

def copy_and_create(
    template_id: str,
    new_name: str,
    cfg: Config,
    on_status: Callable | None = None,
) -> dict:
    """Copy *template_id* in FreshPortal and save it as *new_name*.

    FreshPortal copy flow (discovered via /debug/product-row):
      1. Navigate to list filtered by product ID
      2. Click the row to select it
      3. Click fps-button[name="button_copy"] in the toolbar
      4. A popup/dialog appears — fill in the name fields
      5. Submit

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
        # Allow stylesheets — Angular/fps-button components need them to render
        page.route("**/*", lambda route: route.abort()
            if route.request.resource_type in ("image", "font", "media")
            else route.continue_())

        try:
            _s("Logowanie do FreshPortal…")
            _login(page, cfg)

            # ── Navigate directly to copy URL ───────────────────────────────
            # Debug confirmed: /product/index/copy/PRO_ID/{id}/ opens the copy
            # form directly (has_form=True). The toolbar button opens a popup
            # that gets blocked in headless mode — skip it entirely.
            _s(f"Otwieranie formularza kopiowania produktu {template_id}…")
            copy_url = f"{cfg.freshportal_url}/product/index/copy/PRO_ID/{template_id}/"
            page.goto(copy_url, wait_until="load", timeout=cfg.request_timeout)

            try:
                page.wait_for_selector("#product_index_form_submit", timeout=15_000)
            except PWTimeout:
                return {"ok": False, "message": f"Formularz kopiowania nie załadował się ({copy_url})"}

            # ── Fill name fields ────────────────────────────────────────────
            _s(f"Wypełnianie nazwy: {new_name}…")
            skip_placeholders = {"product number", "vbn number", "note"}
            filled = 0
            for inp in page.query_selector_all("input[type='text']"):
                if not inp.is_visible():
                    continue
                placeholder = (inp.get_attribute("placeholder") or "").strip().lower()
                if placeholder in skip_placeholders:
                    continue
                try:
                    inp.triple_click()
                    inp.fill(new_name)
                    filled += 1
                except Exception:
                    pass

            if filled == 0:
                return {"ok": False, "message": "Nie znaleziono pól nazwy w formularzu"}
            _s(f"Wypełniono {filled} pól nazwy")
            time.sleep(0.5)

            # ── Submit via Shadow DOM click ─────────────────────────────────
            _s("Zapisywanie produktu…")
            submitted = False
            for save_sel in [
                "#product_index_form_submit",
                "fps-button[name='submit']",
                "fps-button[type='save']",
                "fps-button[submit='true']",
            ]:
                loc = page.locator(save_sel)
                if loc.count() > 0:
                    inner = loc.locator("button")
                    if inner.count() > 0:
                        inner.click()
                    else:
                        loc.click(force=True)
                    submitted = True
                    logger.info("Submitted via: %s", save_sel)
                    break

            if not submitted:
                return {"ok": False, "message": "Nie znaleziono przycisku zapisu"}

            try:
                page.wait_for_load_state("networkidle", timeout=20_000)
            except PWTimeout:
                time.sleep(3)

            new_url = page.url
            _s(f"Zapisano. URL: {new_url}")
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
