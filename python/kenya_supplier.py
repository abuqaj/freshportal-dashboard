"""Supplier onboarding for the Kenya system (850254).

A scanned supplier form goes in, a new supplier in FreshPortal comes out.
The document always has the same layout; only the values change.

Pipeline:
  1. Read the PDF with Claude and extract the fields the portal needs.
  2. (later) Log in and fill /supplier/supplier/add, save, then set the
     invoice currency on the supplier's international settings page.

Only step 1 exists so far — the point of stopping here is that the whole
thing is worthless if the extraction is wrong, and that is cheap to check
by eye before any of it is written into the portal.

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
