"""Scrape FreshPortal's grower (manufacturer) list from /manufacturer/index_v2/index/.

Delivery import sends each stock entry's grower as manufacturer_id, which is
the id this list shows on the same system. Only growers from Ecuador and
Colombia are wanted (2026-09-24); wanted_country() picks them out.

The columns are found by their headers (id, manufacturer, country), in
English, Dutch or Spanish. When the id, name or country column cannot be
found, fetch_manufacturers raises with the headers it saw, rather than
storing a list that could be the wrong column.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from collections import Counter
from typing import Callable

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from config import Config

log = logging.getLogger(__name__)

LIST_PATH = "/manufacturer/index_v2/index/"

# Stop paging after this many pages; FreshPortal's list is far shorter.
_MAX_PAGES = 200

_LAST_PAGE_JS = """() => {
    let maxPage = 1;
    document.querySelectorAll('a[href]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/[?&]page=(\\d+)/);
        if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    return maxPage;
}"""


def _plain(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower().strip()


def wanted_country(raw: str) -> str:
    """'Ecuador' or 'Colombia' when a country cell names one, else ''."""
    text = _plain(raw)
    words = set(re.findall(r"[a-z]+", text))
    if "ecuador" in text or words & {"ec", "ecu"}:
        return "Ecuador"
    if any(w in text for w in ("colombia", "columbia", "kolumbia")) or words & {"co", "col"}:
        return "Colombia"
    return ""


def _column_of(header_cells: list) -> dict[str, int]:
    """{'id' | 'name' | 'country': column index} from one header row."""
    cols: dict[str, int] = {}
    for idx, th in enumerate(header_cells):
        sort_field = _plain(th.get("data-sort-field") or "")
        text = _plain(th.get_text(" ", strip=True))
        both = f"{text} {sort_field}"
        if "id" not in cols and (text in ("#", "id", "nr", "nr.") or sort_field == "id"
                                 or sort_field.endswith("_id")):
            cols["id"] = idx
        elif "country" not in cols and any(w in both for w in ("country", "land", "pais", "cou_")):
            cols["country"] = idx
        elif "name" not in cols and any(w in both for w in ("manufacturer", "fabrikant", "kweker",
                                                            "grower", "productor", "name", "naam")):
            cols["name"] = idx
    return cols


def _find_table(soup: BeautifulSoup) -> tuple[object | None, dict[str, int], list[str]]:
    """The list table, its columns, and every header text seen (for the error)."""
    seen_headers: list[str] = []
    for table in soup.find_all("table"):
        header_rows = (table.find("thead") or table).find_all("tr")
        for tr in header_rows[:3]:
            cells = tr.find_all(["th", "td"])
            texts = [c.get_text(" ", strip=True) or (c.get("data-sort-field") or "") for c in cells]
            seen_headers.append(" | ".join(texts))
            cols = _column_of(cells)
            if {"id", "name"} <= cols.keys():
                return table, cols, seen_headers
    return None, {}, seen_headers


def _cell_text(cell) -> str:
    text = cell.get_text(" ", strip=True)
    if text:
        return text
    img = cell.find("img")  # a country may be shown as a flag
    return (img.get("title") or img.get("alt") or "").strip() if img else ""


def _parse_rows(table, cols: dict[str, int]) -> list[dict]:
    rows: list[dict] = []
    body = table.find("tbody") or table
    for tr in body.find_all("tr"):
        if tr.find_parent("thead"):
            continue
        cells = tr.find_all("td")
        if len(cells) <= max(cols.values()):
            continue
        mid = (tr.get("data-id") or "").strip()
        if not mid:
            raw = cells[cols["id"]].get_text(strip=True)
            mid = raw if re.fullmatch(r"\d+", raw) else ""
        name = cells[cols["name"]].get_text(" ", strip=True)
        if not mid or not name:
            continue
        rows.append({
            "manufacturer_id": mid,
            "nm_manufacturer": name,
            "country": _cell_text(cells[cols["country"]]) if "country" in cols else "",
        })
    return rows


def fetch_manufacturers(
    cfg: Config,
    on_status: Callable[[str], None] | None = None,
) -> tuple[list[dict], dict]:
    """Every row of the manufacturer list, page by page, as
    [{manufacturer_id, nm_manufacturer, country}], plus what was seen:
    {"columns", "pages", "countries"}."""
    from scraper_fp import _launch_browser, _login, _logout, _block_resources

    def _s(msg: str) -> None:
        log.info(msg)
        if on_status:
            on_status(msg)

    base_url = f"{cfg.freshportal_url}{LIST_PATH}?1=1"
    results: list[dict] = []
    seen_ids: set[str] = set()
    cols: dict[str, int] = {}
    pages = 0

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        _block_resources(page)
        try:
            _s(f"Logging into {cfg.freshportal_url}…")
            _login(page, cfg)
            last_page = _MAX_PAGES
            p = 1
            while p <= last_page:
                page.goto(f"{base_url}&page={p}", wait_until="domcontentloaded", timeout=cfg.request_timeout)
                try:
                    page.wait_for_selector("table tbody tr", timeout=20_000)
                except Exception:
                    pass
                soup = BeautifulSoup(page.content(), "lxml")
                table, page_cols, headers = _find_table(soup)
                if table is None:
                    if p == 1:
                        raise RuntimeError(f"No manufacturer table with an id and a name column; headers seen: {headers}")
                    break
                if p == 1:
                    cols = page_cols
                    if "country" not in cols:
                        raise RuntimeError(f"No country column in the manufacturer list; headers seen: {headers}")
                    links_last = page.evaluate(_LAST_PAGE_JS)
                    if links_last > 1:
                        last_page = min(links_last, _MAX_PAGES)
                    _s(f"Columns {cols}, up to {last_page} page(s)")
                new = [r for r in _parse_rows(table, cols) if r["manufacturer_id"] not in seen_ids]
                pages = p
                if not new:
                    break  # a page past the end repeats the last one
                seen_ids.update(r["manufacturer_id"] for r in new)
                results.extend(new)
                _s(f"Page {p}: {len(new)} manufacturer(s), {len(results)} so far")
                p += 1
        finally:
            _logout(ctx, cfg)
            ctx.close()
            browser.close()

    countries = Counter(r["country"] for r in results)
    return results, {"columns": cols, "pages": pages, "countries": dict(countries.most_common(15))}
