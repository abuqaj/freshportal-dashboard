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
from parser_delivery import (
    DeliveryLine,
    DeliveryOrder,
    _normalise_box,
    _resolve_grower_id,
    _PACKAGING_VOLUME_WEIGHT,
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
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


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
    volume_weight = _PACKAGING_VOLUME_WEIGHT.get(fust)
    if volume_weight is None:
        raise DfgApiError(f"No volume_weight mapping for fust {fust!r} (product {line.nm_product!r})")

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
        "volume_weight": volume_weight,
        "price": line.mny_rate_stem,
        "characteristics": {
            "length": line.nu_length,
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


def create_batch(cfg: Config, payload: dict[str, Any]) -> BatchResult:
    """POST a batch to FreshPortal. Always returns a BatchResult on HTTP 200 —
    check `.errors` for lines that failed individually (partial success)."""
    resp = _request(cfg, "POST", "/dfg/v1/batch", json=payload)
    resp.raise_for_status()
    data = resp.json()

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
        number=batch.get("number", payload.get("number", "")),
        created=bool(batch.get("id")),
        stock_entries_ok=batch.get("stock_entries", []),
        errors=errors,
        raw=data,
    )
