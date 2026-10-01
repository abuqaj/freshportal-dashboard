"""A delivery JSON's layout as data, and the engine that reads a file with it.

The JSON formats delivery import knows are code, a parser each
(parser_delivery.py), and IT adds new ones with the new-delivery-json-format
skill. A JSON none of them reads is saved for IT like such a PDF, and the
person importing it may have a temporary layout drafted there and then
(pdf_layout_ai, pdf_layout_store; user, 2026-10-01). This module is what such
a layout is and how it reads a file.

A layout says where in the file the invoices, their boxes and the boxes'
products are, and which field holds what. The engine rewrites the file into
the shape of the Elite/Ecoroses format and reads that with its parser
(_parse_invoices_format), so a drafted layout gets the box merging, mix boxes
and variety rules every JSON in code gets. A layout is data and runs nothing:
paths, regular expressions and pdf_layout_json's transforms. A regular
expression can still be slow, so stored layouts are run in a separate process
(pdf_layout_store.run_isolated). The file's own totals are the check, as a
PDF's printed totals are: a layout that finds none is refused.
"""
from __future__ import annotations

import json
import re
from typing import Any

from parser_delivery import DeliveryOrder, UnknownDeliveryJsonError, _parse_invoices_format
from parser_delivery_pdf import _AMOUNT_TOLERANCE, _num, _num_comma
from pdf_layout_json import MAX_LAYOUT_CHARS, MAX_REGEX_CHARS, TRANSFORMS

HEADER_FIELDS = ("tx_company", "id_invoice", "id_purchaseorder", "dt_invoice", "dt_fly",
                 "nm_ship", "nm_cargo", "tx_awb", "tx_hawb")
BOX_FIELDS = ("tp_box", "tx_label", "nu_box_weight", "count")
PRODUCT_FIELDS = ("gu_product", "nm_variety", "nm_species", "nm_product", "nu_length",
                  "nu_stems_bunch", "nu_bunches", "mny_rate_stem", "id_floricode",
                  "nm_location", "nu_weight")
TOTAL_FIELDS = ("amount", "boxes", "stems", "bunches")
# The object each section's readers start from, then the ones it sits in.
_SOURCES = {
    "header": ("invoice", "file"),
    "totals": ("invoice", "file"),
    "box": ("box", "invoice", "file"),
    "product": ("product", "box", "invoice", "file"),
}
_SECTION_FIELDS = {"header": HEADER_FIELDS, "box": BOX_FIELDS, "product": PRODUCT_FIELDS,
                   "totals": TOTAL_FIELDS}
_FIELDS = {"name", "detect", "invoices", "boxes", "products", "header", "box", "product",
           "totals", "price", "bunches", "box_map", "decimal"}
_REQUIRED = ("name", "detect", "boxes", "header", "product", "totals")
_REQUIRED_PRODUCT = ("nm_variety", "nu_stems_bunch", "nu_bunches", "mny_rate_stem")
PRICES = ("stem", "bunch", "line")
BUNCHES = ("per_box", "per_entry")
MAX_READER_DEPTH = 3
MAX_PATH_KEYS = 12


class JsonLayoutError(ValueError):
    """A layout given as data is not one the engine can take."""


class JsonReadError(ValueError):
    """A layout cannot read the file: a path finds nothing, or the lines do
    not add up to the totals the file gives."""


class JsonUnknownLayoutError(ValueError):
    """Neither a parser in code nor a stored layout reads this delivery JSON.
    read_error says why the parser that took it could not, when one did:
    a known format whose file reads as nothing, say."""

    def __init__(self, message: str, read_error: str | None = None):
        super().__init__(message)
        self.read_error = read_error


# ---------------------------------------------------------------------------
# The layout, checked
# ---------------------------------------------------------------------------

def _fail(where: str, message: str) -> JsonLayoutError:
    return JsonLayoutError(f"{where}: {message}")


