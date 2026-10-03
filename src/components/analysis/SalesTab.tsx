"use client";

import { useEffect, useMemo, useState } from "react";
import { Highlighter, Package, Truck } from "lucide-react";

import { BarList } from "@/components/tremor/BarList";
import { LineChart, type TooltipProps } from "@/components/tremor/LineChart";
import { getColorClassName, type AvailableChartColorsKeys } from "@/components/tremor/chartUtils";
import {
  Combobox, LengthChips, Loadable, Panel, Segmented, TooltipBox,
  api, dayLabeller, useAnalysis, useFetch, type PickerItem,
} from "./shared";
import type { Series, TopProduct } from "./types";

// Sprzedaż: the sale price per stem over time, by supplier, product or
// customer. Without a selection it shows the biggest ones; picking one
// drills in. Four lines at most — beyond that a line chart turns into
// spaghetti (Data to Viz) — and one can be put in focus, the rest in taupe.

type Mode = "supplier" | "product" | "customer";
type Rank = "quantity" | "value";
const MAX_LINES = 4;

export function SalesTab() {
  const { t, fmt, start, end, customerId, products, tick, salesSeed, clearSalesSeed } = useAnalysis();
  const [mode, setMode] = useState<Mode>("supplier");
  const [primary, setPrimary] = useState("");
  const [length, setLength] = useState("");
  const [focus, setFocus] = useState("");
  const [rank, setRank] = useState<Rank>("quantity");

  // Arriving from the overview with a supplier picked.
  useEffect(() => {
    if (!salesSeed?.supplierId) return;
    setMode("supplier");
    setPrimary(salesSeed.supplierId);
    clearSalesSeed();
  }, [salesSeed, clearSalesSeed]);

  const suppliers = useFetch<{ suppliers: { supplier_id: string; name: string | null; row_count: number }[] }>(
    api("/bi-sync/suppliers", { limit: 200, start_date: start, end_date: end, customer_id: customerId }), tick);
  const supplierItems: PickerItem[] = (suppliers.data?.suppliers ?? []).map(s => ({ value: s.supplier_id, label: s.name || s.supplier_id, meta: fmt.int(s.row_count) }));

  const lengths = useFetch<{ lengths: number[] }>(
    mode === "product" && primary ? api("/bi-sync/product-lengths", { product_id: primary, start_date: start, end_date: end, customer_id: customerId }) : null, tick);
  useEffect(() => { setLength(""); setFocus(""); }, [primary, mode]);

  const url = primary && mode !== "customer"
    ? api(`/bi-sync/${mode === "supplier" ? "sales-by-supplier" : "sales-by-product"}`, {
        [mode === "supplier" ? "supplier_id" : "product_id"]: primary,
        start_date: start, end_date: end, length: mode === "product" ? length : null, customer_id: customerId,
      })
    : api("/bi-sync/sales-overview", { group_by: mode, start_date: start, end_date: end, customer_id: customerId });
  const sales = useFetch<{ series: Series[] }>(url, tick);

  const top = useFetch<{ points: TopProduct[] }>(
    mode === "supplier" && primary
      ? api("/bi-sync/supplier-top-products", { supplier_id: primary, start_date: start, end_date: end, metric: rank, customer_id: customerId })
      : null, tick);

  const all = useMemo(() => (sales.data?.series ?? []).filter(s => s.points.length), [sales.data]);
  useEffect(() => { if (focus && !all.some(s => s.key === focus)) setFocus(""); }, [all, focus]);

  const shown = useMemo(() => {
    const first = all.slice(0, MAX_LINES);
    const f = all.find(s => s.key === focus);
    return f && !first.includes(f) ? [...first.slice(0, MAX_LINES - 1), f] : first;
  }, [all, focus]);

  // Labels must be unique: they are the chart's category keys.
  const names = useMemo(() => {
    const seen = new Map<string, number>();
    return new Map(shown.map(s => {
      const n = (seen.get(s.label) ?? 0) + 1;
      seen.set(s.label, n);
      return [s.key, n > 1 ? `${s.label} (${s.key})` : s.label];
    }));
  }, [shown]);

  const days = useMemo(() => Array.from(new Set(shown.flatMap(s => s.points.map(p => p.day)))).sort(), [shown]);
  const label = dayLabeller(fmt, days);
  const rows = useMemo(() => days.map(day => {
    const row: Record<string, string | number | null> = { date: label(day), iso: day };
    for (const s of shown) {
      const p = s.points.find(x => x.day === day);
      row[names.get(s.key)!] = p?.value ?? null;
      row[`${names.get(s.key)}::stems`] = p?.quantity ?? null;
    }
    return row;
  }), [days, shown, names, label]);

  const categories = shown.map(s => names.get(s.key)!);
  const colors: AvailableChartColorsKeys[] | undefined = focus
    ? shown.map(s => (s.key === focus ? "emerald" : "taupe"))
    : undefined;

  const SalesTip = ({ active, payload }: TooltipProps) => {
    if (!active || !payload?.length) return null;
    const iso = (payload[0].payload as { iso: string }).iso;
    return (
      <TooltipBox
        title={fmt.dayLong(iso)}
        rows={payload.filter(p => p.value != null).map(p => ({
          color: getColorClassName(p.color, "bg"),
          label: p.category,
          value: `${fmt.price(p.value)} · ${fmt.compact((p.payload as Record<string, number>)[`${p.category}::stems`])}`,
        }))}
      />
    );
  };

  const entityItems = mode === "supplier" ? supplierItems : products;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={t.salesTitle}
        tip={t.salesTip}
        actions={
          <>
            <Segmented<Mode>
              label={t.salesTitle}
              value={mode}
              onChange={m => { setMode(m); setPrimary(""); }}
              items={[
                { value: "supplier", label: t.bySupplier },
                { value: "product", label: t.byProduct },
                { value: "customer", label: t.byCustomer },
              ]}
            />
            {mode !== "customer" && (
              <Combobox
                label={mode === "supplier" ? t.bySupplier : t.byProduct}
                icon={mode === "supplier" ? Truck : Package}
                items={entityItems}
                value={primary}
                onChange={setPrimary}
                allLabel={mode === "supplier" ? t.topSuppliersAll : t.topProductsAll}
                className="w-56"
              />
            )}
            {all.length > 1 && (
              <Combobox
                label={t.highlight}
                icon={Highlighter}
                items={all.map(s => ({ value: s.key, label: s.label }))}
                value={focus}
                onChange={setFocus}
                allLabel={t.noHighlight}
                className="w-48"
              />
            )}
          </>
        }
        table={shown.length ? {
          headers: [t.day, ...categories],
          rows: days.map(day => [fmt.dayLong(day), ...shown.map(s => fmt.price(s.points.find(p => p.day === day)?.value))]),
          alignRight: categories.map((_, i) => i + 1),
        } : null}
      >
        {mode === "product" && primary && (
          <LengthChips lengths={lengths.data?.lengths ?? []} value={length} onChange={setLength} />
        )}
        <Loadable q={sales} height="h-80" isEmpty={() => !shown.length}>
          {() => (
            <LineChart
              className="h-80"
              data={rows}
              index="date"
              categories={categories}
              colors={colors}
              valueFormatter={v => fmt.price(v)}
              autoMinValue
              connectNulls
              yAxisWidth={68}
              legendPosition="left"
              onValueChange={() => undefined}
              customTooltip={SalesTip}
            />
          )}
        </Loadable>
      </Panel>

      {mode === "supplier" && primary && (
        <Panel
          title={t.supplierBest}
          tip={t.supplierBestTip}
          actions={
            <Segmented<Rank>
              label={t.supplierBest}
              value={rank}
              onChange={setRank}
              items={[{ value: "quantity", label: t.metricStems }, { value: "value", label: t.metricValue }]}
            />
          }
          table={top.data?.points.length ? {
            headers: [t.colProduct, t.metricStems, t.metricValue, t.lines],
            rows: top.data.points.map(p => [p.label, fmt.int(p.quantity), fmt.money(p.value), fmt.int(p.line_count)]),
            alignRight: [1, 2, 3],
          } : null}
        >
          <Loadable q={top} height="h-56" isEmpty={d => !d.points.length}>
            {d => (
              <BarList
                data={d.points.map(p => ({ key: p.product_id, name: p.label, value: rank === "quantity" ? p.quantity : p.value }))}
                valueFormatter={v => (rank === "quantity" ? fmt.int(v) : fmt.money(v))}
              />
            )}
          </Loadable>
        </Panel>
      )}
    </div>
  );
}
