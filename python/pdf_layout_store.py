"""Delivery files no layout reads, and the layouts drafted for them.

IT adds a new supplier's layout to pdf_layouts.py with the
new-delivery-json-format skill; that is the normal way. This module covers
the time before IT gets to it — the middle of the night, say (user,
2026-09-28). A PDF invoice that matches no layout is saved here as *waiting*,
so IT finds it in Admin, and the person importing it may ask for a temporary
layout to be drafted there and then (pdf_layout_ai), at most
MAX_DRAFTS_PER_DAY a day. A draft that reads its invoice and agrees with the
totals printed on it is stored as *provisional*: it reads that supplier's
invoices from then on, and every import made with it says so on the screen.
IT checks it in Admin and marks it *verified* or *rejected*, and *closes* an
invoice once its layout is in pdf_layouts.py.

The same goes for a delivery JSON no parser reads (user, 2026-10-01): it is
saved here with kind "json", within the same daily limit, and its drafted
layout is json_layout's rather than a PDF's. IT adds its parser to
parser_delivery.py.

A stored layout is data (pdf_layout_json, json_layout) and is only ever run
in a separate process with a time limit (run_isolated): a regular expression
that never finishes stops that process, not the server.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import logging
import multiprocessing
import os
import threading
import time
from datetime import timedelta

import psycopg2.extras

from db import _conn

log = logging.getLogger(__name__)

WAITING, DRAFTING, PROVISIONAL, VERIFIED, REJECTED, FAILED, CLOSED = (
    "waiting", "drafting", "provisional", "verified", "rejected", "failed", "closed")
# What was saved: a PDF invoice, or a delivery JSON (also one sent as .txt).
KINDS = ("pdf", "json")
# The layouts that read invoices.
READING = (PROVISIONAL, VERIFIED)
# What IT still has to look at: invoices without a layout, and drafted
# layouts nobody has checked.
FOR_IT = (WAITING, FAILED, PROVISIONAL)
# Drafting costs money and stands in for IT only briefly (user, 2026-09-28).
MAX_DRAFTS_PER_DAY = int(os.getenv("PDF_LAYOUT_DRAFTS_PER_DAY", "2"))
# Whose day that is: UTC, which every Postgres knows (one on Windows had no
# time zone database); the day then turns at 01:00 or 02:00 in Europe.
DAY_ZONE = "UTC"
# A draft takes a few minutes; one still "drafting" after this was cut off by
# a restart of the server and will never finish.
STALE_DRAFT = timedelta(minutes=20)
# Stored layouts are read afresh at most this often.
_CACHE_SECONDS = 30
# How long a stored layout may take over one invoice.
ISOLATED_TIMEOUT = 30
# Postgres advisory lock taken while a draft is granted, so two people cannot
# both take the day's last one. Any fixed number no other code uses.
_DRAFT_LOCK = 7_310_428_611

_table_ready = False
# Per kind: when the reading layouts were read, and what they were.
_cache: dict[str, tuple[float, list[dict]]] = {}
_cache_lock = threading.Lock()


def ensure_table() -> None:
    global _table_ready
    if _table_ready:
        return
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS pdf_layouts (
                    id               SERIAL PRIMARY KEY,
                    status           TEXT NOT NULL,
                    supplier         TEXT,
                    spec             JSONB,
                    assumptions      JSONB NOT NULL DEFAULT '[]',
                    sample           JSONB,
                    error            TEXT,
                    file_name        TEXT,
                    file_sha256      TEXT,
                    pdf              BYTEA,
                    model            TEXT,
                    turns            INTEGER,
                    input_tokens     INTEGER,
                    output_tokens    INTEGER,
                    cost_usd         NUMERIC(8, 4),
                    created_by       TEXT,
                    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    draft_started_at TIMESTAMPTZ,
                    drafted_by       TEXT,
                    finished_at      TIMESTAMPTZ,
                    reviewed_by      TEXT,
                    reviewed_at      TIMESTAMPTZ,
                    review_note      TEXT
                )
            """)
            # Why a known supplier's layout could not read the invoice (added
            # 2026-09-30); empty for a supplier no layout knows.
            cur.execute("ALTER TABLE pdf_layouts ADD COLUMN IF NOT EXISTS read_error TEXT")
            # A delivery JSON's row (added 2026-10-01); the file goes in the
            # column named pdf all the same.
            cur.execute("ALTER TABLE pdf_layouts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL "
                        "DEFAULT 'pdf'")
            cur.execute("CREATE INDEX IF NOT EXISTS pdf_layouts_status_idx ON pdf_layouts(status)")
            cur.execute("CREATE INDEX IF NOT EXISTS pdf_layouts_sha_idx ON pdf_layouts(file_sha256)")
    _table_ready = True


