"""Drafting a temporary layout for a PDF invoice no layout reads, or for a
delivery JSON no parser reads (user, 2026-10-01; json_layout).

This stands in for IT for a night, not instead of IT (user, 2026-09-28): IT
adds layouts with the new-delivery-json-format skill, and a drafted one is
provisional until IT has checked it (pdf_layout_store).

The model writes the layout as data (pdf_layout_json), never code, and is
given one tool to try a layout on the invoice and one to hand it in. The
backend runs every try in a separate process with a time limit, and takes a
layout only when it reads the invoice in agreement with the totals the
invoice prints. The model reads the invoice once, to write the layout; the
supplier's invoices after that are read by the engine alone. A JSON's
layout is drafted the same way, against the totals the file gives.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any

import anthropic

import json_layout
import parser_delivery_pdf as engine
import pdf_layout_store as store
from config import config
from parser_delivery import _SUPPLIER_GROWER_MAP
from pdf_layout_json import TRANSFORMS, layouts_as_json

log = logging.getLogger(__name__)

MODEL = os.getenv("PDF_LAYOUT_MODEL", "claude-opus-5")
# How hard the model thinks. Claude Opus 5.5 (set on Railway 2026-09-30)
# thinks more per level than Claude Opus 5, and at medium already does what
# Opus 5 does at high, for less; PDF_LAYOUT_EFFORT overrides either.
EFFORT = os.getenv("PDF_LAYOUT_EFFORT", "")
MAX_TURNS = 8
MAX_COST_USD = 3.0
MAX_INVOICE_CHARS = 60_000
MAX_TABLE_ROWS = 80
# A JSON's lists are shown this far, and shorter when the file is long.
JSON_LIST_ITEMS = 20

# USD per million tokens (input, output, cache read). Cache writes cost
# 1.25x input.
PRICES = {
    "claude-opus-5": (5.0, 25.0, 0.50),
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-sonnet-5": (2.0, 10.0, 0.20),
    "claude-haiku-4-5": (1.0, 5.0, 0.10),
}


def effort(model: str) -> str:
    return EFFORT or ("medium" if model == "claude-opus-5-5" else "high")


class DraftError(RuntimeError):
    """The layout could not be drafted; the message says why, for IT."""


class DraftCancelled(RuntimeError):
    """Someone cancelled the drafting; pdf_layout_store.cancel_draft has
    already put the invoice back to waiting."""


# How often a running draft asks whether it was cancelled, in seconds.
CANCEL_CHECK_SECONDS = 2.0


# ---------------------------------------------------------------------------
# What the model is told
# ---------------------------------------------------------------------------

_GUIDE = """\
You write a *layout*: a JSON description of one supplier's PDF invoice
template. A fixed engine uses the layout to read that supplier's invoices
into delivery lines for FreshPortal, the flower wholesale system of Fresh
From Source (our company; marks such as 1OZH, OZHGYP, OZHD, VDF are ours).
You never write code. You write this JSON, try it on the invoice with the
test_layout tool as often as you need, and hand it in with submit_layout
once test_layout reports ok. After that no model reads this supplier's
invoices: the engine does, with your layout, for months. So describe the
template, not this one shipment.

You get the invoice's page text exactly as the engine sees it (pdfplumber's
extract_text, pages joined by newlines) and every table pdfplumber found,
with row and column indexes.

## The layout

Its fields are the engine's LayoutSpec, documented here as the engine's
authors wrote it (Python names; in JSON a tuple is a list and length_cols
keys are strings):

{spec_doc}

Row fields, the names columns/cell_re/header_columns map and the named
groups of `lines` and `product_re` may use:

{row_fields}

Always use row_model "boxes". For a grid that is a ruled table, give
grid_header (words that together identify its header row, lower case) and
columns (field -> column index); for one read off the text, give lines
(regexes tried at the start of each text line, named groups = row fields)
and leave grid_header and columns empty. Regexes are Python `re`, matched
case-insensitively.

