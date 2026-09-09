"""Daily ingestion of the FreshPortal BI Sync export into the analytics
mirror tables (bi_stock_entry_dim / bi_stock_entry_daily / bi_order_lines).

Usage:
    from bi_sync import run_bi_sync, run_bi_sync_range
    run_bi_sync(cfg, mutation_datetime="2026-08-20")            # one day
    run_bi_sync_range(cfg, "2026-08-01", "2026-08-20")          # backfill a range
    # both blocking — call from a background thread

order_lines keeps every customer EXCEPT the ones in EXCLUDED_CUSTOMER_IDS,
and stores the resolved customer_id per row. Until 2026-09-09 ingest kept
only customer 12 (OZEDS), which made the whole year look far emptier than
it was; the customer is now a *query-time* dimension instead of an ingest
filter.

That widening does not make sale prices comparable across customers —
webshop sale price is customer-specific, so mixing customers in one price
series is still meaningless. It only moves the decision downstream: every
analytics query in db.py takes a customer_id and the Analysis Tool scopes
to customer 12 by default, so price/sell-through comparisons stay
single-customer unless the user deliberately widens them.

Rows whose customer cannot be resolved at all are still dropped — an
order_line with no reachable invoice can't be attributed to anyone, and
letting it through would add an unlabelled bucket to every breakdown. The
invoice table (in the same export) resolves invoice_id -> customer_id, and
is also persisted into the standing bi_invoice_customer map (db.py) so
older invoices not included in a given pull can still be resolved.

order_lines is additionally filtered to rows whose creation_date_time falls
in [filter_start, filter_end] (inclusive) — /v2/export returns everything
*mutated since* mutation_datetime, up to now, which is broader than
"created on these specific days".

IMPORTANT — one API call per sync run, never one per day: mutation_datetime
is a "since" cursor, not a single-day filter — the export contains
*everything* mutated between that date and today. A range backfill that
looped day-by-day (mutation_datetime = each individual day) was therefore
making N redundant, heavily overlapping calls: the pull for a day near the
start of a long historical range already contains almost everything a pull
for a later day would *also* return, plus more — so the earliest days in a
long backfill were by far the most expensive (found 2026-09-02, after a
2.5-year backfill took 12+ hours and only completed the most recent 1.5
years). Since order_lines is filtered locally by creation_date_time anyway,
a single pull anchored at the *oldest* requested date, split into
day-buckets purely in local processing, covers the exact same ground in one
network round-trip instead of hundreds.

Because mutation_datetime is a "since" cursor, an export anchored at date D
already contains every line created between D and now. A backfill therefore
needs exactly ONE successful pull, anchored as far back as the API can
manage — narrowing the *local* filter window does not make the download any
smaller.

That is what the 2026-09-03 chunking got wrong (fixed 2026-09-07): it split
[start, end] into 6-month windows and anchored each at its own start, so
chunk 1 of a 2022 backfill still requested "everything since 2022-01-01" —
the whole database, exactly as big as before chunking — and the loop
aborted the entire run on the first failure. A timeout on the oldest slice
therefore wiped out every later slice too, leaving the scattered months the
user reported.

run_bi_sync_range now walks the anchors oldest-first and, on success,
filters that one export across the WHOLE remaining range rather than just
its own window — so the first anchor that survives fills everything from
there to end_date and the loop stops. A failing anchor is not fatal: it
just means that slice of history is unreachable, and the next (later,
smaller) anchor is tried. The result reports how far back it actually got.

order_lines is also enriched with manufacturer_id/length/supplier_id via
created_from_stock_entry_id, looked up against *every* stock_entry row in
the export (not just the offer/limited-offer ones kept in
bi_stock_entry_dim) — a sold line's created_from_stock_entry_id points to a
"standard" (physical) stock_entry, a different type than the
offer/limited-offer lots bi_stock_entry_dim is scoped to, so this lookup
can't reuse that table (confirmed 2026-09-02).

The "supplier" table (id, name — the FreshPortal-registered supplier list,
confirmed by the user 2026-09-02) is read every sync and kept in
bi_suppliers, purely as an id->name lookup for chart legends.
"""
from __future__ import annotations

import calendar
import logging
import threading
from datetime import date, datetime, timedelta

from bi_sync_client import (
    get_export_url, download_export_zip, read_table,
    find_table_files, list_export_files,
)
from config import Config
from db import (
    upsert_bi_stock_entry_dim, upsert_bi_stock_entry_daily, upsert_bi_order_lines,
    upsert_bi_products,
    upsert_bi_invoice_customer, get_bi_invoice_customer_map,
    upsert_bi_suppliers,
    log_bi_sync_start, log_bi_sync_finish, append_bi_sync_message,
)

