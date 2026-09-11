"""Supplier onboarding for the Kenya system (850254).

A scanned supplier form goes in, a new supplier in FreshPortal comes out.
The document always has the same layout; only the values change.

Pipeline:
  1. Read the PDF with Claude and extract the fields the portal needs.
  2. A human checks and corrects those values on screen.
  3. Log in, fill /supplier/supplier/add, save, read the new SUP_ID off the
     URL, and set the invoice currency on the supplier's international
     settings page when it differs from the portal's Euro default.

Step 2 is not optional and is why extraction and creation are two separate
calls rather than one: creating a supplier is not reversible from here, so
nothing reaches the portal that a person has not looked at.

The PDF is sent to the model as a document block rather than being run
through an OCR library first: these are scans, and Claude reads the page
images directly, so a separate OCR step would only add a lossy layer
between the scan and the model.
"""
from __future__ import annotations

import base64
import logging
import re

import anthropic
from pydantic import BaseModel, Field

from config import Config

logger = logging.getLogger(__name__)

# Anthropic's documented ceiling for a base64 PDF is a 32 MB request; base64
# inflates by ~4/3, so the raw file has to stay under about 24 MB. Refused
# here with a readable message rather than as a 413 from the API.
MAX_PDF_BYTES = 20 * 1024 * 1024

# FreshPortal's currency dropdown on the international settings page, by
# option value. Kept here because the extraction has to resolve whatever the
# document calls a currency ("KES", "Kenyan shilling", "EUR") down to one of
# these ids before anything can be selected (confirmed against the Kenya
# portal 2026-09-11).
CURRENCY_OPTIONS: dict[str, str] = {
    "1": "Euro", "2": "U.S. Dollar", "3": "Czech Koruna", "4": "Polish Zloty",
    "5": "Russian Ruble", "7": "Swedish Krona", "8": "Danish Crown",
    "9": "Norwegian Krone", "10": "Lithuanian Litas", "11": "British Pound",
    "12": "Zuid-Afrikaanse Rand", "13": "Canadese Dollar", "14": "Zwitserse Frank",
    "15": "Australische Dollar", "16": "Braziliaanse Real", "17": "Hongaarse Florint",
    "18": "Chinese Yuan", "19": "Kroatische kuna", "20": "Servische Dinar",
    "21": "Kenyan shilling", "22": "Bahreinse Dinar", "23": "Saoudi-Arabische Riyal",
    "24": "Romanian Leu", "25": "Kuweiti Dinar", "26": "UAE Dirham",
    "27": "Qatari Rial", "28": "Jordaanse Dinar", "29": "Libanese Pond",
    "30": "Ethiopische birr", "31": "Israëlische sjekel", "32": "Indonesische roepia",
    "33": "New Zealand dollar", "34": "Singapore Dollar", "35": "Bulgarian lev",
    "36": "Moroccan Dirham",
}

# The Kenya portal's country dropdown value for Kenya.
KENYA_COUNTRY_ID = "112"

# What the form is already set to when it loads, so a document that says the
# same thing means the currency step can be skipped entirely.
DEFAULT_CURRENCY_ID = "1"


class SupplierDetails(BaseModel):
    """One supplier, as read off the scan.

    Every field is optional: a half-read document that shows which fields
    are missing is far more useful than a hard failure, because the operator
    is going to eyeball this anyway and can fill a gap in seconds.
    """

    company_name: str | None = Field(None, description="Registered company name")
    address: str | None = Field(None, description="Street address, without postal code or city")
    postal_code: str | None = Field(None, description="Postal / ZIP code on its own")
    city: str | None = Field(None, description="City on its own")
    country: str | None = Field(None, description="Country as written on the document")
    phone: str | None = Field(None, description="Phone number including country prefix if shown")
    email: str | None = Field(None, description="Email address")
    vat_number: str | None = Field(None, description="VAT / tax number")
    coc_number: str | None = Field(None, description="Chamber of commerce registration number")
    invoice_currency: str | None = Field(
        None, description="Invoice currency exactly as written on the document, e.g. EUR, USD, KES"
    )
    supplier_code: str | None = Field(
        None,
        description=(
            "Proposed supplier code: 4-7 capital letters A-Z derived from the "
            "company name, no digits, spaces or punctuation"
        ),
    )
    notes: str | None = Field(
        None, description="Anything unreadable or ambiguous on the scan, else null"
    )


_SYSTEM = """You read scanned supplier registration forms and return the fields exactly as printed.

Rules:
- Transcribe what is on the page. Never invent, complete or correct a value.
- If a field is absent, unreadable or you are unsure, return null for it and say why in `notes`.
- Keep the address, postal code and city in separate fields even when the document prints them on one line.
- Return the currency as written on the document. Do not convert it to a code or a name it does not use.
- `supplier_code` is the one field you may construct: 4-7 capital letters derived from the company name, no digits or punctuation."""


