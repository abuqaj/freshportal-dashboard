#!/usr/bin/env python3
"""What creating a product must never do — checked without FreshPortal.

    python python/tests/test_product_create.py

Each test calls the real copy_and_create() against a fake FreshPortal and a
fake catalogue copy, then asserts two things: the outcome the operator sees,
and whether save was clicked. The click count is the important half — a check
that reports a problem but saves anyway still creates the duplicate it warned
about.

The module's third-party imports that these tests don't exercise (playwright,
requests, dotenv, anthropic) are stubbed, so this runs on a machine with
nothing installed. The HTML parsing test needs the real BeautifulSoup and is
skipped when bs4 is missing.

Exit code: 0 everything passed, 1 something failed, 2 could not run at all.

When FreshPortal turns out to behave differently than assumed here, add the
case as a new scenario rather than only fixing the code — that is what keeps
this file worth having.
"""
from __future__ import annotations

import sys
import threading
import time
import types
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PYTHON_DIR))


# ── stand-ins for what the tests don't exercise ──────────────────────────────

def _stub_module(name: str, **attrs) -> None:
    """Register a module only if it isn't installed here."""
    if name in sys.modules:
        return
    try:
        __import__(name)
        return
    except ImportError:
        pass
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod


class _StubTimeout(Exception):
    pass


def _install_stubs() -> bool:
    """Returns whether the real BeautifulSoup is available."""
    _stub_module("dotenv", load_dotenv=lambda *a, **k: None)
    _stub_module("requests", get=None, post=None, Session=object)
    _stub_module("anthropic", Anthropic=object)
    _stub_module("playwright")
    _stub_module("playwright.sync_api", Page=object, TimeoutError=_StubTimeout,
                 sync_playwright=lambda: None)
    if "playwright" in sys.modules and not hasattr(sys.modules["playwright"], "sync_api"):
        sys.modules["playwright"].sync_api = sys.modules["playwright.sync_api"]
    try:
        import bs4  # noqa: F401
        return True
    except ImportError:
        class _NoSoup:
            def __init__(self, *a, **k):
                raise NotImplementedError("bs4 is not installed")
        _stub_module("bs4", BeautifulSoup=_NoSoup)
        return False


HAS_BS4 = _install_stubs()

# The catalogue copy in Postgres, faked: `state` is what it currently holds.
db = types.ModuleType("db")
db.state = {}


def reset_db(names=(), numbers=(), upsert_fails=False) -> None:
    db.state = {"names": list(names), "numbers": {n.upper() for n in numbers},
                "upserted": [], "upsert_fails": upsert_fails}


def _same_name(a: str, b: str) -> bool:
    return " ".join(a.split()).lower() == " ".join(b.split()).lower()


def _upsert(rows):
    if db.state["upsert_fails"]:
        raise RuntimeError("database unavailable")
    db.state["upserted"].extend(rows)
    return len(rows)


db.find_products_by_exact_name = lambda name, limit=10: [p for p in db.state["names"] if _same_name(p["name"], name)]
db.is_product_number_taken = lambda number: number.upper() in db.state["numbers"]
db.upsert_products = _upsert
db.get_product_count = lambda: 1
db.search_products_ilike_term = lambda *a, **k: []
sys.modules["db"] = db

try:
    import product_creator as pc
    from scraper_fp import FPProduct
    from config import Config
except Exception as exc:  # pragma: no cover — a broken import is a setup problem
    print(f"SKIP: could not import the module under test: {exc}")
    sys.exit(2)

pc.time.sleep = lambda seconds: None
pc._login = lambda page, cfg: None
pc._logout = lambda ctx, cfg: None
pc._block_resources = lambda page: None


# ── the fake FreshPortal ─────────────────────────────────────────────────────

