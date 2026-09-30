"""Temporary layouts for PDF invoices no layout reads (2026-09-28).

pdf_layout_json turns a layout into data and back; pdf_layout_store runs a
stored one in a separate process with a time limit; pdf_layout_ai lets a
model draft one. None of it needs the network or a database here: the model
is a stand-in that answers with tool calls, the database calls are replaced,
and the invoice is a small PDF built in the test.

Run either way:
    python -m pytest python/tests/test_pdf_layout_drafts.py -q
    python python/tests/test_pdf_layout_drafts.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import parser_delivery_pdf  # noqa: E402
import pdf_layout_ai  # noqa: E402
import pdf_layout_store as store  # noqa: E402
from parser_delivery_pdf import PdfUnknownLayoutError, parse_delivery_pdf  # noqa: E402
from pdf_layout_json import LayoutJsonError, spec_from_dict, spec_to_dict  # noqa: E402
from pdf_layouts import LAYOUTS  # noqa: E402


def _pdf(lines: list[str]) -> bytes:
    """A one-page PDF with these lines of text, in Helvetica."""
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    text = "BT /F1 10 Tf 14 TL 40 780 Td " + " ".join(f"({esc(l)}) Tj T*" for l in lines) + " ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R "
        "/Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(text)} >>\nstream\n{text}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = "%PDF-1.4\n", []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out.encode("latin-1")))
        out += f"{i} 0 obj\n{body}\nendobj\n"
    xref = len(out.encode("latin-1"))
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")


INVOICE = _pdf([
    "TEST FARM S.A.  RUC 1790000000001",
    "INVOICE 0001234",
    "DATE 21/09/2026",
    "1 QB MONDIAL 60 25 4 100 0.40 40.00",
    "2 HB EXPLORER 50 25 20 500 0.30 150.00",
    "TOTAL 3 24 600 190.00",
])

GOOD = {
    "name": "anything",
    "detect": r"TEST\s+FARM",
    "row_model": "boxes",
    "lines": [r"^(?P<count>\d+)\s+(?P<box>[A-Z]{2})\s+(?P<variety>.+?)\s+(?P<length>\d+)\s+"
              r"(?P<stems_bunch>\d+)\s+(?P<bunches>\d+)\s+(?P<stems>\d+)\s+(?P<rate>[\d.]+)\s+"
              r"(?P<subtotal>[\d.]+)\s*$"],
    "header": {
        "tx_company": {"const": "TEST FARM S.A."},
        "id_invoice": {"regex": r"INVOICE\s+(\d+)"},
        "dt_invoice": {"regex": r"DATE\s+(\S+)", "transform": "date_dmy"},
        "dt_fly": {"regex": r"DATE\s+(\S+)", "transform": "date_dmy"},
    },
    "species": "Roses",
    "totals_re": r"^TOTAL\s+(?P<boxes>\d+)\s+(?P<bunches>\d+)\s+(?P<stems>\d+)\s+(?P<amount>[\d.]+)",
}


# ---------------------------------------------------------------------------
# Layouts as data
# ---------------------------------------------------------------------------

def test_every_layout_in_code_writes_out_and_reads_back():
    for spec in LAYOUTS:
        data = json.loads(json.dumps(spec_to_dict(spec)))
        assert spec_to_dict(spec_from_dict(data)) == data, spec.name


@pytest.mark.parametrize("change, message", [
    ({"exec": "import os"}, "unknown fields"),
    ({"header": {**GOOD["header"], "dt_fly": {"regex": "(x)", "transform": "eval"}}}, "unknown transform"),
    ({"detect": "("}, "not a valid regex"),
    ({"header": {**GOOD["header"], "tx_company": {"python": "x"}}}, "a reader is one of"),
    ({"columns": {"count": "0"}}, "column indexes"),
    ({"extract": {"shell": True}}, "unknown option"),
])
def test_a_layout_as_data_takes_only_what_the_engine_knows(change, message):
    with pytest.raises(LayoutJsonError) as exc:
        spec_from_dict({**GOOD, **change})
    assert message in str(exc.value)


# ---------------------------------------------------------------------------
# Running a layout in its own process
# ---------------------------------------------------------------------------

def test_a_layout_is_tried_on_the_invoice():
    result = store.run_isolated(store.try_layout, INVOICE, GOOD)
    assert result["ok"] and result["detected"]
    assert (result["boxes"], result["stems"], result["amount"]) == (3, 600, 190.0)
    assert result["header"]["id_invoice"] == "0001234"


def test_a_wrong_layout_says_what_the_engine_read():
    bad = {**GOOD, "totals_re": r"^TOTAL\s+(?P<boxes>\d+)\s+\d+\s+(?P<stems>\d+)\s+(?P<amount>9[\d.]+)"}
    bad["lines"] = [GOOD["lines"][0].replace("(?P<stems>\\d+)", "(?P<stems>\\d)")]
    result = store.run_isolated(store.try_layout, INVOICE, bad)
    assert not result["ok"]
    assert result["error"]


def test_a_layout_that_never_finishes_is_stopped():
    import time
    with pytest.raises(store.IsolatedTimeout):
        store.run_isolated(time.sleep, 10, timeout=1)


def test_an_unknown_invoice_is_refused_as_unknown_without_a_database(monkeypatch):
    monkeypatch.setattr(store, "reading_layouts", lambda: (_ for _ in ()).throw(RuntimeError("no db")))
    with pytest.raises(PdfUnknownLayoutError) as exc:
        parse_delivery_pdf(INVOICE)
    assert exc.value.layout is None


# The supplier's layout in code, from before it changed its printout: the
# totals line it looks for is not there any more.
_OUTDATED = spec_from_dict({**GOOD, "name": "test_farm",
                            "totals_re": r"^GRAND TOTAL\s+(?P<stems>\d+)"})


def test_a_known_supplier_whose_layout_cannot_read_the_invoice_goes_to_it(monkeypatch):
    """A new printout from a known supplier is a format error like an unknown
    supplier's: saved for IT, and offered for drafting (user, 2026-09-30)."""
    monkeypatch.setattr(parser_delivery_pdf, "_specs", lambda: [_OUTDATED])
    monkeypatch.setattr(parser_delivery_pdf, "_parse_with_stored", lambda pdf: None)
    with pytest.raises(PdfUnknownLayoutError) as exc:
        parse_delivery_pdf(INVOICE)
    assert exc.value.layout == "test_farm"
    assert "test_farm layout finds this invoice but cannot read it" in str(exc.value)