logger = logging.getLogger(__name__)

# OZ-Hami Direct Sales — same customer_id as the "OZ-Hami - Direct Sales"
# entry in the dfg_customers table (db.py). No longer an ingest filter (see
# module docstring); still the default scope the Analysis Tool opens on, so
# widening ingest didn't silently change what every existing chart means.
REFERENCE_CUSTOMER_ID = "12"

# "OZ-Hami - Growers Offer" (dfg_customers). Not real sales — grower offer
# paperwork that would inflate every volume/revenue series it landed in, so
# it is dropped at ingest rather than filtered in each query.
EXCLUDED_CUSTOMER_IDS = {"160"}

_sync_lock = threading.Lock()
_sync_running = False
_sync_message = ""


# The export does NOT use one date format. mutation_date_time comes back as
# ISO ("2026-01-07 10:57:03.649") while creation_date_time comes back as
# day-first ("26/11/2025 06:44"), in the same row of the same file.
#
# That broke ingestion twice over (found 2026-09-07 from a raw export the
# user pulled by hand):
#   * the range filter compared `creation_date_time[:10]` as a STRING against
#     ISO bounds, so "26/11/2025" <= "2026-09-07" is false — every day-first
#     row was silently discarded as "outside range", regardless of the range.
#   * anything that did get through was handed to a TIMESTAMPTZ column as raw
#     text, so Postgres read it under its own DateStyle: "02/04/2026" became
#     4 February instead of 2 April, and "26/11/2025" is not a valid date at
#     all under the MDY default.
# Everything is therefore parsed here and normalised to ISO before it reaches
# either the filter or the database.
_EXPORT_DATETIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%d/%m/%Y",
    "%d-%m-%Y %H:%M:%S",
    "%d-%m-%Y %H:%M",
    "%d-%m-%Y",
)


def parse_export_datetime(value: str | None) -> datetime | None:
    """Parse either of the export's date formats. Returns None when the value
    is empty or in a shape we don't recognise — callers must treat that as
    "unknown", never as a silently-dropped row."""
    text = (value or "").strip()
    if not text:
        return None
    for fmt in _EXPORT_DATETIME_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _normalise_datetime_field(row: dict, field: str) -> None:
    """Rewrite one field to ISO in place, so the database never has to guess."""
    parsed = parse_export_datetime(row.get(field))
    if parsed is not None:
        row[field] = parsed.isoformat(sep=" ")


def is_bi_sync_running() -> bool:
    return _sync_running


def get_bi_sync_message() -> str:
    return _sync_message


