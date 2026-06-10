"""FreshPortal scraper.

fetch_products  — Playwright in batches: opens browser every 6 pages, reuses
                  session cookies so login only happens once. Keeps peak RAM
                  at ~600 MB instead of accumulating to OOM.
fix_vbn_batch   — Playwright single session (needed for inline JS editing).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import requests
from bs4 import BeautifulSoup
from playwright.sync_api import Page, sync_playwright

from config import Config

logger = logging.getLogger(__name__)

PAGES_PER_BATCH = 6

CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--mute-audio",
]


@dataclass
class FPProduct:
    product_id: str
    name: str
    short_name: str
    vbn_number: str
    origin: str = ""
    product_number: str = ""
    color: str = ""
    product_gtin: str = ""
    product_group_code: str = ""
    product_group: str = ""
    application: str = ""
    vat_rate: str = ""
    cbs_group_code: str = ""
    main_group: str = ""
    creation_moment: str = ""
    change_moment: str = ""


# ---------------------------------------------------------------------------
# Column detection — maps lowercased header text → FPProduct field name
# ---------------------------------------------------------------------------

_HEADER_MAP: dict[str, str] = {
    # VBN
    "vbn number": "vbn_number",
    "vbn nr": "vbn_number",
    "vbn": "vbn_number",
    # Name
    "name": "name",
    # Short name
    "short name": "short_name",
    "shortname": "short_name",
    # Origin
    "origin": "origin",
    # Product number
    "number": "product_number",
    "product number": "product_number",
    "productnumber": "product_number",
    # Color
    "color": "color",
    "colour": "color",
    # GTIN
    "gtin": "product_gtin",
    "product gtin": "product_gtin",
    "ean": "product_gtin",
    # Product group code
    "product group code": "product_group_code",
    "productgroupcode": "product_group_code",
    # Product group
    "product group": "product_group",
    "productgroup": "product_group",
    # Application
    "application": "application",
    # VAT rate
    "vat rate": "vat_rate",
    "vatrate": "vat_rate",
    "vat": "vat_rate",
    # CBS group code
    "cbs group code": "cbs_group_code",
    "cbsgroupcode": "cbs_group_code",
    "cbs group": "cbs_group_code",
    # Main group
    "main group": "main_group",
    "maingroup": "main_group",
    # Timestamps
    "creation moment": "creation_moment",
    "created": "creation_moment",
    "creation date": "creation_moment",
    "change moment": "change_moment",
    "changed": "change_moment",
    "modification date": "change_moment",
    "last modified": "change_moment",
}

# Required fields — if header not found, fall back to these column indices
_FALLBACK_COLS = {
    "vbn_number": 8,
    "name": 10,
    "short_name": 11,
    "origin": 18,
}


def _header_text(h) -> str:
    """Extract header text: prefer data-header-title (clean, no sort icons)."""
    title = h.get("data-header-title", "").strip()
    if title:
        return title.lower()
    return " ".join(h.get_text(separator=" ", strip=True).split()).lower()


def _detect_columns_html(soup: BeautifulSoup) -> dict[str, int]:
    """Return {field_name: col_index} for all detectable columns."""
    col_map: dict[str, int] = {}
    thead = soup.find("thead")
    if thead:
        for i, h in enumerate(thead.find_all(["th", "td"])):
            text = _header_text(h)
            field = _HEADER_MAP.get(text)
            if field and field not in col_map:
                col_map[field] = i
    # Apply fallbacks for critical fields not found by header
    for field, fallback_idx in _FALLBACK_COLS.items():
        if field not in col_map:
            col_map[field] = fallback_idx
    logger.info("Detected columns: %s", col_map)
    return col_map


def _parse_rows_html(soup: BeautifulSoup, col_map: dict[str, int]) -> list[FPProduct]:
    table = soup.find("table")
    if not table:
        return []
    tbody = table.find("tbody")
    if not tbody:
        return []

    required = max(col_map.get("vbn_number", 0), col_map.get("name", 0), col_map.get("short_name", 0))
    products: list[FPProduct] = []

    def _cell(cells: list, field: str) -> str:
        idx = col_map.get(field, -1)
        if idx < 0 or idx >= len(cells):
            return ""
        return cells[idx].get_text(strip=True)

    for row in tbody.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) <= required:
            continue
        product_id = cells[0].get_text(strip=True)
        name = _cell(cells, "name")
        vbn  = _cell(cells, "vbn_number")
        if not product_id or (not vbn and not name):
            continue
        products.append(FPProduct(
            product_id=product_id,
            name=name,
            short_name=_cell(cells, "short_name"),
            vbn_number=vbn,
            origin=_cell(cells, "origin"),
            product_number=_cell(cells, "product_number"),
            color=_cell(cells, "color"),
            product_gtin=_cell(cells, "product_gtin"),
            product_group_code=_cell(cells, "product_group_code"),
            product_group=_cell(cells, "product_group"),
            application=_cell(cells, "application"),
            vat_rate=_cell(cells, "vat_rate"),
            cbs_group_code=_cell(cells, "cbs_group_code"),
            main_group=_cell(cells, "main_group"),
            creation_moment=_cell(cells, "creation_moment"),
            change_moment=_cell(cells, "change_moment"),
        ))
    return products


def _get_last_page_html(soup: BeautifulSoup) -> int:
    try:
        pagination = soup.find("ul", class_="pagination")
        if pagination:
            # Check all <a href> links — last page link often has highest page= param
            import re as _re
            max_from_links = 1
            for a in pagination.find_all("a", href=True):
                m = _re.search(r"[?&]page=(\d+)", a["href"])
                if m:
                    max_from_links = max(max_from_links, int(m.group(1)))

            # Also collect visible digit labels
            numbers = [
                int(li.get_text(strip=True))
                for li in pagination.find_all("li")
                if li.get_text(strip=True).isdigit()
            ]
            if numbers:
                max_from_links = max(max_from_links, max(numbers))

            if max_from_links > 1:
                return max_from_links
    except Exception:
        pass

    # Fallback: look for total-record count in the page and infer pages
    # FreshPortal often shows "X - Y of Z" or "of 65,000 records"
    try:
        import re as _re
        for el in soup.find_all(string=_re.compile(r'\d{3,}')):
            text = str(el).strip()
            m = _re.search(r'of\s+([\d,\.]+)', text, _re.IGNORECASE)
            if m:
                total = int(m.group(1).replace(',', '').replace('.', ''))
                if total > 0:
                    return max(1, -(-total // 250))
    except Exception:
        pass

    return 1


# ---------------------------------------------------------------------------
# Playwright helpers
# ---------------------------------------------------------------------------

def _launch_browser(pw):
    return pw.chromium.launch(headless=True, args=CHROMIUM_ARGS)


def _block_resources(page: Page) -> None:
    page.route("**/*", lambda route: route.abort()
        if route.request.resource_type in ("image", "font", "media", "stylesheet")
        else route.continue_())


def _login(page: Page, cfg: Config) -> None:
    page.goto(
        f"{cfg.freshportal_url}/login_v2/index/index/",
        wait_until="load",
        timeout=cfg.request_timeout,
    )
    page.fill("#username, input[name='USE_Username']", cfg.freshportal_username)
    page.fill("#password, input[name='USE_Password'], input[type='password']", cfg.freshportal_password)
    page.click("button:has-text('Login'), button[type='submit']")
    page.wait_for_url(lambda url: "login" not in url, timeout=cfg.request_timeout)
    time.sleep(1)
    logger.info("Logged in. URL: %s", page.url)


def _goto_and_wait(page: Page, url: str, cfg: Config) -> None:
    page.goto(url, wait_until="load", timeout=cfg.request_timeout)
    try:
        page.wait_for_selector("table tbody tr", timeout=15_000)
    except Exception:
        time.sleep(3)


def _goto_product_page(page: Page, url: str, cfg: Config) -> None:
    """Navigate to product page, re-logging in if the session has expired."""
    _goto_and_wait(page, url, cfg)
    if "login" in page.url.lower():
        logger.info("Session expired mid-scrape — re-logging in")
        _login(page, cfg)
        _goto_and_wait(page, url, cfg)


# ---------------------------------------------------------------------------
# fetch_products — batched Playwright
# ---------------------------------------------------------------------------

def fetch_products(
    vbn_filter: str,
    cfg: Config,
    on_status=None,
) -> list[FPProduct]:
    """Fetch products in browser batches of PAGES_PER_BATCH to cap peak RAM.

    on_status: optional callable(str) — called with human-readable progress messages.
    """
    def _status(msg: str) -> None:
        logger.info(msg)
        if on_status:
            on_status(msg)

    all_products: list[FPProduct] = []
    url_tpl = (
        f"{cfg.freshportal_url}/product/index/index/"
        f"?1=1&vbn_number_adjustable={vbn_filter}&page={{page}}"
    )

    saved_cookies: list = []
    cols: tuple[int, int, int, int] | None = None
    last_page: int | None = None
    current_page = 1

    while True:
        with sync_playwright() as pw:
            browser = _launch_browser(pw)
            context = browser.new_context()
            if saved_cookies:
                context.add_cookies(saved_cookies)
            page = context.new_page()
            _block_resources(page)

            try:
                if not saved_cookies:
                    _status("Logowanie do FreshPortal…")
                    _login(page, cfg)

                pages_in_batch = 0
                while pages_in_batch < PAGES_PER_BATCH:
                    if last_page is not None and current_page > last_page:
                        break

                    _goto_and_wait(page, url_tpl.format(page=current_page), cfg)
                    soup = BeautifulSoup(page.content(), "lxml")

                    if last_page is None:
                        cols = _detect_columns_html(soup)
                        last_page = _get_last_page_html(soup)
                        _status(f"Znaleziono {last_page} stron produktów z VBN {vbn_filter}")

                    products = _parse_rows_html(soup, cols)
                    if not products:
                        last_page = current_page - 1
                        break

                    all_products.extend(products)
                    _status(
                        f"Strona {current_page}/{last_page} — "
                        f"pobrano łącznie {len(all_products)} produktów"
                    )
                    current_page += 1
                    pages_in_batch += 1

                saved_cookies = context.cookies()
            finally:
                context.close()
                browser.close()

        if last_page is None or current_page > last_page:
            break

    _status(f"Pobieranie zakończone — {len(all_products)} produktów")
    return all_products


# ---------------------------------------------------------------------------
# scrape_all_products — no VBN filter, fetches every product
# ---------------------------------------------------------------------------

def scrape_all_products(
    cfg: Config,
    on_status=None,
    on_batch=None,
    from_date: str = "",
    to_date: str = "",
) -> list[FPProduct]:
    """Scrape products from FreshPortal.

    When from_date/to_date are given, filters by mutation_date_time_from/to
    (incremental sync).  Otherwise fetches all products (full sync).
    Uses the same 6-pages-per-browser-batch strategy to cap peak RAM.

    Stop condition: an empty page (0 products parsed) signals end of data.
    The detected last_page is used only for progress display — FreshPortal's
    Angular pagination only shows a sliding window of page numbers, so the
    visible max can be lower than the actual last page.

    on_batch: optional callable(batch: list[FPProduct]) — called after each
    browser session closes (every PAGES_PER_BATCH pages).
    """
    def _status(msg: str) -> None:
        logger.info(msg)
        if on_status:
            on_status(msg)

    all_products: list[FPProduct] = []
    if from_date:
        url_tpl = (
            f"{cfg.freshportal_url}/product/index/index/"
            f"?1=1&mutation_date_time_from={from_date}"
            f"&mutation_date_time_to={to_date}&page={{page}}"
        )
    else:
        url_tpl = f"{cfg.freshportal_url}/product/index/index/?1=1&page={{page}}"

    saved_cookies: list = []
    col_map: dict[str, int] | None = None
    last_page: int | None = None
    current_page = 1

    while True:
        batch_start = len(all_products)

        with sync_playwright() as pw:
            browser = _launch_browser(pw)
            context = browser.new_context()
            if saved_cookies:
                context.add_cookies(saved_cookies)
            page = context.new_page()
            _block_resources(page)

            try:
                if not saved_cookies:
                    _status("Logging into FreshPortal…")
                    _login(page, cfg)

                pages_in_batch = 0
                while pages_in_batch < PAGES_PER_BATCH:
                    if last_page is not None and current_page > last_page:
                        break

                    _goto_product_page(page, url_tpl.format(page=current_page), cfg)
                    soup = BeautifulSoup(page.content(), "lxml")

                    if col_map is None:
                        col_map = _detect_columns_html(soup)
                        last_page = _get_last_page_html(soup)
                        _status(f"Detected {last_page} pages — scraping all")

                    products = _parse_rows_html(soup, col_map)
                    if not products:
                        # Empty page: finalize last_page at the previous page
                        logger.info(
                            "STOP: empty page=%d url=%s total=%d last_page_was=%s",
                            current_page, page.url, len(all_products), last_page,
                        )
                        last_page = current_page - 1
                        break

                    all_products.extend(products)
                    if current_page % 10 == 0:
                        _status(
                            f"Page {current_page}/{last_page} — "
                            f"{len(all_products)} products so far"
                        )
                    current_page += 1
                    pages_in_batch += 1

                saved_cookies = context.cookies()
            finally:
                context.close()
                browser.close()

        # Flush this browser session's products to DB while next session loads
        if on_batch and len(all_products) > batch_start:
            on_batch(all_products[batch_start:])

        if last_page is None or current_page > last_page:
            break

    _status(f"Scrape complete — {len(all_products)} products")
    return all_products


# ---------------------------------------------------------------------------
# fix_vbn_batch — single Playwright session
# ---------------------------------------------------------------------------

def _id_filter(cfg: Config, product_id: str) -> str:
    if "fp042100.freshportal.nl" in cfg.freshportal_url:
        return f"id={product_id}"
    return f"external_id={product_id}"


def _detect_columns(page: Page) -> dict[str, int]:
    """Playwright version of column detection — returns {field: col_index}."""
    headers = page.query_selector_all("table thead th, table thead td")
    col_map: dict[str, int] = {}
    for i, h in enumerate(headers):
        # data-header-title is cleaner than inner_text (no sort-icon noise)
        title_attr = h.get_attribute("data-header-title") or ""
        text = (title_attr.strip() or " ".join(h.inner_text().split())).lower()
        field = _HEADER_MAP.get(text)
        if field and field not in col_map:
            col_map[field] = i
    for field, fallback_idx in _FALLBACK_COLS.items():
        if field not in col_map:
            col_map[field] = fallback_idx
    return col_map


def _fix_inline(page: Page, product_id: str, new_vbn: str, vbn_col: int, cfg: Config) -> bool:
    url = f"{cfg.freshportal_url}/product/index/index/?1=1&{_id_filter(cfg, product_id)}"
    page.goto(url, wait_until="load", timeout=cfg.request_timeout)
    try:
        page.wait_for_selector("table tbody tr", timeout=10_000)
    except Exception:
        time.sleep(3)

    rows = page.query_selector_all("table tbody tr")
    if not rows:
        logger.error("Product not found for id=%s", product_id)
        return False

    cells = rows[0].query_selector_all("td")
    if len(cells) <= vbn_col:
        logger.error("VBN column %d out of range for id=%s", vbn_col, product_id)
        return False

    vbn_cell = cells[vbn_col]
    vbn_cell.click()
    time.sleep(0.5)

    input_el = vbn_cell.query_selector("input")
    if not input_el:
        page.keyboard.press("Space")
        time.sleep(0.5)
        input_el = vbn_cell.query_selector("input")

    if not input_el:
        for sel in ["input[name*='vbn']", "input[id*='vbn']", "input[name*='VBN']"]:
            input_el = page.query_selector(sel)
            if input_el:
                break

    if not input_el:
        logger.error("VBN cell not editable for id=%s (data-can-edit=0?)", product_id)
        return False

    input_el.press("Control+a")
    input_el.fill(new_vbn)
    input_el.press("Enter")
    time.sleep(1)
    logger.info("Saved VBN for id=%s -> %s", product_id, new_vbn)
    return True


def fix_vbn_batch(
    fixes: list[tuple[str, str]],
    cfg: Config,
    on_status=None,
) -> dict[str, bool]:
    """Apply VBN fixes using a single Playwright browser session."""
    def _status(msg: str) -> None:
        logger.info(msg)
        if on_status:
            on_status(msg)

    results: dict[str, bool] = {}
    total = len(fixes)

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        _block_resources(page)
        try:
            _status("Logowanie do FreshPortal…")
            _login(page, cfg)
            page.goto(
                f"{cfg.freshportal_url}/product/index/index/?1=1",
                wait_until="load",
                timeout=cfg.request_timeout,
            )
            time.sleep(1.5)
            col_map = _detect_columns(page)
            vbn_col = col_map.get("vbn_number", 8)
            for i, (product_id, new_vbn) in enumerate(fixes, 1):
                _status(f"Poprawianie produktu {i}/{total} (ID {product_id} → VBN {new_vbn})…")
                try:
                    results[product_id] = _fix_inline(page, product_id, new_vbn, vbn_col, cfg)
                except Exception as exc:
                    logger.error("Error fixing id=%s: %s", product_id, exc)
                    results[product_id] = False
        finally:
            context.close()
            browser.close()

    fixed = sum(1 for ok in results.values() if ok)
    _status(f"Zakończono: {fixed}/{total} poprawionych")
    return results


def fix_vbn_for_product(product_id: str, new_vbn: str, cfg: Config) -> bool:
    return fix_vbn_batch([(product_id, new_vbn)], cfg).get(product_id, False)


# ---------------------------------------------------------------------------
# Debug helper
# ---------------------------------------------------------------------------

def _debug_fetch(cfg: Config, vbn_filter: str) -> dict:
    """Diagnostic: shows login result and raw page content from FreshPortal."""
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})
    timeout = cfg.request_timeout // 1000

    login_url = f"{cfg.freshportal_url}/login_v2/index/index/"
    r = session.get(login_url, timeout=timeout)
    soup = BeautifulSoup(r.text, "lxml")
    data: dict[str, str] = {}
    form = soup.find("form")
    if form:
        for inp in form.find_all("input"):
            name = inp.get("name")
            if name and inp.get("type") not in ("submit", "button"):
                data[name] = inp.get("value", "")
    data["USE_Username"] = cfg.freshportal_username
    data["USE_Password"] = cfg.freshportal_password

    r = session.post(login_url, data=data, timeout=timeout, allow_redirects=True)

    prod_url = (f"{cfg.freshportal_url}/product/index/index/"
                f"?1=1&vbn_number_adjustable={vbn_filter}&page=1")
    r2 = session.get(prod_url, timeout=timeout)
    soup2 = BeautifulSoup(r2.text, "lxml")
    table = soup2.find("table")
    rows = table.find("tbody").find_all("tr") if table and table.find("tbody") else []

    return {
        "login_result_url": r.url,
        "product_page_url": r2.url,
        "product_page_status": r2.status_code,
        "table_found": table is not None,
        "row_count_requests": len(rows),
        "note": "row_count=0 means JS-rendered table — using Playwright batches instead",
        "html_snippet": r2.text[:600],
    }


def _debug_rendered(cfg: Config, vbn_filter: str) -> dict:
    """Use Playwright to get fully-rendered HTML and diagnose pagination."""
    url = (f"{cfg.freshportal_url}/product/index/index/"
           f"?1=1&vbn_number_adjustable={vbn_filter}&page=1")

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        _block_resources(page)
        try:
            _login(page, cfg)
            _goto_and_wait(page, url, cfg)
            html = page.content()
        finally:
            context.close()
            browser.close()

    soup = BeautifulSoup(html, "lxml")

    # Collect pagination element
    pagination = soup.find("ul", class_="pagination")
    pagination_html = str(pagination)[:2000] if pagination else "NOT FOUND"

    # All links with page= in href
    import re as _re
    page_links = []
    for a in soup.find_all("a", href=True):
        m = _re.search(r"[?&]page=(\d+)", a["href"])
        if m:
            page_links.append({"text": a.get_text(strip=True), "page": int(m.group(1))})

    # Visible page numbers in pagination li elements
    li_texts = [li.get_text(strip=True) for li in pagination.find_all("li")] if pagination else []

    # Row count after JS render
    rows = soup.find("table").find("tbody").find_all("tr") if soup.find("table") and soup.find("table").find("tbody") else []

    detected_last = _get_last_page_html(soup)

    return {
        "row_count_rendered": len(rows),
        "detected_last_page": detected_last,
        "pagination_li_texts": li_texts,
        "page_links_in_pagination": page_links,
        "pagination_html": pagination_html,
    }
