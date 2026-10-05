"use client";

import { useMemo, useState } from "react";
import { CircleCheck, CircleAlert, MousePointerClick } from "lucide-react";

import { BarChart } from "@/components/tremor/BarChart";
import { LineChart, type TooltipProps } from "@/components/tremor/LineChart";
import { getColorClassName } from "@/components/tremor/chartUtils";
import { cn } from "@/lib/utils";
import { LogScatter } from "./charts";
import {
  Chip, EmptyState, LengthChips, Loadable, Panel, TooltipBox,
  api, dayLabeller, useAnalysis, useFetch,
} from "./shared";
import type { Elasticity, LengthPoint, Series } from "./types";

// Ceny: one product's price — over time by length, against stem length,
// and how demand answers it (elasticity, log-log, one length at a time).

export function PricesTab() {
  const { t, productId } = useAnalysis();
  if (!productId) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-surface">
        <EmptyState icon={MousePointerClick} text={t.pickProduct} />
      </div>
    );
  }
  return <ProductPrices />;
}

function ProductPrices() {
  const { t, fmt, start, end, customerId, productId, productLabel, tick } = useAnalysis();
  const params = { product_id: productId, start_date: start, end_date: end, customer_id: customerId };
  const trend = useFetch<{ series: Series[] }>(api("/bi-sync/price-trend-by-length", params), tick);
  const byLength = useFetch<{ points: LengthPoint[] }>(api("/bi-sync/price-vs-length", params), tick);
  const lengths = useFetch<{ lengths: number[] }>(api("/bi-sync/product-lengths", params), tick);
  const [elLength, setElLength] = useState("");
  const elasticity = useFetch<Elasticity>(api("/bi-sync/price-elasticity", { ...params, length: elLength }), tick);

  // Up to four lengths, the best-selling ones, in length order.
  const shown = useMemo(() => {
    const series = (trend.data?.series ?? []).filter(s => s.points.length);
    const volume = (s: Series) => s.points.reduce((a, p) => a + p.quantity, 0);
    const top = [...series].sort((a, b) => volume(b) - volume(a)).slice(0, 4);
    return series.filter(s => top.includes(s)).map(s => ({ ...s, label: `${s.key} cm` }));
  }, [trend.data]);
  const days = useMemo(() => Array.from(new Set(shown.flatMap(s => s.points.map(p => p.day)))).sort(), [shown]);
  const label = dayLabeller(fmt, days);
  const trendRows = days.map(day => {
    const row: Record<string, string | number | null> = { date: label(day), iso: day };
    for (const s of shown) {
      const p = s.points.find(x => x.day === day);
      row[s.label] = p?.value ?? null;
      row[`${s.label}::stems`] = p?.quantity ?? null;
    }
    return row;
  });

  const TrendTip = ({ active, payload }: TooltipProps) => {
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

  const lengthPoints = byLength.data?.points ?? [];
  const hasCost = lengthPoints.some(p => p.avg_supplier_price != null);
  const lengthRows = lengthPoints.map(p => ({
    length: `${p.length} cm`,
    [t.seriesSalePrice]: p.avg_price,
    ...(hasCost ? { [t.seriesCostPrice]: p.avg_supplier_price } : {}),
  }));

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={`${t.trendTitle} · ${productLabel}`}
        tip={t.trendTip}
        table={shown.length ? {
          headers: [t.day, ...shown.map(s => s.label)],
          rows: days.map(day => [fmt.dayLong(day), ...shown.map(s => fmt.price(s.points.find(p => p.day === day)?.value))]),
          alignRight: shown.map((_, i) => i + 1),
        } : null}
      >
        <Loadable q={trend} height="h-80" isEmpty={() => !shown.length}>
          {() => (
            <LineChart
              className="h-80"
              data={trendRows}
              index="date"
              categories={shown.map(s => s.label)}
              valueFormatter={v => fmt.price(v)}
              autoMinValue
              connectNulls
              yAxisWidth={68}
              legendPosition="left"
              onValueChange={() => undefined}
              customTooltip={TrendTip}
            />
          )}
        </Loadable>
      </Panel>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-5">
        <Panel
          className="xl:col-span-2"
          title={t.lengthTitle}
          tip={t.lengthTip}
          badge={hasCost ? <Chip tone="info" tip={t.notMarginTip}>{t.notMargin}</Chip> : null}
          table={lengthPoints.length ? {
            headers: [t.length, t.seriesSalePrice, t.seriesCostPrice, t.stems],
            rows: lengthPoints.map(p => [`${p.length} cm`, fmt.price(p.avg_price), fmt.price(p.avg_supplier_price), fmt.int(p.quantity)]),
            alignRight: [1, 2, 3],
          } : null}
        >
          <Loadable q={byLength} height="h-72" isEmpty={d => !d.points.length}>
            {() => (
              <BarChart
                className="h-72"
                data={lengthRows}
                index="length"
                categories={hasCost ? [t.seriesSalePrice, t.seriesCostPrice] : [t.seriesSalePrice]}
                colors={["emerald", "taupe"]}
                valueFormatter={v => fmt.price(v)}
                yAxisWidth={68}
                legendPosition="left"
              />
            )}
          </Loadable>
        </Panel>

        <Panel
          className="xl:col-span-3"
          title={t.elasticityTitle}
          tip={t.elasticityTip}
          actions={<LengthChips lengths={lengths.data?.lengths ?? []} value={elLength} onChange={setElLength} />}
        >
          <Loadable q={elasticity} height="h-72" isEmpty={d => !d.points.length}>
            {d => <ElasticityView data={d} />}
          </Loadable>
        </Panel>
      </div>
    </div>
  );
}

