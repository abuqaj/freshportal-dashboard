"""FreshPortal scraper — fetches all products for a given VBN filter."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from playwright.sync_api import Page, sync_playwright

from config import Config

logger = logging.getLogger(__name__)

ROWS_PER_PAGE = 20  # fallback; actual count detected at runtime


@dataclass
class FPProduct:
    product_id: str
    short_name: str
    name: str
    vbn_number: str
    origin: str = ""


def _login(page: Page, cfg: Config) -> None:
    page.goto(
        f"{cfg.freshportal_url}/login_v2/index/index/",
        wait_until="load",
        timeout=cfg.request_timeout,
    )
    page.fill("#username, input[name='USE_Username']", cfg.freshportal_username)
    page.fill("#password, input[name='USE_Password'], input[type='password']", cfg.freshportal_password)
    page.click("button:has-text('Login'), button[type='submit']")
    # Wait until we leave the login page
    page.wait_for_url(lambda url: "login" not in url, timeout=cfg.request_timeout)
    time.sleep(1)
    logger.info("Logged in. Current URL: %s", page.url)


def _detect_columns(page: Page) -> tuple[int, int, int, int]:
    """Return (col_vbn, col_name, col_short, col_origin) by reading header text."""
    headers = page.query_selector_all("table thead th, table thead td")
    col_vbn = col_name = col_short = col_origin = -1
    for i, h in enumerate(headers):
        t = h.inner_text().strip().lower()
        if t == "vbn number":
            col_vbn = i
        elif t == "name" and col_name == -1:
            col_name = i
        elif t == "short name":
            col_short = i
        elif t == "origin":
            col_origin = i
    if col_vbn == -1:
        col_vbn = 8
    if col_name == -1:
        col_name = 10
    if col_short == -1:
        col_short = 11
    if col_origin == -1:
        col_origin = 18
    logger.info("Column indices: VBN=%d  Name=%d  Short=%d  Origin=%d", col_vbn, col_name, col_short, col_origin)
    return col_vbn, col_name, col_short, col_origin


def _parse_page(page: Page, cols: tuple[int, int, int, int]) -> list[FPProduct]:
    col_vbn, col_name, col_short, col_origin = cols
    rows = page.query_selector_all("table tbody tr")
    products: list[FPProduct] = []
    for row in rows:
        cells = row.query_selector_all("td")
        if len(cells) <= max(col_vbn, col_name, col_short):
            continue
        product_id = cells[0].inner_text().strip()
        vbn = cells[col_vbn].inner_text().strip()
        name = cells[col_name].inner_text().strip()
        short = cells[col_short].inner_text().strip()
        origin = cells[col_origin].inner_text().strip() if len(cells) > col_origin else ""
        if vbn or name:
            products.append(FPProduct(product_id=product_id, short_name=short, name=name, vbn_number=vbn, origin=origin))
    return products


def _get_last_page(page: Page) -> int:
    """Return the last page number from the pagination control."""
    try:
        items = page.query_selector_all("ul.pagination li")
        numbers = []
        for li in items:
            t = li.inner_text().strip()
            if t.isdigit():
                numbers.append(int(t))
        if numbers:
            return max(numbers)
    except Exception:
        pass
    return 1


def fetch_products(vbn_filter: str, cfg: Config) -> list[FPProduct]:
    """Fetch all FreshPortal products where vbn_number contains *vbn_filter*."""
    all_products: list[FPProduct] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
        ])
        context = browser.new_context()
        page = context.new_page()

        try:
            _login(page, cfg)

            # Load page 1 to discover total page count
            url_tpl = (
                f"{cfg.freshportal_url}/product/index/index/"
                f"?1=1&vbn_number_adjustable={vbn_filter}&page={{page}}"
            )
            page.goto(url_tpl.format(page=1), wait_until="load", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector("table tbody tr", timeout=10000)
            except Exception:
                time.sleep(3)

            cols = _detect_columns(page)
            last_page = _get_last_page(page)
            logger.info("Total pages for VBN filter '%s': %d", vbn_filter, last_page)

            products = _parse_page(page, cols)
            all_products.extend(products)
            logger.info("Page 1: %d products", len(products))

            for page_num in range(2, last_page + 1):
                for attempt in range(cfg.retry_attempts):
                    try:
                        page.goto(
                            url_tpl.format(page=page_num),
                            wait_until="load",
                            timeout=cfg.request_timeout,
                        )
                        try:
                            page.wait_for_selector("table tbody tr", timeout=10000)
                        except Exception:
                            time.sleep(3)
                        break
                    except Exception as exc:
                        if attempt == cfg.retry_attempts - 1:
                            raise
                        logger.warning("Retry %d for page %d: %s", attempt + 1, page_num, exc)
                        time.sleep(2 ** attempt)

                products = _parse_page(page, cols)
                if not products:
                    logger.info("Empty page %d — stopping", page_num)
                    break
                all_products.extend(products)
                logger.info("Page %d/%d: %d products (total: %d)", page_num, last_page, len(products), len(all_products))

        finally:
            context.close()
            browser.close()

    logger.info("Total fetched: %d products", len(all_products))
    return all_products


def _id_filter(cfg: Config, product_id: str) -> str:
    """fp042100 is the master — it uses 'id'. All slave portals use 'external_id'."""
    if "fp042100.freshportal.nl" in cfg.freshportal_url:
        return f"id={product_id}"
    return f"external_id={product_id}"


def _fix_inline(page: Page, product_id: str, new_vbn: str, vbn_col: int, cfg: Config) -> bool:
    """Navigate directly to the product by ID and inline-edit its VBN cell."""
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
    """
    Apply multiple VBN fixes in a single browser session using inline table editing.
    fixes = list of (product_id, new_vbn) tuples.
    Returns dict product_id -> success bool.
    """
    results: dict[str, bool] = {}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
        ])
        context = browser.new_context()
        page = context.new_page()

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
                    ok = _fix_inline(page, product_id, new_vbn, vbn_col, cfg)
                    results[product_id] = ok
                except Exception as exc:
                    logger.error("Error fixing id=%s: %s", product_id, exc)
                    results[product_id] = False

        finally:
            context.close()
            browser.close()

    return results


def fix_vbn_for_product(product_id: str, new_vbn: str, cfg: Config) -> bool:
    """Fix a single product's VBN (convenience wrapper around fix_vbn_batch)."""
    return fix_vbn_batch([(product_id, new_vbn)], cfg).get(product_id, False)
