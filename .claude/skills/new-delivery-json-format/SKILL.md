---
name: new-delivery-json-format
description: Handles a supplier delivery file that delivery import cannot read or reads wrongly - JSON (also inside .txt), a PDF invoice, or a .docx - checks it against the existing parsers and PDF layouts and, when needed, adds a separate parser or layout without changing the ones that work. Use when the user shares a delivery file or supplier invoice in a new shape, or reading one fails ("nowy format JSON", "Invalid delivery JSON", "nie czyta tego JSONa", "nie czyta tego PDFa", "faktura w PDF", "not in a supported supplier layout", "do not add up to the totals printed on the invoice").
---

# new-delivery-json-format

Delivery import turns a supplier's delivery file into orders and lines for
FreshPortal. Most suppliers send JSON; some send a PDF invoice; a `.docx` has
not reached delivery import yet. Whatever the shape, the job is the same: find
out whether the file already reads right, and if not, add a reader for it
without changing the ones that work. The name says JSON because JSON came
first.

A supplier's **registration form** (`.docx`, or a scanned PDF) is not a
delivery file. It belongs to Add supplier (`python/kenya_supplier.py`), not to
this skill.

## Rules from the users

- **Working parsers must not change behaviour.** A new format gets its own
  parser rather than bending one that works.
- Suppliers send JSON inside `.txt` files too; that is accepted.
- **Identical per-box lines** are grouped into one line with a quantity.
- **Box content** = stems per bunch × bunches.
- **Packaging codes:** FreshPortal receives only `QBE`, `HBE`, `1/8` or a
  mix box label `MB1`, `MB2`…; any code starting with `QB` becomes `QBE` and
  with `HB` becomes `HBE` (`QB ROSALEDA`, `QB3 ALSTRO`, `HB XL 1`). Mix box
  logic stays as it is. Utopia Farms writes one letter: `Q` is `QBE`, `E`
  is `1/8`.
- **Utopia Farms** sends one box entry per row of boxes: `nu_bunches` is the
  number of boxes and `nu_stems_bunch` the stems of the whole row (Q, 9,
  2700 = 9 boxes of 300 stems); the bunch size is in `nm_product` (`10ST`).
- **Batch code = invoice number, exactly.** Leading zeros are never removed.
- **Weight:** roses, and any weight above 100, send no weight.
- **Pomarosa's grower** comes from each product's `nm_location`.
- **A different farm is a different grower:** boxes of the same product from
  different `nm_location`s never merge into one line.
- **A product name that lacks its variety names another product.** Florecal
  sends tinted `TA RAINBOW MD 60CM …` with `nm_variety` `MONDIAL`; the line
  takes its variety from the name, so it never shares a plain Mondial's match.
- **The invoice total is the check.** A header total that disagrees with the
  lines means the file is read wrongly, even when every box looks plausible.
  Ceresfarms sends the price per bunch, and can write a row's total bunches
  into each of its boxes; only the invoice total shows which row that was.
- **Read with code, not with a model.** A `.docx` is read by a script (the
  user, 2026-09-17: reading one does not need AI), and so is a PDF with a
  text layer. Delivery import has no path for scans.

## Which reader

| The file | Read by | Today |
|---|---|---|
| JSON, or JSON inside `.txt` | `parse_delivery_json` in `python/parser_delivery.py`, endpoint `/delivery/parse` | the formats below |
| PDF invoice with a text layer | `parse_delivery_pdf` in `python/parser_delivery_pdf.py`, one engine, with one `LayoutSpec` per supplier in `python/pdf_layouts.py`; endpoint `/delivery/parse-pdf` | Qualisa, Alissroses |
| scanned PDF, no text layer | nothing: the engine refuses it and asks for the original PDF or the JSON | - |
| `.docx` | nothing yet; see "A .docx delivery" below | - |

Both endpoints hand their orders to the same matching, growers and DFG
payload (`_resolve_and_match()` in `python/api_server.py`), so a reader's only
job is to produce the right `DeliveryOrder` and `DeliveryLine`s.

When a supplier can send both, JSON carries more. A PDF has no box weight
(`nu_box_weight` goes as 0), no stem weight, no product GUIDs, and no farm
per line: `nm_location` is read only from a summary naming a single
warehouse, and it decides the grower for Pomarosa and Tessa.

## JSON formats that exist today

`parse_delivery_json` in `python/parser_delivery.py` detects them in this order:

| Detected by | Parser | Suppliers |
|---|---|---|
| single key holding the text of an INVOICE, value `null` | `_parse_text_invoice` | Fiorentina |
| `invoices`, every `tx_company` Ceresfarms | `_parse_ceresfarms_format` | Ceresfarms |
| `invoices`, every `tx_company` Utopia Farms | `_parse_utopia_format` | Utopia Farms |
| `invoices` | `_parse_invoices_format` | Elite, Ecoroses, Alissroses, Pomarosa |
| `id_factura` or `detalles` | `_parse_factura_format` | Bloomingacres, FreshFromSource |
| `detalle` | `_parse_etiqueta_format` | one row per physical box |

## Samples

