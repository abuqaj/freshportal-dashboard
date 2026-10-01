"""Every delivery parse on record, and its file kept for a while (2026-10-01).

The user wants each parse logged with its kind of file (pdf, txt, json) and
the files kept two months. A file is kept once however often it is parsed,
and dropped once nobody has parsed it for RETENTION_DAYS, or oldest first
past MAX_FILES_MB.

Needs Postgres (KB_TEST_POSTGRES_URL or POSTGRES_URL), and runs in a
temporary schema dropped afterwards, as test_pdf_layout_drafts does.

Run either way:
    python -m pytest python/tests/test_delivery_parse_log.py -q
    python python/tests/test_delivery_parse_log.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import delivery_parse_log as parse_log  # noqa: E402

_DB_URL = os.getenv("KB_TEST_POSTGRES_URL") or os.getenv("POSTGRES_URL") or ""
pytestmark = pytest.mark.skipif(not _DB_URL, reason="set KB_TEST_POSTGRES_URL to a Postgres to run")


@pytest.fixture
def db(monkeypatch):
    import contextlib
    import uuid

    import psycopg2

    schema = "parse_log_test_" + uuid.uuid4().hex[:12]
    admin = psycopg2.connect(_DB_URL)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f'CREATE SCHEMA "{schema}"')

    @contextlib.contextmanager
    def scoped():
        conn = psycopg2.connect(_DB_URL)
        try:
            with conn.cursor() as cur:
                cur.execute(f'SET search_path TO "{schema}"')
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    monkeypatch.setattr(parse_log, "_conn", scoped)
    monkeypatch.setattr(parse_log, "_table_ready", False)
    monkeypatch.setattr(parse_log, "_last_prune", 0.0)
    try:
        yield scoped
    finally:
        with admin.cursor() as cur:
            cur.execute(f'DROP SCHEMA "{schema}" CASCADE')
        admin.close()


def _order(company: str = "QUALISA", invoice: str = "0012", lines: int = 3):
    return SimpleNamespace(tx_company=company, id_invoice=invoice, lines=[object()] * lines)


def test_every_parse_is_on_record_and_its_file_kept_once(db):
    parse_log.record("anna", "txt", "qualisa.txt", b'{"invoices": []}', parse_log.READ, [_order()])
    parse_log.record("piet", "txt", "qualisa (1).txt", b'{"invoices": []}', parse_log.READ, [_order()])
    parse_log.record("anna", "pdf", "x.pdf", b"%PDF-1.4", parse_log.UNKNOWN_FORMAT, error="no layout")
    shown = parse_log.recent()
    assert [p["file_kind"] for p in shown["parses"]] == ["pdf", "txt", "txt"]
    assert shown["parses"][1]["tx_company"] == "QUALISA" and shown["parses"][1]["nu_lines"] == 3
    assert shown["parses"][0]["outcome"] == "unknown_format" and shown["parses"][0]["error"] == "no layout"
    assert shown["files_kept"] == 2 and all(p["file_kept"] for p in shown["parses"])
    assert not shown["hasMore"]
    page = parse_log.recent(limit=2, offset=1)
    assert [p["file_kind"] for p in page["parses"]] == ["txt", "txt"] and not page["hasMore"]
    assert parse_log.recent(limit=2)["hasMore"]
    newest_txt = shown["parses"][1]["id"]
    assert parse_log.get_file(newest_txt) == ("qualisa (1).txt", "txt", b'{"invoices": []}')


def test_files_not_parsed_for_the_retention_period_go(db):
    parse_log.record("anna", "pdf", "old.pdf", b"old", parse_log.READ)
    parse_log.record("anna", "pdf", "new.pdf", b"new", parse_log.READ)
    with db() as conn, conn.cursor() as cur:
        cur.execute("UPDATE delivery_parse_files SET last_seen = NOW() - INTERVAL '61 days' "
                    "WHERE file_name = 'old.pdf'")
    assert parse_log.prune(force=True) == 1
    shown = parse_log.recent()
    kept = {p["file_name"]: p["file_kept"] for p in shown["parses"]}
    assert kept == {"old.pdf": False, "new.pdf": True}
    # The parse stays on record after its file has gone.
    assert len(shown["parses"]) == 2


def test_past_the_cap_the_oldest_files_go_first(db, monkeypatch):
    monkeypatch.setattr(parse_log, "MAX_FILES_MB", 2.5 / 1024)  # 2.5 KB
    for n in range(3):
        parse_log.record("anna", "json", f"{n}.json", bytes([n]) * 1024, parse_log.READ)
        with db() as conn, conn.cursor() as cur:
            cur.execute("UPDATE delivery_parse_files SET last_seen = NOW() - %s * INTERVAL '1 hour' "
                        "WHERE file_name = %s", (3 - n, f"{n}.json"))
    parse_log.prune(force=True)
    kept = {p["file_name"] for p in parse_log.recent()["parses"] if p["file_kept"]}
    assert kept == {"1.json", "2.json"}


def test_no_retention_keeps_no_files(db, monkeypatch):
    monkeypatch.setattr(parse_log, "RETENTION_DAYS", 0)
    parse_log.record("anna", "json", "a.json", b"{}", parse_log.READ)
    shown = parse_log.recent()
    assert len(shown["parses"]) == 1 and shown["files_kept"] == 0


def test_a_failing_log_never_fails_the_parse(monkeypatch):
    def broken():
        raise RuntimeError("database down")
    monkeypatch.setattr(parse_log, "_conn", broken)
    monkeypatch.setattr(parse_log, "_table_ready", False)
    parse_log.record("anna", "pdf", "a.pdf", b"x", parse_log.READ)  # does not raise


if __name__ == "__main__":
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
