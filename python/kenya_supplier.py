"""Supplier onboarding for the Kenya system (850254).

A supplier form goes in - a scanned PDF or a Word .docx - and a new supplier
in FreshPortal comes out. The document always has the same layout; only the
values change.

Pipeline:
  1. Take the fields the portal needs out of the document: a PDF is read by
     Claude, a .docx by label, without a model.
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

A .docx is not sent to the model at all. It holds typed text, not a picture
of text, so docx_reader takes its rows out and each field is found by the
label next to it: no API call, no cost, and the same file always reads the
same way. A label that is not recognised leaves its field empty, highlighted
on the review screen exactly like a field the model could not read.
"""
from __future__ import annotations

import base64
import logging
import re

import anthropic
from pydantic import BaseModel, Field

from config import Config
from docx_reader import DocxContent, read_docx

logger = logging.getLogger(__name__)

# Anthropic's documented ceiling for a base64 PDF is a 32 MB request; base64
# inflates by ~4/3, so the raw file has to stay under about 24 MB. Refused
# here with a readable message rather than as a 413 from the API. A .docx
# gets the same cap - a form is a few hundred KB.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# An OLE compound file: what a Word 97-2003 .doc is, and also what a .docx
# turns into once Word encrypts it with a password.
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

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


_CURRENCY_ALIASES: dict[str, tuple[str, ...]] = {
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

# Names that stand for one currency on their own but end the names of others
# ("Hong Kong Dollar", "Tanzanian Shilling", "Egyptian Pound").
_BARE_CURRENCY_NAMES = {"dollar", "$", "pound", "£", "shilling", "dirham"}


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

    for option_id, names in _CURRENCY_ALIASES.items():
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


# Written in the portal with only the first letter capitalised, whoever wrote
# them - suppliers fill these in as "SHABANGU FLOWERS" as often as not, and an
# operator correcting a field makes the same slips (user, 2026-09-17). Applied
# to what was read and again to what is created, so a value typed on the
# review screen cannot get past it. The screen does the same on leaving a
# field, so what is created is what was shown.
_FIRST_LETTER_ONLY = ("company_name", "city", "country")


def _first_letter_capital(value: str | None) -> str | None:
    """"SHABANGU FLOWERS" -> "Shabangu flowers", and "3M KENYA" -> "3M kenya":
    the first letter, not the first character."""
    if not value:
        return value
    text = value.strip().lower()
    for i, char in enumerate(text):
        if char.isalpha():
            return text[:i] + char.upper() + text[i + 1:]
    return text


def _review_payload(details: SupplierDetails, currency_id: str | None,
                    usage: dict | None = None) -> dict:
    """What the review screen gets, however the details were read."""
    data = details.model_dump()
    data["supplier_code"] = _clean_code(details.supplier_code, details.company_name)
    for key in _FIRST_LETTER_ONLY:
        data[key] = _first_letter_capital(data[key])

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

    result = {
        "details": data,
        "missing": missing,
        "unmapped_currency": bool(details.invoice_currency) and not currency_id,
    }
    if usage is not None:
        result["usage"] = usage
    return result


def extract_from_document(cfg: Config, file_bytes: bytes, filename: str = "") -> dict:
    """Read one supplier form, a scanned PDF or a Word .docx. Writes nothing
    anywhere.

    The kind of file is decided on its bytes rather than its name, so a
    renamed file fails with a message about what it really is."""
    if not file_bytes:
        raise ValueError("Empty file")
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise ValueError(
            f"The file is {len(file_bytes) / 1024 / 1024:.1f} MB; the limit is "
            f"{MAX_UPLOAD_BYTES // 1024 // 1024} MB"
        )
    if file_bytes.startswith(b"%PDF"):
        return _extract_from_pdf(cfg, file_bytes, filename)
    if file_bytes.startswith(_OLE_MAGIC):
        raise ValueError(
            "That is an old Word .doc file or a password-protected document. "
            "Save it as .docx without a password, or as PDF, and upload it again."
        )
    if file_bytes.startswith(b"PK"):
        return _extract_from_docx(file_bytes, filename)
    raise ValueError("That file is neither a PDF nor a Word .docx document")


def _extract_from_pdf(cfg: Config, pdf_bytes: bytes, filename: str) -> dict:
    if not cfg.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured")

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
    return _review_payload(details, _currency_id(details.invoice_currency), {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
    })


# ── Word .docx: read by label, no model ─────────────────────────────────────
#
# The supplier form (as sent in, 2026-09-17) is a two-column table of
# label | value, split by shaded heading rows into COMPANY INFORMATION,
# CONTACT, INVOICE AND BANK INFORMATION and DIRECTOR. Its labels keep the
# form's own spelling ("Adress", "Email adress"), and "Postal Code and City"
# is one field holding both. Other layouts - "Label: value" lines, a row of
# labels over a row of values - are read too, so a reworked template does not
# stop the module; whatever does not match is left empty for the operator.

# The labels a form may put next to each field, most specific first. A label
# matches a synonym when it is that synonym, or contains it as whole words
# and is at most three words longer - long enough for "Company phone
# number", short enough that a sentence of instructions does not count.
# Fields are tried in this order, so "Email address" is an email before it
# is an address and "VAT registration number" a VAT number before a
# registration number. In Kenya the VAT number is the KRA PIN.
_DOCX_LABELS: list[tuple[str, tuple[str, ...]]] = [
    ("email", ("email address", "email")),
    ("phone", ("phone number", "telephone number", "telephone", "phone", "tel",
               "mobile number", "mobile", "cell")),
    ("vat_number", ("vat number tax number", "vat number", "vat registration number", "kra pin",
                    "pin number", "vat", "pin", "tax identification number", "tax number",
                    "tax id", "tin")),
    ("coc_number", ("chamber of commerce number registration number", "chamber of commerce number",
                    "company registration number", "business registration number",
                    "certificate of incorporation number", "incorporation number",
                    "registration number", "chamber of commerce", "certificate of incorporation",
                    "coc")),
    ("invoice_currency", ("invoice currency", "currency")),
    # One field on the supplier form, split into its two parts afterwards.
    ("postal_code_city", ("postal code and city", "postal code city", "post code and city",
                          "postcode and city", "zip code and city", "city and postal code")),
    ("postal_code", ("postal code", "post code", "postcode", "zip code", "zip")),
    ("city", ("city", "town")),
    ("country", ("country",)),
    ("company_name", ("company name", "registered company name", "name of company",
                      "name of the company", "registered name", "business name", "legal name",
                      "supplier name", "name of supplier", "name of business")),
    ("address", ("physical address", "street address", "address")),
]

# Misspellings on real forms, read as the word they mean.
_DOCX_SPELLING = {"adress": "address", "adres": "address", "addres": "address"}

# A label with one of these words is about something other than the
# supplier's own details - the bank, a delivery address, a website.
_DOCX_IGNORE = {"bank", "branch", "swift", "bic", "iban", "account", "delivery", "web", "website"}

# Sections about people rather than the company: a contact's or a director's
# email address is not the supplier's.
_DOCX_SKIP_SECTIONS = {"contact", "contacts", "director", "directors", "owner", "owners",
                       "shareholder", "shareholders", "reference", "references", "delivery"}

# Answers rather than values: "VAT registered? [X] Yes" is not a VAT number,
# and "N/A" under one means the field is empty.
_DOCX_NOT_A_VALUE = {"yes", "no", "n/a", "na", "none", "nil", "-", "--"}

_DOCX_FIELD_NAMES = {
    "company_name": "Company name", "address": "Address", "postal_code": "Postal code",
    "city": "City", "postal_code_city": "Postal code and city", "country": "Country",
    "phone": "Phone", "email": "Email", "vat_number": "VAT number",
    "coc_number": "Registration number", "invoice_currency": "Invoice currency",
}

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


def _label_words(text: str) -> list[str]:
    text = re.sub(r"\(.*?\)", " ", text.lower().replace("e-mail", "email"))
    return [_DOCX_SPELLING.get(w, w) for w in re.findall(r"[a-z]+", text)]


def _label_field(text: str) -> tuple[str, int] | None:
    """(field, rank) when `text` is a label for a field; lower rank is surer."""
    words = _label_words(text)
    if not words or len(words) > 8 or _DOCX_IGNORE & set(words):
        return None
    # Exact labels first, across every field, so "Registered company name"
    # is not taken for a looser match found earlier in the list.
    for field_key, synonyms in _DOCX_LABELS:
        for rank, synonym in enumerate(synonyms):
            if words == synonym.split():
                return field_key, rank
    for field_key, synonyms in _DOCX_LABELS:
        for rank, synonym in enumerate(synonyms):
            syn = synonym.split()
            if len(words) <= len(syn) + 3 and any(
                    words[i:i + len(syn)] == syn for i in range(len(words) - len(syn) + 1)):
                return field_key, 100 + rank
    return None


def _split_label(text: str) -> tuple[str, str] | None:
    """A label and its value written in one cell or paragraph: "Label: value",
    the label on the first line and the value below it, "Label<tab>value" or
    "Label ______ value"."""
    label, sep, value = text.partition(":")
    if sep and "\n" not in label and value.strip() and _label_field(label):
        return label, value
    first, sep, rest = text.partition("\n")
    match = _label_field(first)
    if sep and rest.strip() and match and match[1] < 100:
        return first, rest
    for pattern in (r"\t+", r"\s*(?:_{3,}|\.{4,}|…+)\s*"):
        parts = re.split(pattern, text, maxsplit=1)
        if len(parts) == 2 and parts[1].strip() and "\n" not in parts[0] and _label_field(parts[0]):
            return parts[0], parts[1]
    return None


def _section_heading(row: list[str]) -> set[str] | None:
    """The words of a section heading - capitals in the first cell and nothing
    beside it, like the shaded rows of the supplier form - or None."""
    first = row[0]
    if any(row[1:]) or first != first.upper() or not re.search(r"[A-Z]{3}", first):
        return None
    if _label_field(first) or _split_label(first):
        return None  # a label that happens to be in capitals
    return set(_label_words(first))


def _docx_value(raw: str) -> str:
    """A value as the review screen should show it: fill-in lines removed,
    one line, and for a row of checkboxes the one option that is ticked."""
    text = re.sub(r"_{2,}|\.{3,}|…+", " ", raw)
    lines = (re.sub(r"[ \t   ]+", " ", ln).strip(" :;,") for ln in text.split("\n"))
    value = ", ".join(ln for ln in lines if ln)
    if "[X]" in value or "[ ]" in value:
        ticked = [t.strip(" ,;") for t in re.findall(r"\[X\]\s*([^\[\]]*)", value)]
        ticked = [t for t in ticked if t]
        # None ticked, or several: nothing a human would not have to decide.
        value = ticked[0] if len(ticked) == 1 else ""
    return "" if value.lower() in _DOCX_NOT_A_VALUE else value


def _docx_pairs(doc: DocxContent) -> list[tuple[str, str]]:
    """Every (label, value) the layout offers, in reading order, outside the
    sections about people. Whether a label is one we want is decided later."""
    pairs: list[tuple[str, str]] = []
    rows = doc.rows
    skipping = False
    for i, row in enumerate(rows):
        heading = _section_heading(row)
        if heading is not None:
            skipping = bool(heading & _DOCX_SKIP_SECTIONS)
            continue
        if skipping:
            continue

        inline = [_split_label(cell) for cell in row]
        labels = [None if inline[j] else _label_field(cell) for j, cell in enumerate(row)]
        below = rows[i + 1] if i + 1 < len(rows) else None
        if below is not None and _section_heading(below) is not None:
            below = None

        # A row of labels with the values in the row underneath.
        if (len(row) > 1 and all(labels) and below is not None and len(below) == len(row)
                and not any(_label_field(cell) or _split_label(cell) for cell in below)):
            pairs.extend(zip(row, below))
            continue

        for j, cell in enumerate(row):
            if inline[j]:
                pairs.append(inline[j])
            elif labels[j] and j + 1 < len(row) and not labels[j + 1] and not inline[j + 1]:
                # The value is the next cell - or, for checkboxes spread over
                # several cells, every cell up to the next label.
                end = j + 1
                while end < len(row) and not labels[end] and not inline[end] and (
                        end == j + 1 or "[" in row[end - 1] or "[" in row[end]):
                    end += 1
                pairs.append((cell, " ".join(row[j + 1:end])))
            elif (labels[j] and labels[j][1] < 100 and len(row) == 1 and below is not None
                  and len(below) == 1 and not _label_field(below[0]) and not _split_label(below[0])):
                # A label on its own line and the value on the next.
                pairs.append((cell, below[0]))
    return pairs


def _split_postal_city(value: str) -> tuple[str | None, str | None]:
    """"00100 NAIROBI" -> ("00100", "NAIROBI"); also "Nairobi, 00100". Both
    None when the value is not one number and one name."""
    if re.fullmatch(r"\d[\d -]*", value):
        return value, None
    if not re.search(r"\d", value):
        return None, value
    match = re.fullmatch(r"(\d(?:[\d -]*\d)?)\s*[,/-]?\s*(\D+)", value)
    if match:
        return match.group(1), match.group(2).strip()
    match = re.fullmatch(r"(\D+?)\s*[,/-]?\s*(\d(?:[\d -]*\d)?)", value)
    if match:
        return match.group(2), match.group(1).strip()
    return None, None


def _currency_in_text(raw: str | None) -> str | None:
    """A currency named inside a longer value - "Kenya Shillings (KES)" -
    when exactly one currency is named. Two ("EUR or USD") is left to a human.

    Names are matched whole and longest first, so "New Zealand Dollars" is
    NZD and is not read again as a plain dollar. A bare name after another
    word ("Hong Kong Dollars", a currency with no option here) leaves the
    whole value to a human: read word by word it became USD (review
    2026-09-25)."""
    text = f" {(raw or '').lower()} "
    names = [(name, cid) for cid, aliases in _CURRENCY_ALIASES.items() for name in aliases]
    names += [(label.lower(), cid) for cid, label in CURRENCY_OPTIONS.items()]
    found = set()
    for name, currency_id in sorted(names, key=lambda n: len(n[0]), reverse=True):
        pattern = re.compile(rf"(?<![a-z]){re.escape(name)}s?(?![a-z])")
        for match in pattern.finditer(text):
            if name in _BARE_CURRENCY_NAMES and re.search(r"[a-z]\s*$", text[:match.start()]):
                return None
            found.add(currency_id)
        text = pattern.sub(" ", text)
    return found.pop() if len(found) == 1 else None


def _extract_from_docx(file_bytes: bytes, filename: str) -> dict:
    doc = read_docx(file_bytes)
    logger.info("[kenya-supplier] reading %s (docx, %d rows, %d pictures)",
                filename or "upload", len(doc.rows), doc.pictures)

    found: dict[str, list[tuple[int, int, str]]] = {}
    for order, (label, raw) in enumerate(_docx_pairs(doc)):
        match = _label_field(label)
        value = _docx_value(raw)
        if match and value:
            found.setdefault(match[0], []).append((match[1], order, value))

    if not found:
        if doc.pictures and not doc.rows:
            raise ValueError(
                "The Word document holds only pictures, and pictures in a Word file are "
                "not read. If the form is a scan pasted into Word, upload the scan as PDF."
            )
        raise ValueError(
            "No supplier details were found in the Word document: none of its labels "
            "matched a field of the form."
        )

    values: dict[str, str] = {}
    notes: list[str] = []
    for key, candidates in found.items():
        values[key] = min(candidates)[2]
        distinct = list(dict.fromkeys(value for _, _, value in candidates))
        if len(distinct) > 1:
            notes.append(f"{_DOCX_FIELD_NAMES[key]} appears more than once "
                         f"({' / '.join(distinct)}); {values[key]} was used.")

    combined = values.pop("postal_code_city", None)
    if combined:
        postal, city = _split_postal_city(combined)
        if postal is None and city is None:
            notes.append(f'Postal code and city "{combined}" could not be split - fill them in by hand.')
        for key, part in (("postal_code", postal), ("city", city)):
            if part and not values.get(key):
                values[key] = part

    # The portal takes one address; the form's field sometimes lists several.
    addresses = _EMAIL_RE.findall(values.get("email") or "")
    if addresses:
        values["email"] = addresses[0]
        if len(addresses) > 1:
            notes.append(f"The form lists {len(addresses)} email addresses "
                         f"({', '.join(addresses)}); the first was used.")

    # "COMPANY REGISTRATION: PVT-YQ19KK8E" - the supplier repeating the label.
    for key in ("vat_number", "coc_number"):
        match = re.fullmatch(r"[A-Za-z][A-Za-z .&/-]*:\s*(\S*\d.*)", values.get(key) or "")
        if match:
            values[key] = match.group(1)

    codes = suggest_codes(values.get("company_name"))
    details = SupplierDetails(**values, supplier_code=codes[0] if codes else None)
    raw_currency = details.invoice_currency
    result = _review_payload(details, _currency_id(raw_currency) or _currency_in_text(raw_currency))
    if doc.pictures and result["missing"]:
        notes.append(f"The document has {doc.pictures} picture(s), which are not read - "
                     f"check them for the details missing here.")
    result["details"]["notes"] = " ".join(notes) or None
    return result


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


# What the portal says when a supplier code is taken. Confirmed against the
# live Kenya form 2026-09-11: "Deze leveranciers code bestaat al". Matched on
# a lowercased substring so casing, the leading "x" of the dismiss control and
# any surrounding markup do not matter. The English phrasing is included
# because the portal's language follows the account, not the system.
_DUPLICATE_CODE_MARKERS = ("code bestaat al", "code already exists")


class DuplicateSupplierCode(Exception):
    """The portal refused the save because the code is already in use.

    Raised only when every candidate code was rejected - the normal case
    is handled by retrying, not by surfacing this. `suggestions` then holds
    what was actually tried, so the message can say so.
    """

    def __init__(self, code: str, suggestions: list[str]):
        super().__init__(f"Supplier code {code} is already in use")
        self.code = code
        self.suggestions = suggestions


def suggest_codes(company: str | None, taken: str | None = None, limit: int = 6) -> list[str]:
    """Alternative 4-7 letter codes derived from the company name.

    Deterministic and ordered from most to least recognisable. Words like
    "Ltd" are dropped first: a code built out of the legal suffix tells a
    human nothing about which supplier it is.
    """
    noise = {"ltd", "limited", "plc", "bv", "b", "v", "inc", "llc", "co",
             "company", "the", "and", "farms", "farm", "group", "holdings"}
    words = [w for w in re.findall(r"[A-Za-z]+", company or "")]
    meaningful = [w for w in words if w.lower() not in noise] or words
    if not meaningful:
        return []

    def clean(value: str) -> str:
        return re.sub(r"[^A-Z]", "", value.upper())

    joined = clean("".join(meaningful))
    first = clean(meaningful[0])
    initials = clean("".join(w[0] for w in meaningful))

    candidates = [
        joined[:6], joined[:5], joined[:7], joined[:4],
        clean(meaningful[0][:3] + (meaningful[1][:3] if len(meaningful) > 1 else "")),
        clean("".join(w[:2] for w in meaningful)),
        first[:5], first[:4],
        initials + first[1:4],
        clean("".join(w[:4] for w in meaningful[:2])),
    ]

    seen, out = set(), []
    blocked = {(taken or "").upper()}
    for c in candidates:
        if 4 <= len(c) <= 7 and c not in seen and c not in blocked:
            seen.add(c)
            out.append(c)
        if len(out) >= limit:
            break
    return out


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


def _fill_add_form(page, details: dict, code: str) -> tuple[list[str], list[str]]:
    """Fill every field on a freshly loaded add-supplier form.

    Returns (filled, skipped) where skipped are fields the document simply
    had no value for. Each field is read back after writing: the form has
    been seen to clear itself when one field is rejected, so "we called
    fill()" is not evidence the value is actually in the box. A value that
    does not read back raises rather than being saved half-complete —
    a supplier created with silently missing details looks like a success
    and nobody goes back to check it.
    """
    filled: list[str] = []
    skipped: list[str] = []
    mismatched: list[str] = []

    for field_id, key in _FORM_FIELDS.items():
        value = details.get(key)
        if _fill(page, field_id, value):
            filled.append(field_id)
        else:
            skipped.append(field_id)

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

    # Read everything back before submitting.
    for field_id in filled:
        el = page.query_selector("#" + field_id)
        got = el.input_value() if el else None
        want = code if field_id == "code" else str(details.get(_FORM_FIELDS[field_id]) or "")
        if (got or "") != want:
            mismatched.append(field_id + ": wrote " + repr(want) + ", reads " + repr(got))

    country_now = page.query_selector("#country_id")
    if not country_now or country_now.input_value() != KENYA_COUNTRY_ID:
        mismatched.append("country_id: did not hold " + KENYA_COUNTRY_ID)

    if mismatched:
        raise RuntimeError(
            "The form did not keep what was typed into it - not saving. " + "; ".join(mismatched)
        )
    return filled, skipped


def supplier_profile_url(cfg: Config, supplier_id: str) -> str:
    return cfg.freshportal_url + "/supplier/supplier/index/SUP_ID/" + supplier_id + "/"


# The top of the profile, not the whole page: the header and the details block
# are what show the save worked, and a long profile as one full-page image
# would be megabytes of base64 in the JSON response.
_SCREENSHOT_VIEWPORT = {"width": 1366, "height": 900}
_SCREENSHOT_JPEG_QUALITY = 70

# How long to wait for stylesheets and images after the page is parsed.
# Bounded rather than waiting for "load" outright: FreshPortal pages have
# been slow and heavy enough to run Railway out of memory (see _login).
_SCREENSHOT_LOAD_WAIT_MS = 15_000


def _profile_screenshot(page, cfg: Config, supplier_id: str) -> str | None:
    """The supplier's profile as it looks right after saving, as a base64
    JPEG for the summary on the dashboard.

    Never raises. The supplier exists by the time this runs, so a picture
    that could not be taken is logged and left out - it must not turn a
    successful create into an error the operator would retry."""
    try:
        page.set_viewport_size(_SCREENSHOT_VIEWPORT)
        page.goto(supplier_profile_url(cfg, supplier_id),
                  wait_until="domcontentloaded", timeout=cfg.request_timeout)
        try:
            page.wait_for_load_state("load", timeout=_SCREENSHOT_LOAD_WAIT_MS)
        except Exception:
            pass  # a picture of a half-styled page still shows the right supplier
        if "login" in page.url:
            logger.warning("[kenya-supplier] no screenshot for %s: session ended, on %s",
                           supplier_id, page.url)
            return None
        shot = page.screenshot(type="jpeg", quality=_SCREENSHOT_JPEG_QUALITY, full_page=False)
        return base64.standard_b64encode(shot).decode("ascii")
    except Exception as exc:
        logger.warning("[kenya-supplier] no screenshot for %s: %s", supplier_id, exc)
        return None


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
    # Same control name as the add form, but an <input> here rather than a
    # <button> (user, 2026-09-11) - so match on the name, not the tag.
    save = (page.query_selector('[name="submit_supplier"]')
            or page.query_selector("form input[type=submit], form button[type=submit]"))
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
    details = {**details, **{k: _first_letter_capital(details.get(k)) for k in _FIRST_LETTER_ONLY}}

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
            # Candidate codes, in order. The operator's own code goes first;
            # the rest are only reached if the portal says it is taken.
            candidates = [code] + [c for c in suggest_codes(company, code) if c != code]

            supplier_id = None
            filled: list[str] = []
            skipped: list[str] = []
            tried: list[str] = []
            used_code = code

            for candidate in candidates:
                tried.append(candidate)
                # Reload the form for every attempt instead of editing the
                # code in place. A rejected save can come back with other
                # fields blanked, so anything left on the page after a failure
                # is not to be trusted — refill from `details` every time.
                page.goto(cfg.freshportal_url + "/supplier/supplier/add",
                          wait_until="domcontentloaded", timeout=cfg.request_timeout)
                filled, skipped = _fill_add_form(page, details, candidate)

                _s("Saving " + company + " (" + candidate + ")...")
                save = page.query_selector('button[name="submit_supplier"]')
                if save is None:
                    raise RuntimeError("Save button not found on the add-supplier form")
                save.click()
                page.wait_for_load_state("domcontentloaded", timeout=cfg.request_timeout)

                # A successful save lands on the supplier's own page; staying
                # put means the form rejected something.
                match = _SUP_ID_RE.search(page.url)
                if match:
                    supplier_id = match.group(1)
                    used_code = candidate
                    break

                errors = [e.inner_text().strip()
                          for e in page.query_selector_all(".alert, .error, .invalid-feedback")]
                said = "; ".join(e for e in errors if e) or "(nothing)"
                if any(m in said.lower() for m in _DUPLICATE_CODE_MARKERS):
                    _s("Code " + candidate + " is taken, trying the next one...")
                    continue
                raise RuntimeError(
                    "Save did not create a supplier - still on " + page.url + ". Page says: " + said
                )

            if supplier_id is None:
                raise DuplicateSupplierCode(code, tried)
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

            # Last, so the picture shows the profile with the currency set.
            _s("Taking a picture of the supplier profile...")
            screenshot = _profile_screenshot(page, cfg, supplier_id)

            return {
                "supplier_id": supplier_id,
                "supplier_url": supplier_profile_url(cfg, supplier_id),
                # The code that actually went in, which is not necessarily the
                # one that was asked for.
                "supplier_code": used_code,
                "requested_code": code,
                "codes_tried": tried,
                "company_name": company,
                "filled_fields": filled,
                "skipped_fields": skipped,
                "currency_changed": currency_changed,
                "currency_detail": currency_detail,
                # Base64 JPEG, or None when it could not be taken.
                "profile_screenshot": screenshot,
            }
        finally:
            ctx.close()
            browser.close()
