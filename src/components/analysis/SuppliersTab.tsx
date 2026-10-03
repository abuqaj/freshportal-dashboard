"use client";

import { useState } from "react";
import { MousePointerClick } from "lucide-react";

import { DivergingBars, RankBars } from "./charts";
import {
  Chip, EmptyState, LengthChips, Loadable, Panel, Segmented,
  api, useAnalysis, useFetch,
} from "./shared";
import type { Deviation, SupplierPrice, Volatility } from "./types";

// Dostawcy: who sells a product cheapest, whose prices hold still, and who
// sells dearer or cheaper than the rest for the same product and length.
// The last two can look at one product or at each supplier's whole range.

type Scope = "product" | "all";

export function SuppliersTab() {
  const { t, fmt, start, end, customerId, productId, productLabel, tick } = useAnalysis();
  const [length, setLength] = useState("");
  const [scopeChoice, setScope] = useState<Scope>("product");
  const scope: Scope = productId ? scopeChoice : "all";
  const scoped = scope === "product" ? productId : null;

  const lengths = useFetch<{ lengths: number[] }>(
    productId ? api("/bi-sync/product-lengths", { product_id: productId, start_date: start, end_date: end, customer_id: customerId }) : null, tick);
  const comparison = useFetch<{ points: SupplierPrice[] }>(
    productId ? api("/bi-sync/supplier-price-comparison", { product_id: productId, start_date: start, end_date: end, length, customer_id: customerId }) : null, tick);
  const volatility = useFetch<Volatility>(api("/bi-sync/supplier-volatility", { start_date: start, end_date: end, product_id: scoped, customer_id: customerId }), tick);
  const deviation = useFetch<Deviation>(api("/bi-sync/supplier-market-deviation", { start_date: start, end_date: end, product_id: scoped, customer_id: customerId }), tick);

  const shownOf = (d: { points: unknown[]; total_suppliers?: number; excluded?: number } | null) =>
    d?.excluded ? <Chip tone="info" tip={t.shownOfTip}>{t.shownOf(fmt.int(d.points.length), fmt.int(d.total_suppliers ?? 0))}</Chip> : null;

  const scopeToggle = (
    <Segmented<Scope>
      label={t.scope}
      value={scope}
      onChange={setScope}
      items={[
        { value: "product", label: t.scopeProduct, disabled: !productId, tip: t.scopeTip },
        { value: "all", label: t.scopeAll, tip: t.scopeTip },
      ]}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={productId ? `${t.comparisonTitle} · ${productLabel}` : t.comparisonTitle}
        tip={t.comparisonTip}
        actions={productId ? <LengthChips lengths={lengths.data?.lengths ?? []} value={length} onChange={setLength} /> : null}
        table={comparison.data?.points.length ? {
          headers: [t.colSupplier, t.pricePerStem, "min", "max", t.stems],
          rows: comparison.data.points.map(p => [p.name, fmt.price(p.avg_price), fmt.price(p.min_price), fmt.price(p.max_price), fmt.int(p.quantity)]),
          alignRight: [1, 2, 3, 4],
        } : null}
      >
        {!productId ? <EmptyState icon={MousePointerClick} text={t.pickProduct} /> : (
          <Loadable q={comparison} height="h-56" isEmpty={d => !d.points.length}>
            {d => (
              <RankBars
                rows={d.points.map(p => ({
                  key: p.supplier_id,
                  label: p.name,
                  value: p.avg_price,
                  sub: `${fmt.price(p.min_price)} – ${fmt.price(p.max_price)}`,
                  extra: fmt.int(p.quantity),
                }))}
                format={v => fmt.price(v)}
                valueHeader={t.pricePerStem}
                extraHeader={t.stems}
              />
            )}
          </Loadable>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title={t.volatilityTitle}
          tip={t.volatilityTip}
          badge={shownOf(volatility.data)}
          actions={scopeToggle}
          table={volatility.data?.points.length ? {
            headers: [t.colSupplier, "CV", t.pricePerStem, t.lines],
            rows: volatility.data.points.map(p => [p.name, fmt.pct(p.cv_pct), fmt.price(p.avg_price), fmt.int(p.line_count)]),
            alignRight: [1, 2, 3],
          } : null}
        >
          <Loadable q={volatility} height="h-64" isEmpty={d => !d.points.length}>
            {d => (
              <RankBars
                rows={d.points.map(p => ({
                  key: p.supplier_id,
                  label: p.name,
                  value: p.cv_pct ?? 0,
                  sub: fmt.price(p.avg_price),
                  extra: fmt.int(p.line_count),
                }))}
                format={v => fmt.pct(v)}
                valueHeader="CV"
                extraHeader={t.lines}
              />
            )}
          </Loadable>
        </Panel>

        <Panel
          title={t.deviationTitle}
          tip={t.deviationTip}
          badge={shownOf(deviation.data)}
          actions={scopeToggle}
          table={deviation.data?.points.length ? {
            headers: [t.colSupplier, "±", t.pricePerStem, t.lines],
            rows: deviation.data.points.map(p => [p.name, fmt.signedPct(p.deviation_pct), fmt.price(p.avg_price), fmt.int(p.line_count)]),
            alignRight: [1, 2, 3],
          } : null}
        >
          <Loadable q={deviation} height="h-64" isEmpty={d => !d.points.length}>
            {d => (
              <DivergingBars
                rows={d.points.map(p => ({
                  key: p.supplier_id,
                  label: p.name,
                  value: p.deviation_pct,
                  sub: `${fmt.price(p.avg_price)} · ${fmt.int(p.line_count)}`,
                }))}
                format={v => fmt.signedPct(v)}
                aboveLabel={t.aboveMarket}
                belowLabel={t.belowMarket}
              />
            )}
          </Loadable>
        </Panel>
      </div>
    </div>
  );
}