def _regex(where: str, pattern: Any) -> str:
    if not isinstance(pattern, str) or not pattern:
        raise _fail(where, "must be a non-empty string")
    if len(pattern) > MAX_REGEX_CHARS:
        raise _fail(where, f"regex longer than {MAX_REGEX_CHARS} characters")
    try:
        re.compile(pattern)
    except re.error as exc:
        raise _fail(where, f"not a valid regex ({exc})") from exc
    return pattern


def _path(where: str, value: Any) -> list[str]:
    """Keys joined by dots ("invoice.boxes"), or a list of keys for a key
    that holds a dot. A number indexes a list."""
    if isinstance(value, str):
        keys = value.split(".") if value else []
    elif isinstance(value, list) and all(
            isinstance(k, (str, int)) and not isinstance(k, bool) for k in value):
        keys = [str(k) for k in value]
    else:
        raise _fail(where, "a path is keys joined by dots, or a list of keys")
    if any(k == "" for k in keys):
        raise _fail(where, "a path has an empty key")
    if len(keys) > MAX_PATH_KEYS:
        raise _fail(where, f"a path of more than {MAX_PATH_KEYS} keys")
    return keys


def _reader(data: Any, where: str, sources: tuple[str, ...], depth: int = 0) -> dict:
    if not isinstance(data, dict):
        raise _fail(where, "a reader must be an object")
    if depth > MAX_READER_DEPTH:
        raise _fail(where, "readers nested too deep")
    keys = set(data)
    if "path" in data:
        extra = keys - {"path", "from", "regex", "transform"}
        if extra:
            raise _fail(where, f"unknown keys {sorted(extra)}")
        source = data.get("from", sources[0])
        if source not in sources:
            raise _fail(where, f"from must be one of {list(sources)}")
        out: dict[str, Any] = {"path": _path(f"{where}.path", data["path"]), "from": source}
        if data.get("regex"):
            out["regex"] = _regex(f"{where}.regex", data["regex"])
        if data.get("transform"):
            if data["transform"] not in TRANSFORMS:
                raise _fail(where, f"unknown transform {data['transform']!r}; "
                                   f"use one of {sorted(TRANSFORMS)}")
            out["transform"] = data["transform"]
        return out
    if "const" in data:
        value = data["const"]
        if keys != {"const"} or isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise _fail(where, "const is a string or a number, with no other keys")
        return {"const": value}
    if "any_of" in data:
        if keys != {"any_of"} or not isinstance(data["any_of"], list) or not data["any_of"]:
            raise _fail(where, "any_of must be a non-empty list of readers")
        return {"any_of": [_reader(r, f"{where}.any_of[{i}]", sources, depth + 1)
                           for i, r in enumerate(data["any_of"])]}
    if "join" in data:
        if keys - {"join", "sep"} or not isinstance(data["join"], list) or not data["join"]:
            raise _fail(where, "join must be a non-empty list of readers, with an optional sep")
        sep = data.get("sep", " ")
        if not isinstance(sep, str):
            raise _fail(where, "sep must be a string")
        return {"join": [_reader(r, f"{where}.join[{i}]", sources, depth + 1)
                         for i, r in enumerate(data["join"])], "sep": sep}
    raise _fail(where, "a reader is one of path, const, any_of or join")