`header` maps these fields to readers: tx_company, id_invoice, dt_invoice,
dt_fly (required), id_purchaseorder, nm_ship, nm_cargo, tx_awb, tx_hawb.
A reader is one of:
  {{"regex": "...", "transform": "<name>", "multiline": true}}  group 1 of the
      first match in the page text; optional "cases": [["word", "value"], ...]
      and "default" pick a value by what the text contains instead
  {{"kv": "<label>", "transform": "<name>"}}  a two-column label/value table
  {{"const": "..."}}
  {{"first_line": true}}
  {{"any_of": [reader, ...]}}  the first reader that finds something
Transforms: {transforms}. date_iso reads YYYY-MM-DD, date_us MM/DD/YYYY,
date_dmy DD/MM/YYYY (also - or .), date_ymd YYYY/MM/DD, date_text a month in
words (English or Spanish); every date must come out as DD-MM-YYYY.

## Rules

- detect: a regex matching the supplier's own name or tax number (RUC, NIT)
  as this invoice prints it. Never words of the template: many farms print
  from the same invoicing programs, and a layout found by the program's
  wording would read another farm's invoice with this farm's columns.
  Never our own names or marks.
- tx_company: a const. If the supplier is one of the FreshPortal suppliers
  listed below, under any spelling, use that list's name exactly; otherwise
  the company name as printed.
- id_invoice: the invoice number exactly as printed, leading zeros kept.
  dt_fly: the flight or shipping date, else the invoice date.
- Totals: the engine refuses a layout that finds no printed totals, and
  refuses an invoice whose lines do not add up to them. Point totals_re (named
  groups boxes, bunches, stems, amount, fulls) or totals_marker at the totals
  the invoice prints, and boxes_re / fulls_re at its box count and full-box
  equivalent when it prints them. Check everything it prints: that is what
  catches a supplier changing its template.
- Box codes: FreshPortal takes QBE (quarter box), HBE (half box) and 1/8
  (eighth). Codes starting QB/HB become QBE/HBE on their own; map any other
  code with box_map. A printed full-box equivalent tells a half from a
  quarter (box_fulls, fulls_re).
- Variety: the variety name only. Split grades, lengths, bunch sizes, colour
  codes, SKU codes and species words off with product_re named groups.
- Species: as printed; "Roses" for a rose farm's plain varieties.
- Never invent data. Set stems_bunch (a bunch size the invoice does not
  print) or a box mapping only when the invoice itself makes it plain, and
  put every value you set that the invoice does not state into
  assumptions, one short sentence each, in English. A person checks them.
- If the invoice cannot be read reliably (a scan, no printed totals,
  quantities that do not add up), do not submit: say in one paragraph why.

## FreshPortal suppliers

{suppliers}

## The layouts already in use

Every supplier the engine reads today, as JSON. Many new suppliers print
from one of these programs: find the closest and adapt it.

{examples}
"""


def _row_fields_doc() -> str:
    import inspect
    source = inspect.getsource(engine)
    start = source.index("# Grid columns a spec can map.")
    end = source.index("# How much of a full box each box code is")
    return source[start:end].strip()


def system_prompt() -> str:
    from pdf_layouts import LAYOUTS
    examples = "\n".join(json.dumps(d, ensure_ascii=False) for d in layouts_as_json(LAYOUTS))
    return _GUIDE.format(
        spec_doc=(engine.LayoutSpec.__doc__ or "").strip(),
        row_fields=_row_fields_doc(),
        transforms=", ".join(sorted(TRANSFORMS)),
        suppliers="\n".join(sorted(k.upper() for k in _SUPPLIER_GROWER_MAP)),
        examples=examples,
    )


def invoice_prompt(file_name: str, doc: engine.PdfDoc, read_error: str | None = None) -> str:
    text = doc.text
    if len(text) > MAX_INVOICE_CHARS:
        raise DraftError(f"The invoice's text is {len(text)} characters; the most a draft "
                         f"reads is {MAX_INVOICE_CHARS}.")
    tables = []
    for t, table in enumerate(doc.tables):
        rows = [f"  [{r}] {json.dumps(row, ensure_ascii=False)}"
                for r, row in enumerate(table[:MAX_TABLE_ROWS])]
        more = f"\n  … {len(table) - MAX_TABLE_ROWS} more rows" if len(table) > MAX_TABLE_ROWS else ""
        tables.append(f"table {t}: {len(table)} rows x {len(table[0]) if table else 0} columns\n"
                      + "\n".join(rows) + more)
    # A known supplier's layout that found the invoice but could not read it
    # says why: a changed printout, most likely, which the model adapts to.
    why = (f"\n\n=== WHY NO LAYOUT READS IT ===\n{read_error}\nIf the supplier changed its "
           f"printout, adapt that layout to this one.") if read_error else ""
    return (f"Invoice file: {file_name}\n\n=== PAGE TEXT ===\n{text}\n\n=== TABLES ===\n"
            + ("\n\n".join(tables) or "(no tables)") + why
            + "\n\nWrite this supplier's layout, test it, and submit it.")


_JSON_GUIDE = """\
You write a *layout*: a JSON description of one supplier's delivery file,
which is JSON itself. A fixed engine uses the layout to read that
supplier's files into delivery lines for FreshPortal, the flower wholesale
system of Fresh From Source (our company; marks such as 1OZH, OZHGYP, OZHD,
VDF are ours). You never write code. You write this JSON, try it on the
file with the test_layout tool as often as you need, and hand it in with
submit_layout once test_layout reports ok. After that no model reads this
supplier's files: the engine does, with your layout, for months. So
describe the format, not this one shipment.

