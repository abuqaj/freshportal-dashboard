"""Scrape supplier product catalogue from FreshPortal Ecuador.

URL pattern: /company_product_v2/index_v2/index/?1=1&supplier_edit={supplier_id}&page={n}

Each row in the catalogue represents a product that can be used when creating
a delivery for that supplier.  We store the FP-internal product ID so the
delivery scraper can select the right product without guessing.
"""
from __future__ import annotations

import logging
import re
from typing import Callable

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from config import Config

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Column name → our field mapping  (case-insensitive substring search)
# ---------------------------------------------------------------------------
_COL_MAP = {
    # FP column header keywords → normalized field name
    "naam":         "nm_product",
    "name":         "nm_product",
    "omschrijving": "nm_product",
    "description":  "nm_product",
    "vbn":          "id_floricode",
    "floricode":    "id_floricode",
    "code":         "id_floricode",
    "lengte":       "nu_length",
    "length":       "nu_length",
    "cm":           "nu_length",
    "stuks":        "nu_stems_bunch",
    "stems":        "nu_stems_bunch",
    "bos":          "nu_stems_bunch",
    "bunch":        "nu_stems_bunch",
    "soort":        "nm_species",
    "species":      "nm_species",
    "ras":          "nm_variety",
    "variety":      "nm_variety",
    "variété":      "nm_variety",
}


def _detect_columns(header_row) -> dict[int, str]:
    """Map column index → field name from table <th> cells."""
    col_map: dict[int, str] = {}
    for idx, th in enumerate(header_row.find_all(["th", "td"])):
        text = (th.get_text(" ", strip=True) or "").lower()
        for keyword, field in _COL_MAP.items():
            if keyword in text and field not in col_map.values():
                col_map[idx] = field
                break
    return col_map


def _parse_rows(soup: BeautifulSoup, col_map: dict[int, str]) -> list[dict]:
    """Parse visible data rows into catalogue dicts."""
    items: list[dict] = []
    tbody = soup.find("tbody")
    if not tbody:
        return items

    for tr in tbody.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue

        item: dict = {}

        # Extract FP product ID from row data-id attribute or edit link
        fp_id = tr.get("data-id") or tr.get("data-product-id") or ""
        if not fp_id:
            for a in tr.find_all("a", href=True):
                m = re.search(r"/(?:id|edit|PRO_ID)/(\d+)", a["href"])
                if m:
                    fp_id = m.group(1)
                    break
        if not fp_id:
            continue

        item["fp_product_id"] = fp_id

        # Map cells to fields
        for idx, cell in enumerate(cells):
            field = col_map.get(idx)
            if field:
                val = cell.get_text(" ", strip=True)
                if field in ("nu_length", "nu_stems_bunch"):
                    try:
                        item[field] = int(re.search(r"\d+", val).group())
                    except (AttributeError, ValueError):
                        item[field] = None
                else:
                    item[field] = val or None

        items.append(item)

    return items


def _get_last_page(soup: BeautifulSoup) -> int:
    """Extract last page number from FreshPortal pagination."""
    # Common patterns: "Pagina X van Y" or data-page attributes
    pager = soup.find(class_=re.compile("pager|pagination", re.I))
    if pager:
        # Find last numbered page link
        links = pager.find_all("a", href=True)
        nums = []
        for a in links:
            m = re.search(r"[?&]page=(\d+)", a["href"])
            if m:
                nums.append(int(m.group(1)))
        if nums:
            return max(nums)
        # Text like "van 7"
        m = re.search(r"van\s+(\d+)", pager.get_text(), re.I)
        if m:
            return int(m.group(1))
    return 1


def fetch_supplier_catalogue(
    supplier_id: int | str,
    cfg: Config,
    on_status: Callable[[str], None] | None = None,
) -> list[dict]:
    """Login to Ecuador FP and scrape all catalogue pages for supplier_id.

    Returns list of dicts: {fp_product_id, nm_product, nm_variety, nm_species,
                             nu_length, nu_stems_bunch, id_floricode}
    """
    from scraper_fp import _launch_browser, _login, _block_resources

    def _s(msg: str) -> None:
        if on_status:
            on_status(msg)

    base_url = (
        f"{cfg.freshportal_url}/company_product_v2/index_v2/index/"
        f"?1=1&supplier_edit={supplier_id}"
    )

    results: list[dict] = []
    col_map: dict[int, str] = {}

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        _block_resources(page)
        try:
            _s("Logging into Ecuador FreshPortal…")
            _login(page, cfg)

            # First page — detect columns + last page
            _s("Loading catalogue page 1…")
            page.goto(f"{base_url}&page=1", wait_until="load", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector("table tbody tr", timeout=15_000)
            except Exception:
                pass

            soup = BeautifulSoup(page.content(), "lxml")
            header = soup.find("thead")
            if header:
                col_map = _detect_columns(header)
            elif soup.find("tbody"):
                # Try first row as header
                first_row = soup.find("tbody").find("tr")
                if first_row:
                    col_map = _detect_columns(first_row)

            _s(f"Detected columns: {col_map}")
            last_page = _get_last_page(soup)
            _s(f"Pages to scrape: {last_page}")

            # Parse first page
            items = _parse_rows(soup, col_map)
            results.extend(items)
            _s(f"Page 1: {len(items)} products")

            # Remaining pages
            for p in range(2, last_page + 1):
                page.goto(f"{base_url}&page={p}", wait_until="load", timeout=cfg.request_timeout)
                try:
                    page.wait_for_selector("table tbody tr", timeout=10_000)
                except Exception:
                    pass
                soup = BeautifulSoup(page.content(), "lxml")
                items = _parse_rows(soup, col_map)
                if not items:
                    _s(f"Page {p}: empty — stopping")
                    break
                results.extend(items)
                _s(f"Page {p}: {len(items)} products")

            _s(f"Catalogue scrape complete: {len(results)} products total")

        except Exception as exc:
            log.exception("fetch_supplier_catalogue failed")
            _s(f"Error: {exc}")
            raise
        finally:
            context.close()
            browser.close()

    return results