function ElasticityView({ data }: { data: Elasticity }) {
  const { t, fmt } = useAnalysis();
  const e = data.elasticity;
  const verdict = e == null ? null : e >= 0 ? "none" : e <= -1 ? "strong" : "weak";
  const range = data.price_range_pct != null ? fmt.pct(data.price_range_pct) : "—";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2">
          <span className={cn("text-3xl font-bold tabular-nums tracking-tight", data.reliable ? "text-ink" : "text-ink-3")}>
            {e != null ? fmt.two(e) : "—"}
          </span>
          <span className="text-xs text-ink-3">{t.elasticityValue}</span>
        </div>
        {data.reliable && verdict === "strong" && <Chip tone="warn">{t.verdictStrong}</Chip>}
        {data.reliable && verdict === "weak" && <Chip tone="good">{t.verdictWeak}</Chip>}
        {data.reliable && verdict === "none" && <Chip tone="neutral" tip={t.verdictNoneTip}>{t.verdictNone}</Chip>}
        {!data.reliable && (
          <Chip
            tone="neutral"
            icon={CircleAlert}
            tip={t.tooLittleDataTip(data.periods, data.min_periods, range, data.min_price_range_pct)}
          >
            {t.tooLittleData}
          </Chip>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-ink-3">
          <Condition ok={data.periods >= data.min_periods} text={t.weeksCount(data.periods)} />
          <Condition ok={(data.price_range_pct ?? 0) >= data.min_price_range_pct} text={t.priceRange(range)} />
          {data.r2 != null && <span className="tabular-nums">R² {fmt.two(data.r2)}</span>}
        </span>
      </div>
      <LogScatter
        points={data.points}
        elasticity={data.elasticity}
        intercept={data.intercept}
        formatPrice={v => fmt.price(v)}
        formatStems={v => fmt.compact(v)}
        formatPeriod={iso => fmt.dayLong(iso)}
        xLabel={t.axisPriceLog}
        yLabel={t.axisStemsLog}
        excludedLabel={t.excludedWeek}
      />
      <div className="flex flex-wrap gap-4 text-xs text-ink-3">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-emerald" />{t.weeksCount(data.periods)}</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-taupe" />{t.excludedWeek}</span>
        {data.elasticity != null && <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-ink" />{t.elasticityValue} {fmt.two(data.elasticity)}</span>}
      </div>
    </div>
  );
}

function Condition({ ok, text }: { ok: boolean; text: string }) {
  const Icon = ok ? CircleCheck : CircleAlert;
  return (
    <span className={cn("inline-flex items-center gap-1 tabular-nums", ok ? "text-emerald-dark" : "text-ink-3")}>
      <Icon className="size-3.5" />{text}
    </span>
  );
}