class Portal:
    """What the fake FreshPortal contains and how its form behaves.

    live_numbers / live_names  what the portal already has
    inputs / selects           the fields the copy form offers
    ignore_fill                fields that silently drop what is typed into them
    color_ok                   whether the colour dropdown accepts the choice
    saved                      the row the list shows after saving, or None
    saved_columns              which columns that list shows
    form_error                 text of an error shown on the form
    form_not_loaded            the copy form never appears
    """

    clicks = 0
    raise_on_click = False

    def __init__(self, **kw):
        self.live_numbers = {n.upper() for n in kw.get("live_numbers", set())}
        self.live_names = kw.get("live_names", [])
        self.inputs = kw.get("inputs", [
            "product_index_form_number",
            "product_index_form_name_en",
            "product_index_form_name_nl",
            "product_index_form_short_name_en",
            "product_index_form_vbn_number",
        ])
        self.selects = kw.get("selects", ["product_index_form_color_id"])
        self.ignore_fill = kw.get("ignore_fill", set())
        self.color_ok = kw.get("color_ok", True)
        self.saved = kw.get("saved")
        self.saved_columns = kw.get("saved_columns", {"product_number", "name", "vbn_number", "color"})
        self.form_error = kw.get("form_error", "")
        self.form_not_loaded = kw.get("form_not_loaded", False)
        self.typed = {}


class Locator:
    def __init__(self, count: int):
        self._count = count

    def count(self) -> int:
        return self._count

    @property
    def first(self):
        return self

    def locator(self, selector):
        return Locator(1)

    def click(self):
        Portal.clicks += 1
        if Portal.raise_on_click:
            raise RuntimeError("navigation interrupted during click")


class FakePage:
    def __init__(self, portal: Portal):
        self.portal = portal
        self.url = "https://freshportal.example/"

    # navigation / waiting
    def route(self, *a):
        pass

    def goto(self, url, **kw):
        self.url = url

    def wait_for_selector(self, selector, timeout=0):
        if selector == "#product_index_form_submit" and self.portal.form_not_loaded:
            raise pc.PWTimeout("timeout")

    def wait_for_load_state(self, *a, **kw):
        pass

    def close(self):
        pass

    # elements
    def locator(self, selector):
        return Locator(1)

    def query_selector(self, selector):
        return object() if selector == "#product_index_form_submit" else None

    def query_selector_all(self, selector):
        if self.portal.form_error and selector == ".alert-danger":
            return [types.SimpleNamespace(is_visible=lambda: True,
                                          inner_text=lambda: self.portal.form_error)]
        return []

    # the form, as the module's own JS sees it
    def evaluate(self, js, arg=None):
        p = self.portal
        if js is pc._FPS_NAMES_JS:
            return p.inputs if arg == "fps-input" else p.selects
        if js is pc._FILL_FPS_INPUT_JS:
            field, value = arg
            if field in p.inputs and field not in p.ignore_fill:
                p.typed[field] = value
            return field in p.inputs
        if js is pc._READ_FPS_INPUT_JS:
            # A field never filled still holds what the template had.
            return p.typed.get(arg, "TEMPLATE VALUE")
        if js is pc._SELECT_COLOR_JS:
            return "Pink" if p.color_ok else None
        raise AssertionError(f"unexpected page.evaluate: {js[:60]}")


def fake_load_product_list(page, cfg, filter_query, expect_rows):
    """Stands in for opening the product list with a filter."""
    p = page.portal
    if filter_query.startswith("number_adjustable="):
        number = filter_query.split("=", 1)[1]
        if expect_rows:  # the check that runs after saving
            return ([p.saved] if p.saved else []), p.saved_columns
        rows = [FPProduct(product_id="1", name="Something else", short_name="",
                          vbn_number="", product_number=number)] if number.upper() in p.live_numbers else []
        return rows, set()
    if filter_query.startswith("name_adjustable="):
        return p.live_names, set()
    raise AssertionError(f"unexpected list filter: {filter_query}")


class FakePlaywright:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def create(portal: Portal, **overrides) -> dict:
    """Run the real creation against *portal*."""
    Portal.clicks = 0
    pc._load_product_list = fake_load_product_list
    pc.sync_playwright = lambda: FakePlaywright()
    pc._launch_browser = lambda pw: types.SimpleNamespace(
        new_context=lambda: types.SimpleNamespace(
            new_page=lambda: FakePage(portal), close=lambda: None),
        close=lambda: None,
    )
    cfg = overrides.pop("cfg", None) or Config()
    args = dict(template_id="65945", new_name="Rosa Ec Toxic", product_number="ROECTO",
                vbn_code="580", color_id="12", color_name="Pink")
    args.update(overrides)
    return pc.copy_and_create(cfg=cfg, lang="en", **args)


