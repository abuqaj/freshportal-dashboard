"""Box-weight correction for the Kenya system (850254).

Goal: an invoice's per-box weight in FreshPortal is an estimate, but the
air waybill carries the weight actually shipped. This module divides that
real weight by the number of boxes on the invoice and writes the result
back onto every line, so the invoice reflects what was really flown.

Pipeline, in the order it runs:
  1. BI Sync export (Kenya key/host) for the last 14 days -> open invoices
     (printed = 0) for the configured customers.
  2. customer_stock_item -> the invoice's first line -> stock_entry ->
     supplier_id must not be 200 or 72. An invoice carries exactly one
     supplier (confirmed by the user 2026-09-09), so any one line settles
     it and "first" is a representative sample, not an arbitrary pick.
  3. Playwright on the portal: read the air waybill total weight and the
     invoice's total box count, divide, write to each line's box_weight.

customer_stock_item columns were confirmed against a real Kenya export on
2026-09-09: id, invoice_id, collective_invoice_id, main_invoice_id,
stock_entry_id, description, customer_id, origin, quantity,
quantity_per_pack, buy_price, buy_price_plus, price, fust_id, user_id,
buyer_id, mutation_date_time, creation_date_time.

`quantity` on those lines is a BOX count, not stems — a sample line reads
quantity=2 with quantity_per_pack=532, i.e. two boxes of 532 stems. That
gives a second, independent box count for an invoice (sum of `quantity`)
which is cross-checked against the number scraped off the portal before
anything is written: the two disagreeing means one of them is being read
wrong, and writing a weight derived from a misread box count would put a
plausible-looking wrong number on every line of a real invoice.
"""
from __future__ import annotations

import logging
import re
from datetime import date, timedelta

from bi_sync_client import (
    get_export_url, download_export_zip, read_table,
    find_table_files, list_export_files,
)
from config import Config

logger = logging.getLogger(__name__)

# Tables this module needs, and the ones debug_pull() reports on.
_TABLES = ("invoice", "customer_stock_item", "stock_entry")

# Suppliers whose invoices must never be touched (user, 2026-09-09).
EXCLUDED_SUPPLIER_IDS = {"200", "72"}

# How far back to pull. The export is a "since" cursor, so this is both the
# API anchor and the window we care about.
LOOKBACK_DAYS = 14


def _sample(rows: list[dict], n: int = 2) -> list[dict]:
    return rows[:n]


def debug_pull(cfg: Config, lookback_days: int = LOOKBACK_DAYS) -> dict:
    """One Kenya export pull, reported rather than ingested.

    Answers the questions the rest of this module is blocked on: which
    files the export actually contains, what columns invoice /
    customer_stock_item / stock_entry really have, and which customer_ids
    currently have open invoices. Nothing is written anywhere.
    """
    if not cfg.bi_sync_api_key:
        raise RuntimeError(
            "No Kenya BI Sync key configured — set KENYA_BI_SYNC_API_KEY "
            "(and KENYA_BI_SYNC_API_BASE_URL if the host differs from the default)"
        )

    anchor = (date.today() - timedelta(days=lookback_days)).isoformat()
    logger.info("[kenya-box-weight] requesting export since %s from %s",
                anchor, cfg.bi_sync_api_base_url)
    zip_bytes = download_export_zip(get_export_url(cfg, anchor))

    contents = [{"file": name, "bytes": size} for name, size in list_export_files(zip_bytes)]

    tables: dict[str, dict] = {}
    for table in _TABLES:
        files = find_table_files(zip_bytes, table)
        rows = read_table(zip_bytes, table) if files else []
        tables[table] = {
            "files": files,
            "row_count": len(rows),
            "columns": sorted(rows[0].keys()) if rows else [],
            "sample": _sample(rows),
        }

    # Which customers actually have open invoices right now — the list the
    # admin picker will be choosing from.
    invoices = read_table(zip_bytes, "invoice")
    open_by_customer: dict[str, int] = {}
    printed_values: dict[str, int] = {}
    for inv in invoices:
        printed = str(inv.get("printed", "")).strip()
        printed_values[printed] = printed_values.get(printed, 0) + 1
        if printed == "0":
            cid = str(inv.get("customer_id", "")).strip()
            open_by_customer[cid] = open_by_customer.get(cid, 0) + 1

    return {
        "anchor": anchor,
        "base_url": cfg.bi_sync_api_base_url,
        "portal_url": cfg.freshportal_url,
        "export_files": contents,
        "tables": tables,
        # Distinct values seen in `printed`, so "0 means open" can be
        # confirmed rather than assumed.
        "printed_value_counts": printed_values,
        "open_invoices_by_customer": dict(
            sorted(open_by_customer.items(), key=lambda kv: kv[1], reverse=True)
        ),
    }


