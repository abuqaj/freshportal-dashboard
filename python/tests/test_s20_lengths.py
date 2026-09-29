"""Stem lengths a delivery line may go to FreshPortal with: Floricode S20.

Some supplier invoices print no length, so the delivery screen asks for one,
and only a Floricode S20 length ("Minimum length of flower stem") is taken
(user, 2026-09-28). The list below is Floricode's own, read off
"E-Kenmerkcodes snij.pdf" (2017-03-21), pages 49-51, code by code; the
screen's list in DeliveryImporter.tsx must be the same.

Run either way:
    python -m pytest python/tests/test_s20_lengths.py -q
    python python/tests/test_s20_lengths.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dfg_api_client import S20_LENGTHS, lines_without_grower, lines_without_s20_length  # noqa: E402
from parser_delivery import DeliveryLine  # noqa: E402

# As printed: "005 5 cm" … "070 70 cm", "072 72 cm", … "900 900 cm", "999 other".
FLORICODE_S20 = [
    5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 72, 75,
    80, 82, 85, 90, 95, 100, 105, 110, 115, 120, 125, 128, 130, 135, 140, 145, 150, 155, 160,
    165, 170, 175, 180, 185, 190, 195, 200, 205, 210, 215, 220, 225, 230, 240, 250, 300, 350,
    400, 450, 500, 550, 600, 700, 800, 900,
]


def _line(variety: str, length: int) -> DeliveryLine:
    return DeliveryLine(gu_product=variety, nm_variety=variety, nm_species="Roses",
                        nu_length=length, nu_stems_bunch=25, nu_bunches=4, mny_rate_stem=0.3,
                        id_floricode="", nm_product=variety, fp_product_id="X")


def test_the_list_is_floricodes_s20():
    assert sorted(S20_LENGTHS) == FLORICODE_S20
    assert 999 not in S20_LENGTHS          # "other" is no length


def test_the_screen_checks_the_same_list():
    screen = os.path.join(os.path.dirname(__file__), "..", "..", "src", "components",
                          "DeliveryImporter.tsx")
    with open(screen, encoding="utf-8") as fh:
        source = fh.read()
    m = re.search(r"const S20_LENGTHS[^=]*=\s*new Set\(\[(.*?)\]\);", source, re.DOTALL)
    assert m, "S20_LENGTHS not found in DeliveryImporter.tsx"
    # "...Array.from({ length: 66 }, (_, i) => i + 5)" is 5 to 70.
    span = r"\.\.\.Array\.from\(\{\s*length:\s*66\s*\},\s*\(_,\s*i\)\s*=>\s*i\s*\+\s*5\)"
    assert re.search(span, m.group(1))
    listed = [int(n) for n in re.findall(r"\d+", re.sub(span, "", m.group(1)))]
    assert sorted(set(range(5, 71)) | set(listed)) == FLORICODE_S20
    assert len(listed) == len(set(listed))


def test_a_line_without_a_length_is_named():
    lines = [_line("Mondial", 60), _line("Aila", 0), _line("Explorer", 71)]
    assert lines_without_s20_length(lines) == ["Aila (no length)", "Explorer (71 cm)"]


def test_a_line_without_a_grower_is_named():
    """No line goes to FreshPortal without a grower (user, 2026-09-29)."""
    with_grower, without, blank = _line("Mondial", 60), _line("Pink Pigeon", 60), _line("Thea", 60)
    with_grower.manufacturer_id, blank.manufacturer_id = "61397", "  "
    without.nm_location = "San Pablo"
    assert lines_without_grower([with_grower, without, blank]) == [
        "Pink Pigeon (San Pablo)", "Thea (no farm)"]


if __name__ == "__main__":
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
