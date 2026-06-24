"""FreshPortal Ecuador delivery import.

Flow A — batch header only (HTTP, fast, reliable):
  1. Login via Playwright → extract session cookies
  2. POST cookies + form data to /batch_v2/form/add/ via httpx (no UI)
  3. Parse redirect or batch list HTML to extract BAT_ID

Flow B — product lines (Playwright, interactive):
  Coming once we know the correct POST format for company_product_add_stock.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Callable

import httpx
from bs4 import BeautifulSoup
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
# HTTP-based session helpers (fast, no UI)
# ---------------------------------------------------------------------------

def _get_session_cookies(cfg: Config) -> dict[str, str]:
    """Login to FreshPortal via Playwright and return session cookies dict."""
    from scraper_fp import _launch_browser, _login
    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        try:
            _login(page, cfg)
            return {c["name"]: c["value"] for c in ctx.cookies()}
        finally:
            ctx.close()
            browser.close()


def _fp_http_client(cfg: Config, cookies: dict[str, str]) -> httpx.Client:
    return httpx.Client(
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": cfg.freshportal_url,
            "Referer": f"{cfg.freshportal_url}/batch_v2/form/add/",
            "User-Agent": "Mozilla/5.0 (compatible; FPImport/1.0)",
        },
        cookies=cookies,
        follow_redirects=True,
        timeout=30,
    )


def _batch_id_from_url(url: str) -> str:
    """Try to extract numeric batch ID from a URL."""
    for pat in [r"/(?:id|edit|detail)/(\d+)/?", r"[?&]id=(\d+)"]:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return ""


def _batch_id_from_html(html: str, invoice_code: str) -> str:
    """Parse batch list HTML and return first matching (or first overall) BAT_ID."""
    soup = BeautifulSoup(html, "lxml")
    rows = soup.select("table tbody tr")

    def _row_id(row) -> str:
        did = row.get("data-id", "")
        if did and str(did).isdigit():
            return str(did)
        for a in row.select("a[href]"):
            m = re.search(r"/(\d+)/?", a.get("href", ""))
            if m:
                return m.group(1)
        # Fingerprint column — first numeric-only cell
        for td in row.select("td"):
            txt = td.get_text(strip=True)
            if txt.isdigit():
                return txt
        return ""

    first_id = ""
    for row in rows:
        rid = _row_id(row)
        if not first_id and rid:
            first_id = rid
        if invoice_code and invoice_code in row.get_text():
            if rid:
                return rid
    return first_id


def create_batch_header(
    order: DeliveryOrder,
    cfg: Config,
    supplier_fp_id: str = "",
    on_status: Callable[[str], None] | None = None,
) -> dict:
    """Create a FreshPortal batch header via Playwright with network request capture.

    Fills the form, intercepts the actual outgoing POST request (captures URL +
    body so we can see what FreshPortal really expects), then submits and extracts
    the batch ID from redirect or batch list.

    Returns {"ok": bool, "batch_id": str, "batch_url": str, "message": str,
             "captured_post": {url, body}}
    """
    from scraper_fp import _launch_browser, _login

    def _s(msg: str) -> None:
        log.info(msg)
        if on_status:
            on_status(msg)

    result: dict = {
        "ok": False, "batch_id": "", "batch_url": "", "message": "",
        "captured_post": None,
    }

    captured_post: dict = {}

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.route(
            "**/*",
            lambda r: r.abort() if r.request.resource_type in ("image", "font", "media") else r.continue_(),
        )

        # Capture ALL POST requests so we can see the actual form submission URL + body
        def _on_request(req):
            if req.method.upper() == "POST":
                body = ""
                try:
                    body = req.post_data or ""
                except Exception:
                    pass
                captured_post["url"] = req.url
                captured_post["body"] = body
                _s(f"[NET] POST → {req.url}")
                if body:
                    _s(f"[NET] body: {body[:400]}")

        page.on("request", _on_request)

        try:
            _s("Logging in to FreshPortal…")
            _login(page, cfg)

            _s("Loading /batch_v2/form/add/…")
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

            # Fill batch code
            _s(f"Setting code = {order.id_invoice}")
            _fill_field(page, "code", order.id_invoice)

            # Set supplier via JS directly on the native select (reliable, no Chosen UI)
            if supplier_fp_id:
                set_ok = page.evaluate("""
                    (sid) => {
                        const sel = document.querySelector(
                            "select[name='supplier[]'], select[name='supplier']");
                        if (!sel) return "select not found";
                        let found = false;
                        for (const opt of sel.options) {
                            opt.selected = opt.value === sid;
                            if (opt.value === sid) found = true;
                        }
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        if (window.jQuery) jQuery(sel).trigger('chosen:updated');
                        const chosen = document.querySelector(
                            '#cf_element_supplier_chosen .chosen-single span, '
                            + '#cf_element_supplier_chosen .search-choice span');
                        return found
                            ? "set: " + (chosen ? chosen.textContent : "ok")
                            : "value " + sid + " not found in options";
                    }
                """, supplier_fp_id)
                _s(f"Supplier JS set → {set_ok}")
            else:
                _s("⚠ No supplier_fp_id provided — supplier field left empty")

            # Fill dates
            if order.dt_invoice:
                iso = _to_iso_date(order.dt_invoice)
                _fill_field(page, "date", iso)
                _s(f"date = {iso}")
            if order.dt_fly:
                iso = _to_iso_date(order.dt_fly)
                _fill_field(page, "delivery_date", iso)
                _s(f"delivery_date = {iso}")
            if order.tx_awb:
                _fill_field(page, "airway_bill", order.tx_awb)
            if order.id_purchaseorder:
                _fill_field(page, "order_number", order.id_purchaseorder)
            if order.tx_hawb:
                _fill_field(page, "container_number", order.tx_hawb)

            _s("Submitting batch form…")
            _submit_form(page)
            time.sleep(3)

            batch_url = page.url
            result["batch_url"] = batch_url
            result["captured_post"] = captured_post
            _s(f"After submit → {batch_url}")

            batch_id = _extract_batch_id(page, cfg, order.id_invoice, supplier_id=supplier_fp_id)
            if batch_id:
                result["ok"] = True
                result["batch_id"] = batch_id
                result["message"] = f"Batch {order.id_invoice} created (ID: {batch_id})"
            else:
                result["message"] = (
                    f"Form submitted but batch ID not found. "
                    f"Current URL: {batch_url}. "
                    f"Captured POST: {captured_post.get('url', 'none')}"
                )
            _s(result["message"])

        except Exception as exc:
            result["message"] = str(exc)
            result["captured_post"] = captured_post
            _s(f"Error: {exc}")
            log.exception("create_batch_header failed")
        finally:
            ctx.close()
            browser.close()

    return result


# ---------------------------------------------------------------------------
# Main delivery creation (Playwright — kept for backward compat / product adding)
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


# ---------------------------------------------------------------------------
# Add products to existing batch
# ---------------------------------------------------------------------------

_JS_FIND_ROW = """
    ([catName, nuLength, nuSpb]) => {
        const rows = document.querySelectorAll("table tbody tr");
        const cat = catName.toLowerCase();
        const lenStr = String(nuLength);
        const spbStr = String(nuSpb);
        let best = -1, bestScore = -1;

        for (let i = 0; i < rows.length; i++) {
            const cells = Array.from(rows[i].querySelectorAll("td"));
            const texts = cells.map(c => c.textContent.trim());
            const rowText = texts.join(" ").toLowerCase();

            // Every word of the catalogue name must appear in the row
            const catWords = cat.split(" ").filter(w => w.length > 2);
            if (!catWords.every(w => rowText.includes(w))) continue;

            let score = 1.0;

            // Length must match exactly (skip row if wrong length)
            if (nuLength > 0) {
                const lenMatch = texts.some(t =>
                    t === lenStr || t === lenStr + "cm" || t === lenStr + " cm"
                );
                if (!lenMatch) continue;
                score += 2;
            }

            // SPB is a bonus
            if (nuSpb > 0 && texts.some(t => t === spbStr)) score += 1;

            if (score > bestScore) { bestScore = score; best = i; }
        }
        return best;
    }
