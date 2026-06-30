"""Parse and aggregate delivery JSON (Elite/Ecoroses format) into FreshPortal delivery lines."""
from __future__ import annotations

import difflib
import re as _re
import unicodedata as _ud
from dataclasses import dataclass, field
from typing import Any


@dataclass
class DeliveryLine:
    gu_product: str
    nm_variety: str
    nm_species: str
    nu_length: int
    nu_stems_bunch: int
    nu_bunches: int
    mny_rate_stem: float
    id_floricode: str
    nm_product: str
    # Box code: HB (or original tp_box) for single-variety boxes;
    # MB1, MB2 … for mix-box products (sequential within the invoice)
    nm_box: str = ""
    # Number of physical boxes merged into this line (≥1).
    # Two boxes of the same product with the same box type share one DeliveryLine
    # but each box must become a separate FP stock entry.
    nu_physical_boxes: int = 1
    # Filled after catalogue matching
    fp_product_id: str = ""
    match_method: str = "none"
    catalogue_nm_product: str = ""

    @property
    def nu_stems_total(self) -> int:
        return self.nu_bunches * self.nu_stems_bunch

    @property
    def mny_total(self) -> float:
        return round(self.nu_stems_total * self.mny_rate_stem, 4)


@dataclass
class DeliveryOrder:
    tx_company: str
    nm_location: str
    id_invoice: str
    id_purchaseorder: str
    dt_fly: str            # delivery/flight date  MM/DD/YYYY → normalised to DD-MM-YYYY
    dt_invoice: str
    nm_ship: str
    nm_cargo: str
    tx_awb: str
    tx_hawb: str
    nu_boxes: int
    nu_stems_total: int
    mny_total: float
    lines: list[DeliveryLine] = field(default_factory=list)


_BOX_TYPE_MAP = {"QB": "QBE"}


def _normalise_box(tp: str) -> str:
    """Normalise box type code: QB → QBE (FreshPortal convention)."""
    return _BOX_TYPE_MAP.get(tp.upper(), tp)


def _normalise_date(raw: str) -> str:
    """MM/DD/YYYY → DD-MM-YYYY (FreshPortal date picker format)."""
    raw = raw.strip()
    parts = raw.split("/")
    if len(parts) == 3:
        m, d, y = parts
        return f"{d.zfill(2)}-{m.zfill(2)}-{y}"
    return raw


def _parse_date_iso(raw: str) -> str:
    """YYYY-MM-DD[THH:MM:SS] → DD-MM-YYYY (FreshPortal date picker format)."""
    raw = (raw or "").strip().split("T")[0]
    parts = raw.split("-")
    if len(parts) == 3:
        y, m, d = parts
        return f"{d.zfill(2)}-{m.zfill(2)}-{y}"
    return raw


