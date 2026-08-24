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
    # Weight of a single stem (kg). Only present in the Elite/Alissroses JSON format.
    nu_weight: float = 0
    # Physical weight of the box this line came from (kg), from boxes[].nu_box_weight.
    # Same value shared by every line derived from a mix box. Elite/Alissroses format only.
    nu_box_weight: float = 0
    # Box code: HB (or original tp_box) for single-variety boxes;
    # MB1, MB2 … for mix-box products (sequential within the invoice)
    nm_box: str = ""
    # Number of physical boxes merged into this line (≥1).
    # Two boxes of the same product with the same box type share one DeliveryLine
    # but each box must become a separate FP stock entry.
    nu_physical_boxes: int = 1
    # Source location code from JSON (e.g. "Tessa-S") — used for grower lookup
    nm_location: str = ""
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
    # FreshPortal DFG BatchV1 supplier_id, resolved against the local supplier DB
    # (matched from tx_company). Filled in after parsing, before building the API payload.
    supplier_fp_id: str = ""


_BOX_TYPE_MAP = {"QB": "QBE", "HB": "HBE"}

# Single-letter → two-letter box codes used in the Fiorentina text-invoice format
_BOX_LETTER_MAP: dict[str, str] = {
    'F': 'FB', 'H': 'HB', 'Q': 'QB',
    'E': 'EB', 'S': 'SB', 'D': 'DB', 'T': 'TB',
}

# FreshPortal packaging table: box Code -> volume weight (kg).
# Code is sent as-is as the `fust` field in the DFG BatchV1 API.
# NOTE: "1/8" and "1/6" get corrupted to "01-Aug"/"01-Jun" by Excel when the
# source table is exported/copied — verified against the original FreshPortal
# table and corrected here.
_PACKAGING_VOLUME_WEIGHT: dict[str, float] = {
    "EB": 3.06,
    "QBAZ": 5.72,
    "HBE": 20,
    "QBE": 10,
    "QB8STE": 7,
    "QB9STE": 8,
    "QB8XLTE": 9.5,
    "QB9XLTE": 10.5,
    "HBTE": 14.5,
    "HBXLTE": 24,
    "HBXXLTE": 28,
    "MBTE": 38,
    "ECPR": 0.68,
    "ECPMIS": 0.65,
    "ECPSO": 0.29,
    "ECPPM": 0.12,
    "ECPP": 0.23,
    "ECPS": 0.85,
    "MB1": 2, "MB2": 2, "MB3": 2, "MB4": 2, "MB5": 2,
    "MB6": 2, "MB7": 2, "MB8": 2, "MB9": 2, "MB10": 2,
    "MB11": 2, "MB12": 2, "MB13": 2, "MB14": 2, "MB15": 2,
    "MB16": 2, "MB17": 2, "MB18": 2, "MB19": 2, "MB20": 2,
    "MB21": 2, "MB22": 2, "MB23": 2, "MB24": 2, "MB25": 2,
    "MB26": 2, "MB27": 2, "MB28": 2, "MB29": 2, "MB30": 2,
    "MB31": 2, "MB32": 2, "MB33": 2, "MB34": 2, "MB35": 2,
    "MB36": 2, "MB37": 2, "MB38": 2, "MB39": 2, "MB40": 2,
    "MB41": 2, "MB42": 2, "MB43": 2, "MB44": 2, "MB45": 2,
    "MB46": 2, "MB48": 2, "MB49": 2, "MB50": 2,
    "MB51": 2, "MB52": 2, "MB53": 2, "MB54": 2, "MB55": 2,
    "MB57": 2,
    "COGC1": 2,
    "BXPR": 22,
    "BXHY": 11,
    "BB": 7.13,
    "EBC": 4.76,
    "QB": 6.05,
    "XL130": 19.5,
    "XL160": 24,
    "XL125": 37.5,
    "EBRM": 1.7,
    "QBRM": 5.61,
    "HBRM": 11.21,
    "QBE-A": 8.5,
    "1/8": 3.1,
    "1/6": 3.75,
    "52": 2,
    "53": 2,
    "135": 2,
    "555": 2,
    "656": 2,
    "965": 2,
    "990": 2,
    "Box": 2,
    "ZIMTAM": 18.67,
    "EBALX": 3.17,
}

