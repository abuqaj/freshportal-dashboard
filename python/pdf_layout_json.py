"""A PDF invoice layout as data: LayoutSpec to JSON and back.

The layouts in pdf_layouts.py are code. A layout drafted for a new supplier
by pdf_layout_ai is data, kept in the database by pdf_layout_store until
someone in IT has checked it, and it must never be able to run anything:
it is read back through the readers and transforms the code layouts use,
from a fixed list, with every field checked here. The worst a drafted layout
can do is read an invoice wrongly, which the invoice's own printed totals
catch — or hold a regular expression so slow it never finishes, which is why
drafted layouts are only ever run in a separate process with a time limit
(pdf_layout_store.run_isolated).

The same functions write the layouts in code out as JSON, so the model that
drafts a new one sees how every existing supplier is described.
"""
from __future__ import annotations

import dataclasses
import json
import re
from typing import Any

from parser_delivery_pdf import (
    LayoutSpec,
    Reader,
    any_of,
    const,
    date_dmy,
    date_iso,
    date_text,
    date_us,
    date_ymd,
    first_line,
    kv,
    last_word,
    nospace,
    rx,
)

# The only transforms a header field can go through.
TRANSFORMS = {f.__name__: f for f in (date_iso, date_us, date_dmy, date_ymd, date_text,
                                      nospace, last_word)}

HEADER_FIELDS = ("tx_company", "id_invoice", "id_purchaseorder", "dt_invoice", "dt_fly",
                 "nm_ship", "nm_cargo", "tx_awb", "tx_hawb")

# A layout is a few kilobytes; these bound what a stored one can hold.
MAX_LAYOUT_CHARS = 60_000
MAX_REGEX_CHARS = 2_000
MAX_READER_DEPTH = 3

_REQUIRED = ("name", "detect", "grid_header", "columns", "product_re", "row_model", "header")
_STR_FIELDS = {"name", "detect", "product_re", "row_model", "nm_product", "box_re", "totals_re",
               "totals_marker", "location_block", "location_re", "lines_from", "lines_to",
               "default_box", "species", "label_joins_variety", "decimal", "boxes_re", "fulls_re"}
_REGEX_FIELDS = {"detect", "product_re", "box_re", "totals_re", "location_block", "location_re",
                 "lines_from", "lines_to", "label_joins_variety", "boxes_re", "fulls_re"}
_BOOL_FIELDS = {"merge_across_boxes", "lengths_from_header", "items_per_box", "split_uneven",
                "block_row_is_summary"}
_INT_FIELDS = {"stems_bunch", "totals_col", "box_fill"}
_STR_DICT_FIELDS = {"cell_re", "header_columns", "box_map", "species_map"}
# Lists of [regex, name] pairs, and of [row field, regex, name] triples.
_PAIR_FIELDS = {"species_rules", "mix_names"}
_TRIPLE_FIELDS = {"variety_rules"}
_EXTRACT_TYPES = {"x_tolerance": (int, float), "drop_white": bool, "clip_overflow": bool}


class LayoutJsonError(ValueError):
    """A layout given as data is not one the engine can take."""


# ---------------------------------------------------------------------------
# LayoutSpec -> JSON
# ---------------------------------------------------------------------------

def reader_to_dict(reader: Reader) -> dict[str, Any]:
    description = getattr(reader, "description", None)
    if description is None:
        raise LayoutJsonError("a header reader written as code rather than with "
                              "rx, kv, const, any_of or first_line")
    out = dict(description)
    flags = out.pop("_flags", re.IGNORECASE)
    if flags & ~(re.IGNORECASE | re.MULTILINE):
        raise LayoutJsonError(f"regex flags other than IGNORECASE and MULTILINE: {out}")
    if "any_of" in out:
        out["any_of"] = [reader_to_dict(r) for r in out["any_of"]]
    return out


def spec_to_dict(spec: LayoutSpec) -> dict[str, Any]:
    """The layout as JSON-ready data; fields left at their default are left out."""
    out: dict[str, Any] = {}
    for f in dataclasses.fields(LayoutSpec):
        value = getattr(spec, f.name)
        if f.name == "header":
            out["header"] = {k: reader_to_dict(r) for k, r in value.items()}
            continue
        if f.name not in _REQUIRED:
            default = (f.default if f.default is not dataclasses.MISSING
                       else f.default_factory())  # type: ignore[misc]
            if value == default:
                continue
        if isinstance(value, tuple):
            value = [list(v) if isinstance(v, tuple) else v for v in value]
        if f.name == "length_cols":
            value = {str(k): v for k, v in value.items()}
        out[f.name] = value
    return out