"""

_BUNCH_NAMES = ["nu_bunches", "quantity", "aantal", "bundels", "number_of_bunches", "bunches"]
_PRICE_NAMES = ["mny_rate_stem", "price", "rate", "prijs", "rate_stem", "mny_rate"]


def _fill_any(container, names: list[str], value: str) -> str:
    """Fill first matching named input inside container. Returns name used or ''."""
    for name in names:
        for sel in [
            f"input[name='{name}']",
            f"fps-input[name='{name}'] input",
            f"input[formcontrolname='{name}']",
        ]:
            inp = container.locator(sel)
            if inp.count() > 0:
                try:
                    inp.first.fill(value)
                    inp.first.dispatch_event("change")
                    return name
                except Exception:
                    pass
    return ""


def _save_in(container, page: Page) -> bool:
    """Click a save/submit button inside container."""
    for sel in [
        "fps-button[name='button_save'] button",
        "fps-button[name='save'] button",
        "button[type='submit']",
        "input[type='submit']",
    ]:
        btn = container.locator(sel)
        if btn.count() > 0:
            try:
                btn.first.click(force=True)
                page.wait_for_timeout(2000)
                return True
            except Exception:
                pass
    for text in ["Save", "Opslaan", "Bewaar", "Toevoeg", "Add", "OK"]:
        btn = container.locator(f"button:has-text('{text}')")
        if btn.count() > 0:
            try:
                btn.first.click(force=True)
                page.wait_for_timeout(2000)
                return True
            except Exception:
                pass
    return False


def _add_one_product(
    page: Page,
    cfg: Config,
    batch_id: str,
    stock_url: str,
    fp_product_id: str,
    catalogue_nm: str,
    nu_length: int,
    nu_stems_bunch: int,
    nu_bunches: str,
    mny_rate: str,
    on_status: Callable[[str], None],
) -> bool:
    """Add one product line. Returns True on success."""

    # Ensure we are on the stock page
    if not page.url.rstrip("/").endswith(batch_id):
        page.goto(stock_url, wait_until="load", timeout=cfg.request_timeout)
        try:
            page.wait_for_selector("table tbody tr", timeout=12_000)
        except Exception:
            pass
        time.sleep(1)

    # ── Find the correct table row ────────────────────────────────────────
    row_idx: int = page.evaluate(_JS_FIND_ROW, [catalogue_nm, nu_length, nu_stems_bunch])

    if row_idx is None or row_idx < 0:
        on_status(f"  Row not found: '{catalogue_nm}' {nu_length}cm ×{nu_stems_bunch}spb")
        return _try_direct_add(page, cfg, batch_id, fp_product_id, nu_bunches, mny_rate, on_status)

    on_status(f"  Found at row {row_idx}")

    # Click the row (may open sidebar / inline form)
    page.evaluate(f"() => document.querySelectorAll('table tbody tr')[{row_idx}].click()")
    time.sleep(1.5)

    # ── Try: sidebar / slide panel ────────────────────────────────────────
    for sidebar_sel in [
        ".sidebar", "#sidebar", ".side-form", "#crud-sidebar", ".crud-sidebar",
        ".ui-dialog", ".modal-body", "[class*='sidebar']", "[id*='sidebar']",
        ".right-panel", "[class*='slide-panel']",
    ]:
        container = page.locator(sidebar_sel).first
        try:
            if container.count() > 0 and container.is_visible():
                on_status(f"  Panel: {sidebar_sel}")
                bname = _fill_any(container, _BUNCH_NAMES, nu_bunches)
                pname = _fill_any(container, _PRICE_NAMES, mny_rate)
                on_status(f"  Filled: bunches={bname or '?'}={nu_bunches}, price={pname or '?'}={mny_rate}")
                if _save_in(container, page):
                    time.sleep(1.5)
                    return True
        except Exception:
            pass

    # ── Try: inline inputs inside the row ────────────────────────────────
    row_loc = page.locator("table tbody tr").nth(row_idx)
    visible_inputs = row_loc.locator("input:visible")
    if visible_inputs.count() > 0:
        on_status("  Inline row inputs")
        bname = _fill_any(row_loc, _BUNCH_NAMES, nu_bunches)
        pname = _fill_any(row_loc, _PRICE_NAMES, mny_rate)
        if not bname:  # fallback: fill first input
            try:
                visible_inputs.first.fill(nu_bunches)
                visible_inputs.first.dispatch_event("change")
            except Exception:
                pass
        on_status(f"  Filled: bunches={bname or 'first'}={nu_bunches}, price={pname or '?'}={mny_rate}")
        if _save_in(row_loc, page) or _save_in(page.locator("body"), page):
            time.sleep(1.5)
            return True

    on_status("  No form found after row click — trying direct URL")
    return _try_direct_add(page, cfg, batch_id, fp_product_id, nu_bunches, mny_rate, on_status)


def _try_direct_add(
    page: Page,
    cfg: Config,
    batch_id: str,
    fp_product_id: str,
    nu_bunches: str,
    mny_rate: str,
    on_status: Callable[[str], None],
) -> bool:
    """Fallback: navigate to add-stock URL with fp_product_id."""
    url = (
        f"{cfg.freshportal_url}/company_product_add_stock/index/add/"
        f"BAT_ID/{batch_id}/company_product_id/{fp_product_id}/"
    )
    on_status(f"  Direct URL: {url}")
    page.goto(url, wait_until="load", timeout=cfg.request_timeout)
    time.sleep(1)
    if "login" in page.url.lower():
        return False
    body = page.locator("body")
    bname = _fill_any(body, _BUNCH_NAMES, nu_bunches)
    pname = _fill_any(body, _PRICE_NAMES, mny_rate)
    on_status(f"  Filled: bunches={bname or '?'}={nu_bunches}, price={pname or '?'}={mny_rate}")
    _submit_form(page)
    time.sleep(2)
    return True


def add_products_to_batch(
    batch_id: str,
    matched_lines: list[dict],
    cfg: Config,
    on_status: Callable[[str], None] | None = None,
) -> dict:
    """Add matched product lines to an existing FreshPortal batch via Playwright.

    Navigates to /company_product_add_stock/index/index/BAT_ID/{batch_id}/,
    finds each product row by catalogue name + length + stems-per-bunch,
    clicks the row (opens sidebar), fills quantity + price, saves.
    Intercepts network requests to log the actual POST URL/body.

    Returns {"ok", "lines_added", "lines_skipped", "lines_failed", "message", "details"}
    """
    from scraper_fp import _launch_browser, _login

    def _s(msg: str) -> None:
        log.info(msg)
        if on_status:
            on_status(msg)

    result: dict = {
        "ok": False,
        "lines_added": 0,
        "lines_skipped": 0,
        "lines_failed": 0,
        "message": "",
        "details": [],
    }

    lines_to_add = [l for l in matched_lines if l.get("fp_product_id")]
    result["lines_skipped"] = len(matched_lines) - len(lines_to_add)

    if not lines_to_add:
        result["message"] = (
            f"No matched lines to add — {result['lines_skipped']} unmatched"
        )
        return result

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.route(
            "**/*",
            lambda r: r.abort()
            if r.request.resource_type in ("image", "font", "media")
            else r.continue_(),
        )

        def _on_request(req):
            if req.method.upper() in ("POST", "PUT", "PATCH"):
                body = ""
                try:
                    body = req.post_data or ""
                except Exception:
                    pass
                _s(f"[NET] {req.method} → {req.url}")
                if body:
                    _s(f"[NET] body: {body[:300]}")

        page.on("request", _on_request)

        try:
            _s("Logging in…")
            _login(page, cfg)

            stock_url = (
                f"{cfg.freshportal_url}"
                f"/company_product_add_stock/index/index/BAT_ID/{batch_id}/"
            )
            _s(f"Loading stock page for batch {batch_id}…")
            page.goto(stock_url, wait_until="load", timeout=cfg.request_timeout)
            try:
                page.wait_for_selector("table tbody tr", timeout=15_000)
            except Exception:
                _s("Warning: table rows not found — page may still be loading")
            time.sleep(1.5)

            row_count = page.locator("table tbody tr").count()
            _s(f"Table has {row_count} rows")

            lines_added = 0
            lines_failed = 0
            details: list[dict] = []

            for i, line in enumerate(lines_to_add, 1):
                catalogue_nm = line.get("catalogue_nm_product") or line.get("nm_variety", "")
                nu_length = int(line.get("nu_length") or 0)
                nu_stems_bunch = int(line.get("nu_stems_bunch") or 0)
                nu_bunches = str(int(line.get("nu_bunches") or 0))
                mny_rate = str(line.get("mny_rate_stem", ""))
                fp_product_id = str(line.get("fp_product_id", ""))

                _s(
                    f"\n[{i}/{len(lines_to_add)}] {catalogue_nm} {nu_length}cm "
                    f"×{nu_stems_bunch}spb → {nu_bunches} bunches @ {mny_rate}"
                )

                try:
                    ok = _add_one_product(
                        page, cfg, batch_id, stock_url,
                        fp_product_id, catalogue_nm, nu_length, nu_stems_bunch,
                        nu_bunches, mny_rate, _s,
                    )
                except Exception as exc:
                    _s(f"  Exception: {exc}")
                    ok = False

                if ok:
                    lines_added += 1
                    _s("  ✓ added")
                    details.append({"product": catalogue_nm, "status": "added"})
                else:
                    lines_failed += 1
                    _s("  ✗ failed")
                    details.append({"product": catalogue_nm, "status": "failed"})

                time.sleep(0.3)

            result["ok"] = lines_added > 0
            result["lines_added"] = lines_added
            result["lines_failed"] = lines_failed
            result["details"] = details
            skipped = result["lines_skipped"]
            result["message"] = (
                f"{lines_added}/{len(lines_to_add)} lines added to batch {batch_id}"
                + (f", {skipped} unmatched skipped" if skipped else "")
                + (f", {lines_failed} failed" if lines_failed else "")
            )
            _s(result["message"])

        except Exception as exc:
            result["message"] = str(exc)
            log.exception("add_products_to_batch failed")
        finally:
            ctx.close()
            browser.close()

    return result
