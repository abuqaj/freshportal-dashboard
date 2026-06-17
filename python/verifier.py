"""Verification logic: compares FreshPortal VBN codes against VBN.nl data."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from ai_helper import ai_suggest_vbn_for_checker
from config import Config
from scraper_fp import FPProduct
from scraper_vbn import VBNInfo, find_specific_vbn, find_best_colour_vbn, search_vbn_by_name, _NOISE_WORDS

logger = logging.getLogger(__name__)

# Known VBN reference table (supplement for offline/quick checks)
KNOWN_VBN: dict[str, str] = {
    "269": "Ranunculus other",
    "580": "Rosa grootbloemig overig",
    "595": "Rosa spray other",
    "2712": "Droogbloemen bewerkt H%",
    "4159": "Ruscus coloured H%",
    "6268": "Cutflowers other coloured H%",
    "15126": "Rosa large flowered colour treated",
    "16128": "Rosa spray colour treated H%",
    "17659": "Genista kleurbehandeld H%",
    "121267": "Amaranthus colour treated H%",
    "121584": "Anemone coronaria Mistral Plus Pinkie",
    "122819": "Lepidium kleurbehandeld H%",
}

# Genus-specific fallback VBNs for colour treated products.
# Key: lowercase first word of product name.  Value: (non-spray VBN, spray VBN)
COLOUR_TREATED_BY_GENUS: dict[str, tuple[str, str]] = {
    "rosa":       ("15126", "16128"),  # Rosa large flowered / Rosa spray
    "ruscus":     ("4159",  "4159"),
    "genista":    ("17659", "17659"),
    "amaranthus": ("121267","121267"),
    "lepidium":   ("122819","122819"),
}
COLOUR_TREATED_GENERIC = "6268"  # Cutflowers other coloured — last resort

TREATED_KEYWORDS = ("preserved", "bleached", "dried", "painted", "absorbed", "tinted", "colour treated")

# "spray" in various languages used in flower product names
SPRAY_KEYWORDS = (
    "spray",   # EN
    " sp ",    # abbreviation
    "tros",    # NL (Dutch cluster/spray rose)
)


def _is_spray(name: str) -> bool:
    n = name.lower()
    # "tros" must be a whole word to avoid matching substrings like "Smartrose"
    has_tros = bool(re.search(r'\btros\b', n))
    other_kws = [kw for kw in SPRAY_KEYWORDS if kw != "tros"]
    return any(kw in n for kw in other_kws) or has_tros or n.startswith("sp ") or n.endswith(" sp")


def _is_treated(name: str) -> bool:
    n = name.lower()
    return any(kw in n for kw in TREATED_KEYWORDS)


def _contains_colour_treated(name: str) -> bool:
    n = name.lower()
    colour_kws = ("painted", "absorbed", "tinted", "colour treated", "kleurbehandeld", "colores")
    return any(kw in n for kw in colour_kws) or bool(re.search(r"\bdye[sd]?\b", n))


def _contains_preserved(name: str) -> bool:
    n = name.lower()
    return any(kw in n for kw in ("preserved", "bleached", "dried"))


@dataclass
class VerificationResult:
    product: FPProduct
    vbn_info: VBNInfo | None
    status: str  # "OK" | "ERROR" | "WARNING"
    reason: str = ""
    proposed_vbn: str = ""




def verify_products(
    products: list[FPProduct],
    vbn_data: dict[str, VBNInfo],
    cfg: Config,
    auto_mode: bool = False,
    on_progress=None,
) -> list[VerificationResult]:
    """Apply verification rules to each product. Uses AI for ambiguous cases.
    auto_mode=True skips Rule 5 (AI-only generic check) to prevent hallucinations in automated runs."""
    results: list[VerificationResult] = []

    total = len(products)
    for idx, p in enumerate(products, 1):
        if on_progress:
            on_progress(idx, total)
        vbn_info = vbn_data.get(p.vbn_number)
        status = "OK"
        reason = ""
        proposed = ""

        if p.origin.lower() != "system":
            results.append(VerificationResult(
                product=p, vbn_info=vbn_data.get(p.vbn_number), status="OK", reason="", proposed_vbn=""
            ))
            continue

        if not p.vbn_number:
            _, _, ai_proposed = ai_suggest_vbn_for_checker(p.name, "", "", "", cfg)
            results.append(VerificationResult(
                product=p,
                vbn_info=None,
                status="ERROR",
                reason="No VBN code assigned",
                proposed_vbn=ai_proposed,
            ))
            continue

        if vbn_info is None or not vbn_info.found:
            _, _, ai_proposed = ai_suggest_vbn_for_checker(p.name, p.vbn_number, "", "", cfg)
            results.append(VerificationResult(
                product=p,
                vbn_info=vbn_info,
                status="ERROR",
                reason=f"VBN {p.vbn_number} not found in vbn.nl",
                proposed_vbn=ai_proposed,
            ))
            continue

        name = p.name
        official = vbn_info.official_name
        group = vbn_info.product_group

        # Rule 1: Preserved/Bleached/Dried → must use 2712 or more specific
        if _contains_preserved(name):
            if p.vbn_number != "2712" and not any(kw in official.lower() for kw in ("droog", "dried", "dry")):
                status = "ERROR"
                genus = name.split()[0]
                specific = find_specific_vbn(genus, "droog", cfg.floricode_username, cfg.floricode_password)
                proposed = specific or "2712"
                reason = (
                    f"Product name indicates Preserved/Bleached/Dried but VBN {p.vbn_number} "
                    f"({official}) is not for dried/treated flowers. Expected VBN {proposed} or more specific."
                )

        # Rule 2: Colour treated → look for specific kleurbehandeld VBN
        elif _contains_colour_treated(name):
            colour_vbn_names = ("kleurbehandeld", "colour treated", "coloured", "colored", "color")
            if not any(kw in official.lower() for kw in colour_vbn_names):
                status = "ERROR"
                is_spray_product = _is_spray(name)
                genus = name.split()[0].lower()

                # 1. Search full colour table (all genera, built from Floricode)
                specific = find_best_colour_vbn(
                    name, is_spray_product,
                    cfg.floricode_username, cfg.floricode_password,
                )

                # 2. Direct Floricode search — catches genera not in cached table
                #    (e.g. table not yet built, or genus uses 'gekleurd' keyword)
                if not specific and cfg.floricode_username:
                    for treatment_kw in ("kleurbehandeld", "coloured", "gekleurd", "colour treated"):
                        hits = search_vbn_by_name(
                            f"{genus} {treatment_kw}",
                            cfg.floricode_username, cfg.floricode_password,
                            limit=10,
                        )
                        if hits:
                            # Score by botanical word overlap with product name
                            product_botanical = {
                                w for w in name.lower().split()
                                if len(w) > 2 and w not in _NOISE_WORDS
                            }
                            best = max(hits, key=lambda h: len(
                                product_botanical & {w for w in h["name"].lower().split() if len(w) > 2}
                            ))
                            specific = best["id"]
                            logger.info("Direct search found colour VBN for '%s': %s (%s)", name, specific, best["name"])
                            break

                # 3. Hardcoded genus fallback (when Floricode creds not set)
                if not specific:
                    genus_vbns = COLOUR_TREATED_BY_GENUS.get(genus)
                    if genus_vbns:
                        specific = genus_vbns[1] if is_spray_product else genus_vbns[0]

                # 4. Last resort: generic
                proposed = specific or COLOUR_TREATED_GENERIC
                reason = (
                    f"Product is colour treated but VBN {p.vbn_number} ({official}) "
                    "doesn't reflect colour treatment. Look for specific kleurbehandeld VBN."
                )

        # Rule 3: Spray check
        elif _is_spray(name):
            spray_vbn_names = ("spray", "tros")
            if not any(kw in official.lower() for kw in spray_vbn_names):
                is_correct, ai_reason, ai_proposed = ai_suggest_vbn_for_checker(
                    name, p.vbn_number, official, group, cfg
                )
                if not is_correct:
                    status = "ERROR"
                    reason = ai_reason
                    proposed = ai_proposed
                else:
                    status = "WARNING"
                    reason = (
                        f"Product name suggests spray type but VBN {p.vbn_number} ({official}) "
                        "doesn't mention spray. Verify manually."
                    )

        # Rule 4: Non-spray name with spray VBN
        elif not _is_spray(name) and "spray" in official.lower():
            is_correct, ai_reason, ai_proposed = ai_suggest_vbn_for_checker(
                name, p.vbn_number, official, group, cfg
            )
            if not is_correct:
                status = "ERROR"
                reason = ai_reason
                proposed = ai_proposed
            else:
                status = "ERROR"
                reason = (
                    f"Product name has no 'Spray'/'Sp' but VBN {p.vbn_number} ({official}) is for spray. "
                    "Use non-spray VBN."
                )

        # Rule 5: Generic ambiguous — ask AI (skipped in auto_mode to prevent hallucinations)
        # Only flag as incorrect if the AI both says it's wrong AND found a specific alternative.
        # If the AI says "too generic" but proposes nothing, treat the VBN as acceptable.
        elif not auto_mode:
            is_correct, ai_reason, ai_proposed = ai_suggest_vbn_for_checker(
                name, p.vbn_number, official, group, cfg
            )
            if not is_correct and ai_proposed:
                status = "ERROR"
                reason = ai_reason
                proposed = ai_proposed

        # If the proposed fix is identical to the current code, there is no improvement possible
        if proposed and proposed == p.vbn_number:
            proposed = ""
            status = "OK"
            reason = ""

        results.append(VerificationResult(
            product=p,
            vbn_info=vbn_info,
            status=status,
            reason=reason,
            proposed_vbn=proposed,
        ))

    return results