def _currency_id(raw: str | None) -> str | None:
    """Map whatever the document calls a currency onto a dropdown option id.

    Matches ISO codes, the portal's own option labels (several of which are
    Dutch), and common English names. Returns None when nothing matches —
    a wrong guess here would silently set a supplier to the wrong invoice
    currency, which is worse than leaving it for a human.
    """
    if not raw:
        return None
    text = raw.strip().lower()
    if not text:
        return None

    aliases = {
        "1": ("eur", "euro", "euros", "€"),
        "2": ("usd", "us dollar", "u.s. dollar", "us$", "dollar", "$"),
        "4": ("pln", "zloty", "złoty", "polish zloty"),
        "11": ("gbp", "pound", "british pound", "£"),
        "21": ("kes", "ksh", "kenyan shilling", "shilling", "kenya shilling"),
        "26": ("aed", "uae dirham", "dirham"),
        "18": ("cny", "rmb", "yuan", "chinese yuan"),
        "33": ("nzd", "new zealand dollar"),
        "34": ("sgd", "singapore dollar"),
    }
    for option_id, names in aliases.items():
        if text in names:
            return option_id
    for option_id, label in CURRENCY_OPTIONS.items():
        if text == label.lower():
            return option_id
    return None


def _clean_code(raw: str | None, company: str | None) -> str | None:
    """Force the supplier code into the shape the portal expects.

    The model is asked for 4-7 capital letters but is not a validator, so
    this strips anything else and falls back to the company name's own
    letters if what came back is unusable."""
    def letters(value: str | None) -> str:
        return re.sub(r"[^A-Za-z]", "", value or "").upper()

    code = letters(raw)[:7]
    if len(code) < 4:
        code = letters(company)[:7]
    return code if len(code) >= 4 else (code or None)


def extract_from_pdf(cfg: Config, pdf_bytes: bytes, filename: str = "") -> dict:
    """Read one scanned supplier form. Writes nothing anywhere."""
    if not cfg.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured")
    if not pdf_bytes:
        raise ValueError("Empty file")
    if len(pdf_bytes) > MAX_PDF_BYTES:
        raise ValueError(
            f"PDF is {len(pdf_bytes) / 1024 / 1024:.1f} MB; the limit is "
            f"{MAX_PDF_BYTES // 1024 // 1024} MB"
        )
    if not pdf_bytes.startswith(b"%PDF"):
        raise ValueError("That file is not a PDF")

    client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)
    logger.info("[kenya-supplier] extracting from %s (%d bytes)", filename or "upload", len(pdf_bytes))

    response = client.messages.parse(
        model="claude-opus-5",
        max_tokens=4096,
        system=_SYSTEM,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": "application/pdf",
                        "data": base64.standard_b64encode(pdf_bytes).decode("ascii"),
                    },
                },
                {"type": "text", "text": "Extract the supplier details from this form."},
            ],
        }],
        output_format=SupplierDetails,
    )

    details: SupplierDetails = response.parsed_output
    data = details.model_dump()
    data["supplier_code"] = _clean_code(details.supplier_code, details.company_name)

    currency_id = _currency_id(details.invoice_currency)
    data["currency_id"] = currency_id
    data["currency_label"] = CURRENCY_OPTIONS.get(currency_id or "")
    # The portal already defaults to Euro, so an invoice in euros needs no
    # second page visit at all.
    data["currency_needs_change"] = bool(currency_id) and currency_id != DEFAULT_CURRENCY_ID
    data["country_id"] = KENYA_COUNTRY_ID

    missing = [k for k in (
        "company_name", "address", "postal_code", "city",
        "phone", "email", "vat_number", "coc_number", "invoice_currency",
    ) if not data.get(k)]

    return {
        "details": data,
        "missing": missing,
        "unmapped_currency": bool(details.invoice_currency) and not currency_id,
        "usage": {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        },
    }


# The add-supplier form, field id -> key in the extracted details. Every id
# here was confirmed against the live Kenya form; `code` is the supplier code
# input (user, 2026-09-11).
_FORM_FIELDS = {
    "company_name": "company_name",
    "address": "address",
    "postal": "postal_code",
    "city": "city",
    "phone": "phone",
    "email": "email",
    "vat_number": "vat_number",
    "coc_number": "coc_number",
}

_SUP_ID_RE = re.compile(r"/SUP_ID/(\d+)")


def _fill(page, field_id: str, value: str | None) -> bool:
    if value is None or value == "":
        return False
    el = page.query_selector("#" + field_id)
    if el is None:
        return False
    el.fill(str(value))
    return True


def _form_field_names(page) -> list[str]:
    """Every named input/select on the page - the diagnostic to print when an
    expected field is not where we thought it was."""
    return [
        n for n in (
            el.get_attribute("name")
            for el in page.query_selector_all("form input, form select")
        ) if n
    ]


def supplier_profile_url(cfg: Config, supplier_id: str) -> str:
    return cfg.freshportal_url + "/supplier/supplier/index/SUP_ID/" + supplier_id + "/"