def _invalidate() -> None:
    global _cache
    with _cache_lock:
        _cache = {}


# Everything but the PDF itself, which is fetched only when someone opens it.
_COLUMNS = ("id, kind, status, supplier, spec, assumptions, sample, error, read_error, "
            "file_name, model, turns, "
            "input_tokens, output_tokens, cost_usd, created_by, created_at, draft_started_at, "
            "drafted_by, finished_at, reviewed_by, reviewed_at, review_note")


def _row(row: dict | None) -> dict | None:
    if row is None:
        return None
    out = dict(row)
    if out.get("cost_usd") is not None:
        out["cost_usd"] = float(out["cost_usd"])
    for key in ("created_at", "draft_started_at", "finished_at", "reviewed_at"):
        if out.get(key) is not None:
            out[key] = out[key].isoformat()
    return out


def _fail_stale(cur) -> None:
    cur.execute("""
        UPDATE pdf_layouts SET status = %s, finished_at = NOW(),
            error = 'The drafting stopped before it finished (the server restarted).'
        WHERE status = %s AND draft_started_at < NOW() - %s
    """, (FAILED, DRAFTING, STALE_DRAFT))


# ---------------------------------------------------------------------------
# Saved invoices and drafting
# ---------------------------------------------------------------------------

def save_unknown(file_name: str, pdf: bytes, username: str, read_error: str | None = None,
                 kind: str = "pdf") -> dict:
    """Keep a file no layout reads, for IT and for drafting one; read_error
    says why, when a known supplier's layout (a known JSON format) found it
    but could not read it. The same file saved before is not saved again:
    its row comes back, whatever became of it since (a rejected draft
    excepted)."""
    if kind not in KINDS:
        raise ValueError(f"Unknown kind of file: {kind}")
    ensure_table()
    sha = hashlib.sha256(pdf).hexdigest()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _fail_stale(cur)
            cur.execute(f"""
                SELECT {_COLUMNS} FROM pdf_layouts
                WHERE file_sha256 = %s AND status <> %s
                ORDER BY id DESC LIMIT 1
            """, (sha, REJECTED))
            existing = cur.fetchone()
            if existing:
                return _row(existing)
            cur.execute(f"""
                INSERT INTO pdf_layouts (status, kind, file_name, file_sha256, pdf, created_by,
                                         read_error)
                VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING {_COLUMNS}
            """, (WAITING, kind, file_name, sha, psycopg2.Binary(pdf), username,
                  (read_error or "")[:2000] or None))
            return _row(cur.fetchone())


def _drafts_today(cur) -> int:
    cur.execute("""
        SELECT COUNT(*) AS n FROM pdf_layouts
        WHERE draft_started_at >= (date_trunc('day', NOW() AT TIME ZONE %s) AT TIME ZONE %s)
    """, (DAY_ZONE, DAY_ZONE))
    row = cur.fetchone()
    return int(row["n"] if isinstance(row, dict) else row[0])


def drafts_left_today() -> int:
    ensure_table()
    with _conn() as conn:
        with conn.cursor() as cur:
            return max(0, MAX_DRAFTS_PER_DAY - _drafts_today(cur))


class DraftLimitReached(RuntimeError):
    """MAX_DRAFTS_PER_DAY layouts have been drafted today already."""


