"""HTTP client for the FreshPortal DFG BatchV1 API (Coloriginz / system 850255).

Replaces the Playwright-based scraper_delivery.py flow for creating deliveries:
bearer-token auth, GET (check whether a shipment already exists), POST (create
shipment + stock entries, with partial-success error reporting).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

from config import Config
from db import find_supplier_fp_id
from parser_delivery import (
    DeliveryLine,
    DeliveryOrder,
    _normalise_box,
    _resolve_grower_id,
)

log = logging.getLogger(__name__)

# This integration only ever handles Ecuador-origin flowers — hardcoded per
# explicit decision (2026-08-12), not derived from any field in the source JSON.
_COUNTRY = "EC"


class DfgApiError(Exception):
    """Non-recoverable DFG API failure (auth, network, unexpected HTTP status,
    or a payload that's missing data required before it can even be sent)."""


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


_token: str | None = None


def _authenticate(cfg: Config) -> str:
    """Exchange the DFG API key for a bearer token via POST /v1/auth."""
    resp = httpx.post(
        f"{cfg.dfg_api_base_url}/v1/auth",
        json={"username": cfg.dfg_api_key, "type": "api"},
        timeout=30,
    )
    resp.raise_for_status()
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
    """Send an authenticated request, retrying once with a fresh token on 401."""
    url = f"{cfg.dfg_api_base_url}{path}"
    headers = {"Authorization": f"Bearer {_get_token(cfg)}", "Content-Type": "application/json"}
    resp = httpx.request(method, url, headers=headers, timeout=30, **kwargs)
    if resp.status_code == 401:
        headers["Authorization"] = f"Bearer {_get_token(cfg, force_refresh=True)}"
        resp = httpx.request(method, url, headers=headers, timeout=30, **kwargs)
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
    resp.raise_for_status()
    return resp.json()


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

    manufacturer_id = _resolve_grower_id(line.nm_location)
    if not manufacturer_id:
        log.warning("No grower mapping for nm_location=%r (product %r) — omitting manufacturer_id",
                    line.nm_location, line.nm_product)

    entry: dict[str, Any] = {
        "product_number": line.fp_product_id,
        "country": _COUNTRY,
        "fust": fust,
        "quantity": line.nu_physical_boxes,
        "quantity_per_pack": line.nu_stems_total,
        "weight": line.nu_weight,
        "box_weight": line.nu_box_weight,
        "price": line.mny_rate_stem,
        "characteristics": {
            "length": line.nu_length,
            # FreshPortal has no equivalent data for these — always sent as fixed values
            # per explicit decision (2026-08-24).
            "quality": "AA",
            "maturity": "033",
            "number_of_bunches": str(line.nu_bunches),
            "stems_per_bunch": str(line.nu_stems_bunch),
        },
    }
    if manufacturer_id:
        entry["manufacturer_id"] = int(manufacturer_id)
    return entry


def build_batch_payload(order: DeliveryOrder, customer_id: int | None = None) -> dict[str, Any]:
    """Build the full DFG BatchV1 POST body from a parsed DeliveryOrder.

    `order.supplier_fp_id` must already be resolved (matched from tx_company
    against the local supplier DB) before calling this. `customer_id` is
    optional — omitting it creates the shipment without an invoice.
    """
    if not order.supplier_fp_id:
        raise DfgApiError(f"supplier_fp_id not resolved for {order.tx_company!r} — cannot build payload")

    payload: dict[str, Any] = {
        "number": order.id_invoice,
        "date": _to_iso_date(order.dt_invoice),
        "delivery_date": _to_iso_date(order.dt_fly),
        "supplier_id": int(order.supplier_fp_id),
        "stock_entries": [build_stock_entry(line) for line in order.lines],
    }
    if customer_id:
        payload["customer_id"] = customer_id
    return payload


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
    )


def _batch_url(cfg: Config, batch_id: int | None) -> str:
    """FreshPortal web UI link to view a batch. Same URL the old Playwright
    scraper landed on after submitting the batch form (batch_v2 module) —
    still valid for batches created via the DFG API."""
    if not batch_id:
        return ""
    return f"{cfg.freshportal_url}/batch_v2/stock_entry/index/BAT_ID/{batch_id}/"


def create_batch(cfg: Config, payload: dict[str, Any]) -> BatchResult:
    """POST /dfg/v1/batch — create a new shipment. Always returns a BatchResult
    on HTTP 200; check `.errors` for lines that failed individually (partial
    success). Must be preceded by get_batch() to avoid creating a duplicate."""
    resp = _request(cfg, "POST", "/dfg/v1/batch", json=payload)
    resp.raise_for_status()
    result = _parse_batch_response(resp.json(), fallback_number=payload.get("number", ""))
    result.batch_url = _batch_url(cfg, result.batch_id)
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
    resp.raise_for_status()
    result = _parse_batch_response(resp.json())
    result.batch_url = _batch_url(cfg, result.batch_id or batch_id)
    return result