def spec_from_dict(data: Any) -> dict:
    """The layout, checked and filled in with its defaults, or
    JsonLayoutError saying what is wrong with it."""
    if not isinstance(data, dict):
        raise JsonLayoutError("a layout must be a JSON object")
    try:
        size = len(json.dumps(data))
    except (TypeError, ValueError) as exc:
        raise JsonLayoutError(f"not JSON data ({exc})") from exc
    if size > MAX_LAYOUT_CHARS:
        raise JsonLayoutError(f"the layout is {size} characters; the most is {MAX_LAYOUT_CHARS}")
    unknown = set(data) - _FIELDS
    if unknown:
        raise JsonLayoutError(f"unknown fields {sorted(unknown)}")
    missing = [f for f in _REQUIRED if f not in data]
    if missing:
        raise JsonLayoutError(f"missing fields {missing}")
    if not isinstance(data["name"], str):
        raise _fail("name", "must be a string")

    spec: dict[str, Any] = {
        "name": data["name"],
        "detect": _regex("detect", data["detect"]),
        "invoices": _path("invoices", data.get("invoices", "")),
        "boxes": _path("boxes", data["boxes"]),
        "products": _path("products", data.get("products", "")),
        "price": data.get("price", "stem"),
        "bunches": data.get("bunches", "per_box"),
        "decimal": data.get("decimal", "."),
    }
    if not spec["boxes"]:
        raise _fail("boxes", "the path to an invoice's boxes cannot be empty")
    if spec["price"] not in PRICES:
        raise _fail("price", f"must be one of {list(PRICES)}")
    if spec["bunches"] not in BUNCHES:
        raise _fail("bunches", f"must be one of {list(BUNCHES)}")
    if spec["decimal"] not in (".", ","):
        raise _fail("decimal", 'must be "." or ","')
    box_map = data.get("box_map", {})
    if not isinstance(box_map, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in box_map.items()):
        raise _fail("box_map", "must map box codes to box codes")
    spec["box_map"] = {k.strip().upper(): v for k, v in box_map.items()}

    for section, fields in _SECTION_FIELDS.items():
        value = data.get(section, {})
        if not isinstance(value, dict):
            raise _fail(section, "must be an object")
        extra = set(value) - set(fields)
        if extra:
            raise _fail(section, f"unknown fields {sorted(extra)}; use {list(fields)}")
        spec[section] = {k: _reader(v, f"{section}.{k}", _SOURCES[section])
                         for k, v in value.items()}
    lacking = [f for f in _REQUIRED_PRODUCT if f not in spec["product"]]
    if lacking:
        raise _fail("product", f"missing readers {lacking}")
    if not spec["totals"]:
        raise _fail("totals", "point at least one total the file gives "
                              f"({', '.join(TOTAL_FIELDS)}): it is what checks the lines")
    return spec


# ---------------------------------------------------------------------------
# Reading values out of a file
# ---------------------------------------------------------------------------

def _walk(node: Any, keys: list[str]) -> list[Any]:
    """Every value at keys below node. A list met on the way is walked item
    by item, unless the key is a number, which picks one item."""
    current = [node]
    for key in keys:
        found = []
        for value in current:
            if isinstance(value, list):
                if key.isdigit():
                    if int(key) < len(value):
                        found.append(value[int(key)])
                    continue
                found.extend(item[key] for item in value if isinstance(item, dict) and key in item)
            elif isinstance(value, dict) and key in value:
                found.append(value[key])
        current = found
    return current


def _objects(node: Any, keys: list[str]) -> list[dict]:
    """The objects at keys below node, lists flattened: invoices, boxes, products."""
    out: list[dict] = []
    for value in _walk(node, keys):
        if isinstance(value, dict):
            out.append(value)
        elif isinstance(value, list):
            out.extend(v for v in value if isinstance(v, dict))
    return out


def _empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _number(value: Any, decimal: str) -> float:
    if value is None or isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return (_num_comma if decimal == "," else _num)(str(value))


def _read(reader: dict, ctx: dict[str, Any]) -> Any:
    if "const" in reader:
        return reader["const"]
    if "any_of" in reader:
        for r in reader["any_of"]:
            value = _read(r, ctx)
            if not _empty(value):
                return value
        return None
    if "join" in reader:
        parts = [_text(_read(r, ctx)) for r in reader["join"]]
        return reader["sep"].join(p for p in parts if p)
    value = next((v for v in _walk(ctx[reader["from"]], reader["path"])
                  if not _empty(v) and not isinstance(v, (dict, list))), None)
    if value is None or not ("regex" in reader or "transform" in reader):
        return value
    text = _text(value)
    if "regex" in reader:
        m = re.search(reader["regex"], text, re.IGNORECASE)
        if not m:
            return None
        text = (m.group(1) if m.groups() else m.group(0)) or ""
    if "transform" in reader:
        text = TRANSFORMS[reader["transform"]](text)
    return text