# ASCII patterns used after accent-stripping and corruption normalization.
_LABEL_COLD_RE = _re.compile(r'\bcold\b|\bfri[ao]s?\b', _re.IGNORECASE)
_LABEL_WARM_RE = _re.compile(r'\bcalido[s]?\b|\bcaliente[s]?\b|\bwarm\b', _re.IGNORECASE)


def _normalise_box(tp: str) -> str:
    """Normalise box type code: QB → QBE (FreshPortal convention)."""
    return _BOX_TYPE_MAP.get(tp.upper(), tp)


# Pomarosa grower lookup: nm_location (case-insensitive, spaces normalised) → FP grower_id
_POMAROSA_GROWER_MAP: dict[str, str] = {
    "tessa-e1":  "57396",  # Ecuanros
    "tessa-e2":  "57396",  # Ecuanros
    "tessa-s":   "61370",  # Solera
    "tessa-p":   "60649",  # Positano
    "tessa-ps2": "60649",  # Positano
    "tessa-1":   "57369",  # Tessa
    "tessa-3":   "57369",  # Tessa
    "tessa-d":   "57366",  # Growerfarms S.A
    "tessa-f":   "57426",  # Arcoflor Floress Arcoiris
    "tessa-r1":  "57344",  # Inversiones Pontetresa
    "tessa-r2":  "57344",  # Inversiones Pontetresa
    "tessa-r3":  "57344",  # Inversiones Pontetresa
}


def _resolve_grower_id(nm_location: str) -> str:
    """Return FP grower_id for the given nm_location, or '' if not mapped."""
    key = _re.sub(r"\s+", "", nm_location).lower()
    return _POMAROSA_GROWER_MAP.get(key, "")


def _normalise_label(label: str) -> str:
    """Prepare label for temperature-keyword matching.

    Handles three encoding corruption scenarios common in supplier JSON files:
    1. Proper UTF-8 accents (Á): NFKD decomposition + combining mark removal → A
    2. Double-encoded Latin-1-as-UTF-8 (Á → Ã + U+0081): Ã→A via NFKD,
       U+0081 removed as C1 control char (Unicode category Cc)
    3. Raw Latin-1 byte read as UTF-8 (Á → U+FFFD): replaced with A

    """
    decomposed = _ud.normalize("NFKD", label)
    cleaned = "".join(
        c for c in decomposed
        if not _ud.combining(c) and _ud.category(c) != "Cc"
    )
    return cleaned.replace("�", "A")




