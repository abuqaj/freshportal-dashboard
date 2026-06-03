"""FreshPortal scraper.

fetch_products  — uses requests + BeautifulSoup (no browser, ~30 MB RAM)
fix_vbn_batch   — uses Playwright (browser needed for inline JS editing)
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
    short_name: str
    name: str
    vbn_number: str
    origin: str = ""


# ---------------------------------------------------------------------------
# Requests-based helpers (used by fetch_products)
# ---------------------------------------------------------------------------

def _login_session(cfg: Config) -> requests.Session:
    """Return an authenticated requests.Session for FreshPortal."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    })
    timeout = cfg.request_timeout // 1000

    login_url = f"{cfg.freshportal_url}/login_v2/index/index/"
    resp = session.get(login_url, timeout=timeout)
    resp.raise_for_status()

    # Collect hidden form fields (CSRF tokens etc.)
    soup = BeautifulSoup(resp.text, "lxml")
    data: dict[str, str] = {}
    form = soup.find("form")
    if form:
        for inp in form.find_all("input"):
            name = inp.get("name")
            if name and inp.get("type") not in ("submit", "button"):
                data[name] = inp.get("value", "")

    data["USE_Username"] = cfg.freshportal_username
    data["USE_Password"] = cfg.freshportal_password

    resp = session.post(login_url, data=data, timeout=timeout, allow_redirects=True)

    if "login" in resp.url.lower():
        raise ValueError("FreshPortal login failed — check FRESHPORTAL_USERNAME / FRESHPORTAL_PASSWORD")

    logger.info("Logged in via requests. URL: %s", resp.url)
    return session


def _detect_columns_html(soup: BeautifulSoup) -> tuple[int, int, int, int]:
    col_vbn = col_name = col_short = col_origin = -1
    thead = soup.find("thead")
    if thead:
        for i, h in enumerate(thead.find_all(["th", "td"])):
            t = h.get_text(strip=True).lower()
            if t == "vbn number":
                col_vbn = i
            elif t == "name" and col_name == -1:
                col_name = i
            elif t == "short name":
                col_short = i
            elif t == "origin":
                col_origin = i
    if col_vbn == -1:   col_vbn = 8
    if col_name == -1:  col_name = 10
    if col_short == -1: col_short = 11
    if col_origin == -1: col_origin = 18
    logger.info("Columns: VBN=%d Name=%d Short=%d Origin=%d", col_vbn, col_name, col_short, col_origin)
    return col_vbn, col_name, col_short, col_origin


def _parse_rows_html(soup: BeautifulSoup, cols: tuple[int, int, int, int]) -> list[FPProduct]:
    col_vbn, col_name, col_short, col_origin = cols
    table = soup.find("table")
    if not table:
        return []
    tbody = table.find("tbody")
    if not tbody:
        return []
    products: list[FPProduct] = []
    for row in tbody.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) <= max(col_vbn, col_name, col_short):
            continue
        product_id = cells[0].get_text(strip=True)
        vbn   = cells[col_vbn].get_text(strip=True)
        name  = cells[col_name].get_text(strip=True)
        short = cells[col_short].get_text(strip=True)
        origin = cells[col_origin].get_text(strip=True) if len(cells) > col_origin else ""
        if vbn or name:
            products.append(FPProduct(
                product_id=product_id, short_name=short,
                name=name, vbn_number=vbn, origin=origin,
            ))
    return products


def _get_last_page_html(soup: BeautifulSoup) -> int:
    try:
        pagination = soup.find("ul", class_="pagination")
        if pagination:
            numbers = [
                int(li.get_text(strip=True))
                for li in pagination.find_all("li")
                if li.get_text(strip=True).isdigit()
            ]
            if numbers:
                return max(numbers)
    except Exception:
        pass
    return 1


