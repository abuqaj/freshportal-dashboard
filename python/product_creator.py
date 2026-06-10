"""FreshPortal product creation via Playwright — copy-based approach.

Flow:
1. search_products(query)  → list of similar products with similarity %
2. find_best_template(target, products) → best product to copy from
3. copy_and_create(template_id, new_name) → Playwright: copy row, fill name, save
"""
from __future__ import annotations

import difflib
import itertools
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime
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
from i18n import msg

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

    full_sim = difflib.SequenceMatcher(None, variety_a, variety_b).ratio()

    # Boost for products in the same named series (shared first variety word).
    # e.g. "Matsumoto Lavender" vs "Matsumoto Blue" → treat as same template pool.
    words_a = variety_a.split()
    words_b = variety_b.split()
    if words_a and words_b:
        first_word_sim = difflib.SequenceMatcher(None, words_a[0], words_b[0]).ratio()
        if first_word_sim >= 0.90:
            return max(full_sim, 0.82)

    return full_sim


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
    lang: str = "en",
) -> list[ProductMatch]:
    """Two-phase product search — fast and typo-aware.

    Phase 1 (~8 s): search exact query + variety name via name_adjustable, 2 pages each.
    Phase 2 (~8 s): if no ≥80% matches and ANTHROPIC_API_KEY set, ask Claude for correct
                    spellings of the variety, then search each suggestion (1 page each).
    """
    def _s(m: str) -> None:
        logger.info(m)
        if on_status:
            on_status(m)

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
            _s(msg(lang, "page_result", term=term, page=page_num, total=len(all_matches)))

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        fp_page = context.new_page()
        _block_resources(fp_page)

        try:
            _s(msg(lang, "logging_in"))
            _login(fp_page, cfg)

            # Phase 1: exact query + variety search terms (typo-resistant substrings)
            # Also add individual words from multi-word varieties so that e.g.
            # "Matsumoto Lavender" triggers a search for "Matsumoto" which finds
            # all "Callistephus Matsumoto *" products in FreshPortal.
            variety_terms = _variety_search_terms(variety)
            for word in variety.split():
                if len(word) >= 4 and word not in variety_terms:
                    variety_terms.append(word)
            phase1 = list(dict.fromkeys(filter(None, [query.strip()] + variety_terms)))
            for term in phase1:
                _s(msg(lang, "searching", term=term))
                _fetch(fp_page, term, pages=2)

            # Phase 2: AI spelling correction when no good matches found
            good = sum(1 for m in all_matches if m.similarity >= 0.8)
            if good == 0 and variety:
                _s(msg(lang, "no_good_matches"))
                spellings = ai_suggest_spellings(variety, cfg)
                if spellings:
                    _s(msg(lang, "ai_suggests", spellings=", ".join(spellings)))
                    for spelling in spellings:
                        _s(msg(lang, "searching", term=spelling))
                        _fetch(fp_page, spelling, pages=2)
                else:
                    _s(msg(lang, "ai_unavailable"))

        finally:
            context.close()
            browser.close()

    all_matches.sort(key=lambda m: m.similarity, reverse=True)
    best = f", best: {all_matches[0].similarity:.0%}" if all_matches else ""
    _s(msg(lang, "finished_search", total=len(all_matches), best=best))
    return all_matches


# ── template selection ───────────────────────────────────────────────────────

def generate_product_number(name: str) -> str:
    """Generate a FreshPortal product number from a product name.

    Rules: max 8 chars, uppercase only, no spaces or special characters.
    Strategy: first 2 chars of each word, concatenated and truncated.

    Examples:
      "Rosa Ec Atena"             → ROECAT
      "Rosa Ec Honey Hearst"      → ROECHOHE
      "Rosa Ec Spray Julieta Honey" → ROECSPJU
    """
    words = re.sub(r"[^A-Za-z0-9\s]", "", name).upper().split()
    code = "".join(w[:2] for w in words)[:8]
    return code if code else "PROD"


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