def _enrich_variety(nm_variety: str, tx_label: str) -> str:
    """Append 'Cold' or 'Warm' qualifier to nm_variety when tx_label contains one."""
    if not tx_label or not nm_variety:
        return nm_variety
    label = _normalise_label(tx_label)
    if _LABEL_COLD_RE.search(label):
        qualifier = "Cold"
    elif _LABEL_WARM_RE.search(label):
        qualifier = "Warm"
    else:
        return nm_variety
    if qualifier.lower() not in nm_variety.lower():
        return f"{nm_variety} {qualifier}"
    return nm_variety


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
            tx_label = (box.get("tx_label") or "").strip()

            unique_guids = {
                str(p.get("gu_product") or "").strip()
                for p in products_in_box
                if str(p.get("gu_product") or "").strip()
            }

            # Track which keys are first seen in this physical box.
            # Used to increment nu_physical_boxes exactly once per box.
            keys_new_in_this_box: set[str] = set()

            if len(unique_guids) > 1:
                # Mix box — one line per product inside the box, all labeled MBn.
                mix_box_counter += 1
                box_code = f"MB{mix_box_counter}"

                for prod in products_in_box:
                    gu = str(prod.get("gu_product") or "").strip()
                    if not gu:
                        nm_var_for_key = prod.get("nm_variety") or prod.get("id_migros") or ""
                        gu = (
                            f"{nm_var_for_key}_{prod.get('nu_length','')}"
                            f"_{prod.get('nu_stems_bunch','')}_{prod.get('mny_rate_stem','')}"
                        )
                    # Within a mix box, same gu_product can appear in different rows —
                    # merge them using a key that ties the product to this exact box.
                    # Include nm_variety in the key so same gu_product with different
                    # temperature qualifiers (e.g. Bicolor Cold vs Bicolor Warm) stay separate.
                    raw_variety = (prod.get("nm_variety") or prod.get("id_migros") or "").strip()
                    nm_variety = _enrich_variety(raw_variety.title(), tx_label)
                    key = f"{gu}|{box_code}|{nm_variety.lower()}"
                    nu_bunches = int(prod.get("nu_bunches") or 0)

                    if key in merged:
                        merged[key].nu_bunches += nu_bunches
                        if key not in keys_new_in_this_box:
                            merged[key].nu_physical_boxes += 1
                    else:
                        merged[key] = DeliveryLine(
                            gu_product=gu,
                            nm_variety=nm_variety,
                            nm_species=(prod.get("nm_species") or "").strip().title(),
                            nu_length=int(prod.get("nu_length") or 0),
                            nu_stems_bunch=int(prod.get("nu_stems_bunch") or 0),
                            nu_bunches=nu_bunches,
                            mny_rate_stem=float(prod.get("mny_rate_stem") or 0),
                            id_floricode=(prod.get("id_floricode") or "").strip(),
                            nm_product=(prod.get("nm_product") or "").strip(),
                            nm_box=box_code,
                            nm_location=(prod.get("nm_location") or "").strip(),
                            nu_weight=float(prod.get("nu_weight") or 0),
                            nu_box_weight=float(box.get("nu_box_weight") or 0),
                        )
                    keys_new_in_this_box.add(key)
            else:
                # Single-variety box — aggregate by gu_product + box_type.
                # Different box types (HBE vs QBE) stay as separate lines.
                for prod in products_in_box:
                    gu = str(prod.get("gu_product") or "").strip()
                    if not gu:
                        nm_var_for_key = prod.get("nm_variety") or prod.get("id_migros") or ""
                        gu = (
                            f"{nm_var_for_key}_{prod.get('nu_length','')}"
                            f"_{prod.get('nu_stems_bunch','')}_{prod.get('mny_rate_stem','')}"
                        )
                    # Include nm_variety in the key so same gu_product with different
                    # temperature qualifiers (e.g. Bicolor Cold vs Bicolor Warm) stay separate.
                    # Include mny_rate_stem so boxes priced differently stay as separate lines.
                    raw_variety = (prod.get("nm_variety") or prod.get("id_migros") or "").strip()
                    nm_variety = _enrich_variety(raw_variety.title(), tx_label)
                    mny_rate = float(prod.get("mny_rate_stem") or 0)
                    key = f"{gu}|{tp_box}|{nm_variety.lower()}|{mny_rate}"
                    nu_bunches = int(prod.get("nu_bunches") or 0)

                    if key in merged:
                        merged[key].nu_bunches += nu_bunches
                        if key not in keys_new_in_this_box:
                            merged[key].nu_physical_boxes += 1
                    else:
                        merged[key] = DeliveryLine(
                            gu_product=gu,
                            nm_variety=nm_variety,
                            nm_species=(prod.get("nm_species") or "").strip().title(),
                            nu_length=int(prod.get("nu_length") or 0),
                            nu_stems_bunch=int(prod.get("nu_stems_bunch") or 0),
                            nu_bunches=nu_bunches,
                            mny_rate_stem=float(prod.get("mny_rate_stem") or 0),
                            id_floricode=(prod.get("id_floricode") or "").strip(),
                            nm_product=(prod.get("nm_product") or "").strip(),
                            nm_box=tp_box,
                            nm_location=(prod.get("nm_location") or "").strip(),
                            nu_weight=float(prod.get("nu_weight") or 0),
                            nu_box_weight=float(box.get("nu_box_weight") or 0),
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


def _parse_text_invoice(text: str) -> list[DeliveryOrder]:
    """Parse Fiorentina/vertopal.com text-as-JSON-key format.

    The JSON has exactly one key containing the full invoice text (produced by
    PDF-to-JSON converters).  The product table has 10 columns, one value per line:
      BOX | TB | Box code | VARIETY | CAN | BUNCHES | LENGT | STEMS | PRICE/UNIT | TOTAL
    """
    clean = text.replace('﻿', '').replace('\r\n', '\n').replace('\r', '\n')
    lines = [l.rstrip() for l in clean.split('\n')]
    full = '\n'.join(lines)

    # --- metadata ---
    tx_company = next((l.strip() for l in lines if l.strip()), '')

    def _rx(pattern: str) -> str:
        m = _re.search(pattern, full, _re.IGNORECASE)
        return m.group(1).strip() if m else ''

    id_invoice = _rx(r'INVOICE\s*#\s*0*(\d+)')
    tx_awb     = _rx(r'A\.W\.B[^:\n]*:\s*[\t ]*(\S+)')
    tx_hawb    = _rx(r'H\.A\.W\.B[^:\n]*:\s*[\t ]*(\S+)')
    nm_cargo   = _rx(r'Shipper\s*:\s*[\t ]*(.+)')

    # First "Date :" in dd/mm/yyyy (skip "Due Date")
    dt_invoice = ''
    for _m in _re.finditer(r'Date\s*:\s*[\t ]*(\d{2}/\d{2}/\d{4})', full, _re.IGNORECASE):
        if 'due' not in full[max(0, _m.start() - 6):_m.start()].lower():
            _d, _mo, _y = _m.group(1).split('/')
            dt_invoice = f"{_d}-{_mo}-{_y}"
            break
    dt_fly = dt_invoice

    # Consignee name: first ALL-CAPS line after "Consignee" or "To" label
    nm_ship = ''
    _sm = _re.search(r'(?:Consignee|To)\s*:.*?\n([A-Z][A-Z\s&,.\\-]+)\n', full)
    if _sm:
        nm_ship = _sm.group(1).strip()

    # --- product table ---
    _COLS = 10
    table_start = -1
    for i in range(len(lines) - _COLS):
        if (lines[i].strip().upper() == 'BOX'
                and lines[i + 1].strip().upper() == 'TB'
                and 'BOX' in lines[i + 2].strip().upper()
                and lines[i + 3].strip().upper() == 'VARIETY'):
            table_start = i + _COLS  # skip header row
            break

    delivery_lines: list[DeliveryLine] = []
    nu_boxes = 0

    if table_start >= 0:
        pos = table_start
        while pos + _COLS <= len(lines):
            chunk = [l.strip() for l in lines[pos:pos + _COLS]]
            # End-of-table: first column is "TOTAL" or non-numeric
            if not chunk[0] or not _re.fullmatch(r'\d+', chunk[0]):
                break
            try:
                box_letter = chunk[1].upper()
                nm_box = _normalise_box(_BOX_LETTER_MAP.get(box_letter, box_letter + 'B'))
                nm_variety = chunk[3].title()
                nu_bunches    = int(chunk[4])
                nu_stems_bunch = int(chunk[5])
                nu_length     = int(chunk[6])
                mny_rate_stem = float(chunk[8].replace(',', '.'))
            except (ValueError, IndexError):
                pos += _COLS
                continue

            gu = f"{nm_variety.lower()}_{nu_length}_{nu_stems_bunch}_{mny_rate_stem}"
            delivery_lines.append(DeliveryLine(
                gu_product=gu,
                nm_variety=nm_variety,
                nm_species='Roses',
                nu_length=nu_length,
                nu_stems_bunch=nu_stems_bunch,
                nu_bunches=nu_bunches,
                mny_rate_stem=mny_rate_stem,
                id_floricode='',
                nm_product=f"{nm_variety} {nu_length}CM",
                nm_box=nm_box,
                nu_physical_boxes=1,
            ))
            nu_boxes += 1
            pos += _COLS

    return [DeliveryOrder(
        tx_company=tx_company,
        nm_location='',
        id_invoice=id_invoice,
        id_purchaseorder=id_invoice,
        dt_fly=dt_fly,
        dt_invoice=dt_invoice,
        nm_ship=nm_ship,
        nm_cargo=nm_cargo,
        tx_awb=tx_awb,
        tx_hawb=tx_hawb,
        nu_boxes=nu_boxes,
        nu_stems_total=sum(l.nu_stems_total for l in delivery_lines),
        mny_total=round(sum(l.mny_total for l in delivery_lines), 4),
        lines=delivery_lines,
    )]


def _parse_etiqueta_format(data: dict[str, Any]) -> list[DeliveryOrder]:
    """Parse per-etiqueta format: single object with detalle[] — one row per physical box.

    Field mapping:
      fecha      → dt_invoice / dt_fly    invoice → id_invoice
      cajas      → nu_boxes               detalle → boxes
      PRODUCTO   → nm_product             NomVariedad → nm_variety
      NomColor   → appended to nm_variety BOX     → nm_box
      Bch/box    → nu_bunches (rounded)   st/Bch  → nu_stems_bunch
      Price      → mny_rate_stem          Boxes   → nu_physical_boxes
    """
    merged: dict[str, DeliveryLine] = {}

    for item in data.get("detalle", []):
        producto = (item.get("PRODUCTO") or "").strip()
        nm_variedad = (item.get("NomVariedad") or "").strip()
        nm_color = (item.get("NomColor") or "").strip()

        if nm_variedad:
            nm_variety = f"{nm_variedad} {nm_color}".strip().title()
        else:
            nm_variety = producto.title()

        tp_box = _normalise_box((item.get("BOX") or "").strip())
        nu_bunches = max(1, round(float(item.get("Bch/box") or 0)))
        nu_stems_bunch = int(item.get("st/Bch") or 0)
        mny_rate_stem = float(item.get("Price") or 0)
        nu_boxes_item = int(item.get("Boxes") or 1)

        prod_lower = producto.lower()
        if "minicarnation" in prod_lower or "mini carnation" in prod_lower:
            nm_species = "Mini Carnation"
        elif "carnation" in prod_lower or "dianthus" in prod_lower:
            nm_species = "Carnation"
        elif "rose" in prod_lower:
            nm_species = "Roses"
        else:
            nm_species = producto.split()[0].title() if producto else ""

        key = f"{nm_variety.lower()}|{tp_box}|{nu_stems_bunch}|{mny_rate_stem}"

        if key in merged:
            merged[key].nu_bunches += nu_bunches
            merged[key].nu_physical_boxes += nu_boxes_item
        else:
            merged[key] = DeliveryLine(
                gu_product=key,
                nm_variety=nm_variety,
                nm_species=nm_species,
                nu_length=0,
                nu_stems_bunch=nu_stems_bunch,
                nu_bunches=nu_bunches,
                mny_rate_stem=mny_rate_stem,
                id_floricode="",
                nm_product=producto,
                nm_box=tp_box,
                nu_physical_boxes=nu_boxes_item,
            )

    lines = sorted(merged.values(), key=lambda l: (l.nm_species, l.nm_variety, l.nu_length))

    return [DeliveryOrder(
        tx_company="",
        nm_location="",
        id_invoice=str(data.get("invoice") or "").strip(),
        id_purchaseorder="",
        dt_fly=_parse_date_iso(data.get("fecha") or ""),
        dt_invoice=_parse_date_iso(data.get("fecha") or ""),
        nm_ship="",
        nm_cargo="",
        tx_awb="",
        tx_hawb="",
        nu_boxes=int(data.get("cajas") or 0),
        nu_stems_total=sum(l.nu_stems_total for l in lines),
        mny_total=round(sum(l.mny_total for l in lines), 2),
        lines=lines,
    )]


def parse_delivery_json(data: dict[str, Any]) -> list[DeliveryOrder]:
    """Auto-detect format and parse delivery JSON into DeliveryOrder list.

    Format detection:
      single key with null value containing newlines + "INVOICE" → Fiorentina text format
      "invoices" key present → Format 1/2 (Elite/Ecoroses/Alissroses, english fields, boxes[]/products[])
      "id_factura" or "detalles" key present → Format 3 (Bloomingacres/FFS, spanish fields)
      "detalle" key present → Format 4 (per-etiqueta, one row per physical box)
    """
    if len(data) == 1:
        _key, _val = next(iter(data.items()))
        if isinstance(_key, str) and _val is None and '\n' in _key and 'INVOICE' in _key.upper():
            return _parse_text_invoice(_key)
    if "invoices" in data:
        return _parse_invoices_format(data)
    if "id_factura" in data or "detalles" in data:
        return _parse_factura_format(data)
    if "detalle" in data:
        return _parse_etiqueta_format(data)
    raise ValueError("Unknown delivery JSON format: missing 'invoices', 'id_factura', or 'detalle' key")


# ---------------------------------------------------------------------------
# Catalogue matching
# ---------------------------------------------------------------------------

def delivery_key(nm_variety: str | None) -> str:
    """Stable cache key for a delivery line: '<variety_lower>'.

    Keyed by variety name only (length excluded) — a confirmed product match
    is a variety-identity decision, not a per-length one, so it should apply
    to every line sharing the name (any length) in this order and in future
    deliveries for the same supplier.
    """
    return (nm_variety or "").lower().strip()


# Origin tokens that appear between genus and variety in FP catalogue names.
# Same list as product_creator._ORIGIN_TOKENS — keep in sync.
_ORIGIN_TOKENS = {"ec", "col", "co", "ke", "ken", "nl", "et", "zim", "sa", "tz", "be",
                  "garden", "premium", "special", "select",
                  "preserved", "stem"}  # Preserved-rose catalogue format: "Rosa Preserved Stem 50cm <variety>"

# Descriptor words that appear as a leading token in assembled/preserved delivery varieties
# but never form part of the FP catalogue variety name.
_DELIVERY_DESCRIPTOR_TOKENS = {"assembled", "assembly"}


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

    # Strip product-code tokens that contain both letters and digits (e.g. "sh02st",
    # "dbp13st", "mlg14st") — these are SKU suffixes, not variety words.
    # Also strip known delivery descriptor prefixes like "assembled".
    d_tokens = d.split()
    d_tokens = [
        t for t in d_tokens
        if not (_re.search(r'[a-z]', t) and _re.search(r'\d', t))  # alphanumeric code
        and t not in _DELIVERY_DESCRIPTOR_TOKENS
    ]
    if d_tokens:
        d = " ".join(d_tokens)

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
    key = delivery_key(line.nm_variety)

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

        Entries with a GTIN take priority over those without — regardless of
        similarity score — since a filled GTIN indicates a complete, actively
        maintained catalogue entry rather than a legacy/duplicate one. EC
        entries beat Garden entries when GTIN status and similarity are equal.
        """
        best_e, best_s, best_gtin = None, 0.0, False
        for e in entries:
            nm = e.get("nm_product") or ""
            s = _variety_sim(variety, nm) + _origin_bonus(nm)
            if s < min_sim:
                continue
            gtin = bool(e.get("has_gtin"))
            if best_e is None or (gtin, s) > (best_gtin, best_s):
                best_e, best_s, best_gtin = e, s, gtin
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
                "nm_location": l.nm_location,
                "nu_weight": l.nu_weight,
                "nu_box_weight": l.nu_box_weight,
            }
            for l in order.lines
        ],
    }
