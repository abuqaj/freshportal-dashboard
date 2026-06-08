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
Common VBN category codes:
  580   — Rosa grootbloemig overig (large-flowered, non-spray, non-specific origin)
  595   — Rosa grootbloemig Ecuador (large-flowered, Ecuador origin)
  2712  — Droogbloemen bewerkt (Preserved / Bleached / Dried flowers)
  6268  — Cutflowers other coloured (colour-treated, no specific code)
  15126 — Rosa large flowered colour treated
  16128 — Rosa spray colour treated
"""

_PROMPT_TEMPLATE = """\
You are an expert in Dutch flower auction product names and VBN product codes.

## Product the user wants to create
"{query}"

## Similar products already in the system (string-match candidates)
{candidates}

---

### TASK 1 — Duplicate check
Is any of the candidates the SAME variety as "{query}"?

Rules:
- Origin prefixes are NOT part of the variety name and must be ignored:
  "Ec" = Ecuador, "Col" = Colombia, "Ke" = Kenya, "Nl" = Netherlands, etc.
- "Sp" or "Spray" in the name IS significant — spray variety ≠ non-spray variety.
- Common misspellings count as the same variety:
  Atena ≈ Athena, Litchi ≈ Lychee, Naomi ≈ Naomy, Jaques ≈ Jacques, etc.
- Only mark as duplicate when you are reasonably sure.

### TASK 2 — VBN code suggestion
Assuming "{query}" does not yet exist, what VBN code should be assigned?

{vbn_context}

Additional rules:
- "Ec" in name → Ecuador origin. For Rosa → likely 595.
- "Spray" / "Sp" in name → use the spray variant of the VBN.
- No "Spray" / "Sp" → use non-spray VBN.
- "Preserved" / "Bleached" / "Dried" → 2712.
- "Colour treated" / "Painted" / "Absorbed" → 6268 or a specific kleurbehandeld code.

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