# ---------------------------------------------------------------------------
# JSON -> LayoutSpec
# ---------------------------------------------------------------------------

def _fail(where: str, message: str) -> LayoutJsonError:
    return LayoutJsonError(f"{where}: {message}")


def _regex(where: str, pattern: Any) -> str:
    if not isinstance(pattern, str):
        raise _fail(where, "must be a string")
    if len(pattern) > MAX_REGEX_CHARS:
        raise _fail(where, f"regex longer than {MAX_REGEX_CHARS} characters")
    try:
        re.compile(pattern)
    except re.error as exc:
        raise _fail(where, f"not a valid regex ({exc})") from exc
    return pattern


def _str(where: str, value: Any) -> str:
    if not isinstance(value, str):
        raise _fail(where, "must be a string")
    return value


def _transform(where: str, name: Any):
    if name in (None, ""):
        return None
    if name not in TRANSFORMS:
        raise _fail(where, f"unknown transform {name!r}; use one of {sorted(TRANSFORMS)}")
    return TRANSFORMS[name]


def reader_from_dict(data: Any, where: str, depth: int = 0) -> Reader:
    if not isinstance(data, dict):
        raise _fail(where, "a header reader must be an object")
    if depth > MAX_READER_DEPTH:
        raise _fail(where, "readers nested too deep")
    keys = set(data)
    if "regex" in data:
        extra = keys - {"regex", "transform", "multiline", "cases", "default"}
        if extra:
            raise _fail(where, f"unknown keys {sorted(extra)}")
        cases = data.get("cases") or []
        if not isinstance(cases, list) or not all(
                isinstance(c, list) and len(c) == 2 and all(isinstance(x, str) for x in c)
                for c in cases):
            raise _fail(where, "cases must be a list of [word, value] pairs")
        flags = re.IGNORECASE | (re.MULTILINE if data.get("multiline") else 0)
        return rx(_regex(f"{where}.regex", data["regex"]), _transform(where, data.get("transform")),
                  flags=flags, cases=tuple((a, b) for a, b in cases),
                  default=_str(f"{where}.default", data.get("default", "")))
    if "kv" in data:
        if keys - {"kv", "transform"}:
            raise _fail(where, f"unknown keys {sorted(keys - {'kv', 'transform'})}")
        return kv(_str(f"{where}.kv", data["kv"]), _transform(where, data.get("transform")))
    if "const" in data:
        if keys != {"const"}:
            raise _fail(where, "const takes no other keys")
        return const(_str(f"{where}.const", data["const"]))
    if "first_line" in data:
        if keys != {"first_line"} or data["first_line"] is not True:
            raise _fail(where, "first_line must be exactly {\"first_line\": true}")
        return first_line()
    if "any_of" in data:
        if keys != {"any_of"} or not isinstance(data["any_of"], list) or not data["any_of"]:
            raise _fail(where, "any_of must be a non-empty list of readers")
        return any_of(*(reader_from_dict(r, f"{where}.any_of[{i}]", depth + 1)
                        for i, r in enumerate(data["any_of"])))
    raise _fail(where, "a reader is one of regex, kv, const, first_line or any_of")