def pc_export_stub(products: list[dict]):
    """A product list as product_export builds it from product.csv."""
    import product_export
    rows = [product_export._map_row(
        {"id": p["product_id"], "number": p["product_number"], "name_en": p["name"],
         "name_nl": p.get("name_nl", p["name"]), "vbn_number": p.get("vbn_number", "")},
        {}, {}, {}) for p in products]
    return product_export.ExportProducts(system_id="test", rows=[r for r in rows if r],
                                         fetched_at=time.time())


def other_system_cfg() -> Config:
    """A portal other than the one the catalogue copy mirrors.

    Which one that is depends on FRESHPORTAL_URL, and the repo's own default is
    the test tenant — so pick a second address whenever the first one turns out
    to be the mirrored one.
    """
    cfg = Config()
    for url in ("https://850255test.freshportal.com", "https://850254.freshportal.nl"):
        cfg.freshportal_url = url
        if not pc.uses_catalogue_copy(cfg):
            break
    return cfg


def saved_row(**kw) -> FPProduct:
    """The row FreshPortal shows for a product that saved as asked."""
    row = dict(product_id="99001", name="Rosa Ec Toxic", short_name="Rosa Ec Toxic",
               vbn_number="580", product_number="ROECTO", color="Pink")
    row.update(kw)
    return FPProduct(**row)


def codes(result: dict) -> list[str]:
    return [w["code"] for w in result["warnings"]]


# ── checks ───────────────────────────────────────────────────────────────────

RESULTS: list[tuple[bool, str, str]] = []


def check(label: str, passed: bool, detail: object = "") -> None:
    RESULTS.append((passed, label, "" if passed else str(detail)))


def test_input_is_validated_before_anything_is_typed():
    """The screen's rules again, for values that got past it."""
    for overrides, code in [
        (dict(new_name="Rosa  Ec Toxic"), "name_double_space"),
        (dict(new_name="Rosa <b>Ec</b>"), "name_chars"),
        (dict(new_name="   "), "name_empty"),
        (dict(product_number="RO'EC"), "number"),
        (dict(product_number="TOOLONGNUMBER"), "number"),
        (dict(vbn_code="58a"), "vbn"),
        (dict(template_id="65945'); alert(1)//"), "template"),
    ]:
        reset_db()
        r = create(Portal(saved=saved_row()), **overrides)
        check(f"refused before saving: {code}",
              r["status"] == "blocked" and r["reason"] == "invalid_input"
              and r["error_text"] == code and Portal.clicks == 0, r)

    reset_db()
    r = create(Portal(saved=saved_row(name="Rosa Ec Émilie-O'Hara", product_number="ROECMI")),
               new_name="Rosa Ec Émilie-O'Hara", product_number="roecmi")
    check("accented letters, apostrophe and a lowercase number are accepted",
          r["status"] == "created" and r["product_number"] == "ROECMI", r)


def test_catalogue_copy_stops_known_duplicates():
    """The Postgres copy answers instantly and covers everything older than ~1 h."""
    reset_db(names=[{"product_id": "5", "name": "rosa  ec toxic", "product_number": "ROECTO",
                     "vbn_number": "580", "color": ""}])
    r = create(Portal(saved=saved_row()))
    check("same name (other case and spacing) blocks, nothing saved",
          r["status"] == "blocked" and r["reason"] == "name_exists"
          and r["existing"][0]["product_id"] == "5" and Portal.clicks == 0, r)

    r = create(Portal(saved=saved_row()), allow_duplicate_name=True)
    check("the same name goes through once the operator confirms it",
          r["status"] == "created" and Portal.clicks == 1, r)

    reset_db(numbers={"ROECTO", "RET"})
    r = create(Portal(saved=saved_row()))
    check("taken number blocks and a free variant is suggested",
          r["status"] == "blocked" and r["reason"] == "number_taken"
          and r["suggested_number"] == "ROSECTO" and Portal.clicks == 0, r)