def _run_bi_sync_for_range(cfg: Config, mutation_datetime: str, filter_start: str, filter_end: str, on_status=None) -> dict:
    """Core sync logic — exactly one export pull, with order_lines locally
    filtered to creation_date_time in [filter_start, filter_end] (inclusive).

    mutation_datetime is the "since" cursor sent to the API — for a single
    day it equals filter_start/filter_end; for a range backfill it's the
    *oldest* date in the range (see module docstring for why one call
    anchored at the oldest date covers the whole range).

    No _sync_running management — callers (run_bi_sync / run_bi_sync_range)
    own that at whatever scope is appropriate for them.
    """
    sync_id = log_bi_sync_start(f"{filter_start}..{filter_end}" if filter_start != filter_end else filter_start)

    def _s(msg: str) -> None:
        global _sync_message
        _sync_message = msg
        logger.info("[bi-sync] %s", msg)
        if on_status:
            on_status(msg)
        append_bi_sync_message(sync_id, msg)

    try:
        _s(f"Requesting export (mutation_datetime={mutation_datetime})…")
        export_url = get_export_url(cfg, mutation_datetime)
        zip_bytes = download_export_zip(export_url)
        _s(f"Downloaded export ({len(zip_bytes):,} bytes)")

        # Name every file the export actually contains, and which of them each
        # table resolves to. A table split across numbered parts used to be
        # read only in part, which is invisible unless the log says how many
        # files backed it (2026-09-07).
        contents = list_export_files(zip_bytes)
        _s(f"Export contains {len(contents)} file(s): "
           + ", ".join(f"{n} ({s:,}B)" for n, s in sorted(contents, key=lambda x: -x[1])[:25])
           + (" …" if len(contents) > 25 else ""))
        for table in ("order_line", "stock_entry", "invoice", "supplier"):
            matched = find_table_files(zip_bytes, table)
            _s(f"  table '{table}' -> {len(matched)} file(s): {matched or 'NONE FOUND'}")

        _s("Reading invoice table…")
        invoices = read_table(zip_bytes, "invoice")
        customer_by_invoice = {inv["id"]: inv.get("customer_id") for inv in invoices if inv.get("id")}
        # Persist into the standing invoice->customer map forever, not just for
        # this run — an even earlier order_line than this pull covers could
        # still reference an invoice not included here; the accumulated map is
        # what lets that order_line still resolve its customer below (found
        # 2026-08-31).
        upsert_bi_invoice_customer(invoices)
        _s(f"Loaded {len(customer_by_invoice)} invoice→customer mappings from this export "
           f"(accumulated map used as fallback for older invoices)")

        _s("Reading supplier table…")
        suppliers = read_table(zip_bytes, "supplier")
        upsert_bi_suppliers(suppliers)
        _s(f"Upserted {len(suppliers)} supplier names (id→name lookup for the price/supplier charts)")

        _s("Reading stock_entry table…")
        all_stock_entries = read_table(zip_bytes, "stock_entry")
        # Stored into a TIMESTAMPTZ (bi_stock_entry_daily.source_mutation_time),
        # so it needs the same day-first normalisation as order_lines.
        for entry in all_stock_entries:
            _normalise_datetime_field(entry, "mutation_date_time")
        # Full, unfiltered lookup by id — used below to enrich order_lines with
        # manufacturer_id/length/supplier_id regardless of stock_entry_type_id,
        # since a sold line's created_from_stock_entry_id points to a
        # "standard" type row, not an offer/limited-offer one (see module
        # docstring).
        stock_entry_by_id = {r["id"]: r for r in all_stock_entries if r.get("id")}

        # Only "offer" (4) and "limited offer" (5) stock_entry_type_id rows are
        # the virtual/temporary-offer lots this analyzer cares about — created
        # once (sometimes years ago) and only ever mutated in place (price,
        # quantity, webshop_visible, available_from/until, ...), never
        # soft-deleted (confirmed by the user 2026-09-02). Every other type —
        # "default lot" (1) and "standard" (physical stock, created per order
        # and consumed/soft-deleted via visible=1 on fulfillment) — has
        # completely different lifecycle semantics (high-churn, order-driven)
        # and would otherwise dominate/skew any "how much is offered" count.
        # The visible=0 check is kept as a defensive no-op belt-and-suspenders
        # filter — offer/limited-offer rows are never expected to have
        # visible=1 in the first place.
        stock_entries = [
            r for r in all_stock_entries
            if str(r.get("visible") or "0").strip() not in ("1", "true", "True")
            and str(r.get("stock_entry_type_id") or "").strip() in ("4", "5")
        ]
        # Product names come from the FULL list, not the type 4/5 subset —
        # sold lines point at "standard" entries, whose products are absent
        # from bi_stock_entry_dim and would otherwise render as raw ids.
        upsert_bi_products(all_stock_entries)

        _s(f"Read {len(all_stock_entries)} stock_entry rows, {len(stock_entries)} offer/limited-offer "
           f"lots (type 4/5, visible=0) after dropping other types — upserting…")
        upsert_bi_stock_entry_dim(stock_entries)
        snapshot_date = date.today().isoformat()
        upsert_bi_stock_entry_daily(stock_entries, snapshot_date)
        _s(f"Upserted {len(stock_entries)} stock_entry rows (snapshot_date={snapshot_date})")

        _s("Reading order_lines table…")
        # The export file is literally "order_line.csv" (singular) — confirmed
        # 2026-08-31 by listing the zip's file names — not "order_lines", so the
        # substring match in find_table_file() was silently matching nothing and
        # returning [] every single sync (root cause of the 0 order_lines bug).
        all_order_lines = read_table(zip_bytes, "order_line")

        # Resolve customer_id: prefer this run's own invoice table, fall back to
        # the accumulated bi_invoice_customer map for invoices not covered by
        # this pull (see the upsert_bi_invoice_customer call above for why
        # that's needed).
        unresolved_ids = {
            line.get("invoice_id") or line.get("main_invoice_id")
            for line in all_order_lines
            if (line.get("invoice_id") or line.get("main_invoice_id"))
            and (line.get("invoice_id") not in customer_by_invoice and line.get("main_invoice_id") not in customer_by_invoice)
        }
        fallback_customer_by_invoice = get_bi_invoice_customer_map(list(unresolved_ids))
        if fallback_customer_by_invoice:
            _s(f"Resolved {len(fallback_customer_by_invoice)} additional invoice→customer "
               f"mappings from accumulated history")

        # Only lines actually created within [filter_start, filter_end] —
        # order_lines pulled by /v2/export are everything *mutated* since
        # mutation_datetime, which is broader than "created in this range"
        # (e.g. a line created earlier but touched again later would also
        # come back).
        reference_lines = []
        skipped_wrong_day = 0
        unresolved_stock_entry = 0
        unparseable_date = 0
        unresolved_customer = 0
        excluded_customer = 0
        customer_counts: dict[str, int] = {}
        for line in all_order_lines:
            customer_id = (
                customer_by_invoice.get(line.get("invoice_id"))
                or customer_by_invoice.get(line.get("main_invoice_id"))
                or fallback_customer_by_invoice.get(line.get("invoice_id"))
                or fallback_customer_by_invoice.get(line.get("main_invoice_id"))
            )
            customer_id = str(customer_id).strip() if customer_id else ""
            if not customer_id:
                unresolved_customer += 1
                continue
            if customer_id in EXCLUDED_CUSTOMER_IDS:
                excluded_customer += 1
                continue
            # Parsed, not sliced: creation_date_time is day-first in this
            # export, so a string prefix compare against ISO bounds threw
            # every such row away (see _EXPORT_DATETIME_FORMATS).
            created_dt = parse_export_datetime(line.get("creation_date_time"))
            if created_dt is None:
                unparseable_date += 1
                continue
            created = created_dt.date().isoformat()
            if not (filter_start <= created <= filter_end):
                skipped_wrong_day += 1
                continue
            # Hand the database an unambiguous ISO value rather than letting
            # it guess day-vs-month under its own DateStyle.
            line["creation_date_time"] = created_dt.isoformat(sep=" ")
            line["customer_id"] = customer_id
            source_entry = stock_entry_by_id.get(line.get("created_from_stock_entry_id"))
            if source_entry:
                line["manufacturer_id"] = source_entry.get("manufacturer_id")
                line["length"] = source_entry.get("length")
                line["supplier_id"] = source_entry.get("supplier_id")
                # product_id has to come from the stock_entry too — order_line
                # itself carries no product reference, so before 2026-09-03
                # every bi_order_lines row was written with product_id NULL.
                # That silently emptied the product picker and made the
                # supplier chart group all lines into one unlabelled series.
                # Prefer the line's own value if a future export ever adds one.
                line["product_id"] = line.get("product_id") or source_entry.get("product_id")
            else:
                unresolved_stock_entry += 1
            customer_counts[customer_id] = customer_counts.get(customer_id, 0) + 1
            reference_lines.append(line)
        top_customers = sorted(customer_counts.items(), key=lambda kv: kv[1], reverse=True)[:5]
        _s(f"Read {len(all_order_lines)} order_lines, kept {len(reference_lines)} across "
           f"{len(customer_counts)} customers created in [{filter_start}, {filter_end}] "
           f"({skipped_wrong_day} skipped — outside range, "
           f"{unparseable_date} skipped — unreadable creation date, "
           f"{unresolved_customer} skipped — no resolvable customer, "
           f"{excluded_customer} skipped — excluded customer {'/'.join(sorted(EXCLUDED_CUSTOMER_IDS))}, "
           f"{unresolved_stock_entry} missing farm/length — source stock_entry not in this export) — upserting…")
        if top_customers:
            _s("Top customers this batch: " + ", ".join(f"{cid}={n}" for cid, n in top_customers))
        upsert_bi_order_lines(reference_lines)

        log_bi_sync_finish(sync_id, len(stock_entries), len(reference_lines))
        _s(f"Sync complete — {len(stock_entries)} stock_entries, {len(reference_lines)} order_lines")
        # sync_id goes back to the caller so a range backfill can append its
        # own coverage verdict to this run's log — see run_bi_sync_range.
        return {"ok": True, "stock_entries": len(stock_entries), "order_lines": len(reference_lines),
                "sync_id": sync_id, "error": ""}

    except Exception as exc:
        error = str(exc)
        logger.exception("BI sync failed")
        log_bi_sync_finish(sync_id, 0, 0, error)
        return {"ok": False, "stock_entries": 0, "order_lines": 0, "sync_id": sync_id, "error": error}