def _number_candidates(base: str, name: str = ""):
    """Yield product number candidates.

    Strategy:
    1. base itself
    2. Extend using the remaining chars of the last word in *name* (after the 2
       already used), e.g. base=CAMALA, name="… Lavender" → CAMALAV, CAMALAVE
    3. Fall back to alphabet / digits suffix / last-char replacement
    """
    yield base
    seen: set[str] = {base}

    # Phase 1: extend with next chars of the last word
    if name:
        words = re.sub(r"[^A-Za-z0-9]", " ", name).upper().split()
        if words:
            extra = ""
            for ch in words[-1][2:]:          # skip the 2 chars already in base
                extra += ch
                candidate = (base + extra)[:8]
                if candidate not in seen:
                    seen.add(candidate)
                    yield candidate

    # Phase 2: alphabet / digits fallback (append when room, else replace last char)
    for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789":
        candidate = (base + ch) if len(base) < 8 else base[:7] + ch
        candidate = candidate[:8]
        if candidate not in seen:
            seen.add(candidate)
            yield candidate


def _was_recently_created(soup: BeautifulSoup, minutes: int = 15) -> bool:
    """Return True if any table row contains a datetime within the last `minutes` minutes.

    FreshPortal shows creation date as <span class="display-datetime-component">dd-mm-yyyy HH:MM</span>.
    """
    table = soup.find("table")
    if not table:
        return False
    tbody = table.find("tbody")
    if not tbody:
        return False
    now = datetime.now()
    for row in tbody.find_all("tr"):
        for span in row.find_all("span", class_="display-datetime-component"):
            try:
                dt = datetime.strptime(span.get_text(strip=True), "%d-%m-%Y %H:%M")
                if 0 <= (now - dt).total_seconds() <= minutes * 60:
                    return True
            except Exception:
                continue
    return False


def _find_available_number_on_page(
    page,
    base: str,
    cfg,
    on_status: Callable | None = None,
    name: str = "",
    lang: str = "en",
) -> str | None:
    """Check candidate numbers on an already-open FreshPortal page.

    Returns the first available number (may equal *base*) or None if all
    10 variants are occupied.

    Uses page.evaluate() instead of BeautifulSoup so that input[value]
    fields are checked too — FreshPortal renders the product number column
    as an <input>, which get_text() would miss entirely.
    """
    def _s(m: str) -> None:
        logger.info(m)
        if on_status:
            on_status(m)

    for candidate in itertools.islice(_number_candidates(base, name), 11):
        url = (f"{cfg.freshportal_url}/product/index/index/"
               f"?1=1&number_adjustable={candidate}&page=1")
        page.goto(url, wait_until="load", timeout=cfg.request_timeout)
        # Wait for the SPA to finish rendering the table rows.
        # If no rows appear within 8 s the number is definitely free.
        try:
            page.wait_for_selector(
                "td[data-cell-action='product_number']", timeout=8_000
            )
        except Exception:
            pass  # no rows → number is free, skip evaluate

        # Only inspect td[data-cell-action="product_number"] cells — exact match.
        # number_adjustable is a CONTAINS filter, so we must compare ourselves.
        taken: bool = page.evaluate(
            """
            (candidate) => {
                const target = candidate.toUpperCase();
                for (const td of document.querySelectorAll(
                        'td[data-cell-action="product_number"]')) {
                    if (td.textContent.trim().toUpperCase() === target) return true;
                }
                return false;
            }
            """,
            candidate,
        )

        if not taken:
            if candidate != base:
                _s(msg(lang, "number_taken_using", base=base, candidate=candidate))
            return candidate
        if candidate == base:
            _s(msg(lang, "number_taken_search", base=base))
    return None


def find_available_number(
    base: str,
    cfg,
    on_status: Callable | None = None,
    name: str = "",
    lang: str = "en",
) -> str | None:
    """Return the first available product number — DB-first, Playwright fallback.

    DB path is instant (<10 ms); Playwright fallback used only when DB is empty.
    """
    def _s(m: str) -> None:
        logger.info(m)
        if on_status:
            on_status(m)

    from db import is_product_number_taken, get_product_count
    if get_product_count() > 0:
        for candidate in itertools.islice(_number_candidates(base, name), 11):
            if not is_product_number_taken(candidate):
                if candidate != base:
                    _s(msg(lang, "number_taken_using", base=base, candidate=candidate))
                return candidate
        return None

    # Fallback: Playwright (DB not yet populated)
    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        _block_resources(page)
        try:
            _login(page, cfg)
            return _find_available_number_on_page(page, base, cfg, on_status, name=name, lang=lang)
        except Exception:
            logger.exception("find_available_number failed")
            return None
        finally:
            context.close()
            browser.close()