# ---------------------------------------------------------------------------
# A file read with a layout
# ---------------------------------------------------------------------------

def file_text(data: Any) -> str:
    """What `detect` is matched against: the file as JSON text."""
    return json.dumps(data, ensure_ascii=False)


def detects(spec: dict, text: str) -> bool:
    return bool(re.search(spec["detect"], text, re.IGNORECASE))


def _invoice(data: Any, inv: dict, spec: dict, where: str) -> tuple[DeliveryOrder, dict]:
    """One invoice of the file as an order, and the totals it was checked against."""
    dec = spec["decimal"]
    ctx = {"file": data, "invoice": inv}
    header = {f: _text(_read(r, ctx)) for f, r in spec["header"].items()}
    entries = _objects(inv, spec["boxes"])
    if not entries:
        raise JsonReadError(f"{where}no boxes at {'.'.join(spec['boxes'])}")

    boxes: list[dict] = []
    for entry in entries:
        bctx = {**ctx, "box": entry}
        box = {f: _read(r, bctx) for f, r in spec["box"].items()}
        tp_box = _text(box.get("tp_box"))
        tp_box = spec["box_map"].get(tp_box.upper(), tp_box)
        count = 1 if _empty(box.get("count")) else int(round(_number(box["count"], dec)))
        if count < 1:
            raise JsonReadError(f"{where}a box entry counts {count} boxes")
        products = _objects(entry, spec["products"]) if spec["products"] else [entry]
        if not products:
            raise JsonReadError(f"{where}a box with no products at {'.'.join(spec['products'])}")
        rows = []
        for product in products:
            v = {f: _read(r, {**bctx, "product": product}) for f, r in spec["product"].items()}
            stems_bunch = int(round(_number(v.get("nu_stems_bunch"), dec)))
            bunches = _number(v.get("nu_bunches"), dec)
            # bunches of every box of the entry together, or of each
            per_box = bunches / count if spec["bunches"] == "per_entry" else bunches
            if per_box != int(per_box):
                raise JsonReadError(f"{where}{bunches:g} bunches do not make whole bunches "
                                    f"in each of {count} boxes")
            rate = _number(v.get("mny_rate_stem"), dec)
            if spec["price"] == "bunch":
                rate = rate / stems_bunch if stems_bunch else 0.0
            elif spec["price"] == "line":
                stems = per_box * count * stems_bunch
                rate = rate / stems if stems else 0.0
            variety = _text(v.get("nm_variety"))
            length = int(round(_number(v.get("nu_length"), dec)))
            rows.append({
                # Mix boxes are told by their products' ids: without one in
                # the file, the product is what the line is made of.
                "gu_product": (_text(v.get("gu_product"))
                               or f"{variety.lower()}|{length}|{stems_bunch}|{round(rate, 6)}"),
                "nm_variety": variety,
                "nm_species": _text(v.get("nm_species")),
                "nm_product": _text(v.get("nm_product")),
                "nu_length": length,
                "nu_stems_bunch": stems_bunch,
                "nu_bunches": int(per_box),
                "mny_rate_stem": round(rate, 6),
                "id_floricode": _text(v.get("id_floricode")),
                "nm_location": _text(v.get("nm_location")),
                "nu_weight": _number(v.get("nu_weight"), dec),
            })
        boxes.extend([{
            "tp_box": tp_box,
            "tx_label": _text(box.get("tx_label")),
            "nu_box_weight": _number(box.get("nu_box_weight"), dec),
            "products": rows,
        }] * count)  # read only from here on

    shaped = {**{f: header.get(f, "") for f in HEADER_FIELDS},
              "dt_fly": "", "dt_invoice": "", "nu_boxes": len(boxes), "boxes": boxes}
    [order] = _parse_invoices_format({"invoices": [shaped]})
    # As the transforms wrote them: the Elite parser would read a date
    # written with slashes as MM/DD/YYYY.
    order.dt_fly, order.dt_invoice = header.get("dt_fly", ""), header.get("dt_invoice", "")

    totals = {f: _number(_read(r, ctx), dec) for f, r in spec["totals"].items()}
    totals = {f: (round(t, 2) if f == "amount" else int(round(t))) for f, t in totals.items() if t}
    if not totals:
        raise JsonReadError(f"{where}the file gives none of the totals the layout points at")
    bunches = sum(line.nu_bunches for line in order.lines)
    problems = []
    if "boxes" in totals and totals["boxes"] != order.nu_boxes:
        problems.append(f"boxes: file says {totals['boxes']}, read {order.nu_boxes}")
    if "stems" in totals and totals["stems"] != order.nu_stems_total:
        problems.append(f"stems: file says {totals['stems']}, read {order.nu_stems_total}")
    if "bunches" in totals and totals["bunches"] != bunches:
        problems.append(f"bunches: file says {totals['bunches']}, read {bunches}")
    if "amount" in totals and abs(totals["amount"] - order.mny_total) > _AMOUNT_TOLERANCE:
        problems.append(f"amount: file says {totals['amount']:.2f}, read {order.mny_total:.2f}")
    if problems:
        raise JsonReadError(f"{where}the lines do not add up to the totals in the file "
                            f"({'; '.join(problems)})")
    return order, totals