def _add_months(d: date, months: int) -> date:
    """Calendar-month addition, clamping the day to the target month's
    length (e.g. Jan 31 + 1 month -> Feb 28/29, not an error)."""
    total = d.month - 1 + months
    year = d.year + total // 12
    month = total % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _bi_sync_chunks(start_date: str, end_date: str, months: int = 6) -> list[tuple[str, str]]:
    """Split [start_date, end_date] into consecutive <=`months`-month
    windows. A <=6-month range (the common case) comes back as a single
    chunk, identical to the old un-chunked behavior."""
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    chunks: list[tuple[str, str]] = []
    cur = start
    while cur <= end:
        chunk_end = min(_add_months(cur, months) - timedelta(days=1), end)
        chunks.append((cur.isoformat(), chunk_end.isoformat()))
        cur = chunk_end + timedelta(days=1)
    return chunks


def run_bi_sync(cfg: Config, mutation_datetime: str, on_status=None) -> dict:
    """Pull one BI Sync export and upsert stock_entry / order_lines into the
    mirror tables. Returns {"ok": bool, "stock_entries": int, "order_lines": int, "error": str}.
    """
    global _sync_running

    if _sync_running:
        return {"ok": False, "error": "BI sync already running", "stock_entries": 0, "order_lines": 0}

    with _sync_lock:
        _sync_running = True
    try:
        return _run_bi_sync_for_range(cfg, mutation_datetime, mutation_datetime, mutation_datetime, on_status)
    finally:
        _sync_running = False