## How the engine reads

The file holds one or more invoices; an invoice holds box entries; a box
entry holds products, or is itself the one product (one row per box). The
engine finds them by paths, reads each field with a reader, and rewrites
the file into the shape of our Elite format, whose parser merges equal
boxes, labels mix boxes (a box holding more than one product) MB1, MB2 …
and normalises box codes. So map fields; never do that merging yourself.

## The layout

{{
  "name": "any",
  "detect": "<regex>",         the supplier's own name or tax number as the file writes it
  "invoices": "<path>",         from the top of the file to the invoices; "" when the file is one invoice
  "boxes": "<path>",            from an invoice to its box entries
  "products": "<path>",         from a box entry to its products; "" when each entry is one product
  "header": {{field: reader}},   from the invoice: {header_fields}
  "box": {{field: reader}},      from the box entry: {box_fields}
  "product": {{field: reader}},  from the product: {product_fields}
  "totals": {{field: reader}},   from the invoice: {total_fields}
  "price": "stem",              what mny_rate_stem holds: "stem", "bunch" (price per bunch) or "line" (the product row's amount)
  "bunches": "per_box",         with box.count: nu_bunches is what each box holds ("per_box") or all of them together ("per_entry")
  "box_map": {{"code": "QBE"}},  box codes as the file writes them -> FreshPortal's
  "decimal": "."                "," when numbers written as text use a decimal comma
}}

Required: header tx_company, id_invoice, dt_invoice, dt_fly; product
nm_variety, nu_stems_bunch, nu_bunches, mny_rate_stem; at least one total.

A path is keys joined by dots ("data.facturas"), or a list of keys for a key
that holds a dot. A list met on the way is walked item by item, so the
paths "invoices", "boxes", "products" reach every product. A number picks
one item of a list.

A reader is one of:
  {{"path": "<path>", "from": "<object>", "regex": "...", "transform": "<name>"}}
      the first non-empty value at the path. "from" is where the path
      starts: the reader's own object by default, or one it sits in (a
      product's reader may use "box", "invoice" or "file"; a box's
      "invoice" or "file"; a header's or a total's "file"). regex keeps
      group 1 (else the whole match) of the value, case-insensitively.
  {{"const": "..."}}
  {{"any_of": [reader, ...]}}  the first reader that finds something
  {{"join": [reader, ...], "sep": " "}}  the values found, joined
Transforms: {transforms}. date_iso reads YYYY-MM-DD (a time after it is
fine), date_us MM/DD/YYYY, date_dmy DD/MM/YYYY (also - or .), date_ymd
YYYY/MM/DD, date_text a month in words (English or Spanish). Every date must
come out as DD-MM-YYYY, so a date always needs a transform.

## Rules

- detect: a regex matching the supplier's own name or tax number (RUC, NIT)
  as the file writes it. Never key names or words of the format: many farms
  export from the same programs, and a layout found by the program's
  wording would read another farm's file with this farm's fields. Never our
  own names or marks.