def begin_draft(layout_id: int, username: str) -> dict:
    """Mark a saved invoice as being drafted for, within today's limit.
    Raises DraftLimitReached, LookupError, or ValueError when the invoice
    already has a layout or one is being drafted."""
    ensure_table()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (_DRAFT_LOCK,))
            _fail_stale(cur)
            cur.execute(f"SELECT {_COLUMNS} FROM pdf_layouts WHERE id = %s FOR UPDATE", (layout_id,))
            row = cur.fetchone()
            if row is None:
                raise LookupError(layout_id)
            if row["status"] not in (WAITING, FAILED):
                raise ValueError(f"This invoice is {row['status']}, not waiting for a layout.")
            if _drafts_today(cur) >= MAX_DRAFTS_PER_DAY:
                raise DraftLimitReached(
                    f"{MAX_DRAFTS_PER_DAY} temporary layouts have been drafted today already.")
            cur.execute(f"""
                UPDATE pdf_layouts SET status = %s, draft_started_at = NOW(), drafted_by = %s,
                    error = NULL, finished_at = NULL
                WHERE id = %s RETURNING {_COLUMNS}
            """, (DRAFTING, username, layout_id))
            return _row(cur.fetchone())


def draft_status(layout_id: int, usage: dict | None = None) -> str | None:
    """The row's status, cheaply: a running draft asks it to see whether it
    was cancelled, and leaves what it has spent so far (usage) for the
    delivery screen's counter. A cancelled draft's figures stay cleared."""
    ensure_table()
    with _conn() as conn:
        with conn.cursor() as cur:
            if usage:
                cur.execute("""
                    UPDATE pdf_layouts SET model = %s, turns = %s, input_tokens = %s,
                        output_tokens = %s, cost_usd = %s
                    WHERE id = %s AND status = %s
                """, (usage.get("model"), usage.get("turns"), usage.get("input_tokens"),
                      usage.get("output_tokens"), usage.get("cost_usd"), layout_id, DRAFTING))
            cur.execute("SELECT status FROM pdf_layouts WHERE id = %s", (layout_id,))
            row = cur.fetchone()
    return row[0] if row else None


def cancel_draft(layout_id: int, username: str) -> dict:
    """Stop a draft (user, 2026-09-28): the running draft sees the status
    change and closes its connection to the model, whatever it produced is
    cleared, and the invoice waits in Admin for a layout, as it did before.
    The attempt still counts against today's limit: the tokens it used were
    spent."""
    ensure_table()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                UPDATE pdf_layouts SET status = %s, spec = NULL, supplier = NULL,
                    assumptions = '[]', sample = NULL, error = NULL, model = NULL, turns = NULL,
                    input_tokens = NULL, output_tokens = NULL, cost_usd = NULL,
                    finished_at = NULL, drafted_by = NULL,
                    review_note = %s
                WHERE id = %s AND status = %s RETURNING {_COLUMNS}
            """, (WAITING, f"Drafting cancelled by {username}.", layout_id, DRAFTING))
            row = cur.fetchone()
    if row is None:
        raise LookupError(layout_id)
    return _row(row)


def finish_draft(layout_id: int, spec: dict, supplier: str, assumptions: list[str],
                 sample: dict, usage: dict) -> None:
    ensure_table()
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE pdf_layouts SET status = %s, spec = %s, supplier = %s, assumptions = %s,
                    sample = %s, model = %s, turns = %s, input_tokens = %s, output_tokens = %s,
                    cost_usd = %s, error = NULL, finished_at = NOW()
                WHERE id = %s AND status = %s
            """, (PROVISIONAL, json.dumps(spec), supplier, json.dumps(assumptions),
                  json.dumps(sample, default=str), usage.get("model"), usage.get("turns"),
                  usage.get("input_tokens"), usage.get("output_tokens"), usage.get("cost_usd"),
                  layout_id, DRAFTING))
    _invalidate()