def test_freshportal_itself_is_checked_too():
    """Covers what the copy cannot know yet: the last hour of changes."""
    reset_db()
    r = create(Portal(live_numbers={"ROECTO"}, saved=saved_row()))
    check("number taken in the portal blocks, nothing saved",
          r["status"] == "blocked" and r["reason"] == "number_taken"
          and r["suggested_number"] and Portal.clicks == 0, r)

    r = create(Portal(live_names=[FPProduct(product_id="7", name="Rosa Ec Toxic ",
                                            short_name="", vbn_number="")], saved=saved_row()))
    check("name found in the portal blocks, nothing saved",
          r["status"] == "blocked" and r["reason"] == "name_exists" and Portal.clicks == 0, r)

    r = create(Portal(live_names=[FPProduct(product_id="7", name="Rosa Ec Toxic Spray",
                                            short_name="", vbn_number="")], saved=saved_row()))
    check("a longer name that merely contains ours is not a duplicate",
          r["status"] == "created", r)


def test_form_is_read_back_before_saving():
    """Without this a copy saves under the template's own name or number."""
    reset_db()
    r = create(Portal(ignore_fill={"product_index_form_number"}, saved=saved_row()))
    check("number did not go into the field: not saved",
          r["status"] == "failed" and r["reason"] == "number_not_set" and Portal.clicks == 0, r)

    r = create(Portal(ignore_fill={"product_index_form_name_nl"}, saved=saved_row()))
    check("one language's name field did not take the name: not saved",
          r["status"] == "failed" and r["reason"] == "name_not_set" and Portal.clicks == 0, r)

    r = create(Portal(inputs=["product_index_form_number"], saved=saved_row()))
    check("no name field on the form at all: not saved",
          r["status"] == "failed" and r["reason"] == "name_field_missing" and Portal.clicks == 0, r)

    r = create(Portal(form_not_loaded=True, saved=saved_row()))
    check("copy form never loaded: not saved",
          r["status"] == "failed" and r["reason"] == "form_not_loaded" and Portal.clicks == 0, r)


def test_saved_product_is_compared_with_what_was_asked_for():
    reset_db()
    r = create(Portal(saved=saved_row()))
    check("happy path: created once, added to the copy, link to the product",
          r["status"] == "created" and r["ok"] and Portal.clicks == 1
          and db.state["upserted"] and db.state["upserted"][0]["product_id"] == "99001"
          and r["product_url"].endswith("id=99001&page=1") and r["warnings"] == [], r)

    r = create(Portal(saved=saved_row(vbn_number="595")))
    check("VBN saved differently: reported with both values",
          r["status"] == "created_with_warnings"
          and r["warnings"] == [{"code": "vbn_mismatch", "expected": "580", "actual": "595"}], r)

    no_vbn_field = ["product_index_form_number", "product_index_form_name_en"]
    r = create(Portal(inputs=no_vbn_field, saved=saved_row(vbn_number="595")))
    check("no VBN field and the VBN is wrong: one warning, about the saved value",
          codes(r) == ["vbn_mismatch"], r)

    r = create(Portal(inputs=no_vbn_field, saved=saved_row()))
    check("no VBN field but the VBN is right anyway: no warning",
          r["status"] == "created", r)

    r = create(Portal(color_ok=False, saved=saved_row(color="White")))
    check("colour saved differently: reported with both values",
          codes(r) == ["color_mismatch"] and r["warnings"][0]["actual"] == "White", r)

    r = create(Portal(saved=saved_row(color="pink")))
    check("colour compared regardless of case", r["status"] == "created", r)

    no_color_column = {"product_number", "name", "vbn_number"}
    r = create(Portal(saved=saved_row(color=""), saved_columns=no_color_column))
    check("colour could not be checked: said so rather than passing silently",
          codes(r) == ["color_unverified"], r)

    r = create(Portal(color_ok=False, saved=saved_row(color=""), saved_columns=no_color_column))
    check("colour not selected and not checkable: reported as not set",
          codes(r) == ["color_not_set"], r)

    r = create(Portal(saved=saved_row()), color_id="", color_name="")
    check("no colour asked for: nothing to warn about", r["status"] == "created", r)

    r = create(Portal(ignore_fill={"product_index_form_short_name_en"}, saved=saved_row()))
    check("short name did not take: a warning, not a refusal",
          r["status"] == "created_with_warnings" and codes(r) == ["short_name_not_set"], r)

    reset_db(upsert_fails=True)
    r = create(Portal(saved=saved_row()))
    check("catalogue copy could not be updated: product still created, and it says so",
          r["status"] == "created_with_warnings" and codes(r) == ["catalogue_copy_not_updated"], r)
    reset_db()