- tx_company: if the supplier is one of the FreshPortal suppliers listed
  below, under any spelling, a const with that list's name exactly;
  otherwise the company name as the file writes it.
- id_invoice: the invoice number exactly as written, leading zeros kept.
  dt_fly: the flight or shipping date, else the invoice date; dt_invoice
  the invoice date, else the shipping date.
- Totals: the engine refuses a layout that checks no totals, and a file
  whose lines do not add up to them. Point totals at every total the
  invoice gives: amount, boxes (physical boxes, not full-box equivalents),
  stems, bunches. That is what catches a supplier changing its format.
- Quantities: nu_bunches and nu_stems_bunch are the bunches in one box and
  the stems in one bunch. An entry standing for several identical boxes
  gives their number with box.count, and "bunches" says whether nu_bunches
  is per box or for all of them. A price per bunch or per row is set with
  "price", never by reading another field as the price per stem.
- gu_product: the product's own id or code in the file, when it has one; it
  tells a mix box (several products in one box) from a box of one.
- Box codes: FreshPortal takes QBE (quarter box), HBE (half box) and 1/8
  (eighth). Codes starting QB/HB become QBE/HBE on their own; map any other
  code with box_map only when the file itself makes plain what it is.
- Variety: the variety name only. Take a grade, length, bunch size, colour
  code or SKU off with a regex, or read it from its own field.
- Species: as written; a const "Roses" for a rose farm's plain varieties
  when the file gives none.
- Never invent data. Put every value you set that the file does not state
  into assumptions, one short sentence each, in English. A person checks
  them.
- If the file cannot be read reliably (no totals, quantities that do not add
  up, fields whose meaning the file does not make plain), do not submit: say
  in one paragraph why.

## FreshPortal suppliers

{suppliers}

## The formats read in code, written as layouts

A new supplier often exports from one of these programs. Their detect
regexes are only illustrations.