def copy_and_create(
    template_id: str,
    new_name: str,
    cfg: Config,
    on_status: Callable | None = None,
    product_number: str | None = None,
    lang: str = "en",
    vbn_code: str | None = None,
    color_id: str | None = None,
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
    def _s(m: str) -> None:
        logger.info(m)
        if on_status:
            on_status(m)

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        # Allow stylesheets — Angular/fps-button components need them to render
        page.route("**/*", lambda route: route.abort()
            if route.request.resource_type in ("image", "font", "media")
            else route.continue_())

        try:
            _s(msg(lang, "logging_in"))
            _login(page, cfg)

            # Number was already validated by /product-number-suggest before the
            # user clicked Create — no need to re-check here.
            pnum = product_number or generate_product_number(new_name)

            _s(msg(lang, "opening_copy_form", id=template_id))
            copy_url = f"{cfg.freshportal_url}/product/index/copy/PRO_ID/{template_id}/"
            page.goto(copy_url, wait_until="load", timeout=cfg.request_timeout)

            try:
                page.wait_for_selector("#product_index_form_submit", timeout=15_000)
            except PWTimeout:
                return {"ok": False, "message": f"Formularz kopiowania nie załadował się ({copy_url})"}

            # ── Fill name fields via Angular-compatible JS ──────────────────
            # fps-input uses Shadow DOM. Playwright's fill() dispatches input
            # events, but Angular reactive forms also need 'change' and 'blur'.
            # Use native value setter + full event sequence to trigger Angular
            # change detection.
            _s(msg(lang, "filling_name", name=new_name))

            name_field_ids: list[str] = []
            for fps in page.query_selector_all("fps-input"):
                fps_name = fps.get_attribute("name") or ""
                if "form_name_" in fps_name and "short" not in fps_name:
                    name_field_ids.append(fps_name)

            if not name_field_ids:
                return {"ok": False, "message": "Nie znaleziono fps-input[name*='form_name_'] w formularzu"}

            # ── Fill product number (mandatory, unique) ─────────────────────
            _s(msg(lang, "filling_number", num=pnum))
            page.evaluate(f"""
                () => {{
                    const el = document.querySelector("fps-input[name='product_index_form_number']");
                    if (!el || !el.shadowRoot) return;
                    const inp = el.shadowRoot.querySelector('input');
                    if (!inp) return;
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    setter.call(inp, '{pnum}');
                    ['input', 'change', 'blur'].forEach(t =>
                        inp.dispatchEvent(new Event(t, {{bubbles: true}}))
                    );
                }}
            """)
            time.sleep(0.3)

            # Collect short name field IDs
            short_name_ids: list[str] = []
            for fps in page.query_selector_all("fps-input"):
                fps_nm = fps.get_attribute("name") or ""
                if "form_short_name_" in fps_nm:
                    short_name_ids.append(fps_nm)

            def _fill_fps(field_name: str, value: str) -> None:
                safe = value.replace("'", "\\'").replace('"', '\\"')
                page.evaluate(f"""
                    () => {{
                        const el = document.querySelector("fps-input[name='{field_name}']");
                        if (!el || !el.shadowRoot) return;
                        const inp = el.shadowRoot.querySelector('input');
                        if (!inp) return;
                        const setter = Object.getOwnPropertyDescriptor(
                            HTMLInputElement.prototype, 'value'
                        ).set;
                        setter.call(inp, '{safe}');
                        ['input', 'change', 'blur'].forEach(t =>
                            inp.dispatchEvent(new Event(t, {{bubbles: true}}))
                        );
                    }}
                """)

            for fps_name in name_field_ids:
                _fill_fps(fps_name, new_name)
            for fps_name in short_name_ids:
                _fill_fps(fps_name, new_name)

            _s(msg(lang, "fields_filled", name_n=len(name_field_ids), short_n=len(short_name_ids)))

            # ── Fill VBN code (best-effort — field name varies by FreshPortal config) ──
            if vbn_code:
                _s(msg(lang, "filling_vbn", code=vbn_code))
                for vbn_sel in [
                    "fps-input[name='product_index_form_vbn_number']",
                    "fps-input[name*='form_vbn']",
                    "fps-input[name*='vbn_number']",
                ]:
                    try:
                        el = page.query_selector(vbn_sel)
                        if el:
                            _fill_fps(el.get_attribute("name") or vbn_sel, vbn_code)
                            break
                    except Exception as exc:
                        logger.debug("VBN fill failed for %s: %s", vbn_sel, exc)

            # ── Fill color (best-effort) ─────────────────────────────────────
            if color_id:
                _s(msg(lang, "filling_color", name=color_id))
                for color_sel in [
                    "fps-select[name*='color_id']",
                    "fps-select[name*='form_color']",
                    "fps-select[name*='colour']",
                ]:
                    try:
                        el = page.query_selector(color_sel)
                        if el:
                            # fps-select uses Shadow DOM; set value on inner <select>
                            page.evaluate(
                                """([el, val]) => {
                                    const s = el.shadowRoot?.querySelector('select');
                                    if (!s) return;
                                    s.value = val;
                                    s.dispatchEvent(new Event('change', {bubbles: true}));
                                }""",
                                [el, color_id],
                            )
                            break
                    except Exception as exc:
                        logger.debug("Color fill failed for %s: %s", color_sel, exc)

            time.sleep(1)

            # ── Submit form ─────────────────────────────────────────────────
            _s(msg(lang, "saving_product"))
            submitted = False

            # Try 1: click inner shadow DOM button of the save fps-button
            for save_sel in ["#product_index_form_submit", "fps-button[name='submit']", "fps-button[type='save']"]:
                loc = page.locator(save_sel)
                if loc.count() > 0:
                    inner = loc.locator("button")
                    if inner.count() > 0:
                        inner.click()
                        submitted = True
                        break

            # Try 2: JS click on both the fps-button AND its inner button
            if not submitted:
                page.evaluate("""
                    () => {
                        const btn = document.querySelector('#product_index_form_submit');
                        if (!btn) return;
                        btn.click();
                        const inner = btn.shadowRoot?.querySelector('button');
                        if (inner) inner.click();
                    }
                """)
                submitted = True

            # Try 3: press Enter on the last name field
            time.sleep(0.5)
            page.keyboard.press("Enter")

            # Wait for save to complete — page may or may not navigate
            _s(msg(lang, "waiting_save"))
            try:
                page.wait_for_load_state("load", timeout=10_000)
            except Exception:
                pass
            time.sleep(3)

            # Check for form error messages (execution context may be gone after nav)
            try:
                for err_sel in [".alert-danger", ".text-danger", "[class*='error-message']"]:
                    err = page.query_selector(err_sel)
                    if err and err.is_visible():
                        return {"ok": False, "message": f"Błąd formularza: {err.inner_text()[:300]}"}
            except Exception:
                pass

            # Validate: search by number (exact) — if the row exists, creation succeeded.
            # Uses page.evaluate() on the rendered DOM so the SPA has time to paint.
            _s(msg(lang, "verifying_product"))
            encoded_num = pnum.replace(" ", "+")
            verify_url = (
                f"{cfg.freshportal_url}/product/index/index/"
                f"?1=1&number_adjustable={encoded_num}&page=1"
            )
            page.goto(verify_url, wait_until="load", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector(
                    "td[data-cell-action='product_number']", timeout=12_000
                )
            except Exception:
                pass

            found: bool = page.evaluate(
                """
                ([pnum, pname]) => {
                    const numTarget  = pnum.toUpperCase();
                    const nameTarget = pname.toUpperCase();
                    for (const tr of document.querySelectorAll('table tbody tr')) {
                        const numCell  = tr.querySelector(
                            'td[data-cell-action="product_number"]');
                        const nameCell = tr.querySelector(
                            'td[data-cell-action="product_name"]');
                        if (!numCell || !nameCell) continue;
                        if (numCell.textContent.trim().toUpperCase()  === numTarget &&
                            nameCell.textContent.trim().toUpperCase() === nameTarget) {
                            return true;
                        }
                    }
                    return false;
                }
                """,
                [pnum, new_name],
            )

            if found:
                _s(msg(lang, "product_verified"))
                return {
                    "ok": True,
                    "message": f"Produkt '{new_name}' (nr {pnum}) został pomyślnie utworzony",
                }

            return {
                "ok": False,
                "message": (
                    f"Nie znaleziono produktu '{new_name}' (nr {pnum}) "
                    "w FreshPortal — sprawdź ręcznie"
                ),
            }

        except Exception as exc:
            logger.exception("copy_and_create failed")
            return {"ok": False, "message": str(exc)}
        finally:
            context.close()
            browser.close()
