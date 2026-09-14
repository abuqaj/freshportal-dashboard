---
name: verify-analysis-chart
description: Checks whether an Analysis Tool chart in freshportal-dashboard tells the truth - traces it from the screen to the endpoint, the SQL and the BI Sync tables, explains the formula in plain words, and produces a query that checks one data point independently. Use when the user doubts a chart, asks where its business logic is, or sees an implausible number ("czy formula jest poprawna", "gdzie jest logika biznesowa", "to jest absurdalne").
---

# verify-analysis-chart

## Steps

1. **Find the endpoint.** In `src/components/AnalysisTool.tsx`, every chart
   loads through `api("/bi-sync/<name>", …)`. Match the chart the user means
   to its `<name>`.
2. **Trace it:**
   `python .claude/skills/verify-analysis-chart/scripts/trace_chart.py <name>`
   This lists the screen lines, the API function, and the `db.py` functions,
   helpers and `bi_*` tables. Read every listed range in full.
3. **Explain the formula** in plain words, with file:line links: what is
   summed or averaged, which rows are in or out (customer, dates, lengths,
   types), and how missing periods are handled.
4. **Check the data traps below.** Every one of them has already produced a
   wrong chart.
5. **Check one real point.** Take a concrete value: the user's tooltip, or the
   endpoint's JSON from the browser's Network tab. Write one SQL query that
   recomputes it **independently**; do not copy the function's own SQL. The
   database is reachable only from Railway and Neon, not from this machine,
   so ask the user to run the query in the Neon SQL editor, then compare.
6. **Give a verdict:** correct, or wrong with the evidence. If it is wrong,
   propose the fix and make it, unless the user only asked for an explanation.
   Ship with `ship-to-test`.

## Data traps

- **Customer scope.** Charts start on customer 12 (OZEDS). Webshop prices are
  per customer, so a price across "all customers" mixes price lists; volumes
  are safe across customers. Customer 160 is excluded at ingest, and lines
  whose invoice has no customer are dropped. Rows ingested before 2026-09-09
  hold customer 12 only.
- **Gaps are not zeros.** Whole months are missing because users deleted
  records in FreshPortal. A missing period must show as a gap. Seasonality
  skips incomplete months, and a holiday is compared only when ordinary days
  exist on both sides of it. A volume of 0 is suspicious: "we always sell
  something".
- **Mutation vs creation.** The export returns everything *changed* since the
  date. The sales date is the order line's `creation_date_time`, which the
  export writes day-first.
- **Lot types.** `bi_stock_entry_dim` holds only offer and limited-offer lots
  (types 4 and 5). Sold lines point at *standard* lots, so take product names
  from `bi_products` and lengths from `bi_order_lines`, never through the dim.
- **What order_line carries.** It has its own `product_id` and `supplier_id`.
  `manufacturer_id` (grower) and `length` come from the source `stock_entry`.
- **Price is not margin.** `store_price` is the only real sale price.
  `supplier_price` is the purchase price of the goods alone, not the full
  cost. Real costs live in `customer_stock_item_commission`, which is not
  synced, so the chart shows a spread, never a "margin".
- **Old rows keep old bugs.** A fix to the sync does not repair rows already
  stored. Only re-syncing that date range does.
