"""HTTP client for the FreshPortal DFG BatchV1 API (Coloriginz / system 850255).

Replaces the Playwright-based scraper_delivery.py flow for creating deliveries:
bearer-token auth, GET (check whether a shipment already exists), POST (create
shipment + stock entries, with partial-success error reporting).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import httpx

from config import Config
from db import find_supplier_fp_id
from parser_delivery import (
    DeliveryLine,
    DeliveryOrder,
    _normalise_box,
)

log = logging.getLogger(__name__)

# This integration only ever handles Ecuador-origin flowers — hardcoded per
# explicit decision (2026-08-12), not derived from any field in the source JSON.
_COUNTRY = "EC"


class DfgApiError(Exception):
    """Non-recoverable DFG API failure (auth, network, unexpected HTTP status,
    or a payload that's missing data required before it can even be sent)."""


def _raise_for_status_with_body(resp: httpx.Response) -> None:
    """resp.raise_for_status() alone only gives "422 Unprocessable Entity for
    url ..." with no indication of *why* — the actual validation error (e.g.
    which field DFG rejected) is in the response body, which raise_for_status()
    doesn't include in its message. Callers were previously swallowing that
    body entirely, making failures like a rejected customer_id impossible to
    diagnose from the error the UI showed (found 2026-09-01)."""
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise DfgApiError(f"{exc} — response body: {resp.text}") from exc


@dataclass
class BatchLineError:
    product_number: str
    length: int
    message: str


@dataclass
class BatchResult:
    batch_id: int | None
    number: str
    created: bool  # True if the batch was created (i.e. any stock_entries succeeded)
    stock_entries_ok: list[dict[str, Any]]
    errors: list[BatchLineError]
    raw: dict[str, Any]
    batch_url: str = ""  # FreshPortal web UI link to view the batch, set once batch_id is known
    invoice_id: int | None = None  # Invoice the batch was allocated to (2026-08-26 API change)
    invoice_url: str = ""  # FreshPortal web UI link to view that invoice


_token: str | None = None

# One pooled client for every DFG call. httpx.request()/httpx.post() build and
# throw away a client per call, which means a fresh TCP connect and TLS
# handshake every time — paid on each of the three calls a single import makes,
# and again on every invoice-picker lookup. Keeping the connection alive across
# calls removes that handshake from all but the first. Safe to share: an
# httpx.Client is thread-safe, and FastAPI runs these sync endpoints in a
# threadpool.
_client: httpx.Client | None = None


def _get_client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(
            timeout=30,
            limits=httpx.Limits(max_keepalive_connections=8, keepalive_expiry=120),
        )
    return _client


def _authenticate(cfg: Config) -> str:
    """Exchange the DFG API key for a bearer token via POST /v1/auth."""
    resp = _get_client().post(
        f"{cfg.dfg_api_base_url}/v1/auth",
        json={"username": cfg.dfg_api_key, "type": "api"},
        timeout=30,
    )
    _raise_for_status_with_body(resp)
    token = resp.json().get("token")
    if not token:
        raise DfgApiError(f"Auth response missing 'token': {resp.text}")
    return token


def _get_token(cfg: Config, force_refresh: bool = False) -> str:
    global _token
    if force_refresh or _token is None:
        _token = _authenticate(cfg)
    return _token


def _request(cfg: Config, method: str, path: str, **kwargs: Any) -> httpx.Response:
    """Send an authenticated request, retrying once with a fresh token on 401.

    Logs how long DFG took and how much it sent back, so a slow screen can be
    pinned on this call rather than guessed at.
    """
    url = f"{cfg.dfg_api_base_url}{path}"
    headers = {"Authorization": f"Bearer {_get_token(cfg)}", "Content-Type": "application/json"}
    client = _get_client()
    started = time.monotonic()
    resp = client.request(method, url, headers=headers, **kwargs)
    if resp.status_code == 401:
        headers["Authorization"] = f"Bearer {_get_token(cfg, force_refresh=True)}"
        resp = client.request(method, url, headers=headers, **kwargs)
    log.info("[dfg] %s %s -> %s in %.0f ms, %.1f kB",
             method, path, resp.status_code,
             (time.monotonic() - started) * 1000, len(resp.content) / 1024)
    return resp


def get_batch(cfg: Config, supplier_id: str, batch_number: str) -> dict[str, Any] | None:
    """Check whether a shipment already exists. Returns the batch dict, or None if not found.

    Must be called before create_batch() for every delivery — the API does not
    enforce uniqueness on (supplier_id, number) itself; a duplicate POST creates
    a second, separate batch instead of being rejected or upserted (confirmed
    2026-08-12).
    """
    resp = _request(cfg, "GET", "/dfg/v1/batch", params={
        "supplier_id": supplier_id,
        "batch_number": batch_number,
    })
    # FreshPortal returns 204 (valid query, no matching shipment) as well as the
    # more conventional 404 — both mean "not found, safe to create" (2026-08-24).
    if resp.status_code in (204, 404):
        return None
    _raise_for_status_with_body(resp)
    return resp.json()


# How far back the invoice picker looks. "Open" at FreshPortal reaches years
# back — a test customer came back with invoices from 2024-07 — and a delivery
# is never allocated to one of those, so they are noise in a picker that has
# to be scanned by eye. Two months at first (2026-09-18), narrowed to two
# weeks: nothing older is ever picked (user, 2026-09-23).
OPEN_INVOICE_MAX_AGE_DAYS = 14


def _iso_date(value: str) -> date | None:
    """YYYY-MM-DD as the DFG API writes it, or None if it is anything else."""
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def get_open_invoices(cfg: Config, customer_id: int) -> list[dict[str, Any]]:
    """GET /dfg/v1/invoice_open — the customer's invoices that are still open,
    invoiced in the last OPEN_INVOICE_MAX_AGE_DAYS, latest departure first.

    Offered in the UI so a shipment can be allocated to an invoice that
    already exists instead of always creating a new one (2026-09-18 API
    change). The age limit is applied by DFG itself: invoice_date is a
    required parameter and the endpoint returns the invoices from that date
    up to today (final API shape, 2026-09-23).

    Returns [] rather than raising when the customer has none — an empty
    picker is a normal state ("this customer has no open invoice yet"), not
    an error. A 204 is treated the same way as the empty list, matching
    get_batch()'s handling of the same convention.
    """
    since = date.today() - timedelta(days=OPEN_INVOICE_MAX_AGE_DAYS)
    resp = _request(cfg, "GET", "/dfg/v1/invoice_open", params={
        "customer_id": int(customer_id),
        "invoice_date": since.isoformat(),
    })
    if resp.status_code in (204, 404):
        return []
    _raise_for_status_with_body(resp)
    data = resp.json() or {}

    rows = [
        {
            "id": inv.get("id"),
            "sequence": str(inv.get("sequence") or ""),
            "reference": str(inv.get("reference") or ""),
            "invoice_date": str(inv.get("invoice_date") or ""),
            "departure_date": str(inv.get("departure_date") or ""),
        }
        for inv in (data.get("invoices") or [])
        if inv.get("id")
    ]

    # Latest departure first, as the picker shows departure dates: the invoice
    # a delivery being imported today belongs to is almost always one of the
    # most recent ones. Rows without a readable departure date sort last.
    rows.sort(key=lambda r: _iso_date(r["departure_date"]) or date.min, reverse=True)
    return rows


def resolve_supplier(cfg: Config, order: DeliveryOrder) -> None:
    """Resolve order.supplier_fp_id from the local supplier DB (matched by tx_company), in place.

    Mirrors the explicit → DB lookup pattern already used in api_server.py's
    delivery-creation endpoint. No-op if supplier_fp_id is already set.
    """
    if order.supplier_fp_id:
        return
    order.supplier_fp_id = find_supplier_fp_id(cfg.freshportal_url, order.tx_company)


def _to_iso_date(dd_mm_yyyy: str) -> str:
    """DD-MM-YYYY (parser_delivery's normalised format) → YYYY-MM-DD for the DFG API."""
    parts = dd_mm_yyyy.strip().split("-")
    if len(parts) == 3:
        d, m, y = parts
        return f"{y}-{m.zfill(2)}-{d.zfill(2)}"
    return dd_mm_yyyy


def build_stock_entry(line: DeliveryLine) -> dict[str, Any]:
    """Build one `stock_entries[]` item for the DFG BatchV1 POST body from a parsed DeliveryLine."""
    if not line.fp_product_id:
        raise DfgApiError(
            f"product_number not resolved for {line.nm_product!r} — "
            "run catalogue matching / user confirmation before building the payload"
        )

    fust = _normalise_box(line.nm_box)

    # Resolved by resolve_growers() during /delivery/parse (and user-editable
    # for Pomarosa in the UI) — used as-is here, not re-resolved.
    manufacturer_id = line.manufacturer_id
    if not manufacturer_id:
        log.warning("No grower mapping for nm_location=%r (product %r) — omitting manufacturer_id",
                    line.nm_location, line.nm_product)

    # line.nu_bunches / nu_stems_total are TOTALS across every physical box merged
    # into this line (see parser_delivery._parse_invoices_format), but the DFG API
    # wants per-box figures — "quantity" already says how many physical boxes there
    # are, so number_of_bunches/quantity_per_pack must be per-box, not the sum
    # (bug found 2026-08-27: a 2-box, 4-bunch/box line was sent as 8 bunches —
    # FreshPortal read it as 2 boxes × 8 bunches instead of 2 boxes × 4).
    bunches_per_box = line.nu_bunches // max(1, line.nu_physical_boxes)
    stems_per_box = bunches_per_box * line.nu_stems_bunch

    entry: dict[str, Any] = {
        "product_number": line.fp_product_id,
        "country": _COUNTRY,
        "fust": fust,
        "quantity": line.nu_physical_boxes,
        "quantity_per_pack": stems_per_box,
        "weight": line.nu_weight,
        "box_weight": line.nu_box_weight,
        "price": line.mny_rate_stem,
        "characteristics": {
            "length": line.nu_length,
            # FreshPortal has no equivalent data for these — always sent as fixed values
            # per explicit decision (2026-08-24).
            "quality": "AA",
            "maturity": "033",
            "number_of_bunches": str(bunches_per_box),
            "stems_per_bunch": str(line.nu_stems_bunch),
        },
    }
    if manufacturer_id:
        entry["manufacturer_id"] = int(manufacturer_id)
    return entry


def build_batch_payload(
    order: DeliveryOrder,
    customer_id: int | None = None,
    invoice_id: int | None = None,
) -> dict[str, Any]:
    """Build the full DFG BatchV1 POST body from a parsed DeliveryOrder.

    `order.supplier_fp_id` must already be resolved (matched from tx_company
    against the local supplier DB) before calling this.

    The two allocation fields decide where the shipment's stock lands
    (2026-09-18 API change):

    * neither — the stock goes straight to stock, with no invoice allocation
      at all. This is what the picker's "Stock" option sends; it finally works
      as intended, having been blocked since 2026-09-02 by the API always
      creating an invoice.
    * customer_id only — DFG creates a new invoice for that customer and
      returns its id in the response.
    * customer_id + invoice_id — every product is allocated to that existing
      (still open) invoice, listed by get_open_invoices().

    Both are always sent as keys, with an explicit null when not provided,
    rather than omitted entirely — omitting customer_id outright returned 422
    Unprocessable Entity (found 2026-09-01), consistent with a schema that
    requires the key present-but-nullable rather than absent, and invoice_id
    arrived in the same body schema.
    """
    if not order.supplier_fp_id:
        raise DfgApiError(f"supplier_fp_id not resolved for {order.tx_company!r} — cannot build payload")

    return {
        "number": order.id_invoice,
        "date": _to_iso_date(order.dt_invoice),
        "delivery_date": _to_iso_date(order.dt_fly),
        "supplier_id": int(order.supplier_fp_id),
        "stock_entries": [build_stock_entry(line) for line in order.lines],
        "customer_id": customer_id,
        "invoice_id": invoice_id,
    }


def _parse_batch_response(data: dict[str, Any], fallback_number: str = "") -> BatchResult:
    batch = data.get("batch") or {}
    errors = [
        BatchLineError(
            product_number=e.get("product_number", ""),
            length=e.get("length", 0),
            message=e.get("message", ""),
        )
        for e in data.get("errors", [])
    ]
    return BatchResult(
        batch_id=batch.get("id"),
        number=batch.get("number", fallback_number),
        created=bool(batch.get("id")),
        stock_entries_ok=batch.get("stock_entries", []),
        errors=errors,
        raw=data,
        invoice_id=data.get("invoice_id") or batch.get("invoice_id"),
    )


def _batch_url(cfg: Config, batch_id: int | None) -> str:
    """FreshPortal web UI link to view a batch. Same URL the old Playwright
    scraper landed on after submitting the batch form (batch_v2 module) —
    still valid for batches created via the DFG API."""
    if not batch_id:
        return ""
    return f"{cfg.freshportal_url}/batch_v2/stock_entry/index/BAT_ID/{batch_id}/"


def _invoice_url(cfg: Config, invoice_id: int | None) -> str:
    """FreshPortal web UI link to view the invoice a batch was allocated to."""
    if not invoice_id:
        return ""
    return f"{cfg.freshportal_url}/invoice/invoice/details/INV_ID/{invoice_id}/"


def create_batch(cfg: Config, payload: dict[str, Any]) -> BatchResult:
    """POST /dfg/v1/batch — create a new shipment. Always returns a BatchResult
    on HTTP 200; check `.errors` for lines that failed individually (partial
    success). Must be preceded by get_batch() to avoid creating a duplicate."""
    resp = _request(cfg, "POST", "/dfg/v1/batch", json=payload)
    _raise_for_status_with_body(resp)
    result = _parse_batch_response(resp.json(), fallback_number=payload.get("number", ""))
    result.batch_url = _batch_url(cfg, result.batch_id)
    result.invoice_url = _invoice_url(cfg, result.invoice_id)
    return result


def add_stock_entries(cfg: Config, batch_id: int, supplier_id: str, lines: list[DeliveryLine]) -> BatchResult:
    """POST /dfg/v1/batch_stock_entry — add stock entries to an already-existing batch.

    Two use cases from the workflow:
    1. Retrying lines that came back in create_batch()'s `.errors` (e.g. after
       the product_number has been fixed via user confirmation).
    2. A GET showed the shipment already exists but is missing some products
       that are present in the source JSON — add just the missing ones.
    """
    payload = {
        "batch_id": batch_id,
        "supplier_id": int(supplier_id),
        "stock_entries": [build_stock_entry(line) for line in lines],
    }
    resp = _request(cfg, "POST", "/dfg/v1/batch_stock_entry", json=payload)
    _raise_for_status_with_body(resp)
    result = _parse_batch_response(resp.json())
    result.batch_url = _batch_url(cfg, result.batch_id or batch_id)
    result.invoice_url = _invoice_url(cfg, result.invoice_id)
    return result
