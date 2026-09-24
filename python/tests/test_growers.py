"""The hand-kept grower list behind the delivery grower picker.

data/growers_ecuador_system.csv holds the Ecuador system's (850255) growers
from Ecuador and Colombia, as the user gave them on 2026-09-24. A broken row
would silently hide a grower from the picker or send a wrong
manufacturer_id to the DFG API, so the file's shape is checked here.

Run either way:
    python -m pytest python/tests/test_growers.py -q
    python python/tests/test_growers.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
"""
from __future__ import annotations

import csv
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from growers import GROWERS_FILE, read_growers  # noqa: E402

GROWERS = read_growers()


def test_every_row_has_a_numeric_id_a_name_and_a_wanted_country():
    with GROWERS_FILE.open(encoding="utf-8", newline="") as f:
        raw = list(csv.DictReader(f))
    assert len(raw) == len(GROWERS), "a row without an id or a name was dropped"
    bad = [g for g in GROWERS
           if not g["manufacturer_id"].isdigit() or g["country"] not in ("Ecuador", "Colombia")]
    assert bad == []


def test_no_id_is_listed_twice():
    ids = [g["manufacturer_id"] for g in GROWERS]
    assert len(ids) == len(set(ids))


def test_the_list_as_given():
    by_country = {c: sum(1 for g in GROWERS if g["country"] == c) for c in ("Ecuador", "Colombia")}
    assert by_country == {"Ecuador": 351, "Colombia": 254}
    names = {g["manufacturer_id"]: g["nm_manufacturer"] for g in GROWERS}
    assert names["57365"] == "Ceres Farms cia ltd."
    assert names["57346"] == "FLORES ECUATORIANAS DE CALIDAD FLORECAL S.A."
    assert names["42623"] == "C.I Flores de Aposentos"
    assert names["58591"] == "FLORES SANTA MONICA ÑANTA CIA. LTDA."  # non-ASCII survives


if __name__ == "__main__":
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
