"use client";

import { useMemo, useState } from "react";
import { History } from "lucide-react";

import { BarChart, type TooltipProps as BarTooltipProps } from "@/components/tremor/BarChart";
import { LineChart } from "@/components/tremor/LineChart";
import { getColorClassName, type AvailableChartColorsKeys } from "@/components/tremor/chartUtils";
import { Chip, Loadable, Panel, Segmented, TooltipBox, api, useAnalysis, useFetch } from "./shared";
import type { EventImpact, Seasonality } from "./types";

// Sezon: the year's shape and the holidays' lift. Both read the whole synced
// history, whatever the period above says — seasonality needs whole years.

type Metric = "quantity" | "price";

/** Newest year in emerald, older ones stepping back. */
const YEAR_COLORS: AvailableChartColorsKeys[] = ["emerald", "ink", "brick", "taupe"];

function yearColors(years: string[]): AvailableChartColorsKeys[] {
  return years.map((_, i) => YEAR_COLORS[Math.min(years.length - 1 - i, YEAR_COLORS.length - 1)]);
}

export function SeasonTab() {
  const { t, fmt, customerId, productId, productLabel, tick } = useAnalysis();
  const params = { product_id: productId, customer_id: customerId };
  const season = useFetch<Seasonality>(api("/bi-sync/seasonality", params), tick);
  const events = useFetch<EventImpact>(api("/bi-sync/event-impact", params), tick);
  const [metric, setMetric] = useState<Metric>("quantity");
  const [eventMetric, setEventMetric] = useState<Metric>("quantity");

  const history = <Chip icon={History} tip={t.wholeHistoryTip}>{t.wholeHistory}</Chip>;
  const scopeLabel = productId ? ` · ${productLabel}` : "";

  const seasonChart = useMemo(() => {
    const years = (season.data?.years ?? []).slice(-4);
    const names = years.map(y => String(y.year));
    const rows = t.months.map((m, i) => {
      const row: Record<string, string | number | null> = { month: m };
      for (const y of years) {
        const point = y.months.find(p => p.month === i + 1);
        row[String(y.year)] = point ? (metric === "quantity" ? point.quantity : point.price) : null;
      }
      return row;
    });
    return { names, rows };
  }, [season.data, metric, t.months]);

  const eventChart = useMemo(() => {
    const list = events.data?.events ?? [];
    const years = Array.from(new Set(list.flatMap(e => e.years.map(y => y.year)))).sort().slice(-4).map(String);
    const coverage = new Map<string, string>();
    const values: number[] = [];
    const rows = list.map(e => {
      const name = t.eventNames[e.event] ?? e.event;
      const row: Record<string, string | number | null> = { event: name };
      for (const y of e.years) {
        const v = eventMetric === "quantity" ? y.volume_lift_pct : y.price_lift_pct;
        row[String(y.year)] = v;
        if (v != null) values.push(v);
        coverage.set(`${name}|${y.year}`, t.eventCoverage(String(y.event_days), String(y.baseline_days)));
      }
      return row;
    });
    const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
    const pad = (hi - lo) * 0.1 || 5;
    return { years, rows, coverage, min: lo < 0 ? lo - pad : 0, max: hi + pad };
  }, [events.data, eventMetric, t]);

  const EventTip = ({ active, payload, label }: BarTooltipProps) => {
    if (!active || !payload?.length) return null;
    return (
      <TooltipBox
        title={label}
        rows={payload.filter(p => p.value != null).map(p => ({
          color: getColorClassName(p.color, "bg"),
          label: `${p.category} · ${eventChart.coverage.get(`${label}|${p.category}`) ?? ""}`,
          value: fmt.signedPct(p.value),
        }))}
      />
    );
  };

  const metricItems = [
    { value: "quantity" as Metric, label: t.metricStems },
    { value: "price" as Metric, label: t.metricPrice },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={`${t.seasonalityTitle}${scopeLabel}`}
        tip={t.seasonalityTip}
        badge={history}
        actions={<Segmented<Metric> label={t.seasonalityTitle} value={metric} onChange={setMetric} items={metricItems} />}
        table={seasonChart.names.length ? {
          headers: ["", ...seasonChart.names],
          rows: seasonChart.rows.map(r => [String(r.month), ...seasonChart.names.map(n => {
            const v = r[n] as number | null;
            return v == null ? "—" : metric === "quantity" ? fmt.int(v) : fmt.price(v);
          })]),
          alignRight: seasonChart.names.map((_, i) => i + 1),
        } : null}
      >
        <Loadable q={season} height="h-80" isEmpty={d => !d.years.length}>
          {() => (
            <LineChart
              className="h-80"
              data={seasonChart.rows}
              index="month"
              categories={seasonChart.names}
              colors={yearColors(seasonChart.names)}
              valueFormatter={v => (metric === "quantity" ? fmt.compact(v) : fmt.price(v))}
              autoMinValue={metric === "price"}
              yAxisWidth={68}
              legendPosition="left"
              onValueChange={() => undefined}
            />
          )}
        </Loadable>
      </Panel>

      <Panel
        title={`${t.eventsTitle}${scopeLabel}`}
        tip={t.eventsTip}
        badge={history}
        actions={<Segmented<Metric> label={t.eventsTitle} value={eventMetric} onChange={setEventMetric} items={metricItems} />}
      >
        <Loadable q={events} height="h-72" isEmpty={d => !d.events.length}>
          {() => (
            <BarChart
              className="h-72"
              data={eventChart.rows}
              index="event"
              categories={eventChart.years}
              colors={yearColors(eventChart.years)}
              valueFormatter={v => fmt.signedPct(v)}
              minValue={eventChart.min}
              maxValue={eventChart.max}
              yAxisWidth={60}
              legendPosition="left"
              customTooltip={EventTip}
            />
          )}
        </Loadable>
      </Panel>
    </div>
  );
}
