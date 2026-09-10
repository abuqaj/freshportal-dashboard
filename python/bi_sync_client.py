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
import re
import zipfile
from typing import Any

import httpx

from config import Config

log = logging.getLogger(__name__)

_tokens: dict[tuple[str, str], str] = {}


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
    """Cached per (base URL, API key), not globally.

    A single shared token was fine while there was exactly one BI Sync
    server. A second tenant on a different key and host (Kenya, 2026-09-09)
    would otherwise be handed whichever token was cached first — and the
    failure mode is not necessarily a loud 401: the wrong tenant's token can
    authenticate perfectly well and return the wrong system's export."""
    key = (cfg.bi_sync_api_base_url, cfg.bi_sync_api_key)
    if force_refresh or key not in _tokens:
        _tokens[key] = _authenticate(cfg)
    return _tokens[key]


def get_export_url(cfg: Config, mutation_datetime: str) -> str:
    """GET /v2/export?mutation_datetime=YYYY-MM-DD — returns a presigned S3
    URL (valid ~10 minutes) to a ZIP of every table mutated since that date.

    A wide "since" window means FreshPortal has to assemble a larger export
    before it can respond, so this can legitimately take longer than a
    routine call — 60s rather than 30s (bumped alongside the range-backfill
    chunking fix, 2026-09-03)."""
    url = f"{cfg.bi_sync_api_base_url}/v2/export"
    headers = {"Authorization": f"Bearer {_get_token(cfg)}"}
    resp = httpx.get(url, headers=headers, params={"mutation_datetime": mutation_datetime}, timeout=60)
    if resp.status_code == 401:
        headers["Authorization"] = f"Bearer {_get_token(cfg, force_refresh=True)}"
        resp = httpx.get(url, headers=headers, params={"mutation_datetime": mutation_datetime}, timeout=60)
    resp.raise_for_status()
    export_url = resp.json().get("export_url")
    if not export_url:
        raise BiSyncError(f"Export response missing 'export_url': {resp.text}")
    return export_url


def download_export_zip(export_url: str) -> bytes:
    """The export_url is a presigned S3 URL — no auth headers needed, just
    GET it. Bumped from 120s to 300s alongside the range-backfill chunking
    fix (2026-09-03): a wide "since" window can still produce a sizable
    zip even capped at a 6-month chunk."""
    resp = httpx.get(export_url, timeout=300)
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


def _decode_csv_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise BiSyncError("could not decode CSV as text (tried utf-8-sig, utf-8, latin-1)")


def read_csv_rows(raw: bytes) -> list[dict[str, str]]:
    """Full CSV read (unlike _sniff_and_read_csv, which only samples a few rows
    for the debug endpoint) — every row as {column_name: value}."""
    text = _decode_csv_text(raw)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    return [dict(row) for row in reader]


# A numbered suffix marking one part of a split table: "order_line_1",
# "order_line.2", "order_line-part3". Requires trailing digits, so a
# genuinely different table like "order_line_status" can never match.
_TABLE_PART_RE = re.compile(r"^(?P<base>.+?)[._-]?(?:part[._-]?)?(?P<num>\d+)$")


def list_export_files(zip_bytes: bytes) -> list[tuple[str, int]]:
    """Every entry in the export with its uncompressed size — logged each run
    so a short table can be traced to the zip instead of guessed at."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        return [(i.filename, i.file_size) for i in zf.infolist()]


def find_table_files(zip_bytes: bytes, table_name: str) -> list[str]:
    """Every zip entry belonging to one logical table, parts in order.

    A large export splits a table across numbered parts. Returning only the
    first one silently truncated the table: an export carrying 651k
    stock_entry rows yielded just 13.5k order_lines, because only the first
    order_line part was ever read (found 2026-09-07).

    Exact and part matches are preferred over a substring match, which is
    kept only as a last resort — a pure substring match once picked
    "batch_supplier" for "supplier" (2026-09-02).
    """
    target = table_name.lower()
    exact: list[str] = []
    parts: list[tuple[int, str]] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()

    for name in names:
        base = name.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
        if base == target:
            exact.append(name)
            continue
        m = _TABLE_PART_RE.match(base)
        if m and m.group("base").rstrip("._-") == target:
            parts.append((int(m.group("num")), name))

    if exact or parts:
        return exact + [n for _, n in sorted(parts)]

    for name in names:
        if target in name.rsplit("/", 1)[-1].lower():
            return [name]
    return []


def find_table_file(zip_bytes: bytes, table_name: str) -> str | None:
    """First entry for a table — kept for callers that only need a name."""
    files = find_table_files(zip_bytes, table_name)
    return files[0] if files else None


def read_table(zip_bytes: bytes, table_name: str) -> list[dict[str, str]]:
    """Read every row of one table, concatenating split parts. Returns [] if
    the table isn't present in this export."""
    names = find_table_files(zip_bytes, table_name)
    if not names:
        return []
    rows: list[dict[str, str]] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in names:
            rows.extend(read_csv_rows(zf.read(name)))
    return rows