def spec_from_dict(data: Any) -> LayoutSpec:
    """A LayoutSpec from data, or LayoutJsonError saying what is wrong with it."""
    if not isinstance(data, dict):
        raise LayoutJsonError("a layout must be a JSON object")
    try:
        size = len(json.dumps(data))
    except (TypeError, ValueError) as exc:
        raise LayoutJsonError(f"not JSON data ({exc})") from exc
    if size > MAX_LAYOUT_CHARS:
        raise LayoutJsonError(f"the layout is {size} characters; the most is {MAX_LAYOUT_CHARS}")
    names = {f.name for f in dataclasses.fields(LayoutSpec)}
    unknown = set(data) - names
    if unknown:
        raise LayoutJsonError(f"unknown fields {sorted(unknown)}")

    kwargs: dict[str, Any] = {"grid_header": (), "columns": {}, "product_re": ""}
    for name, value in data.items():
        if name == "header":
            if not isinstance(value, dict):
                raise _fail("header", "must be an object")
            extra = set(value) - set(HEADER_FIELDS)
            if extra:
                raise _fail("header", f"unknown fields {sorted(extra)}")
            kwargs[name] = {k: reader_from_dict(v, f"header.{k}") for k, v in value.items()}
        elif name in _REGEX_FIELDS:
            kwargs[name] = _regex(name, value) if value else ""
        elif name in _STR_FIELDS:
            kwargs[name] = _str(name, value)
        elif name == "grid_header":
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise _fail(name, "must be a list of strings")
            kwargs[name] = tuple(value)
        elif name == "lines":
            if not isinstance(value, list):
                raise _fail(name, "must be a list of regexes")
            kwargs[name] = tuple(_regex(f"lines[{i}]", v) for i, v in enumerate(value))
        elif name == "columns":
            if not isinstance(value, dict) or not all(
                    isinstance(k, str) and isinstance(v, int) and not isinstance(v, bool) and v >= 0
                    for k, v in value.items()):
                raise _fail(name, "must map field names to column indexes")
            kwargs[name] = dict(value)
        elif name == "length_cols":
            if not isinstance(value, dict):
                raise _fail(name, "must map column indexes to lengths")
            try:
                kwargs[name] = {int(k): int(v) for k, v in value.items()}
            except (TypeError, ValueError) as exc:
                raise _fail(name, "must map column indexes to lengths") from exc
        elif name in _STR_DICT_FIELDS:
            if not isinstance(value, dict) or not all(
                    isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
                raise _fail(name, "must map strings to strings")
            if name in ("cell_re", "header_columns"):
                for k, v in value.items():
                    _regex(f"{name}.{k}", v)
            kwargs[name] = dict(value)
        elif name in _PAIR_FIELDS or name in _TRIPLE_FIELDS:
            size = 3 if name in _TRIPLE_FIELDS else 2
            if not isinstance(value, list) or not all(
                    isinstance(v, list) and len(v) == size and all(isinstance(x, str) for x in v)
                    for v in value):
                raise _fail(name, f"must be a list of {size} strings each")
            for i, v in enumerate(value):
                _regex(f"{name}[{i}]", v[-2])
            kwargs[name] = tuple(tuple(v) for v in value)
        elif name == "box_fulls":
            if not isinstance(value, dict) or not all(
                    isinstance(k, str) and isinstance(v, (int, float)) and not isinstance(v, bool)
                    for k, v in value.items()):
                raise _fail(name, "must map box codes to a share of a full box")
            kwargs[name] = {k: float(v) for k, v in value.items()}
        elif name in _BOOL_FIELDS:
            if not isinstance(value, bool):
                raise _fail(name, "must be true or false")
            kwargs[name] = value
        elif name in _INT_FIELDS:
            if not isinstance(value, int) or isinstance(value, bool):
                raise _fail(name, "must be a whole number")
            kwargs[name] = value
        elif name == "extract":
            if not isinstance(value, dict):
                raise _fail(name, "must be an object")
            for k, v in value.items():
                if k not in _EXTRACT_TYPES or not isinstance(v, _EXTRACT_TYPES[k]) or (
                        k != "x_tolerance" and not isinstance(v, bool)):
                    raise _fail(name, f"unknown option or wrong type: {k}")
            kwargs[name] = dict(value)
        else:  # pragma: no cover - every dataclass field is handled above
            raise _fail(name, "not handled")

    missing = [n for n in _REQUIRED if n not in kwargs]
    if missing:
        raise LayoutJsonError(f"missing fields {missing}")
    try:
        return LayoutSpec(**kwargs)
    except (TypeError, ValueError, re.error) as exc:
        raise LayoutJsonError(str(exc)) from exc


def layouts_as_json(specs: list[LayoutSpec]) -> list[dict[str, Any]]:
    """Every layout that can be written out as data; one that cannot is left
    out rather than failing the whole list."""
    out = []
    for spec in specs:
        try:
            out.append(spec_to_dict(spec))
        except LayoutJsonError:
            continue
    return out