def _parse_invoices_format(data: dict[str, Any]) -> list[DeliveryOrder]:
    """Parse Elite/Ecoroses/Alissroses format: data["invoices"][]["boxes"][]["products"][]."""
    orders: list[DeliveryOrder] = []

    for inv in data.get("invoices", []):
        # Parsing rules:
        #   • Single-variety box (1 unique gu_product): aggregate by gu_product + tp_box.
        #     nm_box = tp_box (e.g. "HB", "QB").
        #   • Multi-variety box (Mix box): each product becomes its own line.
        #     All products in the same physical box share a sequential label MB1, MB2 …
        #     assigned in encounter order across the invoice. nm_box = "MB1", "MB2", etc.
        merged: dict[str, DeliveryLine] = {}
        mix_box_counter = 0

        for box in inv.get("boxes", []):
            products_in_box = box.get("products", [])
            if not products_in_box:
                continue

            tp_box = _normalise_box((box.get("tp_box") or box.get("nm_box") or "").strip())

            unique_guids = {
                (p.get("gu_product") or "").strip()
                for p in products_in_box
                if (p.get("gu_product") or "").strip()
            }

            # Track which keys are first seen in this physical box.
            # Used to increment nu_physical_boxes exactly once per box.
            keys_new_in_this_box: set[str] = set()

            if len(unique_guids) > 1:
                # Mix box — one line per product inside the box, all labeled MBn.
                mix_box_counter += 1
                box_code = f"MB{mix_box_counter}"

                for prod in products_in_box:
                    gu = (prod.get("gu_product") or "").strip()
                    if not gu:
                        gu = (
                            f"{prod.get('nm_variety','')}_{prod.get('nu_length','')}"
                            f"_{prod.get('nu_stems_bunch','')}_{prod.get('mny_rate_stem','')}"
                        )
                    # Within a mix box, same gu_product can appear in different rows —
                    # merge them using a key that ties the product to this exact box.
                    key = f"{gu}|{box_code}"
                    nu_bunches = int(prod.get("nu_bunches") or 0)

                    if key in merged:
                        merged[key].nu_bunches += nu_bunches
                        if key not in keys_new_in_this_box:
                            merged[key].nu_physical_boxes += 1
                    else:
                        merged[key] = DeliveryLine(
                            gu_product=gu,
                            nm_variety=(prod.get("nm_variety") or "").strip().title(),
                            nm_species=(prod.get("nm_species") or "").strip().title(),
                            nu_length=int(prod.get("nu_length") or 0),
                            nu_stems_bunch=int(prod.get("nu_stems_bunch") or 0),
                            nu_bunches=nu_bunches,
                            mny_rate_stem=float(prod.get("mny_rate_stem") or 0),
                            id_floricode=(prod.get("id_floricode") or "").strip(),
                            nm_product=(prod.get("nm_product") or "").strip(),
                            nm_box=box_code,
                        )
                    keys_new_in_this_box.add(key)
            else:
                # Single-variety box — aggregate by gu_product + box_type.
                # Different box types (HBE vs QBE) stay as separate lines.
                for prod in products_in_box:
                    gu = (prod.get("gu_product") or "").strip()
                    if not gu:
                        gu = (
                            f"{prod.get('nm_variety','')}_{prod.get('nu_length','')}"
                            f"_{prod.get('nu_stems_bunch','')}_{prod.get('mny_rate_stem','')}"
                        )
                    key = f"{gu}|{tp_box}"
                    nu_bunches = int(prod.get("nu_bunches") or 0)

                    if key in merged:
                        merged[key].nu_bunches += nu_bunches
                        if key not in keys_new_in_this_box:
                            merged[key].nu_physical_boxes += 1
                    else:
                        merged[key] = DeliveryLine(
                            gu_product=gu,
                            nm_variety=(prod.get("nm_variety") or "").strip().title(),
                            nm_species=(prod.get("nm_species") or "").strip().title(),
                            nu_length=int(prod.get("nu_length") or 0),
                            nu_stems_bunch=int(prod.get("nu_stems_bunch") or 0),
                            nu_bunches=nu_bunches,
                            mny_rate_stem=float(prod.get("mny_rate_stem") or 0),
                            id_floricode=(prod.get("id_floricode") or "").strip(),
                            nm_product=(prod.get("nm_product") or "").strip(),
                            nm_box=tp_box,
                        )
                    keys_new_in_this_box.add(key)

        lines = sorted(
            merged.values(),
            key=lambda l: (l.nm_species, l.nm_variety, l.nu_length),
        )

        order = DeliveryOrder(
            tx_company=(inv.get("tx_company") or "").strip(),
            nm_location=next(
                (p.get("nm_location", "") for box in inv.get("boxes", [])
                 for p in box.get("products", []) if p.get("nm_location")),
                "",
            ).strip(),
            id_invoice=str(inv.get("id_invoice") or "").strip(),
            id_purchaseorder=str(inv.get("id_purchaseorder") or "").strip(),
            dt_fly=_normalise_date(inv.get("dt_fly") or ""),
            dt_invoice=_normalise_date(inv.get("dt_invoice") or ""),
            nm_ship=(inv.get("nm_ship") or "").strip(),
            nm_cargo=(inv.get("nm_cargo") or "").strip(),
            tx_awb=(inv.get("tx_awb") or "").strip(),
            tx_hawb=(inv.get("tx_hawb") or "").strip(),
            nu_boxes=int(inv.get("nu_boxes") or 0),
            nu_stems_total=sum(l.nu_stems_total for l in lines),
            mny_total=round(sum(l.mny_total for l in lines), 2),
            lines=lines,
        )
        orders.append(order)

    return orders


