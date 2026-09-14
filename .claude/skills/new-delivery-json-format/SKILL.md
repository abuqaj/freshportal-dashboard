---
name: new-delivery-json-format
description: Handles a supplier delivery file (JSON or .txt) that delivery import cannot read or reads wrongly - checks it against the existing parsers and, when needed, adds a separate parser without changing the ones that work. Use when the user shares a delivery file in a new shape, or parsing fails ("nowy format JSON", "Invalid delivery JSON", "nie czyta tego JSONa").
---

# new-delivery-json-format

## Rules from the users

- **Working parsers must not change behaviour.** A new format gets its own
  parser rather than bending one that works.
- Suppliers send JSON inside `.txt` files too; that is accepted.
- **Identical per-box lines** are grouped into one line with a quantity.
- **Box content** = stems per bunch × bunches.
- **Packaging codes:** `QB` → `QBE`, `HB` → `HBE`.
- **Weight:** roses, and any weight above 100, send no weight.
- **Pomarosa's grower** comes from each product's `nm_location`.

## Formats that exist today

`parse_delivery_json` in `python/parser_delivery.py` detects them in this order:

| Detected by | Parser | Suppliers |
|---|---|---|
| single key holding the text of an INVOICE, value `null` | `_parse_text_invoice` | Fiorentina |
| `invoices` | `_parse_invoices_format` | Elite, Ecoroses, Alissroses |
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

## Steps

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
6. **Ship** with `ship-to-test`, then ask the user to upload the file in
   delivery import on the test environment. The API and matching steps cannot
   be run locally.
