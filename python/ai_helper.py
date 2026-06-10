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