def _parse_factura_format(data: dict[str, Any]) -> list[DeliveryOrder]:
    """Parse Bloomingacres/FreshFromSource format: single factura object with detalles[]/productos[].

    Field mapping vs internal model:
      empresa        → tx_company       id_factura  → id_invoice
      cuarto_frio    → nm_location      fecha_embarque → dt_fly
      mawb           → tx_awb           hawb        → tx_hawb
      agencia        → nm_ship          cajas       → nu_boxes
      detalles       → boxes            productos   → products
      code_caja      → tp_box           id_producto → gu_product
      nombre_variedad→ nm_variety       tipo_producto → nm_species
      grado          → nu_length        tallos_x_ramo → nu_stems_bunch
      ramos          → nu_bunches       precio      → mny_rate_stem
    """
    merged: dict[str, DeliveryLine] = {}
    mix_box_counter = 0

    for box in data.get("detalles", []):
        products_in_box = box.get("productos", [])
        if not products_in_box:
            continue

        tp_box = _normalise_box((box.get("code_caja") or "").strip())

        unique_ids = {
            str(p.get("id_producto") or "")
            for p in products_in_box
            if p.get("id_producto")
        }

        keys_new_in_this_box: set[str] = set()

        if len(unique_ids) > 1:
            mix_box_counter += 1
            box_code = f"MB{mix_box_counter}"

            for prod in products_in_box:
                gu = str(prod.get("id_producto") or "").strip()
                key = f"{gu}|{box_code}"
                nu_bunches = int(prod.get("ramos") or 0)

                if key in merged:
                    merged[key].nu_bunches += nu_bunches
                    if key not in keys_new_in_this_box:
                        merged[key].nu_physical_boxes += 1
                else:
                    merged[key] = DeliveryLine(
                        gu_product=gu,
                        nm_variety=(prod.get("nombre_variedad") or "").strip().title(),
                        nm_species=(prod.get("tipo_producto") or "").strip().title(),
                        nu_length=int(prod.get("grado") or 0),
                        nu_stems_bunch=int(prod.get("tallos_x_ramo") or 0),
                        nu_bunches=nu_bunches,
                        mny_rate_stem=float(prod.get("precio") or 0),
                        id_floricode="",
                        nm_product=(prod.get("variedad") or "").strip(),
                        nm_box=box_code,
                    )
                keys_new_in_this_box.add(key)
        else:
            for prod in products_in_box:
                gu = str(prod.get("id_producto") or "").strip()
                key = f"{gu}|{tp_box}"
                nu_bunches = int(prod.get("ramos") or 0)

                if key in merged:
                    merged[key].nu_bunches += nu_bunches
                    if key not in keys_new_in_this_box:
                        merged[key].nu_physical_boxes += 1
                else:
                    merged[key] = DeliveryLine(
                        gu_product=gu,
                        nm_variety=(prod.get("nombre_variedad") or "").strip().title(),
                        nm_species=(prod.get("tipo_producto") or "").strip().title(),
                        nu_length=int(prod.get("grado") or 0),
                        nu_stems_bunch=int(prod.get("tallos_x_ramo") or 0),
                        nu_bunches=nu_bunches,
                        mny_rate_stem=float(prod.get("precio") or 0),
                        id_floricode="",
                        nm_product=(prod.get("variedad") or "").strip(),
                        nm_box=tp_box,
                    )
                keys_new_in_this_box.add(key)

    lines = sorted(
        merged.values(),
        key=lambda l: (l.nm_species, l.nm_variety, l.nu_length),
    )

    order = DeliveryOrder(
        tx_company=(data.get("empresa") or "").strip(),
        nm_location=(data.get("cuarto_frio") or "").strip(),
        id_invoice=str(data.get("id_factura") or "").strip(),
        id_purchaseorder="",
        dt_fly=_parse_date_iso(data.get("fecha_embarque") or ""),
        dt_invoice=_parse_date_iso(data.get("fecha") or ""),
        nm_ship=(data.get("agencia") or "").strip(),
        nm_cargo="",
        tx_awb=(data.get("mawb") or "").strip(),
        tx_hawb=(data.get("hawb") or "").strip(),
        nu_boxes=int(data.get("cajas") or 0),
        nu_stems_total=sum(l.nu_stems_total for l in lines),
        mny_total=round(sum(l.mny_total for l in lines), 2),
        lines=lines,
    )

    return [order]


