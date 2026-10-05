"use client";

import { useMemo, useState } from "react";
import { CalendarClock, MousePointerClick } from "lucide-react";

import { BarChart, type TooltipProps as BarTooltipProps } from "@/components/tremor/BarChart";
import { LineChart } from "@/components/tremor/LineChart";
import { cn } from "@/lib/utils";
import { DeviationHistogram } from "./charts";
import {
  Chip, EmptyState, Loadable, Panel, Segmented, TooltipBox,
  api, dayLabeller, useAnalysis, useFetch,
} from "./shared";
import type { OfferDaily, OfferVsSale, PriceMatch } from "./types";

// Oferta: what was online, at what price, and whether it sold at that price
// (bi_offer_states, recorded since 2026-09-25). Days before the recording
// began are not drawn at all: the export cannot rebuild them.

type Metric = "lots" | "stems";

/** "Since 25 Sep" — where the offer history starts, said once per panel. */
export function SinceChip({ iso }: { iso: string | null | undefined }) {
  const { t, fmt } = useAnalysis();
  if (!iso) return null;
  return <Chip icon={CalendarClock} tip={t.sinceRecordedTip}>{t.sinceRecorded(fmt.day(iso))}</Chip>;
}

export function OfferTab() {
  const { t, fmt, start, end, productId, productLabel, tick } = useAnalysis();
  const daily = useFetch<OfferDaily>(api("/bi-sync/offer-daily", { start_date: start, end_date: end, product_id: productId }), tick);
  const match = useFetch<PriceMatch>(api("/bi-sync/offer-price-match", { start_date: start, end_date: end, product_id: productId }), tick);
  const vs = useFetch<OfferVsSale>(productId ? api("/bi-sync/offer-vs-sale", { product_id: productId, start_date: start, end_date: end }) : null, tick);
  const [metric, setMetric] = useState<Metric>("lots");

  const dataFrom = daily.data?.data_from ?? match.data?.data_from ?? null;
  const days = daily.data?.days ?? [];
  const label = dayLabeller(fmt, days.map(d => d.day));
  const series = metric === "lots" ? t.lotsOnline : t.stemsOnline;
  const onlineData = days.map(d => ({ date: label(d.day), iso: d.day, [series]: d[metric], soldOut: d.sold_out, lots: d.lots, stems: d.stems }));

  const OnlineTip = ({ active, payload }: BarTooltipProps) => {
    if (!active || !payload?.length) return null;
    const row = payload[0].payload as { iso: string; lots: number; stems: number; soldOut: number };
    return (
      <TooltipBox
        title={fmt.dayLong(row.iso)}
        rows={[
          { color: metric === "lots" ? "bg-emerald" : undefined, label: t.lotsOnline, value: fmt.int(row.lots) },
          { color: metric === "stems" ? "bg-emerald" : undefined, label: t.stemsOnline, value: fmt.int(row.stems) },
          { label: t.soldOutToday, value: fmt.int(row.soldOut), muted: true },
        ]}
      />
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title={productId ? `${t.offerOnline} · ${productLabel}` : t.offerOnline}
          tip={t.offerOnlineTip}
          badge={<SinceChip iso={dataFrom} />}
          actions={
            <Segmented<Metric>
              label={t.offerOnline}
              value={metric}
              onChange={setMetric}
              items={[{ value: "lots", label: t.metricLots }, { value: "stems", label: t.metricStems }]}
            />
          }
          table={days.length ? {
            headers: [t.day, t.lotsOnline, t.stemsOnline, t.soldOutToday],
            rows: days.map(d => [fmt.dayLong(d.day), fmt.int(d.lots), fmt.int(d.stems), fmt.int(d.sold_out)]),
            alignRight: [1, 2, 3],
          } : null}
        >
          <Loadable q={daily} height="h-64" isEmpty={d => !d.days.length}>
            {() => (
              <BarChart
                className="h-64"
                data={onlineData}
                index="date"
                categories={[series]}
                colors={["emerald"]}
                valueFormatter={v => fmt.compact(v)}
                allowDecimals={false}
                showLegend={false}
                yAxisWidth={52}
                customTooltip={OnlineTip}
              />
            )}
          </Loadable>
        </Panel>

        <Panel title={productId ? `${t.priceMatch} · ${productLabel}` : t.priceMatch} tip={t.priceMatchTip} badge={<SinceChip iso={dataFrom} />}>
          <Loadable q={match} height="h-64" isEmpty={d => !d.lines}>
            {d => (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-3 gap-2">
                  <Share label={t.atOffer} value={fmt.pct(d.at_offer_pct)} dot="bg-emerald" strong />
                  <Share label={t.belowOffer} value={fmt.pct(d.below_pct)} dot="bg-brick" />
                  <Share label={t.aboveOffer} value={fmt.pct(d.above_pct)} dot="bg-taupe" />
                </div>
                <DeviationHistogram
                  bins={d.bins}
                  formatStems={v => fmt.int(v)}
                  binTip={(c, s) => t.centsBinTip(c, s)}
                  edgeLabels={t.centsEdges}
                />
                <p className="text-center text-[11px] text-ink-3">{t.centsAxis}</p>
              </div>
            )}
          </Loadable>
        </Panel>
      </div>

      <Panel
        title={productId ? `${t.offerVsSale} · ${productLabel}` : t.offerVsSale}
        tip={t.offerVsSaleTip}
        badge={<SinceChip iso={vs.data?.data_from ?? dataFrom} />}
      >
        {!productId ? (
          <EmptyState icon={MousePointerClick} text={t.pickProduct} />
        ) : (
          <Loadable q={vs} height="h-64" isEmpty={d => !d.lengths.length}>
            {d => <OfferVsSaleGrid data={d} />}
          </Loadable>
        )}
      </Panel>
    </div>
  );
}

function Share({ label, value, dot, strong }: { label: string; value: string; dot: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-xl border px-3 py-2", strong ? "border-sage bg-sage/30" : "border-muted")}>
      <div className="flex items-center gap-1.5 text-[11px] text-ink-3"><span className={cn("size-2 rounded-full", dot)} />{label}</div>
      <div className={cn("mt-0.5 text-lg font-bold tabular-nums", strong ? "text-emerald-dark" : "text-ink")}>{value}</div>
    </div>
  );
}

/** One small chart per length on one shared price scale, so lengths compare
 *  by position as well as side by side (small multiples, Datawrapper). */
function OfferVsSaleGrid({ data }: { data: OfferVsSale }) {
  const { t, fmt } = useAnalysis();
  const { min, max } = useMemo(() => {
    const values = data.lengths.flatMap(l => l.points.flatMap(p => [p.offer, p.sale])).filter((v): v is number => v != null);
    const lo = Math.min(...values), hi = Math.max(...values);
    const pad = (hi - lo) * 0.1 || 0.02;
    return { min: Math.max(0, lo - pad), max: hi + pad };
  }, [data]);
  const allDays = Array.from(new Set(data.lengths.flatMap(l => l.points.map(p => p.day)))).sort();
  const label = dayLabeller(fmt, allDays);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5"><span className="h-[3px] w-4 rounded-full bg-taupe" />{t.seriesOffer}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-[3px] w-4 rounded-full bg-emerald" />{t.seriesSale}</span>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 2xl:grid-cols-3">
        {data.lengths.map(l => {
          const byDay = new Map(l.points.map(p => [p.day, p]));
          const rows = allDays.map(day => ({
            date: label(day),
            [t.seriesOffer]: byDay.get(day)?.offer ?? null,
            [t.seriesSale]: byDay.get(day)?.sale ?? null,
          }));
          return (
            <div key={l.length} className="min-w-0 rounded-xl border border-muted p-3">
              <div className="mb-1 text-xs font-semibold text-ink">{l.length} cm</div>
              <LineChart
                className="h-40"
                data={rows}
                index="date"
                categories={[t.seriesOffer, t.seriesSale]}
                colors={["taupe", "emerald"]}
                valueFormatter={v => fmt.price(v)}
                minValue={min}
                maxValue={max}
                showLegend={false}
                connectNulls
                yAxisWidth={64}
                startEndOnly={rows.length > 1}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
