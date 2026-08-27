"""Scrape the FreshPortal supplier list (used by the delivery-import supplier
picker). The old per-supplier product catalogue scraping that used to live
here was removed 2026-08-27 — dead since the DFG API + products-DB matching
migration (see delivery_product_match.py) made it obsolete; nothing called
it anymore.
"""
from __future__ import annotations

import logging
import re
from typing import Callable

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from config import Config

log = logging.getLogger(__name__)


def _parse_supplier_rows(soup: BeautifulSoup) -> list[dict]:
    """Extract supplier rows. Supports:
    - data-sort-field="SUP_ID" / "SUP_Name" column headers (FreshPortal _v2)
    - data-id row attributes
    - edit/view link patterns
    """
    suppliers: list[dict] = []
    seen_ids: set[str] = set()

    for table in soup.find_all("table"):
        # ── Detect column positions from header ──────────────────────────
        col_id: int | None = None
        col_name: int | None = None

        header_tr = None
        thead = table.find("thead")
        if thead:
            header_tr = thead.find("tr")
        if not header_tr:
            header_tr = table.find("tr")

        if header_tr:
            for idx, th in enumerate(header_tr.find_all(["th", "td"])):
                sf = th.get("data-sort-field", "")
                txt = th.get_text(strip=True).lower()
                if sf == "SUP_ID" or txt in ("#", "id", "nr"):
                    col_id = idx
                elif sf == "SUP_Name" or sf == "SUP_name" or "supplier" in txt or "name" in txt:
                    col_name = idx

        # ── Parse body rows ───────────────────────────────────────────────
        tbody = table.find("tbody") or table
        for tr in tbody.find_all("tr"):
            if tr.find_parent("thead"):
                continue
            cells = tr.find_all("td")
            if not cells:
                continue

            # --- Supplier ID ---
            sup_id = (tr.get("data-id") or "").strip()

            if not sup_id and col_id is not None and len(cells) > col_id:
                txt = cells[col_id].get_text(strip=True)
                if re.match(r"^\d+$", txt):
                    sup_id = txt

            if not sup_id:
                for a in tr.find_all("a", href=True):
                    m = re.search(
                        r"/(?:SUP_ID|supplier_id|edit(?:/index)?|view(?:/index)?)/(\d+)",
                        a["href"], re.IGNORECASE,
                    )
                    if m:
                        sup_id = m.group(1)
                        break

            if not sup_id:
                for a in tr.find_all("a", href=True):
                    if re.search(r"/(edit|view|detail)", a["href"], re.I):
                        m = re.search(r"/(\d+)/?(?:\?|$)", a["href"])
                        if m:
                            sup_id = m.group(1)
                            break

            if not sup_id or sup_id in seen_ids:
                continue
            seen_ids.add(sup_id)

            # --- Supplier name ---
            nm = ""
            if col_name is not None and len(cells) > col_name:
                nm = cells[col_name].get_text(" ", strip=True)

            if not nm:
                for cell in cells:
                    txt = cell.get_text(" ", strip=True)
                    if txt and not re.match(r"^\d+$", txt):
                        nm = txt
                        break

            if nm:
                suppliers.append({"fp_supplier_id": sup_id, "nm_supplier": nm})

    return suppliers


def fetch_supplier_list(
    cfg: Config,
    on_status: Callable[[str], None] | None = None,
    debug: bool = False,
) -> list[dict] | dict:
    """Scrape /supplier/index/index/ in a single Playwright session.

    Normal mode  (debug=False): returns [{fp_supplier_id, nm_supplier}]
    Debug mode   (debug=True):  returns dict with suppliers + diagnostics
                                (same session — no extra memory cost)
    """
    from scraper_fp import _launch_browser, _login, _logout, _block_resources

    def _s(msg: str) -> None:
        if on_status:
            on_status(msg)

    _s("Logging into FreshPortal…")
    suppliers: list[dict] = []
    diag: dict = {}

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        context = browser.new_context()
        page = context.new_page()
        _block_resources(page)
        try:
            _login(page, cfg)

            url = f"{cfg.freshportal_url}/supplier/index_v2/index/"
            _s(f"Loading {url}…")
            page.goto(url, wait_until="domcontentloaded", timeout=cfg.request_timeout)
            final_url = page.url
            _s(f"Final URL: {final_url}")

            try:
                page.wait_for_selector("table tbody tr", timeout=20_000)
                _s("Table rows loaded")
            except Exception:
                _s("No table rows after 20s — parsing whatever is present")

            html = page.content()
            soup = BeautifulSoup(html, "lxml")

            all_trs = soup.find_all("tr")
            tables = soup.find_all("table")
            rows_with_data_id = soup.find_all(True, {"data-id": True})

            _s(f"Page: {len(html)} chars | tables: {len(tables)} | tr: {len(all_trs)} | data-id rows: {len(rows_with_data_id)}")

            suppliers = _parse_supplier_rows(soup)
            _s(f"Parsed {len(suppliers)} supplier(s)")

            if not suppliers:
                for i, tr in enumerate(all_trs[:6]):
                    text = tr.get_text(" ", strip=True)[:120]
                    links = [a["href"] for a in tr.find_all("a", href=True)][:3]
                    _s(f"  tr[{i}]: {text!r}  links={links}")

            if debug:
                page_title = soup.find("title")
                diag = {
                    "final_url": final_url,
                    "page_title": page_title.get_text(strip=True) if page_title else "",
                    "html_snippet": html[:3000],
                    "table_count": len(tables),
                    "tr_count": len(all_trs),
                    "rows_with_dataid": [
                        {"data_id": el.get("data-id"), "text": el.get_text(" ", strip=True)[:100]}
                        for el in rows_with_data_id[:15]
                    ],
                    "tr_samples": [str(tr)[:500] for tr in all_trs[:8]],
                    "supplier_links": sorted({
                        a["href"] for a in soup.find_all("a", href=True)
                        if "supplier" in a["href"].lower()
                    })[:40],
                    "parsed_suppliers": suppliers,
                }

        except Exception as exc:
            log.exception("fetch_supplier_list failed")
            _s(f"Error: {exc}")
            raise
        finally:
            _logout(context, cfg)
            context.close()
            browser.close()

    if debug:
        return diag
    return suppliers