def _read_file(data: Any, spec: dict) -> list[tuple[DeliveryOrder, dict]]:
    invoices = _objects(data, spec["invoices"])
    if not invoices:
        raise JsonReadError(f"no invoice at {'.'.join(spec['invoices']) or 'the top of the file'}")
    return [_invoice(data, inv, spec, f"invoice {n}: " if len(invoices) > 1 else "")
            for n, inv in enumerate(invoices, 1)]


def parse_with_layout(data: Any, spec: dict) -> list[DeliveryOrder]:
    """The file's orders as the layout reads them, or JsonReadError."""
    return [order for order, _ in _read_file(data, spec)]


# ---------------------------------------------------------------------------
# Run in the isolated process (pdf_layout_store.run_isolated)
# ---------------------------------------------------------------------------

def read_with_layouts(data: Any, layouts: list[tuple[int, dict]]) -> dict:
    """The first stored layout whose detect finds this file and whose reading
    agrees with the file's totals: {"id": layout id, "orders": [...]}, else
    {"id": None, "failures": [(layout id, message), …]}."""
    text = file_text(data)
    failures = []
    for layout_id, raw in layouts:
        try:
            spec = spec_from_dict(raw)
        except JsonLayoutError as exc:
            failures.append((layout_id, f"not a valid layout: {exc}"))
            continue
        if not detects(spec, text):
            continue
        try:
            return {"id": layout_id, "orders": parse_with_layout(data, spec)}
        except Exception as exc:  # any layout failing must leave the others to try
            failures.append((layout_id, str(exc) if isinstance(exc, JsonReadError)
                             else f"{type(exc).__name__}: {exc}"))
    return {"id": None, "failures": failures}


def _found(data: Any, spec: dict) -> dict:
    """What the layout's paths find in the file, for the model to see a
    wrong one."""
    found: dict[str, Any] = {}
    invoices = _objects(data, spec["invoices"])
    found["invoices"] = len(invoices)
    if not invoices:
        return found
    entries = _objects(invoices[0], spec["boxes"])
    found["boxes_in_first_invoice"] = len(entries)
    if not entries:
        return found
    products = _objects(entries[0], spec["products"]) if spec["products"] else [entries[0]]
    found["products_in_first_box"] = len(products)
    if products:
        ctx = {"file": data, "invoice": invoices[0], "box": entries[0], "product": products[0]}
        found["first_box_as_read"] = {f: _read(r, ctx) for f, r in spec["box"].items()}
        found["first_product_as_read"] = {f: _read(r, ctx) for f, r in spec["product"].items()}
    return found


