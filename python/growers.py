"""The Ecuador system's (850255) growers that delivery import offers.

The list is kept by hand in data/growers_ecuador_system.csv: the growers from
Ecuador and Colombia on FreshPortal's /manufacturer/index_v2/index/, given by
the user on 2026-09-24 (reading the page itself was dropped as not worth it).
Their ids are what the DFG API takes as manufacturer_id. api_server copies
the file into the fp_growers table after each start; to add a grower, add a
row to the file.
"""
from __future__ import annotations

import csv
from pathlib import Path

GROWERS_FILE = Path(__file__).parent / "data" / "growers_ecuador_system.csv"


def read_growers(path: Path = GROWERS_FILE) -> list[dict]:
    """[{manufacturer_id, nm_manufacturer, country}] from the file."""
    with path.open(encoding="utf-8", newline="") as f:
        return [
            {"manufacturer_id": r["manufacturer_id"].strip(),
             "nm_manufacturer": r["nm_manufacturer"].strip(),
             "country": r["country"].strip()}
            for r in csv.DictReader(f)
            if r.get("manufacturer_id", "").strip() and r.get("nm_manufacturer", "").strip()
        ]
