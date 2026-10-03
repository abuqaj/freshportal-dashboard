"use client";

import { useMemo, useState } from "react";
import { Euro, Flower2, Store, Tag } from "lucide-react";

import { AreaChart, type TooltipProps } from "@/components/tremor/AreaChart";
import { BarList } from "@/components/tremor/BarList";
import {
  KpiCard, Delta, Loadable, Panel, Segmented, TooltipBox,
  addDays, api, dayLabeller, eachDay, isoDay, useAnalysis, useFetch,
} from "./shared";
import type { OfferDaily, Overview } from "./types";

// Przegląd: the period at a glance — four headline figures against the
// period before, sales per day, and the products and suppliers that sold
// most. Rows and the offer tile lead on to the tab that explains them.

type Metric = "stems" | "value";

export function OverviewTab() {
  const { t, fmt, start, end, customerId, tick, setProductId, goTo } = useAnalysis();
  const today = isoDay(new Date());
  const ov = useFetch<Overview>(api("/bi-sync/overview", { start_date: start, end_date: end, customer_id: customerId }), tick);
  const offer = useFetch<OfferDaily>(api("/bi-sync/offer-daily", { start_date: addDays(today, -13), end_date: today }), tick);
  const [metric, setMetric] = useState<Metric>("stems");

  const cur = ov.data?.current ?? null;
  const prev = ov.data?.previous ?? null;
  const prevRange = ov.data?.previous_range;
  const deltaTip = prevRange ? t.vsPrevious(`${fmt.day(prevRange[0])} – ${fmt.day(prevRange[1])}`) : undefined;
  const change = (a?: number | null, b?: number | null) => (a != null && b ? ((a - b) / b) * 100 : null);

  const days = useMemo(() => eachDay(start, end), [start, end]);
  const byDay = useMemo(() => new Map((ov.data?.daily ?? []).map(d => [d.day, d])), [ov.data]);
  const label = dayLabeller(fmt, days);
  const series = metric === "stems" ? t.metricStems : t.metricValue;
  // Every day of the range, a gap where nothing was synced: a missing day
  // is unknown, and a line drawn straight across it would invent sales.
  const chartData = days.map(d => ({ date: label(d), iso: d, [series]: byDay.get(d)?.[metric] ?? null }));
  const spark = (key: Metric) => days.map(d => ({ x: d, v: byDay.get(d)?.[key] ?? null }));

  const todayOffer = offer.data?.days.find(d => d.day === today) ?? null;
  const fmtMetric = (v: number) => (metric === "stems" ? fmt.int(v) : fmt.money(v));

  const DailyTip = ({ active, payload }: TooltipProps) => {
    if (!active || !payload?.length) return null;
    const p = payload[0];
    const row = p.payload as { iso: string };
    return <TooltipBox title={fmt.dayLong(row.iso)} rows={[{ color: "bg-emerald", label: p.category, value: fmtMetric(p.value) }]} />;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={Flower2}
          label={t.kpiStems}
          value={fmt.compact(cur?.stems)}
          exact={fmt.int(cur?.stems)}
          delta={<Delta value={change(cur?.stems, prev?.stems)} tip={deltaTip} />}
          spark={{ data: spark("stems") }}
        />
        <KpiCard
          icon={Euro}
          label={t.kpiValue}
          value={fmt.moneyCompact(cur?.value)}
          exact={fmt.money(cur?.value)}
          delta={<Delta value={change(cur?.value, prev?.value)} tip={deltaTip} />}
          spark={{ data: spark("value") }}
        />
        <KpiCard
          icon={Tag}
          label={t.kpiPrice}
          tip={t.kpiPriceTip}
          value={fmt.price(cur?.price)}
          delta={<Delta value={change(cur?.price, prev?.price)} upIsGood={null} tip={deltaTip} />}
        />
        <KpiCard
          icon={Store}
          label={t.kpiOnline}
          tip={t.kpiOnlineTip}
          value={todayOffer ? fmt.int(todayOffer.lots) : "—"}
          sub={todayOffer ? t.kpiOnlineSub(fmt.compact(todayOffer.stems), fmt.int(todayOffer.sold_out)) : null}
          spark={offer.data?.days.length ? { data: offer.data.days.map(d => ({ x: d.day, v: d.lots })) } : null}
          onClick={() => goTo("offer")}
        />
      </div>

      <Panel
        title={t.dailySales}
        tip={t.dailySalesTip}
        actions={
          <Segmented<Metric>
            label={t.dailySales}
            value={metric}
            onChange={setMetric}
            items={[{ value: "stems", label: t.metricStems }, { value: "value", label: t.metricValue }]}
          />
        }
        table={ov.data ? {
          headers: [t.day, t.metricStems, t.metricValue],
          rows: (ov.data.daily ?? []).map(d => [fmt.dayLong(d.day), fmt.int(d.stems), fmt.money(d.value)]),
          alignRight: [1, 2],
        } : null}
      >
        <Loadable q={ov} height="h-72" isEmpty={d => !d.daily.length}>
          {() => (
            <AreaChart
              className="h-72"
              data={chartData}
              index="date"
              categories={[series]}
              colors={["emerald"]}
              valueFormatter={v => (metric === "stems" ? fmt.compact(v) : fmt.moneyCompact(v))}
              showLegend={false}
              yAxisWidth={64}
              customTooltip={DailyTip}
            />
          )}
        </Loadable>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t.topProducts} tip={t.topProductsTip}>
          <Loadable q={ov} height="h-56" isEmpty={d => !d.top_products.length}>
            {d => (
              <BarList
                data={d.top_products.map(p => ({ key: p.key, name: p.label, value: p.stems }))}
                valueFormatter={v => fmt.int(v)}
                onValueChange={item => { setProductId(item.key ?? ""); goTo("prices"); }}
              />
            )}
          </Loadable>
        </Panel>
        <Panel title={t.topSuppliers} tip={t.topSuppliersTip}>
          <Loadable q={ov} height="h-56" isEmpty={d => !d.top_suppliers.length}>
            {d => (
              <BarList
                data={d.top_suppliers.map(p => ({ key: p.key, name: p.label, value: p.stems }))}
                valueFormatter={v => fmt.int(v)}
                onValueChange={item => goTo("sales", { supplierId: item.key })}
              />
            )}
          </Loadable>
        </Panel>
      </div>
    </div>
  );
}
