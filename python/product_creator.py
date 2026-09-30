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
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Callable
from urllib.parse import quote_plus

from bs4 import BeautifulSoup
from playwright.sync_api import Page, TimeoutError as PWTimeout, sync_playwright

from config import Config
from scraper_fp import (
    CHROMIUM_ARGS,
    FPProduct,
    _login,
    _logout,
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

# What makes two FreshPortal names the same product (as the people who create
# them define it):
#   - the country a flower came from does not: "Rosa Col Toxic" and "Rosa
#     Toxic" are one product;
#   - except for Ecuadorian roses, which are graded as better quality and kept
#     as their own product, so "Ec" on a Rosa is part of what that product is;
#   - spray / single / double and any treatment each make a separate product;
#   - length does not (it belongs to a stock entry, not to a product).
_ORIGIN_TOKENS = {"ec", "col", "co", "ke", "ken", "nl", "et", "zim", "sa", "tz", "be", "de"}
_QUALITY_ORIGIN = "ec"
_QUALITY_ORIGIN_GENUS = "rosa"

# Words that say what kind of product this is rather than which variety. Two
# names that disagree here are never the same product, and these words are
# kept out of the variety: "Rosa Spray Toxic" and "Rosa Spray Mondial" share
# nothing but the word "Spray".
_MARKER_ALIASES = {
    "spray": "spray", "tros": "spray", "sp": "spray",
    "single": "single", "double": "double",
    "preserved": "preserved", "bleached": "bleached",
    "dried": "dried", "droog": "dried",
    "treated": "treated", "kleurbehandeld": "treated",
    "painted": "treated", "tinted": "treated", "absorbed": "treated",
}

# At or above this a product counts as already existing; the screen warns, and
# an exact name is refused outright before saving.
DUPLICATE_SCORE = 0.80
# Same series, different variety ("Matsumoto Lavender" vs "Matsumoto Blue"):
# worth offering as a template, never a duplicate.
_SERIES_SCORE = 0.75
# Same variety but another kind (a spray, a treatment, an Ecuadorian rose):
# a good template and a different product, so it stays under the threshold.
_DIFFERENT_KIND_CAP = 0.75


@dataclass(frozen=True)
class _Identity:
    genus: str
    markers: frozenset[str]
    variety: str


def _product_identity(name: str) -> _Identity:
    """Split a name into what decides whether two products are the same.

    "Rosa Ec Spray Toxic" → genus "rosa", markers {ec, spray}, variety "toxic"
    "Rosa Col Toxic"      → genus "rosa", markers {},           variety "toxic"
    """
    tokens = name.lower().strip().split()
    if not tokens:
        return _Identity("", frozenset(), "")
    genus = tokens[0]
    markers: set[str] = set()
    variety: list[str] = []
    for token in tokens[1:]:
        marker = _MARKER_ALIASES.get(token)
        if marker:
            markers.add(marker)
        elif token == _QUALITY_ORIGIN and genus == _QUALITY_ORIGIN_GENUS:
            markers.add(_QUALITY_ORIGIN)
        elif token in _ORIGIN_TOKENS:
            continue
        else:
            variety.append(token)
    return _Identity(genus, frozenset(markers), " ".join(variety))


def _extract_parts(name: str) -> tuple[str, str]:
    """Return (genus, variety) — the name with origin and kind words removed.

    "Rosa Ec Atena"       → ("rosa", "atena")
    "Rosa Spray Julieta"  → ("rosa", "julieta")
    """
    identity = _product_identity(name)
    return identity.genus, identity.variety


def _similarity(a: str, b: str) -> float:
    """How close two product names are to being the same product.

    Examples:
      "Rosa Ec Atena"    vs "Rosa Ec Athena"      → ~0.91  (typo, same product)
      "Rosa Col Toxic"   vs "Rosa Toxic"          → 1.00   (country ignored)
      "Rosa Ec Toxic"    vs "Rosa Toxic"          → 0.75   (Ecuador is its own)
      "Rosa Spray Toxic" vs "Rosa Toxic"          → 0.75   (spray is its own)
      "Rosa Spray Toxic" vs "Rosa Spray Mondial"  → ~0.15  (other variety)
      "Rosa Ec Toxic"    vs "Dianthus Toxic"      → 0.00   (other genus)
    """
    id_a, id_b = _product_identity(a), _product_identity(b)

    if id_a.genus and id_b.genus and id_a.genus != id_b.genus:
        genus_sim = difflib.SequenceMatcher(None, id_a.genus, id_b.genus).ratio()
        if genus_sim < 0.85:
            return 0.0  # Different genus (Rosa ≠ Dianthus) — never a match

    if not id_a.variety and not id_b.variety:
        score = 1.0 if id_a.genus == id_b.genus else 0.5
    elif not id_a.variety or not id_b.variety:
        score = 0.5
    else:
        score = difflib.SequenceMatcher(None, id_a.variety, id_b.variety).ratio()
        # Same named series (shared first variety word) — a sibling worth
        # copying from, not the same flower.
        words_a, words_b = id_a.variety.split(), id_b.variety.split()
        if difflib.SequenceMatcher(None, words_a[0], words_b[0]).ratio() >= 0.90:
            score = max(score, _SERIES_SCORE)

    if id_a.markers != id_b.markers:
        return min(score, _DIFFERENT_KIND_CAP)
    return score


@dataclass
class ProductMatch:
    product_id: str
    name: str
    short_name: str
    vbn_number: str
    similarity: float
    color: str = ""
    product_group: str = ""
    application: str = ""


# ── FreshPortal search ───────────────────────────────────────────────────────

def _variety_search_terms(variety: str) -> list[str]:
    """Generate typo-resistant search terms using sliding n-gram windows.

    For a single-character typo (insertion, deletion, substitution) anywhere
    in a word, at least one n-gram from the mistyped word will appear unchanged
    in the correct spelling, so ILIKE will always find the product.

    n-gram size by word length:
      3-5 chars → 3-grams  e.g. "Atena" → "Ate","ten","ena"  (ena ∈ "Athena")
      6+ chars  → 4-grams  e.g. "stelata" → "stel","tela","elat","lata"
                                            (stel,lata ∈ "stellata")

    Also adds word[:-1] and word[1:] to cover first/last-char typos that
    n-grams of size k can miss when the error falls at the very edge.
    """
    if not variety:
        return []
    terms: list[str] = [variety]
    seen: set[str] = {variety.lower()}

    def _add(s: str) -> None:
        key = s.lower()
        if key not in seen and len(s) >= 3:
            seen.add(key)
            terms.append(s)

    for word in variety.split():
        n = len(word)
        if n < 3:
            continue
        k = 4 if n >= 6 else 3
        for i in range(n - k + 1):
            _add(word[i : i + k])
        if n >= 4:
            _add(word[:-1])
            _add(word[1:])

    return terms


@dataclass
class Catalogue:
    """Where one system's product list is read from.

    "copy"    the Postgres mirror — instant, and up to an hour behind. Only
              ever the system it mirrors, whose products it also takes back.
    "export"  that system's BI Sync export, held in memory by product_export.
    "portal"  no list at all: FreshPortal is read through the browser, one
              page load per search term.

    Whatever the source, the number and the name are checked in the portal
    itself right before saving — a list is never the last word.
    """

    source: str
    search: Callable[[str], list[dict]] | None = None
    number_taken: Callable[[str], bool] | None = None
    by_exact_name: Callable[[str], list[dict]] | None = None
    writes_back: bool = False


def catalogue_for(cfg: Config, export=None) -> Catalogue:
    """Pick the product list for the system *cfg* points at."""
    if uses_catalogue_copy(cfg):
        from db import get_product_count, is_product_number_taken, search_products_ilike_term, \
            find_products_by_exact_name
        if get_product_count() > 0:
            return Catalogue(
                "copy",
                search=lambda term: search_products_ilike_term(term, limit=100),
                number_taken=is_product_number_taken,
                by_exact_name=find_products_by_exact_name,
                writes_back=True,
            )
    if export is not None:
        return Catalogue(
            "export",
            search=export.search,
            number_taken=export.number_taken,
            by_exact_name=export.by_exact_name,
        )
    return Catalogue("portal")


def search_products(
    query: str,
    cfg: Config,
    on_status: Callable | None = None,
    lang: str = "en",
    catalogue: Catalogue | None = None,
) -> list[ProductMatch]:
    """Two-phase product search — from a product list, or else the browser.

    Phase 1: search exact query + typo-resistant variety substrings.
    Phase 2: if no ≥80% matches and ANTHROPIC_API_KEY set, ask Claude for
             correct spellings and search those too.
    Same similarity logic regardless of data source.

    With no list to search ("portal"), FreshPortal is read through the browser:
    every term is a page load, so only the query, the variety and the genus are
    searched, and it therefore finds less.
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

    # Build search terms — shared between DB and Playwright paths
    variety_terms = _variety_search_terms(variety)
    for word in variety.split():
        if len(word) >= 4 and word not in variety_terms:
            variety_terms.append(word)
    # Generate n-grams for the genus too so typos in the first word are caught
    # (e.g. "Scaibosa" → n-grams "Scai","aibo","bosa" still share "osa" with "Scabiosa").
    genus_terms = _variety_search_terms(genus) if genus else []
    phase1 = list(dict.fromkeys(filter(None, [query.strip()] + variety_terms + genus_terms)))
    # One page load per term in the browser, so keep that list to the terms
    # that carry the most: the whole query, the variety, the genus.
    browser_terms = list(dict.fromkeys(filter(None, [query.strip(), variety, genus])))

    def _collect(rows: list[dict]) -> None:
        """Apply similarity filter and accumulate matches from a list of dicts."""
        for r in rows:
            pid = r.get("product_id", "")
            name = r.get("name", "")
            if not pid or pid in seen_ids:
                continue
            sim = _similarity(query, name)
            if sim > 0.05 or genus in name.lower():
                seen_ids.add(pid)
                all_matches.append(ProductMatch(
                    product_id=pid,
                    name=name,
                    short_name=r.get("short_name", ""),
                    vbn_number=r.get("vbn_number", ""),
                    similarity=sim,
                    color=r.get("color", ""),
                    product_group=r.get("product_group", ""),
                    application=r.get("application", ""),
                ))

    def _run_phases(fetch_fn: Callable[[str], list[dict]], terms: list[str]) -> None:
        """Execute phase 1 + optional AI phase 2 using the given fetch function."""
        for term in terms:
            _s(msg(lang, "searching", term=term))
            _collect(fetch_fn(term))

        good = sum(1 for m in all_matches if m.similarity >= 0.8)
        if good == 0 and variety:
            _s(msg(lang, "no_good_matches"))
            spellings = ai_suggest_spellings(variety, cfg)
            if spellings:
                _s(msg(lang, "ai_suggests", spellings=", ".join(spellings)))
                for spelling in spellings:
                    _s(msg(lang, "searching", term=spelling))
                    _collect(fetch_fn(spelling))
            else:
                _s(msg(lang, "ai_unavailable"))

    # ── From a product list: the copy or the export, both without a browser ──
    catalogue = catalogue or catalogue_for(cfg)
    if catalogue.search:
        _run_phases(catalogue.search, phase1)
        all_matches.sort(key=lambda m: m.similarity, reverse=True)
        best = f", best: {all_matches[0].similarity:.0%}" if all_matches else ""
        _s(msg(lang, "finished_search", total=len(all_matches), best=best))
        return all_matches

    # ── Browser path: no product list for this system ─────────────────────────
    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        fp_page = context.new_page()
        _block_resources(fp_page)

        try:
            _s(msg(lang, "logging_in"))
            _login(fp_page, cfg)

            def _pw_fetch(term: str) -> list[dict]:
                results: list[dict] = []
                for page_num in range(1, 3):
                    url = (
                        f"{cfg.freshportal_url}/product/index/index/"
                        f"?1=1&name_adjustable={quote_plus(term)}&page={page_num}"
                    )
                    try:
                        _goto_and_wait(fp_page, url, cfg)
                    except Exception:
                        break
                    soup = BeautifulSoup(fp_page.content(), "lxml")
                    rows = _parse_rows_html(soup, _detect_columns_html(soup))
                    if not rows:
                        break
                    for r in rows:
                        # Colour, group and application come along so the
                        # confirmation form can fill itself in from a template
                        # found this way, exactly as it does from the copy.
                        results.append({
                            "product_id": r.product_id,
                            "name": r.name,
                            "short_name": r.short_name,
                            "vbn_number": r.vbn_number,
                            "color": r.color,
                            "product_group": r.product_group,
                            "application": r.application,
                        })
                    _s(msg(lang, "page_result", term=term, page=page_num, total=len(results)))
                return results

            _run_phases(_pw_fetch, browser_terms)

        finally:
            _logout(context, cfg)
            context.close()
            browser.close()

    all_matches.sort(key=lambda m: m.similarity, reverse=True)
    best = f", best: {all_matches[0].similarity:.0%}" if all_matches else ""
    _s(msg(lang, "finished_search", total=len(all_matches), best=best))
    return all_matches


# ── template selection ───────────────────────────────────────────────────────

NUMBER_MAX_LEN = 7


def _number_words(name: str) -> list[str]:
    return re.sub(r"[^A-Za-z0-9\s]", "", name).upper().split()


def _code_from(words: list[str], letters_per_word: list[int]) -> str:
    return "".join(w[:n] for w, n in zip(words, letters_per_word))[:NUMBER_MAX_LEN]


def generate_product_number(name: str) -> str:
    """Generate a FreshPortal product number from a product name.

    Rules: at most 7 characters, uppercase letters and digits only.
    Strategy: the first 2 characters of each word, truncated.

    Examples:
      "Rosa Ec Atena"               → ROECAT
      "Rosa Ec Honey Hearst"        → ROECHOH
      "Rosa Ec Spray Julieta Honey" → ROECSPJ
    """
    words = _number_words(name)
    return _code_from(words, [2] * len(words)) if words else "PROD"


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
    """Yield product numbers for *name*, starting with *base*.

    Variants change how many letters each word contributes — three letters
    from the first word, or from the last one, and so on. They never append a
    counter: people read these codes off the screen, and ROECSP01 or ROECSPJA
    say nothing about the product. When every variant is taken the operator is
    asked for a number instead of being handed a meaningless one.
    """
    yield base
    seen: set[str] = {base}
    words = _number_words(name)
    if not words:
        return
    n = len(words)

    patterns: list[list[int]] = [
        [1] * n,                       # one letter per word
        [3] + [2] * (n - 1),           # three from the first word
        [2] * (n - 1) + [3],           # three from the last word
        [3] + [1] * (n - 1),
        [1] * (n - 1) + [3],
        [4] + [2] * (n - 1),
        [2] * (n - 1) + [4],
        [3] * n,
    ]
    # Then one word at a time gets an extra letter, left to right.
    for extra in (3, 4, 5):
        for i in range(n):
            pattern = [2] * n
            pattern[i] = extra
            patterns.append(pattern)
    # A single-word name has no words to redistribute between, so lengthen it.
    if n == 1:
        patterns.extend([[i] for i in range(1, NUMBER_MAX_LEN + 1)])

    for pattern in patterns:
        candidate = _code_from(words, pattern)
        if candidate and candidate not in seen:
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
    catalogue: Catalogue | None = None,
) -> str | None:
    """Return the first available product number for the system in *cfg*.

    Reads the system's product list when there is one (instant), and otherwise
    asks FreshPortal itself, one page load per candidate. A number free in one
    system's list says nothing about another system's portal, which is why the
    list comes from *catalogue* rather than always from the copy.
    """
    def _s(m: str) -> None:
        logger.info(m)
        if on_status:
            on_status(m)

    catalogue = catalogue or catalogue_for(cfg)
    if catalogue.number_taken:
        for candidate in itertools.islice(_number_candidates(base, name), 11):
            if not catalogue.number_taken(candidate):
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
            _logout(context, cfg)
            context.close()
            browser.close()


# ── create product: checks around the copy ───────────────────────────────────
#
# Everything below exists so that a creation never fails silently and never
# leaves a duplicate behind:
#   - one creation at a time, and the number and name are checked again right
#     before saving (the catalogue copy can be up to an hour old);
#   - the form is read back before it is saved, so a copy of the template can't
#     be saved under the template's own name or number;
#   - save is clicked once;
#   - the saved product is read back from FreshPortal and compared with what
#     was asked for; anything that differs is reported, not swallowed.
#
# Result statuses:
#   created                 found in FreshPortal with the requested values
#   created_with_warnings   found, but something differs or could not be checked
#   unconfirmed             save was clicked but the product could not be found;
#                           it may exist, so the user must look before retrying
#   failed                  FreshPortal did not save it (form error, or the save
#                           was never clicked)
#   blocked                 stopped before saving: invalid input, number taken,
#                           name already in use, or another creation running

# The API runs as a single process, so a process-wide lock is enough to stop
# two people claiming the same number between the check and the save.
_create_lock = threading.Lock()
_CREATE_LOCK_WAIT_S = 300

_NUMBER_RE = re.compile(rf"[A-Z0-9]{{1,{NUMBER_MAX_LEN}}}")
_VBN_RE = re.compile(r"[0-9]{1,6}")
_TEMPLATE_ID_RE = re.compile(r"[0-9]{1,12}")

_ROW_SELECTOR = "td[data-cell-action='product_number']"
_NUMBER_FIELD = "product_index_form_number"
_VERIFY_ATTEMPTS = 3
_NUMBER_SUGGESTION_LIVE_CHECKS = 5


def normalize_name(name: str) -> str:
    """Case- and whitespace-insensitive form used to compare product names.

    lower() rather than casefold() so it matches Postgres lower() in
    db.find_products_by_exact_name.
    """
    return " ".join((name or "").split()).lower()


def validate_create_input(
    template_id: str | None,
    new_name: str | None,
    product_number: str | None,
    vbn_code: str | None,
    color_id: str | None,
) -> tuple[dict, str | None]:
    """Clean the values sent by the screen. Returns (clean, error_code).

    Same rules as the screen, so a value that got past it is refused here
    before anything is typed into FreshPortal.
    """
    name = (new_name or "").strip()
    if not name:
        return {}, "name_empty"
    if re.search(r"\s{2,}", name):
        return {}, "name_double_space"
    if any(not (ch.isalnum() or ch in " '-") for ch in name):
        return {}, "name_chars"

    number = (product_number or "").strip().upper() or generate_product_number(name)
    if not _NUMBER_RE.fullmatch(number):
        return {}, "number"

    vbn = (vbn_code or "").strip()
    if vbn and not _VBN_RE.fullmatch(vbn):
        return {}, "vbn"

    tid = (template_id or "").strip()
    if not _TEMPLATE_ID_RE.fullmatch(tid):
        return {}, "template"

    color = (color_id or "").strip()
    if len(color) > 100 or any(ord(ch) < 32 for ch in color):
        return {}, "color"

    return {"template_id": tid, "name": name, "number": number, "vbn": vbn, "color_id": color}, None


def _warning(code: str, expected: str | None = None, actual: str | None = None) -> dict:
    return {"code": code, "expected": expected, "actual": actual}


def _product_summary(p: FPProduct | dict | None) -> dict | None:
    if p is None:
        return None
    d = asdict(p) if isinstance(p, FPProduct) else p
    return {
        "product_id": d.get("product_id", ""),
        "name": d.get("name", ""),
        "product_number": d.get("product_number", ""),
        "vbn_number": d.get("vbn_number", ""),
        "color": d.get("color", ""),
    }


def _product_url(cfg: Config, product_id: str) -> str:
    return f"{cfg.freshportal_url}/product/index/index/?1=1&id={quote_plus(product_id)}&page=1"


def _number_search_url(cfg: Config, number: str) -> str:
    return f"{cfg.freshportal_url}/product/index/index/?1=1&number_adjustable={quote_plus(number)}&page=1"


def uses_catalogue_copy(cfg: Config) -> bool:
    """The Postgres product table mirrors the default FreshPortal only."""
    return cfg.freshportal_url.rstrip("/") == Config().freshportal_url.rstrip("/")


def _parse_product_list(html: str) -> tuple[list[FPProduct], set[str]]:
    """Rows of a FreshPortal product list page, and the columns it shows.

    Number and name come from the data-cell-action cells when present (the
    same cells the old verification relied on); the rest from the headers.
    """
    soup = BeautifulSoup(html, "lxml")
    col_map = _detect_columns_html(soup)
    table = soup.find("table")
    tbody = table.find("tbody") if table else None
    if not tbody:
        return [], set(col_map)

    rows: list[FPProduct] = []
    for tr in tbody.find_all("tr"):
        cells = tr.find_all("td")
        if not cells:
            continue

        def cell(field: str) -> str:
            idx = col_map.get(field, -1)
            return cells[idx].get_text(strip=True) if 0 <= idx < len(cells) else ""

        def action_cell(action: str) -> str | None:
            td = tr.find("td", attrs={"data-cell-action": action})
            return td.get_text(strip=True) if td is not None else None

        product_id = cells[0].get_text(strip=True)
        number = action_cell("product_number")
        name = action_cell("product_name")
        if not product_id:
            continue
        rows.append(FPProduct(
            product_id=product_id,
            name=name if name is not None else cell("name"),
            short_name=cell("short_name"),
            vbn_number=cell("vbn_number"),
            origin=cell("origin"),
            product_number=number if number is not None else cell("product_number"),
            color=cell("color"),
            product_gtin=cell("product_gtin"),
            product_group_code=cell("product_group_code"),
            product_group=cell("product_group"),
            application=cell("application"),
            vat_rate=cell("vat_rate"),
            cbs_group_code=cell("cbs_group_code"),
            main_group=cell("main_group"),
            creation_moment=cell("creation_moment"),
            change_moment=cell("change_moment"),
            external_id=cell("external_id"),
        ))
    return rows, set(col_map)


def _load_product_list(page: Page, cfg: Config, filter_query: str, expect_rows: bool,
                       page_num: int = 1) -> tuple[list[FPProduct], set[str]]:
    """Open the product list with *filter_query* and parse what it shows.

    expect_rows=True waits longer for a row (verifying a product just saved);
    otherwise it waits for the list's data requests to settle, so a free
    number or name doesn't cost the full row timeout.
    """
    url = f"{cfg.freshportal_url}/product/index/index/?1=1&{filter_query}&page={page_num}"
    page.goto(url, wait_until="load", timeout=cfg.request_timeout)
    if "login" in page.url.lower():
        _login(page, cfg)
        page.goto(url, wait_until="load", timeout=cfg.request_timeout)
    if expect_rows:
        try:
            page.wait_for_selector(_ROW_SELECTOR, timeout=12_000)
        except PWTimeout:
            pass
    else:
        try:
            page.wait_for_load_state("networkidle", timeout=8_000)
        except PWTimeout:
            pass
        try:
            page.wait_for_selector(_ROW_SELECTOR, timeout=3_000)
        except PWTimeout:
            pass
    return _parse_product_list(page.content())


# A "contains" filter on a whole name or number never comes near this many
# pages; reaching it fails the check instead of passing it.
_LIVE_CHECK_MAX_PAGES = 20


def _live_exact_matches(page: Page, cfg: Config, filter_query: str,
                        is_exact: Callable[[FPProduct], bool]) -> list[FPProduct]:
    """The rows of a filtered product list that *is_exact* accepts, from the
    first page that has any.

    The name and number filters are "contains" filters, so the exact product
    can sit past page 1 behind longer names that contain it ("Rosa Ec Pink"
    behind "Rosa Ec Pink Floyd"); read only page 1, it passed as free
    (review 2026-09-25). Pages are read until one is empty, as the full
    product sync does, or repeats the one before it.
    """
    previous_ids: list[str] | None = None
    for page_num in range(1, _LIVE_CHECK_MAX_PAGES + 1):
        rows, _ = _load_product_list(page, cfg, filter_query, expect_rows=False, page_num=page_num)
        ids = [r.product_id for r in rows]
        if not rows or ids == previous_ids:
            return []
        exact = [r for r in rows if is_exact(r)]
        if exact:
            return exact
        previous_ids = ids
    raise RuntimeError(
        f"The FreshPortal product list for {filter_query} still had rows after "
        f"{_LIVE_CHECK_MAX_PAGES} pages, so it could not be checked for an existing product"
    )


def _number_taken_live(page: Page, cfg: Config, number: str) -> bool:
    # number_adjustable is a "contains" filter — compare exactly ourselves.
    return bool(_live_exact_matches(
        page, cfg, f"number_adjustable={quote_plus(number)}",
        lambda r: r.product_number.strip().upper() == number,
    ))


def _suggest_free_number(number: str, name: str, page: Page | None, cfg: Config, catalogue: Catalogue) -> str | None:
    """First variant of *number* that is free — the product list first, then live."""
    live_checks = 0
    for candidate in itertools.islice(_number_candidates(number, name), 1, 40):
        if catalogue.number_taken and catalogue.number_taken(candidate):
            continue
        if page is None:
            return candidate
        if live_checks >= _NUMBER_SUGGESTION_LIVE_CHECKS:
            return None
        live_checks += 1
        if not _number_taken_live(page, cfg, candidate):
            return candidate
    return None


_FPS_NAMES_JS = """
(tag) => Array.from(document.querySelectorAll(tag)).map(e => e.getAttribute('name') || '')
"""

_FILL_FPS_INPUT_JS = """
([fieldName, value]) => {
    const host = Array.from(document.querySelectorAll('fps-input'))
        .find(e => e.getAttribute('name') === fieldName);
    const inp = host && host.shadowRoot ? host.shadowRoot.querySelector('input') : null;
    if (!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, value);
    ['input', 'change', 'blur'].forEach(t => inp.dispatchEvent(new Event(t, {bubbles: true})));
    return true;
}
"""

_READ_FPS_INPUT_JS = """
(fieldName) => {
    const host = Array.from(document.querySelectorAll('fps-input'))
        .find(e => e.getAttribute('name') === fieldName);
    const inp = host && host.shadowRoot ? host.shadowRoot.querySelector('input') : null;
    return inp ? inp.value : null;
}
"""

# Exact option value first (Floricode id), then the option label (colour name,
# or the id itself when the colour list came from the catalogue copy).
_SELECT_COLOR_JS = """
([fieldName, colorId, colorName]) => {
    const host = Array.from(document.querySelectorAll('fps-select'))
        .find(e => e.getAttribute('name') === fieldName);
    const s = host && host.shadowRoot ? host.shadowRoot.querySelector('select') : null;
    if (!s) return null;
    const opts = Array.from(s.options);
    const label = o => o.textContent.trim().toLowerCase();
    const match = opts.find(o => o.value === colorId)
        || (colorName ? opts.find(o => label(o) === colorName.toLowerCase()) : undefined)
        || opts.find(o => label(o) === colorId.toLowerCase());
    if (!match) return null;
    s.value = match.value;
    s.dispatchEvent(new Event('change', {bubbles: true}));
    return s.value === match.value ? match.textContent.trim() : null;
}
"""


def _fps_names(page: Page, tag: str) -> list[str]:
    return [n for n in page.evaluate(_FPS_NAMES_JS, tag) if n]


def _pick_vbn_field(input_names: list[str]) -> str | None:
    for predicate in (
        lambda n: n == "product_index_form_vbn_number",
        lambda n: "form_vbn" in n,
        lambda n: "vbn_number" in n,
    ):
        for n in input_names:
            if predicate(n):
                return n
    return None


def _pick_color_field(select_names: list[str]) -> str | None:
    for fragment in ("color_id", "form_color", "colour"):
        for n in select_names:
            if fragment in n:
                return n
    return None


def _click_save(page: Page) -> bool:
    """Click the save button once. False if there is no save button."""
    for sel in ("#product_index_form_submit", "fps-button[name='submit']", "fps-button[type='save']"):
        host = page.locator(sel)
        if host.count() == 0:
            continue
        inner = host.first.locator("button")
        (inner.first if inner.count() > 0 else host.first).click()
        return True
    return False


def _visible_form_error(page: Page) -> str:
    """Text of a visible error on the copy form, or "" when none/unknown."""
    try:
        for sel in (".alert-danger", "[class*='error-message']", ".text-danger"):
            for el in page.query_selector_all(sel):
                if not el.is_visible():
                    continue
                text = " ".join((el.inner_text() or "").split())
                # Required-field asterisks are often styled as .text-danger.
                if len(text.strip("* ")) >= 3:
                    return text[:300]
    except Exception:
        pass
    return ""


def _still_on_copy_form(page: Page) -> bool:
    try:
        return page.query_selector("#product_index_form_submit") is not None
    except Exception:
        return False


def _saved_value_warnings(
    found: FPProduct,
    columns: set[str],
    vbn: str,
    color_id: str,
    color_name: str,
    pre_save: list[dict],
) -> list[dict]:
    """Compare the saved product with the request.

    What FreshPortal actually saved replaces the form-level VBN and colour
    warnings: if the value got saved anyway there is nothing to report, and if
    it didn't, the saved value is the more useful thing to show.
    """
    codes = {w["code"] for w in pre_save}
    out = [w for w in pre_save if w["code"] not in ("vbn_field_missing", "vbn_not_set", "color_not_set")]

    if vbn:
        actual = found.vbn_number.strip()
        if actual != vbn:
            out.append(_warning("vbn_mismatch", expected=vbn, actual=actual))

    if color_id:
        label = color_name or color_id
        expected = {normalize_name(v) for v in (color_name, color_id) if v and v.strip()}
        if "color" in columns:
            actual = found.color.strip()
            if normalize_name(actual) not in expected:
                out.append(_warning("color_mismatch", expected=label, actual=actual))
        elif "color_not_set" in codes:
            out.append(_warning("color_not_set", expected=label))
        else:
            out.append(_warning("color_unverified", expected=label))

    return out


def copy_and_create(
    template_id: str,
    new_name: str,
    cfg: Config,
    on_status: Callable | None = None,
    product_number: str | None = None,
    lang: str = "en",
    vbn_code: str | None = None,
    color_id: str | None = None,
    color_name: str | None = None,
    allow_duplicate_name: bool = False,
    catalogue: Catalogue | None = None,
) -> dict:
    """Copy *template_id* in FreshPortal and save it as *new_name*.

    Never raises. Returns a dict with "status" (see the list above this
    function), "ok" (True for created / created_with_warnings), the product as
    FreshPortal shows it when found, links, "warnings" and, for blocked /
    failed / unconfirmed, a "reason" code and "error_text".
    """
    def _s(key: str, **kwargs: object) -> None:
        m = msg(lang, key, **kwargs)
        logger.info(m)
        if on_status:
            on_status(m)

    clean, invalid = validate_create_input(template_id, new_name, product_number, vbn_code, color_id)
    name = clean.get("name", (new_name or "").strip())
    number = clean.get("number", (product_number or "").strip().upper())

    def _result(status: str, **extra: object) -> dict:
        out = {
            "status": status,
            "ok": status in ("created", "created_with_warnings"),
            "name": name,
            "product_number": number,
            "product": None,
            "product_url": None,
            "search_url": _number_search_url(cfg, number) if number else None,
            "warnings": [],
            "reason": None,
            "error_text": None,
            "suggested_number": None,
            "existing": [],
        }
        out.update(extra)
        logger.info("copy_and_create → %s (%s, nr %s): reason=%s warnings=%s",
                    status, name, number, out["reason"], [w["code"] for w in out["warnings"]])
        return out

    if invalid:
        return _result("blocked", reason="invalid_input", error_text=invalid)

    if not _create_lock.acquire(blocking=False):
        _s("create_waiting_lock")
        if not _create_lock.acquire(timeout=_CREATE_LOCK_WAIT_S):
            return _result("blocked", reason="busy")
    try:
        return _copy_and_create_locked(
            cfg, _s, _result,
            template_id=clean["template_id"], name=name, number=number,
            vbn=clean["vbn"], color_id=clean["color_id"], color_name=(color_name or "").strip(),
            allow_duplicate_name=allow_duplicate_name,
            catalogue=catalogue or catalogue_for(cfg),
        )
    finally:
        _create_lock.release()


def _copy_and_create_locked(
    cfg: Config,
    _s: Callable,
    _result: Callable,
    *,
    template_id: str,
    name: str,
    number: str,
    vbn: str,
    color_id: str,
    color_name: str,
    allow_duplicate_name: bool,
    catalogue: Catalogue,
) -> dict:
    # From the moment save is clicked the product may exist, so any later
    # error must be reported as "unconfirmed", never as "failed".
    submitted = False

    try:
        # ── 1. the system's product list: instant, and catches most of it ──
        if catalogue.by_exact_name or catalogue.number_taken:
            _s("create_checking_list")
            if catalogue.by_exact_name and not allow_duplicate_name:
                existing = catalogue.by_exact_name(name)
                if existing:
                    return _result("blocked", reason="name_exists",
                                   existing=[_product_summary(p) for p in existing])
            if catalogue.number_taken and catalogue.number_taken(number):
                _s("number_taken_search", base=number)
                return _result("blocked", reason="number_taken",
                               suggested_number=_suggest_free_number(number, name, None, cfg, catalogue))

        with sync_playwright() as pw:
            browser = _launch_browser(pw)
            context = browser.new_context()
            page = context.new_page()
            # Stylesheets stay allowed — the fps-* components need them to render.
            page.route("**/*", lambda route: route.abort()
                if route.request.resource_type in ("image", "font", "media")
                else route.continue_())

            try:
                _s("logging_in")
                _login(page, cfg)

                # ── 2. FreshPortal itself: catches what the copy doesn't have yet ──
                _s("create_checking_number", num=number)
                if _number_taken_live(page, cfg, number):
                    _s("number_taken_search", base=number)
                    return _result("blocked", reason="number_taken",
                                   suggested_number=_suggest_free_number(number, name, page, cfg, catalogue))

                if not allow_duplicate_name:
                    _s("create_checking_name")
                    existing_live = _live_exact_matches(
                        page, cfg, f"name_adjustable={quote_plus(name)}",
                        lambda r: normalize_name(r.name) == normalize_name(name),
                    )
                    if existing_live:
                        return _result("blocked", reason="name_exists",
                                       existing=[_product_summary(r) for r in existing_live])

                # ── 3. fill the copy form ──
                _s("opening_copy_form", id=template_id)
                copy_url = f"{cfg.freshportal_url}/product/index/copy/PRO_ID/{template_id}/"
                page.goto(copy_url, wait_until="load", timeout=cfg.request_timeout)
                try:
                    page.wait_for_selector("#product_index_form_submit", timeout=15_000)
                except PWTimeout:
                    return _result("failed", reason="form_not_loaded")

                input_names = _fps_names(page, "fps-input")
                name_fields = [n for n in input_names if "form_name_" in n and "short" not in n]
                short_fields = [n for n in input_names if "form_short_name_" in n]
                if not name_fields:
                    return _result("failed", reason="name_field_missing")

                warnings: list[dict] = []

                _s("filling_number", num=number)
                page.evaluate(_FILL_FPS_INPUT_JS, [_NUMBER_FIELD, number])
                time.sleep(0.3)

                _s("filling_name", name=name)
                for field in name_fields + short_fields:
                    page.evaluate(_FILL_FPS_INPUT_JS, [field, name])
                _s("fields_filled", name_n=len(name_fields), short_n=len(short_fields))

                vbn_field = None
                if vbn:
                    _s("filling_vbn", code=vbn)
                    vbn_field = _pick_vbn_field(input_names)
                    if vbn_field:
                        page.evaluate(_FILL_FPS_INPUT_JS, [vbn_field, vbn])
                    else:
                        warnings.append(_warning("vbn_field_missing", expected=vbn))

                if color_id:
                    label = color_name or color_id
                    _s("filling_color", name=label)
                    color_field = _pick_color_field(_fps_names(page, "fps-select"))
                    selected = page.evaluate(_SELECT_COLOR_JS, [color_field, color_id, color_name]) if color_field else None
                    if not selected:
                        warnings.append(_warning("color_not_set", expected=label))

                time.sleep(1)

                # ── 4. read the form back: never save a copy that still carries
                #       the template's name or number ──
                _s("create_reading_back")
                typed_number = (page.evaluate(_READ_FPS_INPUT_JS, _NUMBER_FIELD) or "").strip().upper()
                if typed_number != number:
                    return _result("failed", reason="number_not_set", error_text=typed_number or None)
                for field in name_fields:
                    typed = (page.evaluate(_READ_FPS_INPUT_JS, field) or "").strip()
                    if typed != name:
                        return _result("failed", reason="name_not_set", error_text=typed or None)
                if any((page.evaluate(_READ_FPS_INPUT_JS, f) or "").strip() != name for f in short_fields):
                    warnings.append(_warning("short_name_not_set", expected=name))
                if vbn_field and (page.evaluate(_READ_FPS_INPUT_JS, vbn_field) or "").strip() != vbn:
                    warnings.append(_warning("vbn_not_set", expected=vbn))

                # ── 5. save — one click, nothing else ──
                _s("saving_product")
                if page.locator("#product_index_form_submit, fps-button[name='submit'], fps-button[type='save']").count() == 0:
                    return _result("failed", reason="save_button_missing")
                submitted = True
                _click_save(page)

                _s("waiting_save")
                try:
                    page.wait_for_load_state("load", timeout=10_000)
                except Exception:
                    pass
                time.sleep(3)

                # ── 6. read the saved product back ──
                found: FPProduct | None = None
                same_number: list[FPProduct] = []
                columns: set[str] = set()
                # A fresh page, so we don't race FreshPortal's own post-save navigation.
                verify_page = context.new_page()
                _block_resources(verify_page)
                try:
                    for attempt in range(1, _VERIFY_ATTEMPTS + 1):
                        if attempt == 1:
                            _s("verifying_product")
                        else:
                            _s("create_verify_retry", attempt=attempt, total=_VERIFY_ATTEMPTS)
                        rows, columns = _load_product_list(
                            verify_page, cfg, f"number_adjustable={quote_plus(number)}", expect_rows=True)
                        same_number = [r for r in rows if r.product_number.strip().upper() == number]
                        found = next((r for r in same_number if normalize_name(r.name) == normalize_name(name)), None)
                        # A row with our number but another name won't change on a retry.
                        if found or same_number:
                            break
                        if attempt < _VERIFY_ATTEMPTS:
                            time.sleep(5 * attempt)
                finally:
                    verify_page.close()

                if found:
                    warnings = _saved_value_warnings(found, columns, vbn, color_id, color_name, warnings)
                    # Only the copy takes products back; an export is read-only
                    # and belongs to a system the copy does not mirror.
                    if catalogue.writes_back:
                        try:
                            from db import upsert_products
                            upsert_products([asdict(found)])
                        except Exception:
                            logger.exception("Could not add product %s to the catalogue copy", found.product_id)
                            warnings.append(_warning("catalogue_copy_not_updated"))
                    _s("product_verified")
                    return _result(
                        "created_with_warnings" if warnings else "created",
                        product=_product_summary(found),
                        product_url=_product_url(cfg, found.product_id),
                        warnings=warnings,
                    )

                form_error = _visible_form_error(page)
                if form_error and _still_on_copy_form(page):
                    return _result("failed", reason="form_error", error_text=form_error, warnings=warnings)

                other = same_number[0] if same_number else None
                return _result(
                    "unconfirmed",
                    reason="name_differs" if other else "not_found",
                    product=_product_summary(other),
                    product_url=_product_url(cfg, other.product_id) if other else None,
                    warnings=warnings,
                )

            finally:
                _logout(context, cfg)
                context.close()
                browser.close()

    except Exception as exc:
        logger.exception("copy_and_create failed")
        return _result("unconfirmed" if submitted else "failed", reason="exception", error_text=str(exc)[:300])
