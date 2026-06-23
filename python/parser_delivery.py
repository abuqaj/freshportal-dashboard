"""Parse and aggregate delivery JSON (Elite/Ecoroses format) into FreshPortal delivery lines."""
from __future__ import annotations

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


def _normalise_date(raw: str) -> str:
    """MM/DD/YYYY → DD-MM-YYYY (FreshPortal date picker format)."""
    raw = raw.strip()
    parts = raw.split("/")
    if len(parts) == 3:
        m, d, y = parts
        return f"{d.zfill(2)}-{m.zfill(2)}-{y}"
    return raw


def parse_delivery_json(data: dict[str, Any]) -> list[DeliveryOrder]:
    """Parse an invoice JSON and return one DeliveryOrder per invoice."""
    orders: list[DeliveryOrder] = []

    for inv in data.get("invoices", []):
        # Aggregate product lines — separate single-product boxes from mix boxes
        merged: dict[str, DeliveryLine] = {}
        mix_boxes: list[dict] = []   # boxes with multiple product types

        for box in inv.get("boxes", []):
            products_in_box = box.get("products", [])
            unique_guids = {(p.get("gu_product") or "").strip() for p in products_in_box if p.get("gu_product")}

            if len(unique_guids) > 1:
                # Multi-product box → handle as Mix
                mix_boxes.append(box)
                continue

            for prod in products_in_box:
                key = (prod.get("gu_product") or "").strip()
                if not key:
                    key = f"{prod.get('nm_variety','')}_{prod.get('nu_length','')}_{prod.get('nu_stems_bunch','')}_{prod.get('mny_rate_stem','')}"

                nu_bunches = int(prod.get("nu_bunches") or 0)
                if key in merged:
                    merged[key].nu_bunches += nu_bunches
                else:
                    merged[key] = DeliveryLine(
                        gu_product=key,
                        nm_variety=(prod.get("nm_variety") or "").strip().title(),
                        nm_species=(prod.get("nm_species") or "").strip().title(),
                        nu_length=int(prod.get("nu_length") or 0),
                        nu_stems_bunch=int(prod.get("nu_stems_bunch") or 0),
                        nu_bunches=nu_bunches,
                        mny_rate_stem=float(prod.get("mny_rate_stem") or 0),
                        id_floricode=(prod.get("id_floricode") or "").strip(),
                        nm_product=(prod.get("nm_product") or "").strip(),
                    )

        # Add one Mix line per box type (grouped by box name / tp_box)
        mix_by_type: dict[str, list[dict]] = {}
        for box in mix_boxes:
            box_type = (box.get("nm_box") or box.get("tp_box") or "MIX").strip().upper()
            mix_by_type.setdefault(box_type, []).append(box)

        for box_type, boxes in mix_by_type.items():
            mix_key = f"__MIX__{box_type}"
            total_bunches = sum(
                sum(int(p.get("nu_bunches") or 0) for p in b.get("products", []))
                for b in boxes
            )
            merged[mix_key] = DeliveryLine(
                gu_product=mix_key,
                nm_variety=f"Mix {box_type}",
                nm_species="Mix",
                nu_length=0,
                nu_stems_bunch=0,
                nu_bunches=len(boxes),      # number of mix boxes
                mny_rate_stem=0.0,
                id_floricode="",
                nm_product=f"Mix {box_type} ({len(boxes)} dozen)",
            )

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
            id_invoice=(inv.get("id_invoice") or "").strip(),
            id_purchaseorder=(inv.get("id_purchaseorder") or "").strip(),
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


# ---------------------------------------------------------------------------
# Catalogue matching
# ---------------------------------------------------------------------------

def delivery_key(nm_variety: str | None, nu_length: int | None) -> str:
    """Stable cache key for a delivery line: '<variety_lower>|<length>'."""
    return f"{(nm_variety or '').lower().strip()}|{nu_length or ''}"


def match_line_to_catalogue(
    line: "DeliveryLine",
    catalogue: list[dict],
    cached_matches: dict[str, dict] | None = None,
) -> tuple[str, str, str]:
    """Return (fp_product_id, match_method, catalogue_nm_product).

    Matching priority:
    0. Cache hit (delivery_product_map)
    1. Exact nm_variety + nu_length  (via cat.nm_variety or cat.nm_product prefix)
    2. Exact id_floricode
    3. Fuzzy nm_variety in cat.nm_product + nu_length
    4. Mix box
    """
    key = delivery_key(line.nm_variety, line.nu_length)

    # 0. Cache lookup
    if cached_matches and key in cached_matches:
        m = cached_matches[key]
        return m["fp_product_id"], m["match_type"], m.get("nm_product") or ""

    variety = (line.nm_variety or "").lower().strip()
    length = line.nu_length

    # 1. Exact variety + length — check nm_variety first, then nm_product prefix
    for entry in catalogue:
        cat_len = entry.get("nu_length")
        if cat_len != length:
            continue
        cat_var = (entry.get("nm_variety") or "").lower().strip()
        if cat_var and cat_var == variety:
            return entry["fp_product_id"], "variety_length", entry.get("nm_product") or cat_var
        # FP catalogue stores STE_Description like "FREEDOM 60CM 5S" — variety is the first word
        cat_prod = (entry.get("nm_product") or "").lower()
        if variety and cat_prod.startswith(variety):
            return entry["fp_product_id"], "variety_length", entry.get("nm_product") or cat_prod

    # 2. Floricode / VBN match
    if line.id_floricode:
        for entry in catalogue:
            if entry.get("id_floricode") == line.id_floricode:
                return entry["fp_product_id"], "floricode", entry.get("nm_product") or ""

    # 3. Fuzzy variety in nm_product + length
    for entry in catalogue:
        cat_len = entry.get("nu_length")
        if cat_len != length or not variety:
            continue
        cat_var = (entry.get("nm_variety") or "").lower().strip()
        cat_prod = (entry.get("nm_product") or "").lower()
        if (cat_var and (variety in cat_var or cat_var in variety)) or \
           (cat_prod and variety in cat_prod):
            return entry["fp_product_id"], "fuzzy_variety", entry.get("nm_product") or cat_var or cat_prod

    # 4. Mix box matching
    if line.gu_product.startswith("__MIX__"):
        box_type = line.gu_product.replace("__MIX__", "").replace(" ", "").upper()
        for entry in catalogue:
            cat_nm = (entry.get("nm_product") or "").upper()
            if "MIX" in cat_nm and (not box_type or box_type in cat_nm):
                return entry["fp_product_id"], "mix", entry.get("nm_product") or cat_nm

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
                "fp_product_id": l.fp_product_id,
                "match_method": l.match_method,
                "catalogue_nm_product": l.catalogue_nm_product,
            }
            for l in order.lines
        ],
    }