def _set_currency(page, cfg: Config, supplier_id: str, currency_id: str) -> tuple[bool, str]:
    """Set the invoice currency on the supplier's international settings.

    Returns (changed, detail). Reads the select before touching it: when the
    portal already holds the wanted currency there is nothing to submit, and
    pressing save anyway is a pointless write to a page we only half know.
    """
    url = cfg.freshportal_url + "/supplier/international_setting/index/SUP_ID/" + supplier_id + "/"
    page.goto(url, wait_until="domcontentloaded", timeout=cfg.request_timeout)

    select = page.query_selector("#currency_id")
    if select is None:
        return False, "currency select not found on the international settings page"

    current = select.input_value()
    if current == currency_id:
        return False, "already set to " + CURRENCY_OPTIONS.get(currency_id, currency_id)

    select.select_option(currency_id)
    save = (page.query_selector("button.btn-save")
            or page.query_selector("form button[type=submit]")
            or page.query_selector("form input[type=submit]"))
    if save is None:
        return False, "currency selected but no save button found - not submitted"
    save.click()
    page.wait_for_load_state("domcontentloaded", timeout=cfg.request_timeout)

    # Re-read rather than trust the click.
    again = page.query_selector("#currency_id")
    now = again.input_value() if again else None
    if now != currency_id:
        return False, "save did not stick - select reads " + repr(now) + ", wanted " + repr(currency_id)
    return True, "set to " + CURRENCY_OPTIONS.get(currency_id, currency_id)


def create_supplier(cfg: Config, details: dict, on_status=None) -> dict:
    """Fill /supplier/supplier/add from the reviewed details and save.

    WRITES to FreshPortal - this creates a real supplier. The caller is
    responsible for having put the values in front of a human first. There is
    no duplicate check: the portal owns that decision, and before the record
    exists we have no key to check against.
    """
    # Validate before importing anything heavy: a bad code should come back as
    # a 400 without having launched a browser or opened a session.
    company = (details.get("company_name") or "").strip()
    if not company:
        raise ValueError("Company name is required")
    code = _clean_code(details.get("supplier_code"), company)
    if not code or not (4 <= len(code) <= 7):
        raise ValueError("Supplier code must be 4-7 capital letters")

    from playwright.sync_api import sync_playwright
    from scraper_fp import _launch_browser, _login

    def _s(msg: str) -> None:
        logger.info("[kenya-supplier] %s", msg)
        if on_status:
            on_status(msg)

    with sync_playwright() as pw:
        browser = _launch_browser(pw)
        ctx = browser.new_context()
        page = ctx.new_page()
        try:
            _s("Logging in to the Kenya portal...")
            _login(page, cfg)

            _s("Opening the add-supplier form...")
            page.goto(cfg.freshportal_url + "/supplier/supplier/add",
                      wait_until="domcontentloaded", timeout=cfg.request_timeout)

            filled, skipped = [], []
            for field_id, key in _FORM_FIELDS.items():
                target = filled if _fill(page, field_id, details.get(key)) else skipped
                target.append(field_id)

            country = page.query_selector("#country_id")
            if country is None:
                raise RuntimeError("Country select not found on the add-supplier form")
            country.select_option(KENYA_COUNTRY_ID)

            code_el = page.query_selector("#code")
            if code_el is None:
                raise RuntimeError(
                    "Supplier code field #code not found. The form has: "
                    + ", ".join(_form_field_names(page))
                )
            code_el.fill(code)
            filled.append("code")

            _s("Saving " + company + " (" + code + ")...")
            save = page.query_selector('button[name="submit_supplier"]')
            if save is None:
                raise RuntimeError("Save button not found on the add-supplier form")
            save.click()
            page.wait_for_load_state("domcontentloaded", timeout=cfg.request_timeout)

            # A successful save lands on the supplier's own page; staying put
            # means the form rejected something.
            match = _SUP_ID_RE.search(page.url)
            if not match:
                errors = [e.inner_text().strip()
                          for e in page.query_selector_all(".alert, .error, .invalid-feedback")]
                said = "; ".join(e for e in errors if e) or "(nothing)"
                raise RuntimeError(
                    "Save did not create a supplier - still on " + page.url + ". Page says: " + said
                )
            supplier_id = match.group(1)
            _s("Created supplier " + supplier_id)

            currency_changed = False
            currency_detail = "no currency resolved from the document"
            currency_id = details.get("currency_id")
            if currency_id and currency_id != DEFAULT_CURRENCY_ID:
                _s("Setting the invoice currency...")
                currency_changed, currency_detail = _set_currency(
                    page, cfg, supplier_id, currency_id)
            elif currency_id == DEFAULT_CURRENCY_ID:
                currency_detail = "document currency matches the portal default, left alone"

            return {
                "supplier_id": supplier_id,
                "supplier_url": supplier_profile_url(cfg, supplier_id),
                "supplier_code": code,
                "company_name": company,
                "filled_fields": filled,
                "skipped_fields": skipped,
                "currency_changed": currency_changed,
                "currency_detail": currency_detail,
            }
        finally:
            ctx.close()
            browser.close()