def fail_draft(layout_id: int, error: str, usage: dict | None = None) -> None:
    ensure_table()
    usage = usage or {}
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE pdf_layouts SET status = %s, error = %s, model = %s, turns = %s,
                    input_tokens = %s, output_tokens = %s, cost_usd = %s, finished_at = NOW()
                WHERE id = %s AND status = %s
            """, (FAILED, error[:2000], usage.get("model"), usage.get("turns"),
                  usage.get("input_tokens"), usage.get("output_tokens"), usage.get("cost_usd"),
                  layout_id, DRAFTING))


# ---------------------------------------------------------------------------
# What Admin shows, and IT's answers
# ---------------------------------------------------------------------------

def get_layout(layout_id: int) -> dict | None:
    ensure_table()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _fail_stale(cur)
            cur.execute(f"SELECT {_COLUMNS} FROM pdf_layouts WHERE id = %s", (layout_id,))
            return _row(cur.fetchone())


def get_file(layout_id: int) -> tuple[str, bytes] | None:
    """The saved file and its name: a PDF, or a delivery JSON."""
    ensure_table()
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT file_name, pdf, kind FROM pdf_layouts WHERE id = %s", (layout_id,))
            row = cur.fetchone()
    if not row or not row[1]:
        return None
    return row[0] or f"invoice-{layout_id}.{row[2]}", bytes(row[1])


def list_layouts(statuses: list[str] | None, limit: int = 100) -> list[dict]:
    ensure_table()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _fail_stale(cur)
            if statuses:
                cur.execute(f"""SELECT {_COLUMNS} FROM pdf_layouts WHERE status = ANY(%s)
                                ORDER BY id DESC LIMIT %s""", (statuses, limit))
            else:
                cur.execute(f"SELECT {_COLUMNS} FROM pdf_layouts ORDER BY id DESC LIMIT %s", (limit,))
            return [_row(r) for r in cur.fetchall()]


def pending_count() -> int:
    """What IT still has to look at (FOR_IT)."""
    ensure_table()
    with _conn() as conn:
        with conn.cursor() as cur:
            _fail_stale(cur)
            cur.execute("SELECT COUNT(*) FROM pdf_layouts WHERE status = ANY(%s)", (list(FOR_IT),))
            return int(cur.fetchone()[0])


def review(layout_id: int, decision: str, username: str, note: str | None) -> dict:
    """IT's answer on a drafted layout: verify it or reject it. A rejected
    layout reads nothing; the answer can be changed."""
    if decision not in ("verify", "reject"):
        raise ValueError(f"Unknown decision: {decision}")
    ensure_table()
    status = VERIFIED if decision == "verify" else REJECTED
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                UPDATE pdf_layouts SET status = %s, reviewed_by = %s, reviewed_at = NOW(),
                    review_note = %s
                WHERE id = %s AND status = ANY(%s) AND spec IS NOT NULL RETURNING {_COLUMNS}
            """, (status, username, (note or "").strip() or None, layout_id,
                  [PROVISIONAL, VERIFIED, REJECTED]))
            row = cur.fetchone()
    if row is None:
        raise LookupError(layout_id)
    _invalidate()
    return _row(row)


def close(layout_id: int, username: str, note: str | None) -> dict:
    """IT has added this invoice's layout to pdf_layouts.py, or set the
    invoice aside: it leaves the list of things to do. A drafted layout goes
    too, since the one in code now reads the supplier's invoices first."""
    ensure_table()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                UPDATE pdf_layouts SET status = %s, reviewed_by = %s, reviewed_at = NOW(),
                    review_note = %s
                WHERE id = %s AND status = ANY(%s) RETURNING {_COLUMNS}
            """, (CLOSED, username, (note or "").strip() or None, layout_id,
                  [WAITING, FAILED, PROVISIONAL, VERIFIED, REJECTED]))
            row = cur.fetchone()
    if row is None:
        raise LookupError(layout_id)
    _invalidate()
    return _row(row)


def reading_layouts(kind: str = "pdf") -> list[dict]:
    """The stored layouts of this kind that read files, newest first, so a
    layout drafted after an older one of the same supplier failed is tried
    before it."""
    global _cache
    with _cache_lock:
        cached = (_cache or {}).get(kind)
        if cached and time.monotonic() - cached[0] < _CACHE_SECONDS:
            return cached[1]
    ensure_table()
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""SELECT id, status, supplier, spec, assumptions FROM pdf_layouts
                           WHERE status = ANY(%s) AND kind = %s AND spec IS NOT NULL
                           ORDER BY id DESC""",
                        (list(READING), kind))
            rows = [dict(r) for r in cur.fetchall()]
    with _cache_lock:
        _cache = {**(_cache or {}), kind: (time.monotonic(), rows)}
    return rows