def try_layout(data: Any, raw: dict, max_lines: int = 80) -> dict:
    """For a layout being drafted: what it reads from this file, or why it
    cannot, in the shape pdf_layout_store.try_layout gives for a PDF. ok
    means the file's own totals agree."""
    out: dict[str, Any] = {"ok": False}
    try:
        spec = spec_from_dict(raw)
    except JsonLayoutError as exc:
        out["error"] = f"not a valid layout: {exc}"
        return out
    out["detected"] = detects(spec, file_text(data))
    try:
        read = _read_file(data, spec)
    except Exception as exc:
        out["error"] = str(exc) if isinstance(exc, JsonReadError) else f"{type(exc).__name__}: {exc}"
        try:
            out["found"] = _found(data, spec)
        except Exception as inner:  # the diagnosis is a courtesy
            out["found_error"] = str(inner)
        return out
    orders = [order for order, _ in read]
    lines = [line for order in orders for line in order.lines]
    checked: dict[str, float] = {}
    for _, totals in read:
        for key, value in totals.items():
            checked[key] = round(checked.get(key, 0) + value, 2)
    first = orders[0]
    out.update({
        "ok": out["detected"],
        "invoices": len(orders),
        "header": {k: getattr(first, k) for k in HEADER_FIELDS},
        "boxes": sum(o.nu_boxes for o in orders),
        "stems": sum(o.nu_stems_total for o in orders),
        "amount": round(sum(o.mny_total for o in orders), 2),
        "bunches": sum(line.nu_bunches for line in lines),
        "printed_totals_checked": checked,
        "lines": [
            f"{l.nm_box} x{l.nu_physical_boxes} | {l.nm_species} | {l.nm_variety} | {l.nu_length}cm"
            f" | {l.nu_bunches} bunches x {l.nu_stems_bunch} | {l.mny_rate_stem:g}/stem"
            f" | {l.nm_location} | {l.nm_product}"
            for l in lines[:max_lines]
        ],
        "line_count": len(lines),
    })
    if not out["detected"]:
        out["error"] = "detect does not match this file's text"
    return out


# ---------------------------------------------------------------------------
# Delivery import's way in
# ---------------------------------------------------------------------------

def unwrap(raw: Any) -> Any:
    """Some exporters wrap the payload in an outer array: its objects become
    one, their lists joined."""
    if not isinstance(raw, list):
        return raw
    merged: dict = {}
    for item in raw:
        if isinstance(item, dict):
            for k, v in item.items():
                if k in merged and isinstance(merged[k], list) and isinstance(v, list):
                    merged[k].extend(v)
                else:
                    merged.setdefault(k, v)
    return merged


def read_delivery_json(data: Any) -> list[DeliveryOrder]:
    """The file read by the parsers in code; when none reads it, by a stored
    layout; else JsonUnknownLayoutError.

    Not read means the parser failed, found no invoice, or found one without
    a single stem: a new supplier whose file has an "invoices" key but fields
    of its own names reads as empty lines, not as an error.
    """
    from parser_delivery import parse_delivery_json

    read_error: str | None = None
    try:
        orders = parse_delivery_json(data)
        empty = [o for o in orders if not o.lines or o.nu_stems_total <= 0]
        if orders and not empty:
            return orders
        read_error = ("the parser for this file's format reads no invoice from it" if not orders
                      else f"the parser for this file's format reads {len(empty)} of its "
                           f"{len(orders)} invoice(s) without a single stem")
    except UnknownDeliveryJsonError:
        pass
    except Exception as exc:
        read_error = f"the parser for this file's format fails on it: {type(exc).__name__}: {exc}"

    from pdf_layout_store import parse_json_with_stored
    stored = parse_json_with_stored(data)
    if stored is not None:
        return stored
    raise JsonUnknownLayoutError(
        "this file is not in a delivery format we read"
        + (f" ({read_error})" if read_error else "")
        + " — send it in to have its format added.",
        read_error,
    )


# ---------------------------------------------------------------------------
# The formats in code, as layouts: what the model drafting one is shown
# ---------------------------------------------------------------------------