{examples}
"""


def json_system_prompt() -> str:
    return _JSON_GUIDE.format(
        header_fields=", ".join(json_layout.HEADER_FIELDS),
        box_fields=", ".join(json_layout.BOX_FIELDS),
        product_fields=", ".join(json_layout.PRODUCT_FIELDS),
        total_fields=", ".join(json_layout.TOTAL_FIELDS),
        transforms=", ".join(sorted(TRANSFORMS)),
        suppliers="\n".join(sorted(k.upper() for k in _SUPPLIER_GROWER_MAP)),
        examples="\n".join(json.dumps(e, ensure_ascii=False) for e in json_layout.EXAMPLES),
    )


def _preview(value: Any, items: int) -> Any:
    """The file with every list cut to its first `items` items."""
    if isinstance(value, dict):
        return {k: _preview(v, items) for k, v in value.items()}
    if isinstance(value, list):
        shown = [_preview(v, items) for v in value[:items]]
        if len(value) > items:
            shown.append(f"… {len(value) - items} more items")
        return shown
    return value


def json_file_prompt(file_name: str, data: Any, read_error: str | None = None) -> str:
    for items in (JSON_LIST_ITEMS, 5, 2):
        text = json.dumps(_preview(data, items), ensure_ascii=False, indent=1)
        if len(text) <= MAX_INVOICE_CHARS:
            break
    else:
        raise DraftError(f"The file is {len(text)} characters even with its lists cut short; "
                         f"the most a draft reads is {MAX_INVOICE_CHARS}.")
    # The parser of a format the file looks like says why it read nothing.
    why = f"\n\n=== WHY NO PARSER READS IT ===\n{read_error}" if read_error else ""
    return (f"Delivery file: {file_name}\nLists longer than {items} items show their first "
            f"{items} and how many more there are; test_layout reads the whole file.\n\n"
            f"=== FILE ===\n{text}{why}\n\nWrite this supplier's layout, test it, and submit it.")


_LAYOUT_SCHEMA = {"type": "object",
                  "description": "The layout, as the instructions describe it."}

TOOLS = [
    {
        "name": "test_layout",
        "description": (
            "Run the engine with a candidate layout on this file. Returns ok (the layout "
            "finds the file and its lines agree with every total it checks), the header "
            "fields, box/stem/bunch/amount totals, the totals it compared against, and every "
            "line; or the error, with what the engine read."),
        "input_schema": {"type": "object", "properties": {"layout": _LAYOUT_SCHEMA},
                         "required": ["layout"]},
    },
    {
        "name": "submit_layout",
        "description": (
            "Hand in the finished layout. It is tested again and taken only if test_layout "
            "would report ok. assumptions lists, one short sentence each, every value set "
            "that the file does not state (an empty list if none)."),
        "input_schema": {
            "type": "object",
            "properties": {
                "layout": _LAYOUT_SCHEMA,
                "supplier": {"type": "string", "description": "The supplier's name, as tx_company."},
                "assumptions": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["layout", "supplier", "assumptions"],
        },
    },
]


# ---------------------------------------------------------------------------
# The drafting loop
# ---------------------------------------------------------------------------

# About this many characters of streamed output make a token. It errs low
# for layout JSON and regexes, and thinking streams only as a summary, so an
# estimate made with it stays below the figure the turn ends with.
CHARS_PER_TOKEN = 4


def _tokens(usage: Any) -> tuple[int, int, int, int]:
    return tuple(getattr(usage, f, 0) or 0 for f in (
        "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))


class Usage:
    def __init__(self, model: str):
        self.model = model
        self.turns = 0
        self.input = self.cache_write = self.cache_read = self.output = 0
        # The turn under way, for the delivery screen's counter: its input is
        # reported when it starts, its output only when it ends, so meanwhile
        # the output is estimated from the characters streamed.
        self._turn_input: tuple[int, int, int, int] = (0, 0, 0, 0)
        self._turn_chars = 0

    def turn_started(self, usage: Any) -> None:
        self._turn_input = _tokens(usage)
        self._turn_chars = 0

    def streamed(self, chars: int) -> None:
        self._turn_chars += chars

    def add(self, usage: Any) -> None:
        self.turns += 1
        inp, write, read, out = _tokens(usage)
        self.input += inp
        self.cache_write += write
        self.cache_read += read
        self.output += out
        self._turn_input, self._turn_chars = (0, 0, 0, 0), 0

    def _cost(self, inp: int, write: int, read: int, out: int) -> float:
        price_in, price_out, price_read = PRICES.get(self.model, PRICES["claude-opus-5"])
        return round((inp * price_in + write * price_in * 1.25
                      + read * price_read + out * price_out) / 1e6, 4)

    @property
    def cost(self) -> float:
        return self._cost(self.input, self.cache_write, self.cache_read, self.output)

    def as_dict(self) -> dict:
        return {"model": self.model, "turns": self.turns,
                "input_tokens": self.input + self.cache_write + self.cache_read,
                "output_tokens": self.output, "cost_usd": self.cost}

    def so_far(self) -> dict:
        """as_dict with the turn under way counted in, as far as it is known."""
        inp, write, read, out = self._turn_input
        out = max(out, self._turn_chars // CHARS_PER_TOKEN)
        totals = (self.input + inp, self.cache_write + write, self.cache_read + read,
                  self.output + out)
        return {"model": self.model, "turns": self.turns,
                "input_tokens": sum(totals[:3]), "output_tokens": totals[3],
                "cost_usd": self._cost(*totals)}


def _run(try_layout: Any, content: Any, layout: Any) -> dict:
    if not isinstance(layout, dict):
        return {"ok": False, "error": "layout must be a JSON object"}
    try:
        return store.run_isolated(try_layout, content, layout)
    except store.IsolatedTimeout:
        return {"ok": False, "error": "the layout took too long on this file; a regex "
                                      "backtracks without end — make it simpler"}
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}


def _test(pdf: bytes, layout: Any) -> dict:
    return _run(store.try_layout, pdf, layout)


def _for_model(result: dict) -> str:
    return json.dumps({k: v for k, v in result.items() if k != "order"},
                      ensure_ascii=False, default=str)


class _CancelWatch:
    """Whether the draft was cancelled — asked of the database at most every
    CANCEL_CHECK_SECONDS, since the cancel may arrive at another worker. Each
    time it asks, it leaves what the draft has spent so far there too, for the
    counter the delivery screen shows (user, 2026-09-30)."""

    def __init__(self, layout_id: int, usage: Usage, check=None):
        self.layout_id = layout_id
        self._check = check or (
            lambda: store.draft_status(layout_id, usage.so_far()) != store.DRAFTING)
        self._last = 0.0

    def __call__(self, force: bool = False) -> bool:
        now = time.monotonic()
        if not force and now - self._last < CANCEL_CHECK_SECONDS:
            return False
        self._last = now
        return self._check()


def _delta_chars(delta: Any) -> int:
    for field in ("text", "thinking", "partial_json"):
        value = getattr(delta, field, None)
        if isinstance(value, str):
            return len(value)
    return 0


def _ask(client: Any, watch: _CancelWatch, usage: Usage, **params: Any) -> Any:
    """One model turn, streamed so that a cancel can close the connection
    mid-answer: the model stops generating, and billing, when it does. What
    streams feeds the running estimate of what the turn costs."""
    with client.beta.messages.stream(**params) as stream:
        for event in stream:
            kind = getattr(event, "type", "")
            if kind == "message_start":
                usage.turn_started(getattr(getattr(event, "message", None), "usage", None))
            elif kind == "content_block_delta":
                usage.streamed(_delta_chars(getattr(event, "delta", None)))
            if watch():
                raise DraftCancelled()
        return stream.get_final_message()


def draft(layout_id: int, file_name: str, content: bytes, client: Any = None,
          model: str = MODEL, cancelled=None, read_error: str | None = None,
          kind: str = "pdf") -> dict:
    """Draft and store a layout for one saved file, a PDF invoice or (kind
    "json") a delivery JSON. Returns what the layout read; raises DraftError
    with the reason when there is none, DraftCancelled when someone
    cancelled it. read_error is why the supplier's own layout (the parser of
    the JSON's format) could not read it, if it has one. `client` and
    `cancelled` are for tests."""
    usage = Usage(model)
    try:
        return _draft(layout_id, file_name, content, client, usage,
                      _CancelWatch(layout_id, usage, cancelled), read_error, kind)
    except DraftCancelled:
        log.info("[pdf-layouts] drafting %s cancelled after %d turns, %.4f USD",
                 layout_id, usage.turns, usage.cost)
        raise
    except DraftError as exc:
        store.fail_draft(layout_id, str(exc), usage.as_dict())
        raise
    except Exception as exc:  # the row must not stay "drafting"
        log.exception("[pdf-layouts] drafting %s failed", layout_id)
        store.fail_draft(layout_id, f"{type(exc).__name__}: {exc}", usage.as_dict())
        raise DraftError(str(exc)) from exc


def _draft(layout_id: int, file_name: str, file_bytes: bytes, client: Any, usage: Usage,
           watch: _CancelWatch, read_error: str | None, kind: str) -> dict:
    if client is None:
        if not config.anthropic_api_key:
            raise DraftError("ANTHROPIC_API_KEY is not configured on the server.")
        client = anthropic.Anthropic(api_key=config.anthropic_api_key)
    if kind == "json":
        try:
            file_data = json_layout.unwrap(json.loads(file_bytes.decode("utf-8-sig")))
        except (UnicodeDecodeError, ValueError) as exc:
            raise DraftError(f"The saved file is not JSON: {exc}") from exc
        guide, prompt = json_system_prompt(), json_file_prompt(file_name, file_data, read_error)

        def test(layout: Any) -> dict:
            return _run(json_layout.try_layout, file_data, layout)
    else:
        try:
            doc = engine.extract_pdf(file_bytes)
        except engine.PdfParseError as exc:
            raise DraftError(str(exc)) from exc
        guide, prompt = system_prompt(), invoice_prompt(file_name, doc, read_error)

        def test(layout: Any) -> dict:
            return _test(file_bytes, layout)

    system = [{"type": "text", "text": guide, "cache_control": {"type": "ephemeral"}}]
    messages: list[dict] = [{"role": "user", "content": prompt}]
    nudged = False

    while True:
        if watch(force=True):
            raise DraftCancelled()
        if usage.turns >= MAX_TURNS:
            raise DraftError(f"No layout that reads the invoice after {MAX_TURNS} turns.")
        if usage.cost >= MAX_COST_USD:
            raise DraftError(f"Stopped at the cost limit of {MAX_COST_USD:g} USD.")
        response = _ask(
            client, watch, usage,
            model=usage.model,
            # Room for the thinking as well as the layout: it counts too.
            max_tokens=32000,
            system=system,
            tools=TOOLS,
            messages=messages,
            # Summarized, not the default omitted: thinking then streams as
            # text, and the screen's counter moves while the model thinks.
            # Billing is the same either way.
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": effort(usage.model)},
            # Caches the conversation as it grows; the system prompt has its own.
            cache_control={"type": "ephemeral"},
            # On a policy decline, the API retries on the model Anthropic
            # recommends for that case rather than returning nothing.
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
        )
        usage.add(response.usage)

        if response.stop_reason == "refusal":
            raise DraftError("The model declined to read this invoice.")
        # Fallback markers are audit notes and are not echoed back.
        content = [b for b in response.content if getattr(b, "type", "") != "fallback"]
        tool_uses = [b for b in content if getattr(b, "type", "") == "tool_use"]

        if not tool_uses:
            text = " ".join(getattr(b, "text", "") for b in content
                            if getattr(b, "type", "") == "text").strip()
            if response.stop_reason == "max_tokens" or nudged:
                raise DraftError(text or "The model stopped without a layout.")
            # Once: it may have described a layout instead of submitting one.
            nudged = True
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": (
                "If the file can be read reliably, test and submit the layout with the "
                "tools. If it cannot, answer in one paragraph why, without calling a tool.")})
            continue

        messages.append({"role": "assistant", "content": content})
        results = []
        accepted = None
        if watch(force=True):
            raise DraftCancelled()
        for block in tool_uses:
            data = block.input if isinstance(block.input, dict) else {}
            layout = data.get("layout")
            if block.name == "test_layout":
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": _for_model(test(layout))})
            elif block.name == "submit_layout":
                result = test(layout)
                problem = _submit_problem(result, data)
                if problem:
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "is_error": True, "content": problem + "\n" + _for_model(result)})
                else:
                    accepted = (layout, data, result)
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": "Accepted."})
            else:
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "is_error": True, "content": f"Unknown tool {block.name}."})
        if accepted:
            layout, data, result = accepted
            layout = {**layout, "name": f"drafted_{layout_id}"}
            assumptions = [str(a).strip() for a in data.get("assumptions") or [] if str(a).strip()]
            sample = {k: result.get(k) for k in ("header", "boxes", "stems", "bunches", "amount",
                                                 "printed_totals_checked", "lines", "line_count")}
            store.finish_draft(layout_id, layout, str(data.get("supplier") or "").strip()
                               or result["header"]["tx_company"], assumptions, sample,
                               usage.as_dict())
            log.info("[pdf-layouts] drafted %s in %d turns, %.4f USD", layout_id,
                     usage.turns, usage.cost)
            return sample
        messages.append({"role": "user", "content": results})


def _submit_problem(result: dict, data: dict) -> str:
    if not result.get("ok"):
        return "Not taken: the layout does not read the invoice in agreement with its totals."
    header = result.get("header") or {}
    missing = [f for f in ("tx_company", "id_invoice", "dt_invoice", "dt_fly") if not header.get(f)]
    if missing:
        return f"Not taken: the layout reads no {', '.join(missing)}."
    if not isinstance(data.get("assumptions"), list):
        return "Not taken: assumptions must be a list (empty when there are none)."
    return ""


def start(layout_id: int, file_name: str, content: bytes, read_error: str | None = None,
          kind: str = "pdf") -> None:
    """Draft in the background; the row in pdf_layout_store says how it went."""
    def run() -> None:
        try:
            draft(layout_id, file_name, content, read_error=read_error, kind=kind)
        except DraftCancelled:
            pass
        except DraftError as exc:
            log.warning("[pdf-layouts] no layout for %s: %s", layout_id, exc)
    threading.Thread(target=run, name=f"pdf-layout-{layout_id}", daemon=True).start()
