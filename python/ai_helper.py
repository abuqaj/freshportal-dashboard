"""Claude AI helpers for product creation flow.

ai_analyze_product(query, candidates, cfg)
  — single Haiku call that does two things at once:
    1. Duplicate check: is any candidate the same variety as the query?
    2. VBN suggestion: what code should the new product get?
"""
from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING

import anthropic

if TYPE_CHECKING:
    from config import Config
    from product_creator import ProductMatch

logger = logging.getLogger(__name__)


def ai_suggest_spellings(variety: str, cfg: "Config") -> list[str]:
    """Ask Claude for likely correct spellings of a possibly misspelled variety name.

    Returns 2-3 candidate spellings (NOT including the original).
    Fast call — max_tokens=80, single sentence prompt.
    """
    if not cfg.anthropic_api_key or not variety:
        return []
    try:
        client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)
        msg = client.messages.create(
            model=cfg.anthropic_model,
            max_tokens=80,
            messages=[{
                "role": "user",
                "content": (
                    f'The flower variety name "{variety}" may be misspelled. '
                    "List 2-3 likely CORRECT spellings (common fixes: missing h, "
                    "double letters, i↔y, c↔k). "
                    'Return ONLY a JSON array, e.g. ["Athena","Atena"]'
                ),
            }],
        )
        text = msg.content[0].text.strip()
        m = re.search(r"\[.*?\]", text, re.DOTALL)
        if not m:
            return []
        spellings: list[str] = json.loads(m.group())
        # Exclude the original variety (case-insensitive) to avoid redundant searches
        return [s for s in spellings if s.lower() != variety.lower()]
    except Exception as exc:
        logger.error("ai_suggest_spellings failed: %s", exc)
        return []

_VBN_CONTEXT = """
CRITICAL — FreshPortal names are in English, Floricode VBN names are in Dutch.
Equivalent terms (treat as identical when matching):
  "Spray"          ↔  "Tros"
  "Large-flowered" ↔  "Grootbloemig"
  "Other"          ↔  "Overig"
  "Colour treated" ↔  "Kleurbehandeld"

Always compare the DUTCH translation of the product name against Floricode VBN names.
Example: "Rosa Spray Royal Blush" → Dutch: "Rosa Tros Royal Blush"
  → Floricode VBN 130231 is named "Rosa Tros Royal Blush" → MATCH → suggest 130231, not 595.

CRITICAL — genus rule (HIGHEST PRIORITY):
The FIRST word of a product name is ALWAYS the genus/family. All remaining words describe
variety, color, or type — they are NEVER a different genus.
  "Limonium Rose"  → genus=Limonium, "Rose"=color/variety descriptor → Limonium VBN, NOT Rosa
  "Limonium Pink"  → genus=Limonium, "Pink"=color descriptor → Limonium VBN, NOT Rosa
  "Gypsophila Blue"→ genus=Gypsophila, "Blue"=color → Gypsophila VBN, NOT anything else
Color and variety words (Rose, Pink, Blue, Red, Peach, Lavender, Lemon, Orchid, White, Yellow…)
can follow ANY genus as descriptors. NEVER change the genus when proposing a VBN.

Category VBN codes (use ONLY when no specific variety code exists for this product):
  580   — Rosa grootbloemig overig (large-flowered NON-spray, any origin including Ecuador)
  595   — Rosa spray other / tros overig (SPRAY type roses)
  2712  — Droogbloemen bewerkt (Preserved / Bleached / Dried flowers)
  6268  — Cutflowers other coloured (colour-treated, no specific code)
  15126 — Rosa large flowered colour treated
  16128 — Rosa spray colour treated

"Ec" in name = Ecuador COUNTRY OF ORIGIN only.
"""

_PROMPT_TEMPLATE = """\
You are an expert in Dutch flower auction product names and VBN product codes.

## Product the user wants to create
"{query}"

## Similar products already in the system (string-match candidates)
{candidates}

---

### Naming conventions (from company style guide)
- Format: {{Family Name}} {{Origin/Type}} {{Variety/Color}}
- Rosa large-flowered (non-spray): "Rosa {{Name}}" or "Rosa Ec {{Name}}" (Ec = Ecuador)
- Rosa spray: "Rosa Spray {{Name}}" or "Rosa Ec Spray {{Name}}"
- Use English language (color names etc.)
- "Tros", "Tr", "Sp" → should be "Spray" in the name
- Preserved/Bleached/Dried: "{{Family}} {{Treatment}} {{Variety/Color}}"

## TASK 1 — Duplicate check
Is any of the candidates the SAME variety as "{query}"?

Rules:
- Origin prefixes are NOT part of the variety name and must be ignored:
  "Ec" = Ecuador, "Col" = Colombia, "Ke" = Kenya, "Nl" = Netherlands, etc.
- "Sp" or "Spray" in the name IS significant — spray variety ≠ non-spray variety.
- Common misspellings count as the same variety:
  Atena ≈ Athena, Litchi ≈ Lychee, Naomi ≈ Naomy, Jaques ≈ Jacques, etc.
- Only mark as duplicate when you are reasonably sure.

## TASK 2 — Dutch translation
Translate "{query}" into Dutch using Floricode conventions:
- "Spray" → "Tros"
- Color terms → Dutch: Red→Rood, White→Wit, Yellow→Geel, Pink→Roze,
  Purple→Paars, Blue→Blauw, Orange→Oranje, Lavender→Lavendel, Green→Groen
- Proper variety names (Royal Blush, Athena, Naomi…) → keep unchanged
- "Large-flowered" → "Grootbloemig"

## TASK 3 — VBN code suggestion
Using the Dutch translation of "{query}", determine the correct VBN code.
Validate your reasoning: the Floricode VBN name should match the Dutch translation.

{vbn_context}

Additional rules:
- "Ec", "Col", "Ke" etc. in name = country of origin ONLY.
- When a candidate's VBN name (Dutch) matches the Dutch translation of "{query}",
  that VBN is the correct specific code — prefer it over category codes.
  But reason about it: does the product type AND color match?
- "Preserved" / "Bleached" / "Dried" → 2712.
- "Colour treated" / "Painted" / "Absorbed" → 6268 or specific kleurbehandeld code.

IMPORTANT — candidates may have WRONG VBNs stored in the database.
For each candidate, validate whether its VBN category (product type, treatment method,
spray vs non-spray) actually matches the product described by "{query}".
Do NOT copy a candidate's VBN if the category contradicts the product type.
Instead, determine the correct VBN from the Dutch translation of "{query}".
Always fill in the "explanation" field: state which Floricode name matched the Dutch
translation, or why you chose a category code instead of a specific variety code.

---

Respond with ONLY valid JSON (no explanation outside the JSON):
{{
  "duplicate": {{
    "found": true,
    "product_id": "<id or null>",
    "product_name": "<name or null>",
    "confidence": "high",
    "reason": "<one sentence>"
  }},
  "dutch_name": "<Dutch translation of the product name>",
  "vbn": {{
    "code": "595",
    "name": "Rosa grootbloemig Ecuador",
    "confidence": "high",
    "explanation": "<one sentence>"
  }}
}}
"""