EXAMPLES: list[dict] = [
    {
        # Elite, Ecoroses, Alissroses, Pomarosa (_parse_invoices_format)
        "name": "elite",
        "detect": r"ECOROSES",
        "invoices": "invoices",
        "boxes": "boxes",
        "products": "products",
        "header": {
            "tx_company": {"path": "tx_company"},
            "id_invoice": {"path": "id_invoice"},
            "id_purchaseorder": {"path": "id_purchaseorder"},
            "dt_invoice": {"path": "dt_invoice", "transform": "date_us"},
            "dt_fly": {"path": "dt_fly", "transform": "date_us"},
            "nm_ship": {"path": "nm_ship"},
            "nm_cargo": {"path": "nm_cargo"},
            "tx_awb": {"path": "tx_awb"},
            "tx_hawb": {"path": "tx_hawb"},
        },
        "box": {
            "tp_box": {"any_of": [{"path": "tp_box"}, {"path": "nm_box"}]},
            "tx_label": {"path": "tx_label"},
            "nu_box_weight": {"path": "nu_box_weight"},
        },
        "product": {
            "gu_product": {"path": "gu_product"},
            "nm_variety": {"any_of": [{"path": "nm_variety"}, {"path": "id_migros"}]},
            "nm_species": {"path": "nm_species"},
            "nm_product": {"path": "nm_product"},
            "nu_length": {"path": "nu_length"},
            "nu_stems_bunch": {"path": "nu_stems_bunch"},
            "nu_bunches": {"path": "nu_bunches"},
            "mny_rate_stem": {"path": "mny_rate_stem"},
            "id_floricode": {"path": "id_floricode"},
            "nm_location": {"path": "nm_location"},
            "nu_weight": {"path": "nu_weight"},
        },
        "totals": {"amount": {"path": "mny_total"}, "boxes": {"path": "nu_boxes"}},
    },
    {
        # Bloomingacres, FreshFromSource (_parse_factura_format): the file is
        # one invoice, in Spanish
        "name": "factura",
        "detect": r"BLOOMINGACRES",
        "boxes": "detalles",
        "products": "productos",
        "header": {
            "tx_company": {"path": "empresa"},
            "id_invoice": {"path": "id_factura"},
            "dt_invoice": {"path": "fecha", "transform": "date_iso"},
            "dt_fly": {"path": "fecha_embarque", "transform": "date_iso"},
            "nm_ship": {"path": "agencia"},
            "tx_awb": {"path": "mawb"},
            "tx_hawb": {"path": "hawb"},
        },
        "box": {"tp_box": {"path": "code_caja"}},
        "product": {
            "gu_product": {"path": "id_producto"},
            "nm_variety": {"path": "nombre_variedad"},
            "nm_species": {"path": "tipo_producto"},
            "nm_product": {"path": "variedad"},
            "nu_length": {"path": "grado"},
            "nu_stems_bunch": {"path": "tallos_x_ramo"},
            "nu_bunches": {"path": "ramos"},
            "mny_rate_stem": {"path": "precio"},
        },
        "totals": {"boxes": {"path": "cajas"}},
    },
    {
        # One row per kind of box, with how many such boxes
        # (_parse_etiqueta_format). The file names no supplier: the layout
        # gives it.
        "name": "etiqueta",
        "detect": r"EXAMPLE\s+FARM",
        "boxes": "detalle",
        "header": {
            "tx_company": {"const": "EXAMPLE FARM S.A."},
            "id_invoice": {"path": "invoice"},
            "dt_invoice": {"path": "fecha", "transform": "date_iso"},
            "dt_fly": {"path": "fecha", "transform": "date_iso"},
        },
        "box": {"tp_box": {"path": "BOX"}, "count": {"path": "Boxes"}},
        "product": {
            "nm_variety": {"join": [{"path": "NomVariedad"}, {"path": "NomColor"}]},
            "nm_product": {"path": "PRODUCTO"},
            "nu_stems_bunch": {"path": "st/Bch"},
            "nu_bunches": {"path": "Bch/box"},
            "mny_rate_stem": {"path": "Price"},
        },
        "totals": {"boxes": {"path": "cajas"}},
    },
]