def test_when_the_product_cannot_be_found_afterwards():
    """The dangerous half: "failed" invites a retry, so it must be earned."""
    reset_db()
    r = create(Portal(saved=None, form_error="Product number already exists"))
    check("form rejected it and is still open: failed, with FreshPortal's text",
          r["status"] == "failed" and r["reason"] == "form_error"
          and "already exists" in (r["error_text"] or ""), r)

    r = create(Portal(saved=None, form_error="*"))
    check("a required-field asterisk is not an error: unconfirmed, not failed",
          r["status"] == "unconfirmed" and r["reason"] == "not_found", r)

    r = create(Portal(saved=None))
    check("nothing found: unconfirmed, with a link to search the number",
          r["status"] == "unconfirmed" and "number_adjustable=ROECTO" in (r["search_url"] or ""), r)

    r = create(Portal(saved=saved_row(name="ROSA EC TOXIC XL")))
    check("our number under another name: unconfirmed, showing that product",
          r["status"] == "unconfirmed" and r["reason"] == "name_differs"
          and r["product"]["product_id"] == "99001", r)

    Portal.raise_on_click = True
    try:
        r = create(Portal(saved=saved_row()))
    finally:
        Portal.raise_on_click = False
    check("crash after clicking save: unconfirmed, never failed",
          r["status"] == "unconfirmed" and r["reason"] == "exception", r)

    original_login = pc._login
    pc._login = lambda page, cfg: (_ for _ in ()).throw(RuntimeError("login failed"))
    try:
        r = create(Portal(saved=saved_row()))
    finally:
        pc._login = original_login
    check("crash before saving: failed, because nothing can exist yet",
          r["status"] == "failed" and r["reason"] == "exception" and Portal.clicks == 0, r)


def test_another_system_never_touches_the_catalogue_copy():
    """The copy mirrors one portal; its names, numbers and ids mean nothing elsewhere."""
    other = other_system_cfg()
    check("the copy is only used for the system it mirrors",
          pc.uses_catalogue_copy(Config()) and not pc.uses_catalogue_copy(other),
          other.freshportal_url)

    reset_db(names=[{"product_id": "5", "name": "Rosa Ec Toxic", "product_number": "ROECTO",
                     "vbn_number": "580", "color": ""}],
             numbers={"ROECTO"})
    r = create(Portal(saved=saved_row()), cfg=other)
    check("a name and number taken in the copy do not block another system",
          r["status"] == "created" and Portal.clicks == 1, r)
    check("a product created on another system is not written into the copy",
          db.state["upserted"] == [], db.state["upserted"])
    check("the link points at the system it was created on",
          (r["product_url"] or "").startswith(other.freshportal_url), r["product_url"])

    r = create(Portal(live_numbers={"ROECTO"}, saved=saved_row()), cfg=other)
    check("that system's own portal is still checked before saving",
          r["status"] == "blocked" and r["reason"] == "number_taken" and Portal.clicks == 0, r)
    reset_db()


def test_reading_a_system_from_its_export():
    """A system with an export key gets a product list without a browser.

    The rows come from product.csv, so they carry no colour and no short name;
    what matters here is that the list is used for the checks and is never
    written back into the copy.
    """
    export = pc_export_stub([
        {"product_id": "70001", "product_number": "ROECTO", "name": "Rosa Ec Toxic"},
        {"product_id": "70002", "product_number": "ROECMO", "name": "Rosa Ec Mondial"},
    ])
    other = other_system_cfg()
    catalogue = pc.catalogue_for(other, export=export)
    check("a system with an export reads its list, not the copy and not the browser",
          catalogue.source == "export" and catalogue.search is not None
          and not catalogue.writes_back, catalogue.source)

    reset_db()
    r = create(Portal(saved=saved_row()), cfg=other, catalogue=catalogue)
    check("a name in that system's export blocks before saving",
          r["status"] == "blocked" and r["reason"] == "name_exists"
          and r["existing"][0]["product_id"] == "70001" and Portal.clicks == 0, r)

    r = create(Portal(saved=saved_row(product_number="ROECMOX")), cfg=other, catalogue=catalogue,
               new_name="Rosa Ec Mondial Plus", product_number="ROECMO")
    check("a number in that system's export blocks, with a suggestion",
          r["status"] == "blocked" and r["reason"] == "number_taken"
          and r["suggested_number"] and Portal.clicks == 0, r)

    r = create(Portal(saved=saved_row(name="Rosa Ec Novelty", product_number="ROECNO")), cfg=other,
               catalogue=catalogue, new_name="Rosa Ec Novelty", product_number="ROECNO")
    check("a product the export does not have is created and stays out of the copy",
          r["status"] == "created" and db.state["upserted"] == [], r)

    check("searching the export finds a product by part of its name",
          [row["product_id"] for row in export.search("toxic")] == ["70001"], export.search("toxic"))
    check("the export answers in any language it carries",
          export.by_exact_name("rosa ec mondial")[0]["product_id"] == "70002")


