"""HTTP client for the FreshPortal BI Sync export API (same host/auth as the
DFG BatchV1 API — POST /v1/auth bearer-token flow, BI_SYNC_API_KEY as the
"username"). GET /v2/export?mutation_datetime=YYYY-MM-DD returns a presigned
S3 URL to a ZIP containing one file per exported table.

This is a read-only mirror source for the planned internal analytics tool
(stock_entry / order_lines) — nothing here writes back to FreshPortal.
"""
from __future__ import annotations

import csv
import io
import logging
import zipfile
from typing import Any

import httpx

from config import Config

log = logging.getLogger(__name__)

_token: str | None = None


class BiSyncError(Exception):
    """Non-recoverable BI Sync failure (auth, network, unexpected response)."""


def _authenticate(cfg: Config) -> str:
    resp = httpx.post(
        f"{cfg.bi_sync_api_base_url}/v1/auth",
        json={"username": cfg.bi_sync_api_key, "type": "api"},
        timeout=30,
    )
    resp.raise_for_status()
    token = resp.json().get("token")
    if not token:
        raise BiSyncError(f"Auth response missing 'token': {resp.text}")
    return token


def _get_token(cfg: Config, force_refresh: bool = False) -> str:
    global _token
    if force_refresh or _token is None:
        _token = _authenticate(cfg)
    return _token


def get_export_url(cfg: Config, mutation_datetime: str) -> str:
    """GET /v2/export?mutation_datetime=YYYY-MM-DD — returns a presigned S3
    URL (valid ~10 minutes) to a ZIP of every table mutated since that date."""
    url = f"{cfg.bi_sync_api_base_url}/v2/export"
    headers = {"Authorization": f"Bearer {_get_token(cfg)}"}
    resp = httpx.get(url, headers=headers, params={"mutation_datetime": mutation_datetime}, timeout=30)
    if resp.status_code == 401:
        headers["Authorization"] = f"Bearer {_get_token(cfg, force_refresh=True)}"
        resp = httpx.get(url, headers=headers, params={"mutation_datetime": mutation_datetime}, timeout=30)
    resp.raise_for_status()
    export_url = resp.json().get("export_url")
    if not export_url:
        raise BiSyncError(f"Export response missing 'export_url': {resp.text}")
    return export_url


def download_export_zip(export_url: str) -> bytes:
    """The export_url is a presigned S3 URL — no auth headers needed, just GET it."""
    resp = httpx.get(export_url, timeout=120)
    resp.raise_for_status()
    return resp.content


def _sniff_and_read_csv(raw: bytes, sample_rows: int = 3) -> dict[str, Any]:
    """Best-effort CSV read: sniff delimiter, decode, return header/sample/row count."""
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        return {"error": "could not decode as text"}

    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel

    reader = csv.reader(io.StringIO(text), dialect)
    rows = list(reader)
    if not rows:
        return {"columns": [], "row_count": 0, "sample_rows": []}

    header, data_rows = rows[0], rows[1:]
    return {
        "columns": header,
        "row_count": len(data_rows),
        "sample_rows": data_rows[:sample_rows],
    }


def summarize_export(zip_bytes: bytes, tables_of_interest: tuple[str, ...] = (), sample_rows: int = 3) -> dict[str, Any]:
    """Return {filename: {columns, row_count, sample_rows}} for every file in the
    zip (or only files matching `tables_of_interest`, matched by substring on
    the filename stem, case-insensitive)."""
    result: dict[str, Any] = {"files_in_zip": [], "tables": {}}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        result["files_in_zip"] = zf.namelist()
        for name in zf.namelist():
            if tables_of_interest:
                stem = name.rsplit("/", 1)[-1].lower()
                if not any(t.lower() in stem for t in tables_of_interest):
                    continue
            try:
                raw = zf.read(name)
                result["tables"][name] = _sniff_and_read_csv(raw, sample_rows=sample_rows)
            except Exception as exc:
                result["tables"][name] = {"error": str(exc)}
    return result


def pull_and_summarize(cfg: Config, mutation_datetime: str, tables_of_interest: tuple[str, ...] = (), sample_rows: int = 3) -> dict[str, Any]:
    """End-to-end: authenticate, request the export, download the zip, summarize it."""
    export_url = get_export_url(cfg, mutation_datetime)
    zip_bytes = download_export_zip(export_url)
    summary = summarize_export(zip_bytes, tables_of_interest=tables_of_interest, sample_rows=sample_rows)
    summary["export_url_host"] = export_url.split("?", 1)[0]
    summary["zip_size_bytes"] = len(zip_bytes)
    return summary
