"""Scrape FreshPortal packaging (fust) table from /fust/index/index/.

The fust table contains all packaging types known to FreshPortal.
Each row has a numeric ID (used as fust_code_adjustable in stock-creation
POST requests) and a short code like HB/QB/MB that maps to delivery nm_box.

URL pattern: /fust/index/index/?1=1&page={n}
"""
from __future__ import annotations

import logging
import re
from typing import Callable

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from config import Config

log = logging.getLogger(__name__)

# data-sort-field values found on /fust/index/index/ <th> elements
_SORT_FIELD_MAP: dict[str, str] = {
    "FUS_ID":          "fust_id",
    "FUS_Code":        "nm_fust_code",
    "FUS_Name":        "nm_fust_desc",
    "FUS_Description": "nm_fust_desc",
    "FUS_Omschrijving": "nm_fust_desc",
}

_COL_KEYWORDS: dict[str, str] = {
    "code":   "nm_fust_code",
    "naam":   "nm_fust_desc",
    "name":   "nm_fust_desc",
    "omschr": "nm_fust_desc",
    "descr":  "nm_fust_desc",
}

_EXTRACT_JS = """() => {
    const table = document.querySelector('table');
    return table ? table.outerHTML : '';
}"""

_LAST_PAGE_JS = """() => {
    let maxPage = 1;
    document.querySelectorAll('a[href]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/[?&]page=(\\d+)/);
        if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    return maxPage;
}"""


def _detect_columns(soup: BeautifulSoup) -> dict[int, str]:
    thead = soup.find("thead")
    if not thead:
        return {}
    for tr in thead.find_all("tr"):
        cells = tr.find_all(["th", "td"], recursive=False) or tr.find_all(["th", "td"])
        if not cells:
            continue
        col_map: dict[int, str] = {}
        for idx, th in enumerate(cells):
            sf = th.get("data-sort-field", "")
            if sf and sf in _SORT_FIELD_MAP:
                col_map[idx] = _SORT_FIELD_MAP[sf]
                continue
            text = (th.get_text(" ", strip=True) or "").lower()
            for kw, field in _COL_KEYWORDS.items():
                if kw in text and field not in col_map.values():
                    col_map[idx] = field
                    break
        if col_map:
            return col_map
    return {}


def _parse_rows(soup: BeautifulSoup, col_map: dict[int, str]) -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()
    tbody = soup.find("tbody")
    if not tbody:
        return items

    for tr in tbody.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue

        item: dict = {}

        # Prefer data-id on the row as the authoritative fust_id
        fust_id = (tr.get("data-id") or tr.get("data-fust-id") or "").strip()

        for idx, cell in enumerate(cells):
            field = col_map.get(idx)
            if not field:
                continue
            val = cell.get_text(" ", strip=True)
            if field == "fust_id":
                fust_id = fust_id or val.strip()
            else:
                item[field] = val or None

        # Fallback: if fust_id still missing, check any link href for a numeric ID
        if not fust_id:
            for a in tr.find_all("a", href=True):
                m = re.search(r"/(\d+)(?:[/?]|$)", a["href"])
                if m:
                    fust_id = m.group(1)
                    break

        # Last resort: first purely numeric cell
        if not fust_id:
            for cell in cells:
                txt = cell.get_text(strip=True)
                if re.fullmatch(r"\d+", txt):
                    fust_id = txt
                    break

        if not fust_id or fust_id in seen:
            continue

        seen.add(fust_id)
        item["fust_id"] = fust_id
        items.append(item)

    return items


def fetch_fust_catalogue(
    cfg: Config,
    on_status: Callable[[str], None] | None = None,
) -> list[dict]:
    """Scrape all fust (packaging) rows from /fust/index/index/.

    Returns list of dicts: {fust_id, nm_fust_code, nm_fust_desc}
    fust_id is the numeric string used in fust_code_adjustable POST field.
    """
    from scraper_fp import _launch_browser, _login, _block_resources

    def _s(msg: str) -> None:
        log.info(msg)
        if on_status:
            on_status(msg)

    base_url = f"{cfg.freshportal_url}/fust/index/index/?1=1"
    results: list[dict] = []
    col_map: dict[int, str] = {}

    # Global dedup: tracks fust_ids already collected across ALL pages.
    # The FP AJAX table often returns the same page content regardless of ?page=N,
    # so we stop as soon as a page adds zero new entries.
    global_seen: set[str] = set()

    def _new_items(raw_items: list[dict]) -> list[dict]:
        new: list[dict] = []
        for item in raw_items:
            fid = item.get("fust_id", "")
            if fid and fid not in global_seen:
                global_seen.add(fid)
                new.append(item)
        return new

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        _block_resources(page)
        try:
            _s("Logging into FreshPortal…")
            _login(page, cfg)

            _s("Loading fust page 1…")
            page.goto(f"{base_url}&page=1", wait_until="domcontentloaded", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector("table tbody tr", timeout=20_000)
            except Exception:
                pass

            html = page.evaluate(_EXTRACT_JS)
            soup = BeautifulSoup(html or "", "lxml")
            col_map = _detect_columns(soup)
            _s(f"Detected columns: {col_map}")

            # Determine last page from pagination links, capped at 300
            last_page = page.evaluate(_LAST_PAGE_JS)
            if last_page <= 1:
                last_page = 300
            _s(f"Max page from links: {last_page}")

            items = _new_items(_parse_rows(soup, col_map))
            results.extend(items)
            _s(f"Page 1: {len(items)} new fust entries")

            for p in range(2, last_page + 1):
                page.goto(f"{base_url}&page={p}", wait_until="domcontentloaded", timeout=cfg.request_timeout)
                try:
                    page.wait_for_selector("table tbody tr", timeout=15_000)
                except Exception:
                    pass
                html = page.evaluate(_EXTRACT_JS)
                soup = BeautifulSoup(html or "", "lxml")
                raw = _parse_rows(soup, col_map)
                items = _new_items(raw)
                if not items:
                    # All entries on this page already seen → server is returning the same
                    # content (pagination exhausted or AJAX ignores page param)
                    _s(f"Page {p}: no new entries ({len(raw)} seen already) — stopping")
                    break
                results.extend(items)
                _s(f"Page {p}: {len(items)} new entries (total: {len(results)})")

            _s(f"Fust scrape complete: {len(results)} unique entries")

        except Exception as exc:
            log.exception("fetch_fust_catalogue failed")
            _s(f"Error: {exc}")
            raise
        finally:
            ctx.close()
            browser.close()

    return results