Delivery files contain prices and customer data, so they stay **out of git**.
The collection lives in the local knowledge base:
`C:\Users\Jakub.Lewando_col\coloriginz-knowledge\raw\delivery-json\`.
Add each new file following that repo's `add-new-resource` rules: copy it
byte for byte, never overwrite or delete, and put a date prefix on a name
clash. Then commit it there; that repo has no remote. If the folder is empty
or missing, ask the user for earlier files of each format.

PDF invoices belong in the same collection. `run_samples.py` reads only
`.json` and `.txt`, so it skips them; a PDF is checked through the PDF tests
instead (see the PDF steps). A file pasted into the chat is not a sample: ask
for the path to the original, so it can be copied byte for byte. On
2026-09-24 three files arrived only as chat text and could not be added.

## Steps for JSON

1. **Baseline first.** Before touching code, run the whole collection once:
   `python .claude/skills/new-delivery-json-format/scripts/run_samples.py <samples folder> --save-baseline <scratchpad>/baseline.json`
2. **Run the new file alone:** `run_samples.py <file>`. It shows the detected
   format, orders, lines, boxes, stems and totals. It also flags a header that
   disagrees with the sum of its lines.
3. **Check the result by hand** against the file: box count, total stems,
   total amount, and three lines picked at random.
4. **Decide:**
   - **Everything matches:** no code change. Tell the user it already works.
   - **Detected as an existing format, but numbers are wrong:** fix that parser
     only if the cause is a bug its other samples share. Otherwise treat the
     file as a new format.
   - **Unknown or structurally different:** add
     `_parse_<name>_format(data) -> list[DeliveryOrder]`, built the way the
     others build orders and lines. Add a detection branch in
     `parse_delivery_json` keyed on something the existing formats lack, placed
     so it cannot capture them. Update the "Format detection" docstring.
5. **Regression check:** `run_samples.py <samples folder> --compare <scratchpad>/baseline.json`.
   Any `CHANGED` old sample means a working parser changed. Undo that change.
   Then run both parser test files, `python python/tests/test_parser_delivery_json.py`
   and `python python/tests/test_parser_delivery_pdf.py`: the PDF reader
   shares `_normalise_box` and the line model with the JSON parsers, so a JSON
   rule can move a PDF result. On 2026-09-24 the box-code rule changed what
   the Qualisa PDF test expects.
6. **Ship** with `ship-to-test`, then ask the user to upload the file in
   delivery import on the test environment. The API and matching steps cannot
   be run locally.

## Steps for a PDF invoice

1. **Baseline first**, exactly as step 1 for JSON, and run the two test files
   once: a change made for a PDF can move a JSON result through the shared
   code.
2. **Look at what the PDF really contains.** From the `python/` folder,
   `python -m pdf_layouts <invoice.pdf>` prints the detected layout (or that
   it needs a new spec), the page text, and every table with its column
   indexes. Write and fix specs from this output, never from how the invoice
   looks: both first layouts were written from the picture, and their tests
   passed while the real files failed.
3. **Decide:**
   - **A layout is detected and the import works:** check it by hand against
     the invoice (boxes, stems, amount, three lines at random). If it
     matches, no code change.
   - **A layout is detected but fails or reads wrongly:** the supplier changed
     its printout, or the spec never matched the real text. Fix that
     supplier's spec only.
   - **No layout is detected** ("not in a supported supplier layout"): add a
     `LayoutSpec` to `python/pdf_layouts.py`, following the five steps in
     that file's docstring: `detect` from the template's wording, not one
     shipment's; the grid; the four header fields FreshPortal needs
     (`tx_company`, `id_invoice`, `dt_invoice`, `dt_fly`); `totals_marker` or
     `totals_re` on the invoice's own totals; and for a grouped layout,
     `merge_across_boxes` set to whatever `parser_delivery` does with the same
     supplier's JSON, so one delivery imports the same way whichever file
     arrives. A new supplier is a spec of a few dozen lines, never a new
     parser.
   - **A scan:** ask for the original PDF or the JSON; there is no OCR path.
4. **Keep the engine's refusals.** Without `totals_marker` or `totals_re` the
   engine only logs "checksum skipped" and imports whatever it read, so every
   spec points at the printed totals. A block whose quantities do not divide
   between its boxes, and lines that do not add up to the printed totals,
   stop the import. That is the safety net, not the bug.
5. **Tests:** add a case to `python/tests/test_parser_delivery_pdf.py` with
   the real text and rows from step 2, then run both test files and the JSON
   regression check (step 5 for JSON).
6. **Ship** with `ship-to-test`, then ask the user to upload the PDF in
   delivery import on the test environment. PDF reading is on `test_1` only:
   on 2026-09-23 the user sent the invoice picker to `main` without it (it
   brings `pdfplumber` to Railway). Carry a PDF change to `main` only when the
   user asks for that.

## A .docx delivery

Delivery import reads no `.docx` yet. First ask whether the same supplier also
sends JSON or a PDF invoice, which it already reads. If `.docx` is what there
is, build on `python/docx_reader.py`, the standard-library reader Add supplier
uses for supplier forms, rather than writing a second one: `read_docx` returns
the document as rows in reading order (table cells, form fields, checkboxes,
text boxes). It leaves out page headers and footers on purpose, because on a
form they hold the buyer's details; on an invoice they may hold the invoice
number, so check. Then treat it as a new format: its own parser into the same
`DeliveryOrder` and `DeliveryLine`s, checked against the totals the document
prints, with the JSON baseline and regression steps. The upload takes JSON,
`.txt` and PDF today, so a `.docx` also needs its way in, on the screen and in
the backend, as the PDF path got on 2026-09-22.
