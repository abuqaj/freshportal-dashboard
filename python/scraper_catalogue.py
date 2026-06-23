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
# data-sort-field → our field mapping  (FreshPortal v2 canonical column IDs)
# ---------------------------------------------------------------------------
_SORT_FIELD_MAP: dict[str, str] = {
    "STE_Description":     "nm_product",
    "PRO_Number":          "_pro_number",   # internal ID fallback
    "PRO_VbnNumber":       "id_floricode",
    "STE_QuantityPerPack": "nu_stems_pack",  # content = qty per STE/pack
    "SEF_Length0":         "nu_length",
    "SEF_StemsPerBunch":   "nu_stems_bunch",  # L11 = stems per individual bunch
    "FUS_Code":            "nm_packaging",
    "CST_Code":            "nm_maturity",
}

# Fallback: text-keyword → field for non-v2 pages (no data-sort-field)
_COL_MAP = {
    "naam":         "nm_product",
    "name":         "nm_product",
    "omschrijving": "nm_product",
    "description":  "nm_product",
    "vbn":          "id_floricode",
    "floricode":    "id_floricode",
    "lengte":       "nu_length",
    "length":       "nu_length",
    "stuks":        "nu_stems_bunch",
    "stems":        "nu_stems_bunch",
    "bunch":        "nu_stems_bunch",
    "content":      "nu_stems_pack",
    "packaging":    "nm_packaging",
    "maturity":     "nm_maturity",
}


def _find_header_row(soup: BeautifulSoup):
    """Return the single <tr> that holds column headers.

    FreshPortal v2 <thead> may have multiple rows (group headers +
    individual column headers).  We prefer the row that carries
    data-sort-field attributes; otherwise the last row in <thead>.
    """
    thead = soup.find("thead")
    if thead:
        rows = thead.find_all("tr")
        for row in rows:
            if any(th.get("data-sort-field") for th in row.find_all(["th", "td"])):
                return row
        if rows:
            return rows[-1]
    tbody = soup.find("tbody")
    if tbody:
        return tbody.find("tr")
    return None


def _detect_columns(header_row) -> dict[int, str]:
    """Map column index → field name from a single header <tr>.

    Uses data-sort-field attributes first (reliable for FP v2 pages
    whose <th> contain SVG icons rather than text).  Falls back to
    keyword-in-text matching for legacy pages.
    """
    col_map: dict[int, str] = {}
    if header_row is None:
        return col_map

    # Direct <th>/<td> children only — avoids counting nested elements
    cells = header_row.find_all(["th", "td"], recursive=False)
    if not cells:
        cells = header_row.find_all(["th", "td"])

    for idx, th in enumerate(cells):
        sf = th.get("data-sort-field", "")
        if sf and sf in _SORT_FIELD_MAP:
            col_map[idx] = _SORT_FIELD_MAP[sf]
            continue
        # Fallback: text matching (skip cells with no useful text)
        text = (th.get_text(" ", strip=True) or "").lower()
        if not text:
            continue
        for keyword, field in _COL_MAP.items():
            if keyword in text and field not in col_map.values():
                col_map[idx] = field
                break

    return col_map


def _parse_rows(soup: BeautifulSoup, col_map: dict[int, str]) -> list[dict]:
    """Parse visible data rows into catalogue dicts."""
    items: list[dict] = []
    seen_ids: set[str] = set()
    tbody = soup.find("tbody")
    if not tbody:
        return items

    for tr in tbody.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue

        item: dict = {}

        # --- Extract FP product ID ---
        fp_id = (tr.get("data-id") or tr.get("data-product-id") or "").strip()

        if not fp_id:
            for a in tr.find_all("a", href=True):
                href = a["href"]
                # /PRO_ID/123  /edit/123  /view/123  /id/123
                m = re.search(r"/(?:PRO_ID|edit|view|id)/(\d+)", href, re.I)
                if m:
                    fp_id = m.group(1)
                    break
                # query string: ?PRO_ID=123 or &id=123
                m = re.search(r"[?&](?:PRO_ID|product_id|pro_id|id)=(\d+)", href, re.I)
                if m:
                    fp_id = m.group(1)
                    break
                # last numeric segment: /company_product_v2/.../123
                m = re.search(r"/(\d+)(?:[/?]|$)", href)
                if m:
                    fp_id = m.group(1)
                    break

        # --- Map cells to fields ---
        for idx, cell in enumerate(cells):
            field = col_map.get(idx)
            if not field:
                continue
            val = cell.get_text(" ", strip=True)
            if field in ("nu_length", "nu_stems_bunch", "nu_stems_pack"):
                try:
                    item[field] = int(re.search(r"\d+", val).group())
                except (AttributeError, ValueError):
                    item[field] = None
            else:
                item[field] = val or None

        pro_num = (item.pop("_pro_number", None) or "").strip()

        if not fp_id:
            if pro_num:
                # PRO_Number is a variety number shared across lengths/stems —
                # qualify it with length + stems so each line gets a unique ID.
                ln  = item.get("nu_length") or ""
                sp  = item.get("nu_stems_pack") or item.get("nu_stems_bunch") or ""
                fp_id = f"{pro_num}_{ln}_{sp}"
            else:
                # Synthetic fallback: stable across re-syncs, unique per variant.
                nm  = re.sub(r"\s+", "_", (item.get("nm_product") or "").lower().strip())
                ln  = item.get("nu_length") or ""
                sp  = item.get("nu_stems_pack") or item.get("nu_stems_bunch") or ""
                fp_id = f"syn_{nm}_{ln}_{sp}"

        if not fp_id or fp_id in seen_ids:
            continue

        seen_ids.add(fp_id)
        item["fp_product_id"] = fp_id
        items.append(item)

    return items


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
    return Math.min(maxPage, 10);
}"""


def _page_soup(page) -> BeautifulSoup:
    """Extract only table+pager HTML via JS to avoid serialising the full DOM.

    page.content() on FreshPortal catalogue pages crashes Railway containers
    because the full DOM includes huge SVG blobs in every <th>, easily 2-5 MB
    of HTML that spikes memory during serialisation.
    """
    html = page.evaluate(_EXTRACT_JS)
    return BeautifulSoup(html or "", "lxml")


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
            page.goto(f"{base_url}&page=1", wait_until="domcontentloaded", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector("table tbody tr", timeout=20_000)
            except Exception:
                pass

            soup = _page_soup(page)
            header_row = _find_header_row(soup)
            col_map = _detect_columns(header_row)
            _s(f"Detected columns: {col_map}")
            last_page = page.evaluate(_LAST_PAGE_JS)
            # FP may use JS-driven pagination with no plain <a href="?page=N"> links.
            # Fall back to probing up to 10 pages; the empty-stop guard below handles the rest.
            if last_page <= 1:
                last_page = 10
            _s(f"Pages to scrape: up to {last_page}")

            # Parse first page
            items = _parse_rows(soup, col_map)
            results.extend(items)
            _s(f"Page 1: {len(items)} products")

            # Remaining pages
            for p in range(2, last_page + 1):
                page.goto(f"{base_url}&page={p}", wait_until="domcontentloaded", timeout=cfg.request_timeout)
                try:
                    page.wait_for_selector("table tbody tr", timeout=15_000)
                except Exception:
                    pass
                soup = _page_soup(page)
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


# ---------------------------------------------------------------------------
# Supplier list
# ---------------------------------------------------------------------------

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
    from scraper_fp import _launch_browser, _login, _block_resources

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
            context.close()
            browser.close()

    if debug:
        return diag
    return suppliers