def parse_delivery_json(data: dict[str, Any]) -> list[DeliveryOrder]:
    """Auto-detect format and parse delivery JSON into DeliveryOrder list.

    Format detection:
      "invoices" key present → Format 1/2 (Elite/Ecoroses/Alissroses, english fields, boxes[]/products[])
      "id_factura" key present → Format 3 (Bloomingacres/FFS, spanish fields, detalles[]/productos[])
    """
    if "invoices" in data:
        return _parse_invoices_format(data)
    if "id_factura" in data or "detalles" in data:
        return _parse_factura_format(data)
    raise ValueError("Unknown delivery JSON format: missing 'invoices' or 'id_factura' key")


# ---------------------------------------------------------------------------
# Catalogue matching
# ---------------------------------------------------------------------------

def delivery_key(nm_variety: str | None, nu_length: int | None) -> str:
    """Stable cache key for a delivery line: '<variety_lower>|<length>'."""
    return f"{(nm_variety or '').lower().strip()}|{nu_length or ''}"


# Origin tokens that appear between genus and variety in FP catalogue names.
# Same list as product_creator._ORIGIN_TOKENS — keep in sync.
_ORIGIN_TOKENS = {"ec", "col", "co", "ke", "ken", "nl", "et", "zim", "sa", "tz", "be",
                  "garden", "premium", "special", "select"}


def _norm(s: str) -> str:
    """Lowercase, strip diacritics/hyphens/dots, collapse spaces.

    "x-pression" → "xpression"  |  "Crème" → "creme"  |  "Rosa EC" → "rosa ec"
    """
    s = s.lower().strip()
    # strip diacritics: crème → creme, ñ → n, etc.
    s = _ud.normalize("NFD", s)
    s = "".join(c for c in s if _ud.category(c) != "Mn")
    s = _re.sub(r"[-.'`+]", "", s)
    s = _re.sub(r"\s+", " ", s).strip()
    return s


# Known floral genera — delivery nm_variety starting with one of these is
# treated as a full product name and variety is extracted from it.
_GENERA = {"rosa", "dianthus", "tulipa", "chrysanthemum", "gerbera", "lisianthus",
           "anthurium", "alstroemeria", "freesia", "gypsophila", "lilium", "iris",
           "ranunculus", "eustoma", "helianthus", "hydrangea"}


def _extract_variety(nm_product: str) -> str:
    """Extract the variety part from a full FP catalogue name.

    "Rosa EC Garden Country Candy 60CM 5S" → "country candy"
    "Veggie 60CM 5S"                       → "veggie"  (single word = genus=variety)
    "Rosa Atena"                           → "atena"

    Strips: genus (first token), origin/qualifier tokens, length+bunch suffixes.
    """
    tokens = _norm(nm_product).split()
    if not tokens:
        return ""
    # Remove length/bunch tokens: "60cm", "5s", pure numbers
    tokens = [t for t in tokens if not _re.fullmatch(r"\d+(cm)?|\d+s", t)]
    if not tokens:
        return ""
    # Drop first token (genus like "rosa", "dianthus") only when there are more
    if len(tokens) > 1:
        tokens = tokens[1:]
    # Strip known origin/qualifier tokens
    tokens = [t for t in tokens if t not in _ORIGIN_TOKENS]
    return " ".join(tokens) if tokens else _norm(nm_product).split()[0]