def test_a_layout_drafted_for_the_new_printout_reads_it(monkeypatch):
    monkeypatch.setattr(parser_delivery_pdf, "_specs", lambda: [_OUTDATED])
    monkeypatch.setattr(parser_delivery_pdf, "_parse_with_stored", lambda pdf: ["drafted"])
    assert parse_delivery_pdf(INVOICE) == ["drafted"]


# ---------------------------------------------------------------------------
# Drafting, with a stand-in for the model
# ---------------------------------------------------------------------------

class _Stream:
    def __init__(self, message):
        self.message = message

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        yield SimpleNamespace(type="message_start")
        yield SimpleNamespace(type="message_stop")

    def get_final_message(self):
        return self.message


class _Model:
    """Answers each turn with the next scripted tool call, and records what
    it was sent."""

    def __init__(self, calls):
        self.calls = list(calls)
        self.sent = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self.stream))

    def stream(self, **params):
        # The loop keeps appending to one list; keep it as it was when sent.
        self.sent.append({**params, "messages": list(params["messages"])})
        name, arguments = self.calls.pop(0)
        block = SimpleNamespace(type="tool_use", id=f"t{len(self.sent)}", name=name, input=arguments)
        usage = SimpleNamespace(input_tokens=1000, cache_creation_input_tokens=0,
                                cache_read_input_tokens=0, output_tokens=500)
        return _Stream(SimpleNamespace(content=[block], stop_reason="tool_use", usage=usage))


@pytest.fixture
def stored(monkeypatch):
    saved = {}
    monkeypatch.setattr(store, "finish_draft", lambda *a: saved.setdefault("finish", a))
    monkeypatch.setattr(store, "fail_draft", lambda *a: saved.setdefault("fail", a))
    return saved