def run_bi_sync_range(cfg: Config, start_date: str, end_date: str, on_status=None) -> dict:
    """Backfill [start_date, end_date] (inclusive) with ONE successful export
    pull, anchored as far back as the API can actually serve.

    Anchors are tried oldest-first. Each attempt filters the export across
    the whole remaining range [anchor, end_date] — not just a 6-month slice —
    because a "since anchor" export already contains everything created after
    that anchor. So the first anchor that succeeds fills the entire range and
    the loop stops; there is nothing left for later anchors to add.

    A failed anchor is not fatal. It means that slice of history is too large
    for the API to deliver, so the next (later, therefore smaller) anchor is
    tried and that much history is recovered. `oldest_covered` in the result
    says how far back the run actually reached, which is the number worth
    checking when a chart shows gaps.
    """
    global _sync_running

    if _sync_running:
        return {"ok": False, "error": "BI sync already running", "stock_entries": 0, "order_lines": 0}

    try:
        if date.fromisoformat(end_date) < date.fromisoformat(start_date):
            return {"ok": False, "error": "end_date is before start_date", "stock_entries": 0, "order_lines": 0}
        anchors = [c[0] for c in _bi_sync_chunks(start_date, end_date)]
    except ValueError as exc:
        return {"ok": False, "error": f"Invalid date: {exc}", "stock_entries": 0, "order_lines": 0}

    with _sync_lock:
        _sync_running = True
    try:
        failures: list[str] = []
        for i, anchor in enumerate(anchors, start=1):
            if len(anchors) > 1 and on_status:
                on_status(f"Backfill attempt {i}/{len(anchors)} — pulling everything since {anchor} "
                          f"and filtering to {anchor}..{end_date}")
            result = _run_bi_sync_for_range(cfg, anchor, anchor, end_date, on_status)
            if result.get("ok"):
                # Persist the coverage verdict, don't just hand it to on_status:
                # the HTTP entry point runs this in a bare thread with no
                # callback and drops the return value, so a backfill that
                # silently recovered far less history than asked for reported
                # nothing at all and looked like a clean success (2026-09-09).
                if failures:
                    verdict = (f"PARTIAL COVERAGE — requested from {start_date}, actually covered from "
                               f"{anchor}. {len(failures)} older anchor(s) were too large for the API: "
                               + " | ".join(failures))
                else:
                    verdict = f"Full requested range covered, from {start_date} to {end_date}"
                if result.get("sync_id"):
                    append_bi_sync_message(result["sync_id"], verdict)
                if on_status:
                    on_status(verdict)
                return {
                    "ok": True,
                    "stock_entries": result.get("stock_entries", 0),
                    "order_lines": result.get("order_lines", 0),
                    "oldest_covered": anchor,
                    "skipped_anchors": failures,
                    "error": "",
                }
            failures.append(f"{anchor}: {result.get('error', 'unknown error')}")
            if on_status:
                on_status(f"Anchor {anchor} failed ({result.get('error', 'unknown error')}) — "
                          f"retrying from a later date, which recovers less history")

        return {
            "ok": False,
            "stock_entries": 0,
            "order_lines": 0,
            "oldest_covered": None,
            "skipped_anchors": failures,
            "error": "Every anchor failed: " + " | ".join(failures),
        }
    finally:
        _sync_running = False
