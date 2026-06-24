"""FreshPortal Ecuador delivery import via Playwright.

Flow:
  1. POST /batch_v2/form/add/  — create batch header (code, supplier, dates, AWB)
  2. Scrape batch ID from the redirect or batch list page
  3. For each matched product line:
       GET /company_product_add_stock/index/index/BAT_ID/{batch_id}/
       → fill product form → submit
"""
from __future__ import annotations

import logging
import re
import time
from typing import Callable

from playwright.sync_api import sync_playwright, Page

from config import Config
from parser_delivery import DeliveryOrder

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Date helper
# ---------------------------------------------------------------------------

def _to_iso_date(dd_mm_yyyy: str) -> str:
    """DD-MM-YYYY → YYYY-MM-DD (required by batch form date fields)."""
    parts = str(dd_mm_yyyy).strip().split("-")
    if len(parts) == 3:
        d, m, y = parts
        return f"{y}-{m.zfill(2)}-{d.zfill(2)}"
    return dd_mm_yyyy


# ---------------------------------------------------------------------------
# Debug: explore batch add form structure
# ---------------------------------------------------------------------------

def explore_delivery_form(cfg: Config) -> dict:
    """Navigate to /batch_v2/form/add/ and return its full field structure."""
    from scraper_fp import _launch_browser, _login

    result: dict = {
        "url": "",
        "form_fields": [],
        "fps_inputs": [],
        "supplier_options": [],
        "buttons": [],
        "html_snippet": "",
        "error": None,
    }

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.route(
            "**/*",
            lambda r: r.abort() if r.request.resource_type in ("image", "font", "media") else r.continue_(),
        )
        try:
            _login(page, cfg)
            page.goto(f"{cfg.freshportal_url}/batch_v2/form/add/", wait_until="load", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector("input, select, fps-input", timeout=15_000)
            except Exception:
                pass
            time.sleep(1.5)
            result["url"] = page.url

            for el in page.query_selector_all("input, select, textarea"):
                try:
                    result["form_fields"].append({
                        "tag": el.evaluate("el => el.tagName.toLowerCase()"),
                        "name": el.get_attribute("name"),
                        "id": el.get_attribute("id"),
                        "type": el.get_attribute("type"),
                        "placeholder": el.get_attribute("placeholder"),
                        "value": el.evaluate("el => el.value"),
                        "visible": el.is_visible(),
                    })
                except Exception:
                    pass

            result["supplier_options"] = page.evaluate("""
                () => {
                    const sel = document.querySelector("select[name='supplier[]'], select[name='supplier']");
                    if (!sel) return [];
                    return Array.from(sel.options).map(o => ({value: o.value, text: o.text.trim()}));
                }
            """)

            for el in page.query_selector_all("fps-input, fps-select, fps-datepicker, fps-autocomplete"):
                try:
                    result["fps_inputs"].append({
                        "tag": el.evaluate("el => el.tagName.toLowerCase()"),
                        "name": el.get_attribute("name"),
                        "label": el.get_attribute("label"),
                        "formcontrolname": el.get_attribute("formcontrolname"),
                    })
                except Exception:
                    pass

            for btn in page.query_selector_all("button, fps-button, input[type=submit]"):
                try:
                    result["buttons"].append({
                        "text": (btn.inner_text() or "").strip()[:80],
                        "type": btn.get_attribute("type"),
                        "name": btn.get_attribute("name"),
                    })
                except Exception:
                    pass

            result["html_snippet"] = page.content()[:15000]

        except Exception as exc:
            result["error"] = str(exc)
        finally:
            ctx.close()
            browser.close()

    return result


def explore_stock_add_form(batch_id: str, cfg: Config) -> dict:
    """Navigate to /company_product_add_stock/index/index/BAT_ID/{batch_id}/ and return form structure."""
    from scraper_fp import _launch_browser, _login

    result: dict = {"url": "", "form_fields": [], "fps_inputs": [], "html_snippet": "", "error": None}

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.route(
            "**/*",
            lambda r: r.abort() if r.request.resource_type in ("image", "font", "media") else r.continue_(),
        )
        try:
            _login(page, cfg)
            url = f"{cfg.freshportal_url}/company_product_add_stock/index/index/BAT_ID/{batch_id}/"
            page.goto(url, wait_until="load", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector("table tbody tr, input, fps-input", timeout=15_000)
            except Exception:
                pass
            time.sleep(1.5)
            result["url"] = page.url

            for el in page.query_selector_all("input, select, textarea, fps-input, fps-autocomplete"):
                try:
                    result["form_fields"].append({
                        "tag": el.evaluate("el => el.tagName.toLowerCase()"),
                        "name": el.get_attribute("name"),
                        "id": el.get_attribute("id"),
                        "visible": el.is_visible(),
                    })
                except Exception:
                    pass

            result["html_snippet"] = page.content()[:20000]

        except Exception as exc:
            result["error"] = str(exc)
        finally:
            ctx.close()
            browser.close()

    return result


# ---------------------------------------------------------------------------
# Main delivery creation
# ---------------------------------------------------------------------------

def add_delivery(
    order: DeliveryOrder,
    matched_lines: list[dict],
    cfg: Config,
    supplier_fp_id: str = "",
    on_status: Callable[[str], None] | None = None,
) -> dict:
    """Create batch + add product lines in FreshPortal Ecuador.

    Args:
        order:          Parsed DeliveryOrder (header info).
        matched_lines:  List of {fp_product_id, nu_bunches, nu_stems_bunch,
                                 mny_rate_stem, nm_variety, nu_length} dicts.
                        Lines where fp_product_id is empty are skipped.
        cfg:            Config pointing at Ecuador FreshPortal URL.
        supplier_fp_id: FreshPortal supplier option value (from supplier[] select).
        on_status:      Progress callback → receives status strings.
    """
    from scraper_fp import _launch_browser, _login

    def _s(msg: str) -> None:
        log.info(msg)
        if on_status:
            on_status(msg)

    result: dict = {"ok": False, "batch_url": "", "batch_id": "", "lines_added": 0, "message": ""}

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.route(
            "**/*",
            lambda r: r.abort() if r.request.resource_type in ("image", "font", "media") else r.continue_(),
        )
        try:
            _s("Logging into Ecuador FreshPortal…")
            _login(page, cfg)

            # ── 1. Create batch header ────────────────────────────────────────
            _s("Navigating to /batch_v2/form/add/…")
            page.goto(
                f"{cfg.freshportal_url}/batch_v2/form/add/",
                wait_until="load",
                timeout=cfg.request_timeout,
            )
            try:
                page.wait_for_selector("input[name='code'], fps-input", timeout=15_000)
            except Exception:
                _s("Warning: batch form slow to load")
            time.sleep(1.5)

            _s(f"Batch code: {order.id_invoice}")
            _fill_field(page, "code", order.id_invoice)

            _s(f"Supplier: {order.tx_company}")
            sid = supplier_fp_id or _find_supplier_id(page, order.tx_company)
            if sid:
                _select_supplier(page, sid, supplier_text=order.tx_company)
                _s(f"  → selected supplier ID: {sid}")
            else:
                _s("  ⚠ Supplier not found in select — leaving unset")

            if order.dt_invoice:
                iso = _to_iso_date(order.dt_invoice)
                _s(f"Invoice date: {iso}")
                _fill_field(page, "date", iso)

            if order.dt_fly:
                iso = _to_iso_date(order.dt_fly)
                _s(f"Delivery date: {iso}")
                _fill_field(page, "delivery_date", iso)

            if order.tx_awb:
                _fill_field(page, "airway_bill", order.tx_awb)
                _s(f"AWB: {order.tx_awb}")

            if order.id_purchaseorder:
                _fill_field(page, "order_number", order.id_purchaseorder)

            if order.tx_hawb:
                _fill_field(page, "container_number", order.tx_hawb)

            _s("Submitting batch header…")
            _submit_form(page)
            time.sleep(3)

            batch_url = page.url
            result["batch_url"] = batch_url
            _s(f"Redirected to: {batch_url}")

            # ── 2. Extract batch ID ───────────────────────────────────────────
            batch_id = _extract_batch_id(page, cfg, order.id_invoice, supplier_id=sid or supplier_fp_id)
            if not batch_id:
                raise RuntimeError(
                    f"Could not determine batch ID after submission. "
                    f"Current URL: {batch_url}"
                )
            result["batch_id"] = batch_id
            _s(f"Batch ID: {batch_id}")

            # ── 3. Add product lines ──────────────────────────────────────────
            lines_to_add = [l for l in matched_lines if l.get("fp_product_id")]
            skipped = len(matched_lines) - len(lines_to_add)
            if skipped:
                _s(f"{skipped} lines have no catalogue match — skipped")

            _s(f"Adding {len(lines_to_add)} product lines…")
            lines_added = 0
            for i, line in enumerate(lines_to_add, 1):
                _s(
                    f"  [{i}/{len(lines_to_add)}] "
                    f"{line.get('nm_variety','')} {line.get('nu_length','')}cm "
                    f"× {line.get('nu_bunches','')} bossen"
                )
                try:
                    ok = _add_stock_line(page, cfg, batch_id, line)
                    if ok:
                        lines_added += 1
                        _s(f"    ✓ added")
                    else:
                        _s(f"    ⚠ could not confirm save")
                    time.sleep(0.8)
                except Exception as exc:
                    _s(f"    ✗ failed: {exc}")

            result["ok"] = True
            result["lines_added"] = lines_added
            result["message"] = (
                f"Batch {order.id_invoice} (ID {batch_id}) created. "
                f"{lines_added}/{len(lines_to_add)} lines added"
                + (f", {skipped} unmatched skipped" if skipped else "")
            )
            _s(result["message"])

        except Exception as exc:
            result["ok"] = False
            result["message"] = str(exc)
            _s(f"Error: {exc}")
            log.exception("add_delivery failed")
        finally:
            ctx.close()
            browser.close()

    return result


# ---------------------------------------------------------------------------
# Batch ID extraction
# ---------------------------------------------------------------------------

def _extract_batch_id(page: Page, cfg: Config, invoice_code: str, supplier_id: str = "") -> str:
    """Extract batch ID after form submission.

    Strategy:
    1. Parse from redirect URL (e.g. /batch_v2/form/edit/id/12345/)
    2. Search current page table for invoice_code row
    3. Navigate to batch list (filtered by supplier) and:
       a. Search for invoice_code row
       b. If still not found, take the first row (newest batch, list is sorted BAT_ID desc)
    """
    def _id_from_row(row) -> str:
        data_id = (row.get_attribute("data-id") or "").strip()
        if data_id and data_id.isdigit():
            return data_id
        # Look for edit/detail link like /batch_v2/form/edit/id/12345/
        link = row.query_selector("a[href]")
        if link:
            href = link.get_attribute("href") or ""
            m2 = re.search(r"/(\d+)/?(?:\?|$)", href)
            if m2:
                return m2.group(1)
        # Fingerprint cell: first td that is a number
        cells = row.query_selector_all("td")
        for cell in cells:
            txt = (cell.inner_text() or "").strip()
            if txt.isdigit():
                return txt
        return ""

    # 1. From redirect URL
    for pattern in [r"/(?:id|edit|detail)/(\d+)/?", r"[?&]id=(\d+)", r"/(\d+)/?$"]:
        m = re.search(pattern, page.url)
        if m:
            return m.group(1)

    # 2. Search current page
    try:
        rows = page.query_selector_all("table tbody tr")
        for row in rows:
            if invoice_code in (row.inner_text() or ""):
                bid = _id_from_row(row)
                if bid:
                    return bid
    except Exception:
        pass

    # 3. Navigate to batch list with supplier filter
    try:
        list_url = f"{cfg.freshportal_url}/batch_v2/index/index/?1=1"
        if supplier_id:
            list_url += f"&supplier={supplier_id}"
        page.goto(list_url, wait_until="load", timeout=cfg.request_timeout)
        try:
            page.wait_for_selector("table tbody tr", timeout=10_000)
        except Exception:
            pass

        rows = page.query_selector_all("table tbody tr")
        first_row_id = ""
        for row in rows:
            bid = _id_from_row(row)
            if bid and not first_row_id:
                first_row_id = bid  # remember first (newest) row as fallback
            if invoice_code in (row.inner_text() or ""):
                if bid:
                    return bid
        # Fallback: return first row's ID (list is sorted BAT_ID desc — newest first)
        if first_row_id:
            return first_row_id
    except Exception:
        pass

    return ""


# ---------------------------------------------------------------------------
# Add one product line via /company_product_add_stock/index/index/BAT_ID/{id}/
# ---------------------------------------------------------------------------

def _add_stock_line(page: Page, cfg: Config, batch_id: str, line: dict) -> bool:
    """Add a product line to the batch via the company_product_add_stock form.

    The page at BAT_ID/{batch_id}/ shows the supplier's catalogue as a table.
    We find the row for fp_product_id and fill in quantity + price, then save.
    """
    fp_product_id = str(line.get("fp_product_id", ""))
    nu_bunches = str(line.get("nu_bunches", ""))
    mny_rate = str(line.get("mny_rate_stem", ""))

    stock_url = f"{cfg.freshportal_url}/company_product_add_stock/index/index/BAT_ID/{batch_id}/"
    page.goto(stock_url, wait_until="load", timeout=cfg.request_timeout)
    try:
        page.wait_for_selector("table tbody tr, form, fps-input", timeout=12_000)
    except Exception:
        pass
    time.sleep(1)

    # Strategy A: table rows — find row with fp_product_id and fill inline inputs
    rows = page.query_selector_all("table tbody tr")
    for row in rows:
        row_id = (
            row.get_attribute("data-id") or
            row.get_attribute("data-product-id") or
            ""
        )
        if not row_id:
            # Try finding a link with the product ID
            for a in row.query_selector_all("a[href]"):
                href = a.get_attribute("href") or ""
                if fp_product_id in href:
                    row_id = fp_product_id
                    break

        if row_id == fp_product_id or fp_product_id in (row.inner_text() or ""):
            # Fill quantity and price inputs within this row
            _fill_row_input(row, ["quantity", "nu_bunches", "aantal", "bossen"], nu_bunches)
            _fill_row_input(row, ["price", "mny_rate_stem", "prijs", "rate"], mny_rate)

            # Click save / add button in this row
            for btn_sel in [
                "fps-button[name='save'] button",
                "fps-button[name='add'] button",
                "button[type='submit']",
                "button",
            ]:
                btn = row.query_selector(btn_sel)
                if btn:
                    btn.click(force=True)
                    page.wait_for_timeout(1000)
                    return True

    # Strategy B: dedicated form for this product (fp_product_id in URL)
    add_url = (
        f"{cfg.freshportal_url}/company_product_add_stock/index/add/"
        f"BAT_ID/{batch_id}/company_product_id/{fp_product_id}/"
    )
    page.goto(add_url, wait_until="load", timeout=cfg.request_timeout)
    if "login" not in page.url.lower():
        time.sleep(1)
        _fill_field(page, "quantity", nu_bunches)
        _fill_field(page, "nu_bunches", nu_bunches)
        _fill_field(page, "price", mny_rate)
        _fill_field(page, "mny_rate_stem", mny_rate)
        _submit_form(page)
        time.sleep(1.5)
        return True

    return False


def _fill_row_input(row, names: list[str], value: str) -> bool:
    """Fill a named input inside a table row element."""
    for name in names:
        for sel in [f"input[name='{name}']", f"fps-input[name='{name}'] input"]:
            el = row.query_selector(sel)
            if el:
                try:
                    el.fill(value)
                    el.dispatch_event("change")
                    return True
                except Exception:
                    pass
    return False


# ---------------------------------------------------------------------------
# Form field helpers
# ---------------------------------------------------------------------------

def _fill_field(page: Page, name: str, value: str) -> bool:
    """Fill a named input/fps-input. Returns True if found."""
    el = page.locator(f"input[name='{name}']")
    if el.count() > 0:
        el.first.fill(value)
        el.first.dispatch_event("change")
        return True

    fps = page.locator(f"fps-input[name='{name}'], fps-datepicker[name='{name}']")
    if fps.count() > 0:
        inp = fps.first.locator("input")
        if inp.count() > 0:
            inp.fill(value)
            inp.dispatch_event("change")
            return True

    fc = page.locator(f"input[formcontrolname='{name}']")
    if fc.count() > 0:
        fc.first.fill(value)
        fc.first.dispatch_event("change")
        return True

    return False


def _find_supplier(page: Page, company_name: str) -> dict | None:
    """Return {value, text} for the best matching supplier option, or None."""
    options: list[dict] = page.evaluate("""
        () => {
            const sel = document.querySelector("select[name='supplier[]'], select[name='supplier']");
            if (!sel) return [];
            return Array.from(sel.options).map(o => ({value: o.value, text: o.text.trim()}));
        }
    """)
    if not options:
        return None
    name_lower = company_name.lower()
    for opt in options:
        if name_lower in opt["text"].lower():
            return opt
    first_word = name_lower.split()[0] if name_lower.split() else ""
    for opt in options:
        if first_word and first_word in opt["text"].lower():
            return opt
    return None


def _find_supplier_id(page: Page, company_name: str) -> str:
    """Return supplier option value for company_name (legacy helper)."""
    match = _find_supplier(page, company_name)
    return match["value"] if match else ""


def _select_supplier(page: Page, supplier_id: str, supplier_text: str = "") -> None:
    """Select supplier in a jQuery Chosen multi-select (searchable mode).

    FreshPortal uses a Chosen multi-select with a .chosen-search-input inside
    .chosen-choices.  Clicking that input opens the dropdown; typing filters
    results; clicking an .active-result selects it.
    """
    # Pick a search keyword: first word > 3 chars from supplier_text (skips "SA", "S.A." etc.)
    raw = supplier_text.strip() or supplier_id
    words = [w for w in raw.split() if len(w) > 3]
    keyword = words[0] if words else (raw.split()[0] if raw.split() else raw)

    # 1. jQuery Chosen multi-select
    chosen = page.locator(
        "#cf_element_supplier_chosen, "
        "[id$='_supplier_chosen'], "
        "[id$='supplier_chosen']"
    )
    if chosen.count() > 0:
        # Click the Chosen search input (inside .chosen-choices .search-field)
        search_inp = chosen.first.locator(".chosen-search-input, .search-field input[type='text']")
        if search_inp.count() > 0:
            search_inp.first.click()
            page.wait_for_timeout(300)
            search_inp.first.fill(keyword)
            page.wait_for_timeout(700)  # let Chosen filter the list

            # Click the first .active-result (not .result-selected / disabled)
            results = chosen.first.locator(".chosen-results li.active-result")
            if results.count() > 0:
                results.first.click()
                page.wait_for_timeout(400)
                return

    # 2. JS fallback — find option by value or by partial text match, then trigger chosen:updated
    page.evaluate("""
        ([sid, keyword]) => {
            const sel = document.querySelector("select[name='supplier[]'], select[name='supplier']");
            if (!sel) return;
            const kw = keyword.toLowerCase();
            let found = null;
            for (const opt of sel.options) {
                if (opt.value === sid) { found = opt; break; }
                if (kw && opt.text.toLowerCase().includes(kw)) { found = opt; break; }
            }
            if (found) {
                found.selected = true;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                if (window.jQuery) jQuery(sel).trigger('chosen:updated');
            }
        }
    """, [supplier_id, keyword])
    page.wait_for_timeout(300)

    # 3. fps-select fallback
    for sel_str in ["fps-select[name='supplier[]']", "fps-select[name='supplier']"]:
        el = page.locator(sel_str)
        if el.count() > 0:
            try:
                el.first.select_option(value=supplier_id)
                return
            except Exception:
                pass


def _submit_form(page: Page) -> None:
    for sel in [
        "fps-button[name='button_save'] button",
        "fps-button[name='save'] button",
        "fps-button[name='opslaan'] button",
        "button[type='submit']",
        "input[type='submit']",
    ]:
        el = page.locator(sel)
        if el.count() > 0:
            el.first.click(force=True)
            page.wait_for_timeout(2500)
            return

    for btn in page.locator("button").all():
        try:
            txt = (btn.inner_text() or "").lower()
            if any(w in txt for w in ["save", "opslaan", "bewaar", "ok", "submit", "toevoeg"]):
                btn.click(force=True)
                page.wait_for_timeout(2000)
                return
        except Exception:
            pass