def test_a_draft_is_tested_until_it_reads_the_invoice(stored):
    wrong = {**GOOD, "detect": "SOMEONE ELSE"}
    model = _Model([("test_layout", {"layout": wrong}),
                    ("submit_layout", {"layout": GOOD, "supplier": "TEST FARM S.A.",
                                       "assumptions": ["Stems per bunch as printed."]})])
    sample = pdf_layout_ai.draft(42, "invoice.pdf", INVOICE, client=model, cancelled=lambda: False)

    assert sample["boxes"] == 3 and sample["amount"] == 190.0
    layout_id, layout, supplier, assumptions, _sample, usage = stored["finish"]
    assert layout_id == 42 and layout["name"] == "drafted_42"
    assert supplier == "TEST FARM S.A." and assumptions == ["Stems per bunch as printed."]
    assert usage["turns"] == 2 and usage["cost_usd"] > 0
    # The first test's result went back to the model, and said it failed.
    second = model.sent[1]["messages"]
    result = second[-1]["content"][0]
    assert result["type"] == "tool_result" and '"ok": false' in result["content"]
    # The long instructions are cached.
    assert model.sent[0]["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_a_submission_that_does_not_read_the_invoice_is_not_taken(stored):
    wrong = {**GOOD, "totals_re": r"^TOTAL\s+(?P<boxes>\d+)\s+\d+\s+(?P<stems>\d+)\s+(?P<amount>1[\d.]+)"}
    model = _Model([("submit_layout", {"layout": {**wrong, "totals_re": r"^NOTHING (?P<stems>\d+)"},
                                       "supplier": "X", "assumptions": []}),
                    ("submit_layout", {"layout": GOOD, "supplier": "X", "assumptions": []})])
    pdf_layout_ai.draft(7, "invoice.pdf", INVOICE, client=model, cancelled=lambda: False)
    first_answer = model.sent[1]["messages"][-1]["content"][0]
    assert first_answer.get("is_error") is True
    assert "finish" in stored


def test_the_draft_leaves_what_it_has_spent_so_far(stored, monkeypatch):
    """The delivery screen counts the money as the tokens go (user,
    2026-09-30): each check for a cancel leaves the spend so far."""
    seen = []
    monkeypatch.setattr(pdf_layout_ai, "CANCEL_CHECK_SECONDS", 0)
    monkeypatch.setattr(store, "draft_status", lambda layout_id, usage=None: (
        seen.append(usage), store.DRAFTING)[1])

    class Stream(_Stream):
        def __iter__(self):
            yield SimpleNamespace(type="message_start", message=SimpleNamespace(usage=SimpleNamespace(
                input_tokens=1000, cache_creation_input_tokens=0, cache_read_input_tokens=0,
                output_tokens=1)))
            for _ in range(3):
                yield SimpleNamespace(type="content_block_delta",
                                      delta=SimpleNamespace(type="text_delta", text="x" * 400))
            yield SimpleNamespace(type="message_stop")

    model = _Model([("test_layout", {"layout": GOOD}),
                    ("submit_layout", {"layout": GOOD, "supplier": "X", "assumptions": []})])
    plain = model.stream
    model.beta.messages.stream = lambda **p: Stream(plain(**p).message)
    pdf_layout_ai.draft(5, "invoice.pdf", INVOICE, client=model)

    costs = [u["cost_usd"] for u in seen]
    assert costs == sorted(costs) and costs[0] < costs[-1]
    # Mid-turn: the input as reported, the output estimated from the 1,200
    # characters streamed so far.
    assert (1000, 300) in [(u["input_tokens"], u["output_tokens"]) for u in seen]
    # After the last turn the figures are exact: what the draft is stored with.
    usage = stored["finish"][-1]
    assert (usage["input_tokens"], usage["output_tokens"]) == (2000, 1000)
    assert seen[-1]["cost_usd"] <= usage["cost_usd"]


def test_opus_5_5_drafts_at_medium_effort_and_its_own_prices(stored, monkeypatch):
    """Railway runs Claude Opus 5.5 from 2026-09-30: it thinks more per level
    than Opus 5, and reads its cache at 0.20 USD per million, not 0.1x input."""
    monkeypatch.setattr(pdf_layout_ai, "EFFORT", "")
    model = _Model([("submit_layout", {"layout": GOOD, "supplier": "X", "assumptions": []})])
    pdf_layout_ai.draft(4, "invoice.pdf", INVOICE, client=model, model="claude-opus-5-5",
                        cancelled=lambda: False)
    assert model.sent[0]["model"] == "claude-opus-5-5"
    assert model.sent[0]["output_config"] == {"effort": "medium"}
    assert pdf_layout_ai.effort("claude-opus-5") == "high"
    usage = pdf_layout_ai.Usage("claude-opus-5-5")
    usage.add(SimpleNamespace(input_tokens=0, cache_creation_input_tokens=0,
                              cache_read_input_tokens=1_000_000, output_tokens=0))
    assert usage.cost == 0.2


def test_the_model_hears_why_the_suppliers_layout_failed(stored):
    model = _Model([("submit_layout", {"layout": GOOD, "supplier": "X", "assumptions": []})])
    pdf_layout_ai.draft(3, "invoice.pdf", INVOICE, client=model, cancelled=lambda: False,
                        read_error="the test_farm layout finds this invoice but cannot read it: x")
    prompt = model.sent[0]["messages"][0]["content"]
    assert "WHY NO LAYOUT READS IT" in prompt and "test_farm layout" in prompt


def test_cancelling_stops_the_draft_and_stores_nothing(stored):
    model = _Model([("test_layout", {"layout": GOOD}), ("test_layout", {"layout": GOOD})])
    answers = iter([False, False, True])
    with pytest.raises(pdf_layout_ai.DraftCancelled):
        pdf_layout_ai.draft(9, "invoice.pdf", INVOICE, client=model,
                            cancelled=lambda: next(answers, True))
    assert "finish" not in stored and "fail" not in stored
    assert len(model.sent) == 1


# ---------------------------------------------------------------------------
# Storage: needs Postgres (KB_TEST_POSTGRES_URL or POSTGRES_URL), and runs in
# a temporary schema dropped afterwards, as test_kb_install does
# ---------------------------------------------------------------------------

_DB_URL = os.getenv("KB_TEST_POSTGRES_URL") or os.getenv("POSTGRES_URL") or ""
needs_db = pytest.mark.skipif(not _DB_URL, reason="set KB_TEST_POSTGRES_URL to a Postgres to run")


@pytest.fixture
def db(monkeypatch):
    import contextlib
    import uuid

    import psycopg2

    schema = "pdf_test_" + uuid.uuid4().hex[:12]
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

    monkeypatch.setattr(store, "_conn", scoped)
    monkeypatch.setattr(store, "_table_ready", False)
    monkeypatch.setattr(store, "_cache", None)
    try:
        yield scoped
    finally:
        with admin.cursor() as cur:
            cur.execute(f'DROP SCHEMA "{schema}" CASCADE')
        admin.close()


@needs_db
def test_an_unknown_invoice_is_saved_once(db):
    first = store.save_unknown("a.pdf", INVOICE, "anna")
    again = store.save_unknown("a (copy).pdf", INVOICE, "piet")
    assert first["status"] == store.WAITING and again["id"] == first["id"]
    assert store.get_pdf(first["id"]) == ("a.pdf", INVOICE)
    assert store.pending_count() == 1


@needs_db
def test_the_reason_a_known_layout_failed_is_kept_for_it(db):
    row = store.save_unknown("a.pdf", INVOICE, "anna", "the test_farm layout finds this invoice "
                                                       "but cannot read it: stems")
    assert row["read_error"].startswith("the test_farm layout")
    assert store.save_unknown("b.pdf", INVOICE + b"2", "anna")["read_error"] is None


@needs_db
def test_a_running_draft_leaves_its_spend_until_cancelled(db, monkeypatch):
    monkeypatch.setattr(store, "MAX_DRAFTS_PER_DAY", 2)
    row = store.save_unknown("a.pdf", INVOICE, "anna")
    store.begin_draft(row["id"], "anna")
    spend = {"model": "claude-opus-5", "turns": 1, "input_tokens": 30000, "output_tokens": 800,
             "cost_usd": 0.17}
    assert store.draft_status(row["id"], spend) == store.DRAFTING
    shown = store.get_layout(row["id"])
    assert (shown["input_tokens"], shown["output_tokens"], shown["cost_usd"]) == (30000, 800, 0.17)
    store.cancel_draft(row["id"], "anna")
    assert store.draft_status(row["id"], spend) == store.WAITING
    assert store.get_layout(row["id"])["cost_usd"] is None


@needs_db
def test_drafting_is_limited_per_day(db, monkeypatch):
    monkeypatch.setattr(store, "MAX_DRAFTS_PER_DAY", 2)
    ids = [store.save_unknown(f"{n}.pdf", INVOICE + str(n).encode(), "anna")["id"] for n in range(3)]
    store.begin_draft(ids[0], "anna")
    with pytest.raises(ValueError):
        store.begin_draft(ids[0], "anna")          # already being drafted
    store.begin_draft(ids[1], "anna")
    with pytest.raises(store.DraftLimitReached):
        store.begin_draft(ids[2], "anna")
    assert store.drafts_left_today() == 0


@needs_db
def test_cancelling_clears_the_draft_but_keeps_the_invoice(db, monkeypatch):
    monkeypatch.setattr(store, "MAX_DRAFTS_PER_DAY", 2)
    row = store.save_unknown("a.pdf", INVOICE, "anna")
    store.begin_draft(row["id"], "anna")
    cancelled = store.cancel_draft(row["id"], "anna")
    assert cancelled["status"] == store.WAITING
    assert cancelled["spec"] is None and cancelled["cost_usd"] is None
    assert store.get_pdf(row["id"]) is not None
    # A draft finishing after the cancel changes nothing.
    store.finish_draft(row["id"], GOOD, "X", [], {}, {})
    assert store.get_layout(row["id"])["status"] == store.WAITING
    # The attempt spent tokens: it still counts against the day.
    assert store.drafts_left_today() == 1


@needs_db
def test_a_drafted_layout_reads_the_suppliers_invoices_until_rejected(db):
    row = store.save_unknown("a.pdf", INVOICE, "anna")
    store.begin_draft(row["id"], "anna")
    store.finish_draft(row["id"], GOOD, "TEST FARM S.A.", ["Bunch size 25."], {"boxes": 3},
                       {"model": "claude-opus-5", "turns": 2, "cost_usd": 0.5})
    [order] = store.parse_with_stored(INVOICE)
    [warning] = order.warnings
    assert warning["code"] == "provisional_pdf_layout" and warning["assumptions"] == ["Bunch size 25."]
    assert order.nu_boxes == 3

    store.review(row["id"], "verify", "it", None)
    store._invalidate()
    [order] = store.parse_with_stored(INVOICE)
    assert order.warnings == []                    # checked by IT: no warning

    store.review(row["id"], "reject", "it", "wrong species")
    store._invalidate()
    assert store.parse_with_stored(INVOICE) is None


@needs_db
def test_a_draft_cut_off_by_a_restart_ends_as_failed(db):
    row = store.save_unknown("a.pdf", INVOICE, "anna")
    store.begin_draft(row["id"], "anna")
    with db() as conn, conn.cursor() as cur:
        cur.execute("UPDATE pdf_layouts SET draft_started_at = NOW() - INTERVAL '1 hour' WHERE id = %s",
                    (row["id"],))
    assert store.get_layout(row["id"])["status"] == store.FAILED


@needs_db
def test_it_closes_an_invoice_once_its_layout_is_in_code(db):
    row = store.save_unknown("a.pdf", INVOICE, "anna")
    closed = store.close(row["id"], "it", "added as TEST_FARM")
    assert closed["status"] == store.CLOSED and store.pending_count() == 0


if __name__ == "__main__":
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
