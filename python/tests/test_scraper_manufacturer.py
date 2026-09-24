"""Reading FreshPortal's manufacturer list into the delivery grower picker.

The page could not be seen while this was written (2026-09-24), so these
check the shapes the reader accepts rather than a copy of the real page:
headers in English with data-sort-field, headers in Dutch, a country shown
as a flag, and a list without a country column, which must not be stored.
When the real page turns out different, add its header row here.

Run either way:
    python -m pytest python/tests/test_scraper_manufacturer.py -q
    python python/tests/test_scraper_manufacturer.py

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.
Without beautifulsoup4 and lxml the HTML tests are skipped, not passed.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _scraper():
    pytest.importorskip("bs4")
    pytest.importorskip("lxml")
    pytest.importorskip("playwright")
    import scraper_manufacturer
    return scraper_manufacturer


def _soup(html: str):
    from bs4 import BeautifulSoup
    return BeautifulSoup(html, "lxml")


ENGLISH = """
<table class="filters"><tr><td>Search</td></tr></table>
<table>
  <thead><tr>
    <th data-sort-field="MAN_ID">ID</th>
    <th data-sort-field="MAN_Name">Manufacturer</th>
    <th data-sort-field="COU_Name">Country</th>
  </tr></thead>
  <tbody>
    <tr data-id="57369"><td>57369</td><td>Tessa</td><td>Ecuador</td></tr>
    <tr data-id="42623"><td>42623</td><td>C.I. Flores de Aposentos SAS</td><td>Colombia</td></tr>
    <tr data-id="11111"><td>11111</td><td>Some Kenyan Farm</td><td>Kenya</td></tr>
  </tbody>
</table>
"""

DUTCH_FLAGS = """
<table>
  <thead><tr><th>#</th><th>Kweker</th><th>Land</th></tr></thead>
  <tbody>
    <tr><td>60649</td><td>Positano</td><td><img src="/flags/ec.png" title="Ecuador"></td></tr>
    <tr><td>58524</td><td>Greenex S.A.S.</td><td><img src="/flags/co.png" alt="CO"></td></tr>
  </tbody>
</table>
"""

NO_COUNTRY = """
<table>
  <thead><tr><th>ID</th><th>Manufacturer</th></tr></thead>
  <tbody><tr><td>57369</td><td>Tessa</td></tr></tbody>
</table>
"""


def _read(html: str) -> list[dict]:
    s = _scraper()
    table, cols, _ = s._find_table(_soup(html))
    assert table is not None
    return s._parse_rows(table, cols)


def test_english_headers():
    assert _read(ENGLISH) == [
        {"manufacturer_id": "57369", "nm_manufacturer": "Tessa", "country": "Ecuador"},
        {"manufacturer_id": "42623", "nm_manufacturer": "C.I. Flores de Aposentos SAS", "country": "Colombia"},
        {"manufacturer_id": "11111", "nm_manufacturer": "Some Kenyan Farm", "country": "Kenya"},
    ]


def test_dutch_headers_and_flags():
    rows = _read(DUTCH_FLAGS)
    assert [(r["manufacturer_id"], r["nm_manufacturer"], r["country"]) for r in rows] == [
        ("60649", "Positano", "Ecuador"), ("58524", "Greenex S.A.S.", "CO"),
    ]


def test_list_without_a_country_column_is_not_taken_as_complete():
    _, cols, headers = _scraper()._find_table(_soup(NO_COUNTRY))
    assert "country" not in cols
    assert any("Manufacturer" in h for h in headers)


@pytest.mark.parametrize("raw, expected", [
    ("Ecuador", "Ecuador"), ("ECUADOR", "Ecuador"), ("EC", "Ecuador"), ("Ecuador (EC)", "Ecuador"),
    ("Colombia", "Colombia"), ("Columbia", "Colombia"), ("Kolumbia", "Colombia"), ("CO", "Colombia"),
    ("Kenya", ""), ("Costa Rica", ""), ("Netherlands", ""), ("", ""),
])
def test_only_ecuador_and_colombia_are_wanted(raw, expected):
    assert _scraper().wanted_country(raw) == expected


if __name__ == "__main__":
    try:
        import pytest as _pytest
    except ImportError:
        print("pytest is not installed — these tests could not run")
        raise SystemExit(2)
    raise SystemExit(_pytest.main([__file__, "-q"]))