# ---------------------------------------------------------------------------
# Running a stored layout, away from the server process
# ---------------------------------------------------------------------------

class IsolatedTimeout(RuntimeError):
    """A stored layout took longer than its time limit over one invoice."""


def _child_main(conn, module: str, name: str, args: tuple) -> None:
    try:
        result = getattr(importlib.import_module(module), name)(*args)
        conn.send(("ok", result))
    except BaseException as exc:  # the parent must hear of every failure
        conn.send(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def run_isolated(fn, *args, timeout: float = ISOLATED_TIMEOUT):
    """fn(*args) in a separate process, stopped after `timeout` seconds. fn
    must be a module-level function; its result must pickle."""
    if "forkserver" in multiprocessing.get_all_start_methods():
        # A clean process to fork from, not the server with its threads; and
        # without importing the server's own module (python api_server.py is
        # __main__ on Railway): the child needs only this module.
        ctx = multiprocessing.get_context("forkserver")
        ctx.set_forkserver_preload([])
    else:  # Windows, for local runs
        ctx = multiprocessing.get_context("spawn")
    parent, child = ctx.Pipe(duplex=False)
    process = ctx.Process(target=_child_main, args=(child, fn.__module__, fn.__name__, args),
                          daemon=True)
    process.start()
    child.close()
    try:
        if not parent.poll(timeout):
            raise IsolatedTimeout(f"stopped after {timeout:g} seconds")
        kind, value = parent.recv()
    except EOFError:
        kind, value = "error", "the process ended without an answer"
    finally:
        if process.is_alive():
            process.terminate()
        process.join(5)
        parent.close()
    if kind == "error":
        raise RuntimeError(value)
    return value


def read_with_layouts(pdf: bytes, layouts: list[tuple[int, dict]]) -> dict:
    """Run in the isolated process: the first stored layout whose detect finds
    this invoice and whose reading agrees with the printed totals.

    {"id": layout id, "order": DeliveryOrder} on success, else
    {"id": None, "failures": [(layout id, message), …]}.
    """
    import re

    from parser_delivery_pdf import PdfParseError, extract_pdf, parse_with_spec
    from pdf_layout_json import LayoutJsonError, spec_from_dict

    doc = extract_pdf(pdf)
    failures = []
    for layout_id, data in layouts:
        try:
            spec = spec_from_dict(data)
        except LayoutJsonError as exc:
            failures.append((layout_id, f"not a valid layout: {exc}"))
            continue
        if not re.search(spec.detect, doc.text, re.IGNORECASE):
            continue
        try:
            read_doc = extract_pdf(pdf, **spec.extract) if spec.extract else doc
            return {"id": layout_id, "order": parse_with_spec(read_doc, spec)}
        except PdfParseError as exc:
            failures.append((layout_id, str(exc)))
    return {"id": None, "failures": failures}


def try_layout(pdf: bytes, data: dict, max_lines: int = 80) -> dict:
    """Run in the isolated process, for a layout being drafted: what the
    layout reads from this invoice, or why it cannot, in a form the model
    drafting it can act on. ok means the invoice's own totals agree."""
    import dataclasses
    import re

    import parser_delivery_pdf as engine
    from pdf_layout_json import LayoutJsonError, spec_from_dict

    out: dict = {"ok": False}
    try:
        spec = spec_from_dict(data)
    except LayoutJsonError as exc:
        out["error"] = f"not a valid layout: {exc}"
        return out
    if spec.row_model != "boxes":
        out["error"] = 'row_model must be "boxes"'
        return out
    doc = engine.extract_pdf(pdf)
    out["detected"] = bool(re.search(spec.detect, doc.text, re.IGNORECASE))
    read_doc = engine.extract_pdf(pdf, **spec.extract) if spec.extract else doc
    try:
        order = engine.parse_with_spec(read_doc, spec)
    except engine.PdfParseError as exc:
        out["error"] = str(exc)
        # What the rows looked like to the engine, to see a wrong column or
        # a line pattern that matched nothing.
        try:
            resolved = engine._resolve_columns(read_doc, spec)
            if resolved.lines:
                rows = engine._text_rows(read_doc, resolved)
            else:
                rows = [f for r in engine._grid_rows(read_doc, resolved.grid_header)
                        if (f := engine._table_row_fields(r, resolved)) is not None]
            out["rows_read"] = [{k: v for k, v in r.items() if not k.startswith("_") and v}
                                for r in rows[:25]]
            out["rows_read_count"] = len(rows)
        except Exception as inner:  # the diagnosis is a courtesy
            out["rows_read_error"] = str(inner)
        return out
    num = engine._num_comma if spec.decimal == "," else engine._num
    out.update({
        "ok": out["detected"],
        "header": {k: getattr(order, k) for k in ("tx_company", "id_invoice", "id_purchaseorder",
                                                  "dt_invoice", "dt_fly", "nm_ship", "nm_cargo",
                                                  "tx_awb", "tx_hawb")},
        "boxes": order.nu_boxes, "stems": order.nu_stems_total, "amount": order.mny_total,
        "bunches": sum(l.nu_bunches for l in order.lines),
        "printed_totals_checked": engine._printed_totals(read_doc, spec, num, {}),
        "lines": [
            f"{l.nm_box} x{l.nu_physical_boxes} | {l.nm_species} | {l.nm_variety} | {l.nu_length}cm"
            f" | {l.nu_bunches} bunches x {l.nu_stems_bunch} | {l.mny_rate_stem:g}/stem"
            f" | {l.nm_location} | {l.nm_product}"
            for l in order.lines[:max_lines]
        ],
        "line_count": len(order.lines),
    })
    if not out["detected"]:
        out["error"] = "detect does not match this invoice's text"
    if out["ok"]:
        out["order"] = dataclasses.asdict(order)
    return out


def _provisional(row: dict, orders: list) -> list:
    """A provisional layout's orders carry a warning naming it and its
    assumptions, which the delivery screen shows."""
    if row["status"] == PROVISIONAL:
        for order in orders:
            order.warnings.append({
                "code": "provisional_pdf_layout",
                "layout_id": row["id"],
                "supplier": row.get("supplier") or order.tx_company,
                "assumptions": list(row.get("assumptions") or []),
            })
    return orders


def parse_with_stored(pdf: bytes):
    """The invoice read by a stored layout, as parse_delivery_pdf returns it,
    or None when none reads it."""
    try:
        layouts = reading_layouts("pdf")
    except Exception as exc:  # no database here, or it is down: as if none stored
        log.warning("[pdf-layouts] stored layouts unavailable: %s", exc)
        return None
    if not layouts:
        return None
    try:
        result = run_isolated(read_with_layouts, pdf, [(r["id"], r["spec"]) for r in layouts])
    except (IsolatedTimeout, RuntimeError) as exc:
        log.warning("[pdf-layouts] stored layouts could not read the file: %s", exc)
        return None
    if result["id"] is None:
        for layout_id, message in result["failures"]:
            log.info("[pdf-layouts] stored layout %s found the invoice but: %s", layout_id, message)
        return None
    row = next(r for r in layouts if r["id"] == result["id"])
    log.info("[pdf-layouts] read with stored layout %s (%s)", row["id"], row["status"])
    return _provisional(row, [result["order"]])


def parse_json_with_stored(data):
    """A delivery JSON read by a stored layout (json_layout), as
    parse_delivery_json returns it, or None when none reads it."""
    try:
        layouts = reading_layouts("json")
    except Exception as exc:  # no database here, or it is down: as if none stored
        log.warning("[pdf-layouts] stored JSON layouts unavailable: %s", exc)
        return None
    if not layouts:
        return None
    import json_layout
    try:
        result = run_isolated(json_layout.read_with_layouts, data,
                              [(r["id"], r["spec"]) for r in layouts])
    except (IsolatedTimeout, RuntimeError) as exc:
        log.warning("[pdf-layouts] stored JSON layouts could not read the file: %s", exc)
        return None
    if result["id"] is None:
        for layout_id, message in result["failures"]:
            log.info("[pdf-layouts] stored JSON layout %s found the file but: %s",
                     layout_id, message)
        return None
    row = next(r for r in layouts if r["id"] == result["id"])
    log.info("[pdf-layouts] JSON read with stored layout %s (%s)", row["id"], row["status"])
    return _provisional(row, result["orders"])