def test_export_lookup_tables():
    """Group, application and VAT names come out of the export's own tables.

    Built as a real zip, because the part worth checking is which file each
    label is taken from: "product_application" has to win over any other table
    whose name merely contains "application".
    """
    import csv as csv_mod
    import io
    import zipfile
    import product_export

    _stub_module("httpx", get=None, post=None)
    try:
        import bi_sync_client  # noqa: F401
    except Exception as exc:
        check(f"export lookups (bi_sync_client unavailable: {exc}) — skipped", True)
        return

    def sheet(rows: list[dict]) -> bytes:
        buf = io.StringIO()
        writer = csv_mod.DictWriter(buf, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        return buf.getvalue().encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("product.csv", sheet([{
            "id": "65537", "group_id": "2188", "number": "2", "vbn_number": "2",
            "application_id": "1", "name_nl": "Agapanthus overig", "name_en": "Agapanthus overig",
            "vat_id": "2", "barcode": "",
            "mutation_date_time": "2026-06-17 00:49:52.000", "creation_date_time": "24/10/2016 10:21",
        }]))
        # Real column layouts: the group table names its label "name" and
        # carries its own code and parent, the VAT table has both a name and a
        # rate.
        zf.writestr("product_group.csv", sheet([{
            "id": "2188", "code": "20201601", "parent_group_id": "", "vbn_code": "20201601",
            "name": "Aster", "mutation_date_time": "17/09/2026 05:57",
            "creation_date_time": "17/04/2020 18:29",
        }]))
        zf.writestr("product_application.csv", sheet([{"id": "1", "code": "1", "name_en": "Cut flower",
                                                       "name_nl": "Snijbloem"}]))
        zf.writestr("vat.csv", sheet([{"id": "2", "code": "L", "name": "Laag 9%", "rate": "9",
                                       "vbn_code": "2", "land": "NL"}]))
        # Decoy: contains "application", must not be mistaken for the real one.
        zf.writestr("application_log.csv", sheet([{"id": "1", "name_en": "WRONG TABLE"}]))
    zip_bytes = buf.getvalue()

    groups = product_export._lookup_labels(zip_bytes, product_export.LOOKUP_TABLES["group"])
    applications = product_export._lookup_labels(zip_bytes, product_export.LOOKUP_TABLES["application"])
    vats = product_export._lookup_labels(zip_bytes, product_export.LOOKUP_TABLES["vat"])
    check("group names read from product_group.csv", groups == {"2188": "Aster"}, groups)
    check("application names read from product_application.csv, not a lookalike",
          applications == {"1": "Cut flower"}, applications)
    check("VAT read from vat.csv", vats == {"2": "Laag 9%"}, vats)

    raw, table = product_export.read_product_master(zip_bytes)
    row = product_export._map_row(raw[0], groups, applications, vats)
    check("the product master is read from the product table", table == "product", table)
    check("a product row carries the copy id, and the group joined on group_id",
          row["product_id"] == "65537" and row["product_number"] == "2"
          and row["name"] == "Agapanthus overig" and row["vbn_number"] == "2"
          and row["product_group"] == "Aster" and row["application"] == "Cut flower"
          and row["vat_rate"] == "Laag 9%" and row["color"] == "", row)


def test_product_master_is_chosen_by_its_columns():
    """Two tables can be named after products; only one is the master.

    The master is the one carrying the number and the VBN code. Reading a
    table of id/code/names instead would leave every number empty, and "this
    number is free" would then be a guess rather than an answer.
    """
    import csv as csv_mod
    import io
    import zipfile
    import product_export

    _stub_module("httpx", get=None, post=None)
    try:
        import bi_sync_client  # noqa: F401
    except Exception as exc:
        check(f"product master choice (bi_sync_client unavailable: {exc}) — skipped", True)
        return

    def sheet(rows):
        buf = io.StringIO()
        writer = csv_mod.DictWriter(buf, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        return buf.getvalue().encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        # Named "product" but only id/code/names — not the master.
        zf.writestr("product.csv", sheet([{"id": "9", "code": "9", "name_nl": "Groep",
                                           "name_en": "Group", "name_es": "Grupo"}]))
        zf.writestr("product_master.csv", sheet([{"id": "65537", "group_id": "2188", "number": "AGOV",
                                                  "vbn_number": "2", "application_id": "1",
                                                  "name_en": "Agapanthus overig", "vat_id": "2"}]))
    raw, table = product_export.read_product_master(buf.getvalue())
    check("a product table without a number is not taken for the master",
          table == "product_master.csv" and raw and raw[0]["number"] == "AGOV", (table, raw[:1]))


def test_what_counts_as_the_same_product():
    """The rules the people who create these products work by.

    Country does not make a product, except for Ecuadorian roses, which are
    graded as better quality and kept separate. Spray, single, double and any
    treatment each make their own product. Length does not — it belongs to a
    stock entry. At or above DUPLICATE_SCORE the screen says "this may already
    exist", so anything that is a different product has to stay below it.
    """
    same = [
        ("Rosa Col Toxic", "Rosa Toxic", "country ignored"),
        ("Rosa Ec Atena", "Rosa Ec Athena", "a typo is the same variety"),
        ("Rosa Ec Spray Julieta", "Rosa Ec Sp Julieta", "Sp is Spray"),
        ("Rosa Ke Toxic", "Rosa Col Toxic", "two other countries"),
    ]
    for a, b, why in same:
        score = pc._similarity(a, b)
        check(f"same product: {a} / {b} ({why})", score >= pc.DUPLICATE_SCORE, round(score, 2))

    different = [
        ("Rosa Ec Toxic", "Rosa Toxic", "an Ecuadorian rose is its own product"),
        ("Rosa Ec Toxic", "Rosa Col Toxic", "Ecuador against another country"),
        ("Rosa Spray Toxic", "Rosa Toxic", "spray is its own product"),
        ("Rosa Ec Toxic", "Rosa Ec Preserved Toxic", "a treatment is its own product"),
        ("Rosa Single Toxic", "Rosa Double Toxic", "single against double"),
        ("Rosa Spray Toxic", "Rosa Spray Mondial", "another variety"),
        ("Rosa Pink Floyd", "Rosa Pink Mondial", "same series, another variety"),
        ("Rosa Ec Toxic", "Dianthus Ec Toxic", "another genus"),
    ]
    for a, b, why in different:
        score = pc._similarity(a, b)
        check(f"different products: {a} / {b} ({why})", score < pc.DUPLICATE_SCORE, round(score, 2))

    check("Ecuador only counts on roses",
          pc._similarity("Gypsophila Ec Xlence", "Gypsophila Xlence") >= pc.DUPLICATE_SCORE,
          round(pc._similarity("Gypsophila Ec Xlence", "Gypsophila Xlence"), 2))
    check("a different kind still ranks as a template, above an unrelated variety",
          pc._similarity("Rosa Spray Toxic", "Rosa Toxic") > pc._similarity("Rosa Spray Toxic", "Rosa Spray Mondial"))


def test_product_numbers_follow_the_house_rules():
    """At most 7 characters, two letters per word, and no counters.

    A variant is made by moving letters between words, never by appending 1, 2,
    3 or A, B, C: these codes are read off the screen, so they have to keep
    saying what the product is.
    """
    check("two letters per word, cut to seven",
          pc.generate_product_number("Rosa Ec Spray Julieta Honey") == "ROECSPJ",
          pc.generate_product_number("Rosa Ec Spray Julieta Honey"))
    check("a short name keeps its own length",
          pc.generate_product_number("Rosa Ec Toxic") == "ROECTO", pc.generate_product_number("Rosa Ec Toxic"))
    check("a name with no usable letters still gives a code",
          pc.generate_product_number("...") == "PROD", pc.generate_product_number("..."))

    import itertools
    name = "Rosa Ec Toxic"
    variants = list(itertools.islice(pc._number_candidates(pc.generate_product_number(name), name), 12))
    check("the base comes first", variants[0] == "ROECTO", variants[:3])
    check("one letter per word is offered", "RET" in variants, variants)
    check("three letters from the first word are offered", "ROSECTO" in variants, variants)
    check("three letters from the last word are offered", "ROECTOX" in variants, variants)
    check("no variant is longer than seven", all(len(v) <= pc.NUMBER_MAX_LEN for v in variants), variants)
    check("no variant ends in a counter",
          not any(v[-1].isdigit() for v in variants), variants)
    check("every variant is different", len(variants) == len(set(variants)), variants)

    single = list(itertools.islice(pc._number_candidates(pc.generate_product_number("Aster"), "Aster"), 6))
    check("a one-word name is lengthened rather than suffixed",
          single[:4] == ["AS", "A", "AST", "ASTE"], single)


def test_only_one_creation_at_a_time():
    reset_db()
    pc._create_lock.acquire()
    threading.Timer(0.2, pc._create_lock.release).start()
    statuses: list[str] = []
    r = create(Portal(saved=saved_row()), on_status=statuses.append)
    check("a second creation waits for the first and says so",
          r["status"] == "created" and any("Another product" in s for s in statuses), statuses[:2])
    check("the lock is released afterwards", pc._create_lock.acquire(blocking=False))
    pc._create_lock.release()


def test_product_list_parsing():
    """The columns the module reads back out of FreshPortal's list page."""
    if not HAS_BS4:
        check("list parsing (needs beautifulsoup4 — skipped)", True)
        return
    html = """
    <table>
      <thead><tr>
        <th data-header-title="ID">ID</th><th data-header-title="Number">Number</th>
        <th data-header-title="Name">Name</th><th data-header-title="Color">Color</th>
        <th>a</th><th>b</th><th>c</th><th>d</th>
        <th data-header-title="VBN number">VBN</th>
      </tr></thead>
      <tbody><tr>
        <td>123</td><td data-cell-action="product_number"> ROECTO </td>
        <td data-cell-action="product_name">Rosa Ec Toxic</td><td>Pink</td>
        <td></td><td></td><td></td><td></td><td>580</td>
      </tr></tbody>
    </table>"""
    rows, columns = pc._parse_product_list(html)
    check("a list row gives id, number, name, VBN and colour",
          len(rows) == 1 and rows[0].product_id == "123" and rows[0].product_number == "ROECTO"
          and rows[0].name == "Rosa Ec Toxic" and rows[0].vbn_number == "580"
          and rows[0].color == "Pink" and "color" in columns, rows)


TESTS = [
    test_input_is_validated_before_anything_is_typed,
    test_catalogue_copy_stops_known_duplicates,
    test_freshportal_itself_is_checked_too,
    test_form_is_read_back_before_saving,
    test_saved_product_is_compared_with_what_was_asked_for,
    test_when_the_product_cannot_be_found_afterwards,
    test_another_system_never_touches_the_catalogue_copy,
    test_reading_a_system_from_its_export,
    test_export_lookup_tables,
    test_product_master_is_chosen_by_its_columns,
    test_what_counts_as_the_same_product,
    test_product_numbers_follow_the_house_rules,
    test_only_one_creation_at_a_time,
    test_product_list_parsing,
]


def main() -> int:
    import logging
    logging.disable(logging.CRITICAL)  # the module logs every step
    for test in TESTS:
        start = len(RESULTS)
        try:
            test()
        except Exception as exc:
            check(f"{test.__name__} raised", False, exc)
        if len(RESULTS) == start:
            check(f"{test.__name__} checked nothing", False)

    failed = [r for r in RESULTS if not r[0]]
    for passed, label, detail in RESULTS:
        if not passed:
            print(f"FAIL  {label}\n      {detail}")
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed"
          + ("" if HAS_BS4 else " (list parsing skipped: no beautifulsoup4)"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