def _variety_sim(delivery_variety: str, catalogue_nm_product: str) -> float:
    """Similarity between a delivery variety name and a FP catalogue product name.

    Handles two forms of delivery_variety:
    - Short variety name:       "Veggie", "Country Candy", "Cotton X-Pression"
    - Full FP product name:     "Rosa Ec Veggie", "Rosa EC Country Candy 50CM"

    For the full-name case the variety is extracted only when the first word is
    a known floral genus (rosa, dianthus, …), so "Pink Mondial" is never confused
    with "Mondial" and "Cotton X-Pression" is never reduced to just "xpression".
    """
    cat_var = _extract_variety(catalogue_nm_product)
    if not cat_var:
        return 0.0

    # Decide how to normalise the delivery side
    first = _norm(delivery_variety).split()
    if first and first[0] in _GENERA:
        # Full product name starting with genus → extract variety part
        d = _extract_variety(delivery_variety)
    else:
        d = _norm(delivery_variety)

    if not d:
        return 0.0

    d_words = set(d.split())
    c_words = set(cat_var.split())

    if d_words and d_words == c_words:
        return 1.0

    # Space-removal exact match (handles apostrophe/hyphen space mismatches):
    #   "O Hara"    (d) vs "ohara"      (cat_var) → d_nospace == cat_nospace ✓
    #   "Carpediem" (d) vs "carpe diem" (cat_var) → d_nospace == cat_nospace ✓
    # Guard: only when d and cat_var differ in space structure but are otherwise
    # the same characters (not a subset like "shimmer" vs "cream shimmer").
    d_nospace = d.replace(" ", "")
    cat_nospace = cat_var.replace(" ", "")
    if len(d_nospace) > 2 and d_nospace == cat_nospace:
        return 1.0
    # Also: multi-word d collapses to a single word found in c_words
    # ("O Hara" → "ohara" ∈ {"pink","ohara"}).  Not for single-word d to avoid
    # "shimmer" falsely matching {"cream","shimmer"}.
    if " " in d and d_nospace in c_words:
        return 1.0

    # Subset match scores just below 1.0 so an exact match always wins.
    # e.g. "Shimmer" ⊂ "Cream Shimmer" → 0.95, but "Shimmer"=="Shimmer" → 1.0
    if d_words and d_words.issubset(c_words):
        return 0.95

    return difflib.SequenceMatcher(None, d, cat_var).ratio()