def _num(value) -> float | None:
    """Export numerics arrive as strings and occasionally with a decimal
    comma. Returns None rather than 0 for unparseable input — 0 is a
    meaningful weight here ("nothing recorded yet") and must not be
    manufactured out of a parse failure."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text.replace(",", "."))
    except ValueError:
        return None


def select_candidates(cfg: Config, customer_ids: set[str], lookback_days: int = LOOKBACK_DAYS) -> dict:
    """Open invoices for the given customers that are safe to correct.

    An invoice qualifies when it is unprinted (open), belongs to one of the
    configured customers, and its supplier is not in EXCLUDED_SUPPLIER_IDS.
    An invoice carries exactly one supplier (user, 2026-09-09), so the
    supplier of its lowest-id line settles the whole invoice — "first line"
    is a representative sample, not an arbitrary pick. Lowest id rather than
    file order because CSV row order is not a guaranteed property of the
    export.
    """
    if not customer_ids:
        return {"candidates": [], "skipped": [], "anchor": None,
                "detail": "No customers enabled for this module"}

    anchor = (date.today() - timedelta(days=lookback_days)).isoformat()
    zip_bytes = download_export_zip(get_export_url(cfg, anchor))

    invoices = read_table(zip_bytes, "invoice")
    items = read_table(zip_bytes, "customer_stock_item")
    entries = read_table(zip_bytes, "stock_entry")
    supplier_by_entry = {
        str(e.get("id", "")).strip(): str(e.get("supplier_id", "")).strip()
        for e in entries if e.get("id")
    }

    lines_by_invoice: dict[str, list[dict]] = {}
    for item in items:
        inv = str(item.get("invoice_id", "")).strip()
        if inv:
            lines_by_invoice.setdefault(inv, []).append(item)

    candidates, skipped = [], []
    for inv in invoices:
        invoice_id = str(inv.get("id", "")).strip()
        if not invoice_id:
            continue
        if str(inv.get("printed", "")).strip() != "0":
            continue
        if str(inv.get("customer_id", "")).strip() not in customer_ids:
            continue

        lines = lines_by_invoice.get(invoice_id, [])
        if not lines:
            skipped.append({"invoice_id": invoice_id, "reason": "no customer_stock_item lines in this export"})
            continue

        def line_sort_key(line: dict) -> tuple[int, str]:
            raw = str(line.get("id", "")).strip()
            return (int(raw), raw) if raw.isdigit() else (10**18, raw)

        first = min(lines, key=line_sort_key)
        supplier_id = supplier_by_entry.get(str(first.get("stock_entry_id", "")).strip(), "")
        if not supplier_id:
            skipped.append({"invoice_id": invoice_id,
                            "reason": f"stock_entry {first.get('stock_entry_id')} not in this export"})
            continue
        if supplier_id in EXCLUDED_SUPPLIER_IDS:
            skipped.append({"invoice_id": invoice_id, "reason": f"excluded supplier {supplier_id}"})
            continue

        # Independent box count, cross-checked against the portal later.
        box_counts = [_num(l.get("quantity")) for l in lines]
        api_boxes = sum(b for b in box_counts if b is not None) or None

        candidates.append({
            "invoice_id": invoice_id,
            # What a human calls this invoice. invoice_id stays the key for
            # dedup and retries; sequence is what gets shown.
            "sequence": str(inv.get("sequence", "")).strip(),
            "customer_id": str(inv.get("customer_id", "")).strip(),
            "supplier_id": supplier_id,
            "line_count": len(lines),
            "api_box_count": api_boxes,
            "invoice_number": str(inv.get("invoice_number", "")).strip(),
        })

    candidates.sort(key=lambda c: int(c["invoice_id"]) if c["invoice_id"].isdigit() else 0)
    return {"anchor": anchor, "candidates": candidates, "skipped": skipped, "detail": ""}


def open_invoice_customers(cfg: Config, lookback_days: int = LOOKBACK_DAYS) -> list[dict]:
    """customer_id -> open invoice count, for the admin picker. Unfiltered by
    the enabled list on purpose: the picker has to be able to offer customers
    that are not selected yet."""
    anchor = (date.today() - timedelta(days=lookback_days)).isoformat()
    zip_bytes = download_export_zip(get_export_url(cfg, anchor))
    counts: dict[str, int] = {}
    for inv in read_table(zip_bytes, "invoice"):
        if str(inv.get("printed", "")).strip() == "0":
            cid = str(inv.get("customer_id", "")).strip()
            if cid:
                counts[cid] = counts.get(cid, 0) + 1
    return [{"customer_id": c, "open_invoices": n}
            for c, n in sorted(counts.items(), key=lambda kv: kv[1], reverse=True)]


# Decimals written into a box_weight cell. Two is what a kg figure carries on
# these invoices; more would be false precision on a divided total.
WEIGHT_DECIMALS = 2

# Boxes counted from the API and boxes read off the page should agree
# exactly. A tolerance exists only so a portal that renders "12.0" against an
# API "12" isn't treated as a conflict.
BOX_COUNT_TOLERANCE = 0.01


def _format_weight(value: float, sample_text: str) -> str:
    """Render the weight the way this page already renders numbers.

    The decimal separator is taken from whatever is currently in the cell
    rather than assumed: FreshPortal is a Dutch application and a comma-
    locale field silently reading "1.5" as 15 would put a ten-fold error on
    every line. If the existing text carries no separator, a dot is used."""
    text = f"{value:.{WEIGHT_DECIMALS}f}"
    if "," in sample_text and "." not in sample_text:
        return text.replace(".", ",")
    return text


def _cell_number(text: str) -> float | None:
    """Pull a number out of cell text like '12,5 kg' or '1.234,5'."""
    cleaned = re.sub(r"[^\d.,-]", "", text or "")
    if not cleaned:
        return None
    # A comma after the last dot means comma-decimal; strip the thousands mark.
    if "," in cleaned and cleaned.rfind(",") > cleaned.rfind("."):
        cleaned = cleaned.replace(".", "").replace(",", ".")
    else:
        cleaned = cleaned.replace(",", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def _read_air_waybill_weight(page, cfg: Config, invoice_id: str) -> float | None:
    url = f"{cfg.freshportal_url}/transport/invoice_transport/invoice/code/air_waybill/INV_ID/{invoice_id}/"
    page.goto(url, wait_until="domcontentloaded", timeout=cfg.request_timeout)
    field = page.query_selector("#transport_type_air_waybill_total_weight")
    if field is None:
        return None
    return _cell_number(field.get_attribute("value") or "")


# How long to let the grid settle after focus moves. The column commits the
# cell being edited and opens the one below on ArrowDown, and that round trip
# is not instant - typing into a cell whose editor has not opened yet sends
# the keystrokes nowhere and silently leaves the original weight in place
# (seen in the wild 2026-09-11: "expected 33.33, reloaded cell reads 11.0",
# where 11.0 was the line's own prior weight).
SETTLE_MS = 500

# Ceiling on the total-weight tolerance. The real allowance is derived per
# invoice (see _total_tolerance) - this only stops a very short invoice from
# getting an absurdly wide one.
MAX_TOTAL_TOLERANCE = 0.05


def _total_tolerance(line_count: int, boxes: float | None,
                     expected_total: float | None) -> float:
    """How far the invoice total may sit from the air waybill.

    Scales with the number of lines instead of being fixed: one wrong line
    moves the total by roughly its own share, so a flat 5% quietly passes a
    missing line on any invoice long enough - at 30 lines one line is 3% and
    slips straight through (user, 2026-09-11).

    Half a line's share, not a whole one: at exactly 1/N the boundary case
    sits on the threshold rather than over it.

    The floor exists because the per-box weight is stored to two decimals,
    so the portal's own multiplication can drift by up to half a cent per box
    however carefully we write. On an invoice with many boxes and a light
    per-box weight that rounding can exceed a line's share, and then it wins -
    a check that fails on arithmetic nobody can avoid is worse than one that
    occasionally lets a line through, because it trains people to ignore it.
    """
    share = (0.5 / line_count) if line_count else MAX_TOTAL_TOLERANCE
    rounding = (0.01 * boxes / expected_total) if (boxes and expected_total) else 0.0
    return max(min(share, MAX_TOTAL_TOLERANCE), rounding)


def _cell_holds(page, cell_id: str, want: float | None) -> bool:
    """Whether a committed cell already shows the value we meant to write."""
    if want is None:
        return False
    cell = page.query_selector("#" + cell_id)
    got = _cell_number(cell.inner_text() if cell else "")
    return got is not None and abs(got - want) <= 0.005


def _retype_cell(page, cell_id: str, weight_text: str) -> None:
    """Second attempt at one cell, on its own rather than as part of the run
    down the column.

    Clicking straight at the cell avoids depending on where focus drifted to,
    and Escape-free: the value is committed with Enter so the grid does not
    move on and take the next cell with it."""
    cell = page.query_selector("#" + cell_id)
    if cell is None:
        return
    cell.click()
    page.wait_for_timeout(SETTLE_MS)
    page.keyboard.press("Control+A")
    page.keyboard.type(weight_text)
    page.keyboard.press("Enter")
    page.wait_for_timeout(SETTLE_MS)


def _write_line_weights(page, cfg: Config, details_url: str, weight_text: str,
                        expected_total: float | None = None,
                        expected_boxes: float | None = None) -> tuple[int, list[str]]:
    """Type down the box_weight column the way the grid expects, then verify.

    The column behaves like a spreadsheet: ArrowDown commits the cell being
    edited and opens the one below it (user, 2026-09-09). Editing each cell
    on its own — click, fill, Enter — only ever landed the FIRST value,
    because committing re-renders the table and the next click no longer
    hits an editable cell.

    Verification is a separate pass over a freshly loaded page rather than
    an immediate read of each cell. While a cell is being edited its value
    lives in an input inside the td, not in the td's text, so reading the
    text back mid-edit reported None even for the cell that had just been
    written successfully. Reloading also means what is checked is what the
    server actually stored, not what the browser is showing.

    `expected_total` is the air waybill weight. Once the lines are in, the
    invoice's own total is compared against it — the one check that covers
    the whole invoice rather than only the cells we managed to enumerate.
    """
    ids = [
        el.get_attribute("id")
        for el in page.query_selector_all("#invoice_table td.box_weight")
    ]
    ids = [i for i in ids if i]
    if not ids:
        return 0, ["no box_weight cells found in #invoice_table"]

    first = page.query_selector(f"#{ids[0]}")
    if first is None:
        return 0, [f"{ids[0]}: cell vanished before editing"]
    first.click()
    page.wait_for_timeout(SETTLE_MS)

    want = _cell_number(weight_text)
    for idx, cell_id in enumerate(ids):
        # Select whatever the cell already holds so typing replaces it
        # rather than appending to the old weight.
        page.keyboard.press("Control+A")
        page.keyboard.type(weight_text)
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(SETTLE_MS)

        # Check the cell we just left. Once focus has moved on it is committed
        # and its value is back in the cell's own text, so this read is safe -
        # unlike reading a cell that is still open for editing.
        #
        # This catches the failure the settle time is there to prevent: if the
        # grid had not finished opening the editor, the keystrokes went
        # nowhere and the cell still holds its ORIGINAL weight. That looked
        # like a corrupted write ("expected 33.33, reads 11.0") when it was
        # really no write at all.
        if not _cell_holds(page, cell_id, want):
            _retype_cell(page, cell_id, weight_text)

    # The last ArrowDown has no row below it to move to, so the final cell
    # may still be open; blur to force the commit before reloading.
    page.keyboard.press("Tab")
    page.wait_for_timeout(SETTLE_MS + 300)

    page.goto(details_url, wait_until="domcontentloaded", timeout=cfg.request_timeout)

    # Repair, don't just report. A cell that is still wrong after the reload
    # gets one more attempt here before it counts as a failure — leaving it
    # means the whole invoice comes back on the next run for the sake of one
    # line (user, 2026-09-11).
    repaired = []
    for cell_id in ids:
        if not _cell_holds(page, cell_id, want):
            _retype_cell(page, cell_id, weight_text)
            repaired.append(cell_id)
    if repaired:
        page.goto(details_url, wait_until="domcontentloaded", timeout=cfg.request_timeout)

    written, problems = 0, []
    for cell_id in ids:
        cell = page.query_selector(f"#{cell_id}")
        got = _cell_number(cell.inner_text() if cell else "")
        if got is not None and want is not None and abs(got - want) <= 0.005:
            written += 1
        else:
            problems.append(f"{cell_id}: expected {weight_text}, reloaded cell reads {got!r}")

    # End-to-end check on the whole invoice: the table's own total weight
    # against the air waybill it was derived from. Every per-cell check can
    # pass and this still fail — a line the grid never showed us, a box count
    # that moved, a row added between reading and writing — because this
    # multiplies by quantities we never looked at.
    total_el = page.query_selector("#invoice_table_footer_total_weight")
    shown_total = _cell_number(total_el.inner_text() if total_el else "")
    if shown_total is None:
        problems.append("could not read the invoice's total weight to cross-check")
    elif expected_total and expected_total > 0:
        drift = abs(shown_total - expected_total) / expected_total
        allowance = _total_tolerance(len(ids), expected_boxes, expected_total)
        if drift > allowance:
            problems.append(
                f"invoice total is {shown_total} kg against an air waybill of "
                f"{expected_total} kg — {drift * 100:.2f}% out, over the "
                f"{allowance * 100:.2f}% allowed for {len(ids)} line(s)"
            )

    return written, problems


def invoice_details_url(cfg: Config, invoice_id: str) -> str:
    """The invoice's own page. Built from invoice_id, not the sequence that
    gets displayed - the portal addresses invoices by id."""
    return f"{cfg.freshportal_url}/invoice/invoice/details/INV_ID/{invoice_id}/"


def _needs_run(candidate: dict, prior: dict | None, weight: float, boxes: float) -> tuple[bool, str]:
    """Redo when either input changed since the last successful run.

    The user's rule was "redo if the air waybill weight changed". Box count
    is compared too: an unchanged weight spread over a box more or less is
    still a different weight per box, so weight alone would leave a stale
    figure on the invoice (agreed with the user 2026-09-09)."""
    if prior is None or prior.get("status") != "ok":
        return True, "not yet completed"
    prior_weight = _num(prior.get("total_weight"))
    prior_boxes = _num(prior.get("box_count"))
    if prior_weight is None or abs(prior_weight - weight) > 0.005:
        return True, f"weight changed {prior_weight} -> {weight}"
    if prior_boxes is None or abs(prior_boxes - boxes) > BOX_COUNT_TOLERANCE:
        return True, f"box count changed {prior_boxes} -> {boxes}"
    return False, "unchanged since last run"


def run_correction(cfg: Config, customer_ids: set[str], limit: int | None = None,
                   on_status=None, on_progress=None) -> dict:
    """Select, then correct. One browser session for the whole batch.

    `on_progress` receives a dict after selection and after every invoice:
    {done, total, lines, invoice_id, status}. The caller needs `total` before
    any work starts - a progress display that only learns the denominator at
    the end is not a progress display."""
    from playwright.sync_api import sync_playwright
    from scraper_fp import _launch_browser, _login
    from db import get_kenya_box_weight_log, record_kenya_box_weight

    def _s(msg: str) -> None:
        logger.info("[kenya-box-weight] %s", msg)
        if on_status:
            on_status(msg)

    lines_written_total = 0

    def _p(**fields) -> None:
        if on_progress:
            on_progress(fields)

    _s("Pulling Kenya export and selecting open invoices…")
    selection = select_candidates(cfg, customer_ids)
    candidates = selection["candidates"]
    if limit:
        candidates = candidates[:limit]
    _s(f"{len(candidates)} candidate invoice(s), {len(selection['skipped'])} skipped by the supplier rule")
    _p(done=0, total=len(candidates), lines=0)
    if not candidates:
        return {"ok": True, "processed": [], **selection}

    prior_by_invoice = {
        str(r["invoice_id"]): r
        for r in get_kenya_box_weight_log([c["invoice_id"] for c in candidates])
    }

    processed = []

    def _record(result: dict) -> None:
        """Append a result and report progress in one move, so a path that
        forgets one cannot report the other."""
        nonlocal lines_written_total
        processed.append(result)
        lines_written_total += int(result.get("lines_written") or 0)
        _p(done=len(processed), total=len(candidates), lines=lines_written_total,
           invoice_id=result.get("invoice_id"), sequence=result.get("sequence"),
           status=result.get("status"))

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        try:
            _s("Logging in to the Kenya portal…")
            _login(page, cfg)

            for i, cand in enumerate(candidates, start=1):
                invoice_id = cand["invoice_id"]
                result = {"invoice_id": invoice_id, "customer_id": cand["customer_id"],
                          "sequence": cand.get("sequence") or "",
                          "invoice_url": invoice_details_url(cfg, invoice_id)}
                try:
                    _s(f"[{i}/{len(candidates)}] invoice {invoice_id}…")
                    weight = _read_air_waybill_weight(page, cfg, invoice_id)
                    if weight is None or weight <= 0:
                        result |= {"status": "skipped",
                                   "detail": "no air waybill weight recorded"}
                        _record(result)
                        record_kenya_box_weight({**result, "total_weight": weight})
                        continue

                    details_url = invoice_details_url(cfg, invoice_id)
                    page.goto(details_url, wait_until="domcontentloaded", timeout=cfg.request_timeout)
                    footer = page.query_selector("#invoice_table_footer_total_quantities")
                    boxes = _cell_number(footer.inner_text() if footer else "")
                    if not boxes:
                        result |= {"status": "failed", "total_weight": weight,
                                   "detail": "could not read total box count from the invoice table"}
                        _record(result)
                        record_kenya_box_weight(result)
                        continue

                    # Two independent counts must agree before a weight
                    # derived from one of them lands on a live invoice.
                    api_boxes = _num(cand.get("api_box_count"))
                    if api_boxes is not None and abs(api_boxes - boxes) > BOX_COUNT_TOLERANCE:
                        result |= {"status": "failed", "total_weight": weight, "box_count": boxes,
                                   "detail": f"box count mismatch: portal {boxes} vs API {api_boxes} "
                                             f"— refusing to write a weight derived from either"}
                        _record(result)
                        record_kenya_box_weight(result)
                        continue

                    should_run, why = _needs_run(cand, prior_by_invoice.get(invoice_id), weight, boxes)
                    if not should_run:
                        result |= {"status": "skipped", "total_weight": weight,
                                   "box_count": boxes, "detail": why}
                        _record(result)
                        continue

                    per_box = round(weight / boxes, WEIGHT_DECIMALS)
                    sample = page.query_selector("#invoice_table td.box_weight")
                    weight_text = _format_weight(per_box, sample.inner_text() if sample else "")
                    written, problems = _write_line_weights(page, cfg, details_url, weight_text, weight, boxes)

                    result |= {
                        "total_weight": weight, "box_count": boxes, "weight_per_box": per_box,
                        "lines_written": written,
                        # Only a clean sweep counts as done: a partial write
                        # marked "ok" would never be retried, and rewriting
                        # the same average is idempotent so a retry is free.
                        "status": "ok" if written and not problems else "failed",
                        "detail": "; ".join(problems) if problems else f"{why}; wrote {weight_text}",
                    }
                    _record(result)
                    record_kenya_box_weight(result)

                except Exception as exc:
                    logger.exception("Kenya box weight failed for invoice %s", invoice_id)
                    result |= {"status": "failed", "detail": str(exc)}
                    _record(result)
                    record_kenya_box_weight(result)
        finally:
            ctx.close()
            browser.close()

    done = sum(1 for r in processed if r.get("status") == "ok")
    _s(f"Finished — {done} corrected, {len(processed) - done} skipped or failed")
    return {"ok": True, "processed": processed, "anchor": selection["anchor"],
            "skipped": selection["skipped"], "detail": ""}
