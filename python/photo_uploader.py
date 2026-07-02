"""
FreshPortal Photo Uploader
Automates uploading product photos based on a list of product names from Excel.

Usage:
    python photo_uploader.py products.xlsx --photo-dir ./photos
    python photo_uploader.py products.xlsx --photo-dir ./photos --headless
    python photo_uploader.py products.xlsx --photo-dir ./photos --dry-run
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

import pandas as pd
from playwright.sync_api import Page, TimeoutError as PWTimeoutError, sync_playwright

from config import Config
from i18n import msg as i18n_msg

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("photo_upload.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]

# Column indices detected from actual FreshPortal table structure
COL_ID    = 0   # internal row ID
COL_NAME  = 13  # data-cell-action="product_name"
COL_SHORT = 14  # data-cell-action="product_short_name"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _build_config(photo_dir: str) -> tuple[Config, Path]:
    cfg = Config()
    cfg.validate()
    photo_path = Path(photo_dir).resolve()
    if not photo_path.exists():
        raise FileNotFoundError(f"Photo directory does not exist: {photo_path}")
    return cfg, photo_path


# ---------------------------------------------------------------------------
# Excel reader
# ---------------------------------------------------------------------------

class ProductEntry:
    __slots__ = ("name", "product_id", "photo_filename")
    def __init__(self, name: str, product_id: str, photo_filename: str):
        self.name = name
        self.product_id = product_id
        self.photo_filename = photo_filename
    def __repr__(self):
        return f"ProductEntry(id={self.product_id!r}, name={self.name!r}, photo={self.photo_filename!r})"


def load_products_from_excel(excel_path: str) -> list[ProductEntry]:
    """
    Read product list from Excel.
    Columns: A = product name, B = product ID, C = photo filename
    Skips header row if column A looks like a label.
    """
    df = pd.read_excel(excel_path, header=None, usecols=[0, 1, 2], dtype=str)
    df.columns = ["name", "product_id", "photo_filename"]
    df = df.dropna(subset=["product_id"])
    df = df.fillna("")
    df = df.map(str.strip)

    # Skip header row
    if df.iloc[0]["name"].lower() in {"name", "naam", "product", "product name", "nazwa", "produkt", "a"}:
        df = df.iloc[1:]

    products = [
        ProductEntry(row["name"], row["product_id"], row["photo_filename"])
        for _, row in df.iterrows()
        if row["product_id"]
    ]
    log.info("Loaded %d products from %s", len(products), excel_path)
    return products


# ---------------------------------------------------------------------------
# Photo finder
# ---------------------------------------------------------------------------

def find_photo(photo_dir: Path, photo_filename: str) -> Path | None:
    """
    Find a photo file in *photo_dir* by *photo_filename* from column C.
    1. Exact filename match (as given)
    2. Case-insensitive match
    3. If no extension in filename, try all IMAGE_EXTENSIONS
    """
    if not photo_filename:
        return None

    # Exact match
    candidate = photo_dir / photo_filename
    if candidate.exists():
        return candidate

    # Case-insensitive match
    filename_lower = photo_filename.lower()
    for f in photo_dir.iterdir():
        if f.name.lower() == filename_lower:
            return f

    # If filename has no extension, try appending image extensions
    if not Path(photo_filename).suffix:
        for ext in IMAGE_EXTENSIONS:
            candidate = photo_dir / f"{photo_filename}{ext}"
            if candidate.exists():
                return candidate
        for f in photo_dir.iterdir():
            if f.suffix.lower() in IMAGE_EXTENSIONS and f.stem.lower() == filename_lower:
                return f

    return None


# ---------------------------------------------------------------------------
# FreshPortal: login
# ---------------------------------------------------------------------------

def _login(page: Page, cfg: Config, _retries: int = 3) -> None:
    login_url = f"{cfg.freshportal_url}/login_v2/index/index/"
    nav_timeout = max(cfg.request_timeout, 60_000)
    last_exc: Exception | None = None
    for attempt in range(1, _retries + 1):
        try:
            page.goto(login_url, wait_until="load", timeout=nav_timeout)
            page.fill("#username, input[name='USE_Username']", cfg.freshportal_username)
            page.fill("#password, input[name='USE_Password'], input[type='password']", cfg.freshportal_password)
            page.click("button:has-text('Login'), button[type='submit']")
            page.wait_for_url(lambda url: "login" not in url, timeout=nav_timeout)
            time.sleep(1)
            log.info("Logged in. URL: %s", page.url)
            return
        except Exception as exc:
            last_exc = exc
            if attempt < _retries:
                delay = attempt * 5
                log.warning("Login attempt %d/%d failed (%s) — retrying in %ds", attempt, _retries, exc, delay)
                time.sleep(delay)
            else:
                log.error("Login failed after %d attempts", _retries)
                raise last_exc


def _logout(ctx, cfg: Config) -> None:
    try:
        pg = ctx.new_page()
        pg.goto(f"{cfg.freshportal_url}/login/index/logout", wait_until="commit", timeout=8_000)
        pg.close()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# FreshPortal: detect photo column
# ---------------------------------------------------------------------------

def _detect_photo_column(page: Page) -> int:
    """
    Return the index of the photo column.
    FreshPortal header: id="table_header_product_index_index_image",
                        class contains "header_image_adjustable".
    Body cells: data-cell-action="image_adjustable".
    """
    headers = page.query_selector_all("table thead th, table thead td")
    for i, h in enumerate(headers):
        el_id  = h.get_attribute("id")    or ""
        el_cls = h.get_attribute("class") or ""
        if "image" in el_id.lower() or "image_adjustable" in el_cls:
            log.info("Photo column at index %d (header id/class)", i)
            return i
    for i, h in enumerate(headers):
        if h.inner_text().strip().lower() in {"photo", "image", "foto"}:
            log.info("Photo column at index %d (header text)", i)
            return i
    rows = page.query_selector_all("table tbody tr")
    if rows:
        for i, cell in enumerate(rows[0].query_selector_all("td")):
            if "image" in (cell.get_attribute("data-cell-action") or "").lower():
                log.info("Photo column at index %d (data-cell-action)", i)
                return i
    log.warning("Photo column not detected — defaulting to index 2")
    return 2


# ---------------------------------------------------------------------------
# FreshPortal: find product row by ID (precise, no ambiguity)
# ---------------------------------------------------------------------------

def _id_filter(cfg: Config, product_id: str) -> str:
    """fp042100 is the master — it uses 'id'. All slave portals use 'external_id'."""
    if "fp042100.freshportal.nl" in cfg.freshportal_url:
        return f"id={product_id}"
    return f"external_id={product_id}"


def find_product_row_by_id(page: Page, cfg: Config, product_id: str) -> object | None:
    """
    Navigate directly to ?1=1&id=<product_id>&page=1 (master) or
    ?1=1&external_id=<product_id>&page=1 (slave) and return the table row.
    """
    url = f"{cfg.freshportal_url}/product/index/index/?1=1&{_id_filter(cfg, product_id)}&page=1"

    for attempt in range(3):
        try:
            page.goto(url, wait_until="load", timeout=cfg.request_timeout)
            break
        except Exception as exc:
            if attempt == 2:
                log.error("  Navigation failed for id=%s after 3 attempts: %s", product_id, exc)
                return None
            time.sleep(2)

    try:
        page.wait_for_selector("table tbody tr", timeout=10_000)
    except PWTimeoutError:
        time.sleep(3)

    rows = page.query_selector_all("table tbody tr")
    if not rows:
        log.warning("  No row found for product id=%s", product_id)
        return None

    return rows[0]


# ---------------------------------------------------------------------------
# FreshPortal: upload photo
# ---------------------------------------------------------------------------

def _upload_photo_for_row(
    page: Page,
    row,
    photo_col: int,
    photo_path: Path,
    product_name: str,
) -> bool:
    try:
        # Prefer cell by data-cell-action; fall back to column index
        photo_cell = row.query_selector("td[data-cell-action='image_adjustable']")
        if not photo_cell:
            cells = row.query_selector_all("td")
            if len(cells) <= photo_col:
                log.error("  Photo column %d out of range (%d cells) for '%s'",
                          photo_col, len(cells), product_name)
                return False
            photo_cell = cells[photo_col]

        # The photo cell contains <a class="colorbox_iframe_600"> which opens an
        # iframe-based popup at /stock/image/add?type=product&PRO_ID=<id>.
        # The upload form (input[name="file"]) lives inside that iframe.
        link = photo_cell.query_selector("a.colorbox_iframe_600")
        target = link if link else photo_cell
        target.scroll_into_view_if_needed()
        time.sleep(0.3)
        target.click()

        # Wait for the colorbox iframe dialog to appear
        try:
            page.wait_for_selector("iframe#dialog_iframe", timeout=10_000)
        except PWTimeoutError:
            log.error("  Colorbox popup did not open for '%s'", product_name)
            return False

        time.sleep(1)  # let iframe content load

        # Access the iframe's content frame
        iframe_el = page.query_selector("iframe#dialog_iframe")
        frame = iframe_el.content_frame() if iframe_el else None
        if not frame:
            log.error("  Could not access iframe content for '%s'", product_name)
            return False

        # Wait for the file input inside the iframe
        try:
            frame.wait_for_selector("input[name='file']", timeout=8_000)
        except PWTimeoutError:
            log.error("  input[name='file'] not found in iframe for '%s'", product_name)
            return False

        file_input = frame.query_selector("input[name='file']")
        if not file_input:
            log.error("  input[name='file'] vanished from iframe for '%s'", product_name)
            return False

        file_input.set_input_files(str(photo_path))
        log.info("  File set in iframe for: %s", photo_path.name)
        time.sleep(0.5)

        # Click Upload button inside the iframe
        return _click_upload_button_in_frame(frame, product_name)

    except Exception as exc:
        log.error("  Upload error for '%s': %s", product_name, exc)
        return False


def _click_upload_button(page: Page, product_name: str) -> bool:
    """Click the Upload/Save button on the main page. Returns True on success."""
    for sel in ["button[type='submit']", "input[type='submit']",
                "button:has-text('Upload')", "button:has-text('Save')",
                "button:has-text('Opslaan')", ".btn-primary"]:
        btn = page.query_selector(sel)
        if btn and btn.is_visible():
            btn.click()
            try:
                page.wait_for_load_state("networkidle", timeout=10_000)
            except PWTimeoutError:
                time.sleep(2)
            return True
    log.warning("  Upload button not found on page for '%s'", product_name)
    return False


def _click_upload_button_in_frame(frame, product_name: str) -> bool:
    """Click the Upload/Save button inside the iframe. Returns True on success."""
    for sel in [
        "button[type='submit']",
        "input[type='submit']",
        "button:has-text('Upload')",
        "button:has-text('Save')",
        "button:has-text('Opslaan')",
        ".btn-primary",
        "button",           # last resort: any button
    ]:
        try:
            btn = frame.query_selector(sel)
        except Exception:
            continue
        if btn and btn.is_visible():
            btn.click()
            log.debug("  Clicked iframe upload button: %s", sel)
            time.sleep(2)
            return True
    log.warning("  Upload button not found in iframe for '%s'", product_name)
    return False


def _close_modal_if_open(page: Page) -> None:
    """Try to dismiss any open modal. Silently ignores navigation/context errors."""
    for sel in ["button:has-text('Close')", "button:has-text('Cancel')",
                ".modal-close", "[aria-label='Close']", ".close"]:
        try:
            btn = page.query_selector(sel)
            if btn:
                btn.click()
                return
        except Exception:
            return  # page navigated — modal already gone


# ---------------------------------------------------------------------------
# Session health helpers
# ---------------------------------------------------------------------------

def _is_logged_out(page: Page) -> bool:
    """True when FreshPortal has redirected us to the login page."""
    return "login" in page.url.lower()


def _relogin_and_reset(page: Page, cfg: Config, on_evt=None, lang: str = "en") -> int:
    """Clear cookies, re-login, re-detect photo column. Returns new photo_col."""
    status_msg = i18n_msg(lang, "photo_session_expired")
    log.warning(status_msg)
    if on_evt:
        on_evt({"type": "status", "message": status_msg})
    page.context.clear_cookies()
    _login(page, cfg)
    page.goto(
        f"{cfg.freshportal_url}/product/index/index/?1=1",
        wait_until="load",
        timeout=cfg.request_timeout,
    )
    try:
        page.wait_for_selector("table tbody tr", timeout=10_000)
    except Exception:
        time.sleep(3)
    return _detect_photo_column(page)


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------

def run(
    excel_path: str,
    photo_dir: str,
    headless: bool = False,
    dry_run: bool = False,
    start_from: int = 1,
) -> None:
    cfg, photos_root = _build_config(photo_dir)
    products = load_products_from_excel(excel_path)
    if not products:
        log.error("No products found in Excel. Aborting.")
        return

    stats = {"success": 0, "no_photo": 0, "not_found": 0, "error": 0, "skipped": 0}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless, args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-translate",
            "--metrics-recording-only",
            "--mute-audio",
        ])
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(cfg.request_timeout)

        try:
            _login(page, cfg)

            # Detect photo column once from the products listing page
            page.goto(
                f"{cfg.freshportal_url}/product/index/index/?1=1",
                wait_until="load",
                timeout=cfg.request_timeout,
            )
            try:
                page.wait_for_selector("table tbody tr", timeout=10_000)
            except PWTimeoutError:
                time.sleep(3)
            photo_col = _detect_photo_column(page)

            if start_from > 1:
                log.info("Resuming from product #%d", start_from)

            # --- Process each product ---
            for idx, entry in enumerate(products, 1):
                if idx < start_from:
                    continue
                log.info("[%d/%d] id=%-8s  %s", idx, len(products), entry.product_id, entry.name)

                photo_path = find_photo(photos_root, entry.photo_filename)
                if not photo_path:
                    log.warning("  No photo on disk: %s", entry.photo_filename)
                    stats["no_photo"] += 1
                    continue

                log.info("  Photo: %s", photo_path.name)

                if dry_run:
                    log.info("  [DRY RUN] Would upload %s", photo_path.name)
                    stats["skipped"] += 1
                    continue

                row = find_product_row_by_id(page, cfg, entry.product_id)
                if not row:
                    log.warning("  Not found in FreshPortal: id=%s", entry.product_id)
                    stats["not_found"] += 1
                    continue

                success = _upload_photo_for_row(page, row, photo_col, photo_path, entry.name)
                if success:
                    log.info("  OK — uploaded")
                    stats["success"] += 1
                else:
                    stats["error"] += 1

                _close_modal_if_open(page)
                time.sleep(1.5)  # let colorbox fully close before next navigation

        finally:
            _logout(context, cfg)
            context.close()
            browser.close()

    log.info("")
    log.info("=" * 55)
    log.info("UPLOAD SUMMARY (%d products)", len(products))
    log.info("  Uploaded successfully : %d", stats["success"])
    log.info("  Photo not on disk     : %d", stats["no_photo"])
    log.info("  Product not in portal : %d", stats["not_found"])
    log.info("  Upload errors         : %d", stats["error"])
    if dry_run:
        log.info("  Dry-run skipped       : %d", stats["skipped"])
    log.info("=" * 55)
    log.info("Log saved to: photo_upload.log")


# ---------------------------------------------------------------------------
# run_from_list — upload from a confirmed session list (API use)
# ---------------------------------------------------------------------------

def run_from_list(
    session_dir: str,
    confirmed_items: list[dict],
    on_progress=None,
    lang: str = "en",
) -> list[dict]:
    """Upload photos from a temp session directory to FreshPortal.

    confirmed_items: [{filename, product_id, product_name}]
    on_progress:     optional callable(event_dict) for SSE streaming.
    Returns:         [{filename, product_id, product_name, status, message}]
    """
    cfg = Config()
    photos_root = Path(session_dir)
    total = len(confirmed_items)
    upload_results: list[dict] = []

    def _evt(d: dict) -> None:
        if on_progress:
            on_progress(d)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=[
            "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
            "--disable-extensions", "--disable-background-networking",
            "--disable-sync", "--disable-translate",
            "--metrics-recording-only", "--mute-audio",
        ])
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(cfg.request_timeout)

        try:
            _evt({"type": "status", "message": i18n_msg(lang, "photo_logging_in")})
            _login(page, cfg)

            page.goto(
                f"{cfg.freshportal_url}/product/index/index/?1=1",
                wait_until="load",
                timeout=cfg.request_timeout,
            )
            try:
                page.wait_for_selector("table tbody tr", timeout=10_000)
            except Exception:
                time.sleep(3)
            photo_col = _detect_photo_column(page)

            for idx, item in enumerate(confirmed_items, 1):
                filename = item["filename"]
                product_id = item["product_id"]
                product_name = item["product_name"]

                _evt({"type": "status", "message": i18n_msg(lang, "photo_uploading", idx=idx, total=total, name=product_name)})

                photo_path = photos_root / filename
                if not photo_path.exists():
                    result = {
                        "filename": filename, "product_id": product_id,
                        "product_name": product_name, "status": "error",
                        "message": i18n_msg(lang, "photo_file_missing"),
                    }
                    upload_results.append(result)
                    _evt({"type": "item", **result})
                    continue

                row = find_product_row_by_id(page, cfg, product_id)
                if not row:
                    # Session may have expired (FreshPortal redirects to /login).
                    # Clear cookies, re-login, then retry once by product_id.
                    if _is_logged_out(page):
                        photo_col = _relogin_and_reset(page, cfg, _evt, lang=lang)
                        row = find_product_row_by_id(page, cfg, product_id)
                    if not row:
                        result = {
                            "filename": filename, "product_id": product_id,
                            "product_name": product_name, "status": "error",
                            "message": i18n_msg(lang, "photo_not_found"),
                        }
                        upload_results.append(result)
                        _evt({"type": "item", **result})
                        continue

                ok = _upload_photo_for_row(page, row, photo_col, photo_path, product_name)
                result = {
                    "filename": filename, "product_id": product_id,
                    "product_name": product_name,
                    "status": "ok" if ok else "error",
                    "message": "" if ok else i18n_msg(lang, "photo_upload_failed"),
                }
                upload_results.append(result)
                _evt({"type": "item", **result})

                _close_modal_if_open(page)
                time.sleep(1.5)

        finally:
            _logout(context, cfg)
            context.close()
            browser.close()

    ok_count = sum(1 for r in upload_results if r["status"] == "ok")
    _evt({
        "type": "result",
        "data": {
            "results": upload_results,
            "ok": ok_count,
            "error": len(upload_results) - ok_count,
            "total": len(upload_results),
        },
    })
    return upload_results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload product photos to FreshPortal")
    parser.add_argument("excel", help="Excel file with product names in column A")
    parser.add_argument(
        "--photo-dir",
        default=os.getenv("PHOTO_DIR", "./photos"),
        help="Directory containing photos (default: PHOTO_DIR from .env or ./photos)",
    )
    parser.add_argument("--headless", action="store_true", help="Run browser headless")
    parser.add_argument("--dry-run", action="store_true", help="Find photos, skip upload")
    parser.add_argument("--start-from", type=int, default=1, metavar="N",
                        help="Resume from product number N (1-based, skips N-1 products)")
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    run(
        excel_path=args.excel,
        photo_dir=args.photo_dir,
        headless=args.headless,
        dry_run=args.dry_run,
        start_from=args.start_from,
    )