def match_line_to_catalogue(
    line: "DeliveryLine",
    catalogue: list[dict],
    cached_matches: dict[str, dict] | None = None,
) -> tuple[str, str, str]:
    """Return (fp_product_id, match_method, catalogue_nm_product).

    Uses the same variety-extraction + similarity approach as product_creator.py:
    _extract_variety() strips genus and origin tokens from catalogue nm_product,
    then compares against the delivery variety (word-set first, difflib fallback).

    Priority:
    0. Cache hit (delivery_product_map)
    1. sim == 1.0 — perfect variety word-match (full catalogue, length ignored)
    2. Floricode / VBN
    3. sim ≥ 0.80 — typo-tolerant difflib match (full catalogue)

    Length is intentionally ignored — it is adjusted manually during stock creation.
    """
    key = delivery_key(line.nm_variety, line.nu_length)

    # 0. Cache lookup — only use approved or manual entries as authoritative
    if cached_matches and key in cached_matches:
        m = cached_matches[key]
        if m.get("approved") or m.get("match_type") == "manual":
            return m["fp_product_id"], "cached", m.get("nm_product") or ""

    variety = (line.nm_variety or "").strip()

    if not variety:
        return "", "none", ""

    def _origin_bonus(nm_product: str) -> float:
        """Small bonus so EC > Col > default > Garden when sim scores tie."""
        nm = f" {(nm_product or '').lower()} "
        if " ec " in nm:   return 0.002
        if " col " in nm:  return 0.001
        if " garden " in nm: return -0.001
        return 0.0

    def _scan(entries: list[dict], min_sim: float) -> tuple[dict | None, float]:
        """Return (best_entry, best_sim) from entries above min_sim threshold.

        EC entries beat Garden entries when variety similarity is equal.
        """
        best_e, best_s = None, 0.0
        for e in entries:
            nm = e.get("nm_product") or ""
            s = _variety_sim(variety, nm) + _origin_bonus(nm)
            if s >= min_sim and s > best_s:
                best_e, best_s = e, s
        return best_e, best_s

    # Length is adjusted manually during creation — match only by variety name,
    # scanning the full catalogue regardless of nu_length.

    # 1. Perfect variety match (sim == 1.0)
    e, _ = _scan(catalogue, 1.0)
    if e:
        return e["fp_product_id"], "variety_anylength", e.get("nm_product") or ""

    # 2. Floricode / VBN — guard: at least one word must overlap between the
    #    delivery variety and the catalogue entry's extracted variety.
    #    Floricodes in delivery JSONs are sometimes wrong/stale and would
    #    otherwise produce absurd matches (e.g. "Powder Puff" → "Deep Purple").
    if line.id_floricode:
        first = _norm(variety).split()
        d_w = set((_extract_variety(variety) if first and first[0] in _GENERA
                   else _norm(variety)).split())
        for e in catalogue:
            if e.get("id_floricode") == line.id_floricode:
                c_w = set(_extract_variety(e.get("nm_product") or "").split())
                if d_w and c_w and d_w & c_w:
                    return e["fp_product_id"], "floricode", e.get("nm_product") or ""

    # 3. Fuzzy match (sim ≥ 0.80)
    e, _ = _scan(catalogue, 0.80)
    if e:
        return e["fp_product_id"], "fuzzy_anylength", e.get("nm_product") or ""

    return "", "none", ""


def match_order(
    order: "DeliveryOrder",
    catalogue: list[dict],
    cached_matches: dict[str, dict] | None = None,
) -> "DeliveryOrder":
    """Attach catalogue match results to each line (mutates in-place, returns order)."""
    for line in order.lines:
        fp_id, method, cat_name = match_line_to_catalogue(line, catalogue, cached_matches)
        line.fp_product_id = fp_id
        line.match_method = method
        line.catalogue_nm_product = cat_name
    return order


def order_to_dict(order: DeliveryOrder) -> dict:
    return {
        "tx_company": order.tx_company,
        "nm_location": order.nm_location,
        "id_invoice": order.id_invoice,
        "id_purchaseorder": order.id_purchaseorder,
        "dt_fly": order.dt_fly,
        "dt_invoice": order.dt_invoice,
        "nm_ship": order.nm_ship,
        "nm_cargo": order.nm_cargo,
        "tx_awb": order.tx_awb,
        "tx_hawb": order.tx_hawb,
        "nu_boxes": order.nu_boxes,
        "nu_stems_total": order.nu_stems_total,
        "mny_total": order.mny_total,
        "lines": [
            {
                "gu_product": l.gu_product,
                "nm_variety": l.nm_variety,
                "nm_species": l.nm_species,
                "nu_length": l.nu_length,
                "nu_stems_bunch": l.nu_stems_bunch,
                "nu_bunches": l.nu_bunches,
                "nu_stems_total": l.nu_stems_total,
                "mny_rate_stem": l.mny_rate_stem,
                "mny_total": l.mny_total,
                "id_floricode": l.id_floricode,
                "nm_product": l.nm_product,
                "nm_box": l.nm_box,
                "nu_physical_boxes": l.nu_physical_boxes,
                "fp_product_id": l.fp_product_id,
                "match_method": l.match_method,
                "catalogue_nm_product": l.catalogue_nm_product,
            }
            for l in order.lines
        ],
    }