def ai_analyze_product(
    query: str,
    candidates: list["ProductMatch"],
    cfg: "Config",
) -> dict | None:
    """
    Ask Claude Haiku to check for duplicates and suggest a VBN code.

    Returns a dict with keys "duplicate" and "vbn", or None if API key missing.
    """
    if not cfg.anthropic_api_key:
        return None

    if candidates:
        cand_lines = "\n".join(
            f"  {i+1}. ID={m.product_id} | {m.name} | VBN: {m.vbn_number or '—'} | similarity: {m.similarity:.0%}"
            for i, m in enumerate(candidates[:6])
        )
    else:
        cand_lines = "  (no candidates found)"

    prompt = _PROMPT_TEMPLATE.format(
        query=query,
        candidates=cand_lines,
        vbn_context=_VBN_CONTEXT,
    )

    try:
        client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)
        msg = client.messages.create(
            model=cfg.anthropic_model,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text.strip()
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            logger.warning("AI response not JSON: %.200s", text)
            return None
        return json.loads(m.group())
    except Exception as exc:
        logger.error("ai_analyze_product failed: %s", exc)
        return None


_CHECKER_PROMPT = """\
You are an expert in Dutch flower auction VBN product codes.

## Product being checked
Name: "{name}"
Current VBN code: {current_vbn}
Current VBN official name (Dutch): "{official_name}"
VBN product group: "{group}"

## VBN context
{vbn_context}

## Task
1. Translate "{name}" into Dutch using Floricode conventions (Spray→Tros, Large-flowered→Grootbloemig, colour names to Dutch, etc.)
2. If the current VBN official name is empty or unknown, the current VBN is invalid — always set is_correct=false and propose the correct code.
3. If the official name is known, check whether it correctly matches the Dutch translation of "{name}".
4. Determine the correct VBN code. Use category codes from the VBN context when no specific variety code can be determined.

Rules:
- The FIRST word of the product name is the GENUS — the proposed VBN must belong to the SAME genus.
  "Limonium Rose" is a Limonium; NEVER propose a Rosa VBN for it.
  "Gypsophila Pink" is a Gypsophila; NEVER propose a VBN from a different genus.
  Color/variety words (Rose, Pink, Blue, White, Peach, Lemon…) that follow the genus are descriptors only.
- "Spray" / "Sp " in name → must use a spray/tros VBN
- No "Spray"/"Sp" in name → must NOT use a spray/tros VBN
- Colour treated / Painted / Absorbed / Tinted → kleurbehandeld VBN within the SAME genus
- Preserved / Bleached / Dried → 2712 or specific droog VBN
- Prefer specific variety VBN over generic category code when the name matches

Respond with ONLY valid JSON:
{{
  "is_correct": true,
  "reason": "<one sentence>",
  "proposed_vbn": "<VBN code string, or null if correct or unknown>"
}}
"""


def ai_suggest_vbn_for_checker(
    name: str,
    current_vbn: str,
    official_name: str,
    group: str,
    cfg: "Config",
) -> tuple[bool, str, str]:
    """Ask Claude to verify a VBN assignment and propose the correct code if wrong.

    Returns (is_correct, reason, proposed_vbn).
    Falls back to (True, error_msg, "") on failure so the caller treats it as non-actionable.
    """
    if not cfg.anthropic_api_key:
        return True, "AI unavailable (no API key)", ""

    prompt = _CHECKER_PROMPT.format(
        name=name,
        current_vbn=current_vbn,
        official_name=official_name,
        group=group,
        vbn_context=_VBN_CONTEXT,
    )

    try:
        client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)
        msg = client.messages.create(
            model=cfg.anthropic_model,
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text.strip()
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            logger.warning("ai_suggest_vbn_for_checker: non-JSON response: %.200s", text)
            return True, "AI response parse error", ""
        data = json.loads(m.group())
        is_correct = bool(data.get("is_correct", True))
        reason = str(data.get("reason", ""))
        proposed = str(data.get("proposed_vbn") or "")
        return is_correct, reason, proposed
    except Exception as exc:
        logger.error("ai_suggest_vbn_for_checker failed: %s", exc)
        return True, f"AI unavailable: {exc}", ""