def fetch_products(vbn_filter: str, cfg: Config) -> list[FPProduct]:
    """Fetch all FreshPortal products using HTTP requests (no browser)."""
    session = _login_session(cfg)
    timeout = cfg.request_timeout // 1000

    url_tpl = (
        f"{cfg.freshportal_url}/product/index/index/"
        f"?1=1&vbn_number_adjustable={vbn_filter}&page={{page}}"
    )

    resp = session.get(url_tpl.format(page=1), timeout=timeout)
    resp.raise_for_status()
    soup1 = BeautifulSoup(resp.text, "lxml")

    cols = _detect_columns_html(soup1)
    last_page = _get_last_page_html(soup1)
    logger.info("Total pages for VBN filter '%s': %d", vbn_filter, last_page)

    all_products = _parse_rows_html(soup1, cols)
    logger.info("Page 1: %d products", len(all_products))

    for page_num in range(2, last_page + 1):
        for attempt in range(cfg.retry_attempts):
            try:
                resp = session.get(url_tpl.format(page=page_num), timeout=timeout)
                resp.raise_for_status()
                break
            except Exception as exc:
                if attempt == cfg.retry_attempts - 1:
                    raise
                logger.warning("Retry %d for page %d: %s", attempt + 1, page_num, exc)
                time.sleep(2 ** attempt)

        products = _parse_rows_html(BeautifulSoup(resp.text, "lxml"), cols)
        if not products:
            logger.info("Empty page %d — stopping", page_num)
            break
        all_products.extend(products)
        logger.info("Page %d/%d: %d products (total: %d)",
                    page_num, last_page, len(products), len(all_products))

    logger.info("Total fetched: %d products", len(all_products))
    return all_products


# ---------------------------------------------------------------------------
# Playwright helpers (used by fix_vbn_batch only)
# ---------------------------------------------------------------------------

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
    logger.info("Playwright logged in. URL: %s", page.url)


def _detect_columns(page: Page) -> tuple[int, int, int, int]:
    headers = page.query_selector_all("table thead th, table thead td")
    col_vbn = col_name = col_short = col_origin = -1
    for i, h in enumerate(headers):
        t = h.inner_text().strip().lower()
        if t == "vbn number":          col_vbn = i
        elif t == "name" and col_name == -1: col_name = i
        elif t == "short name":        col_short = i
        elif t == "origin":            col_origin = i
    if col_vbn == -1:   col_vbn = 8
    if col_name == -1:  col_name = 10
    if col_short == -1: col_short = 11
    if col_origin == -1: col_origin = 18
    return col_vbn, col_name, col_short, col_origin


def _id_filter(cfg: Config, product_id: str) -> str:
    if "fp042100.freshportal.nl" in cfg.freshportal_url:
        return f"id={product_id}"
    return f"external_id={product_id}"


def _fix_inline(page: Page, product_id: str, new_vbn: str, vbn_col: int, cfg: Config) -> bool:
    url = f"{cfg.freshportal_url}/product/index/index/?1=1&{_id_filter(cfg, product_id)}"
    page.goto(url, wait_until="load", timeout=cfg.request_timeout)
    try:
        page.wait_for_selector("table tbody tr", timeout=10000)
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


def fix_vbn_batch(fixes: list[tuple[str, str]], cfg: Config) -> dict[str, bool]:
    """Apply VBN fixes using a single Playwright browser session."""
    results: dict[str, bool] = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=CHROMIUM_ARGS)
        context = browser.new_context()
        page = context.new_page()
        page.route("**/*", lambda route: route.abort()
            if route.request.resource_type in ("image", "font", "media", "stylesheet")
            else route.continue_())
        try:
            _login(page, cfg)
            page.goto(
                f"{cfg.freshportal_url}/product/index/index/?1=1",
                wait_until="load",
                timeout=cfg.request_timeout,
            )
            time.sleep(1.5)
            vbn_col, _, _, _ = _detect_columns(page)
            for product_id, new_vbn in fixes:
                logger.info("Fixing id=%s -> VBN %s", product_id, new_vbn)
                try:
                    results[product_id] = _fix_inline(page, product_id, new_vbn, vbn_col, cfg)
                except Exception as exc:
                    logger.error("Error fixing id=%s: %s", product_id, exc)
                    results[product_id] = False
        finally:
            context.close()
            browser.close()
    return results


def fix_vbn_for_product(product_id: str, new_vbn: str, cfg: Config) -> bool:
    return fix_vbn_batch([(product_id, new_vbn)], cfg).get(product_id, False)
