"use client";

import { useState } from "react";
import { CircleCheck } from "lucide-react";

import { DotStrip, ProgressRows } from "./charts";
import { SinceChip } from "./OfferTab";
import { Chip, DataTable, EmptyState, Loadable, Panel, Segmented, api, useAnalysis, useFetch } from "./shared";
import type { IdleLots, SelloutSpeed, SellThrough } from "./types";

// Rotacja: what came of the offer — how much of it sold (sell-through), how
// fast it sold out, and what sat online without a single sale. All of it
// rests on the offer recorded since 2026-09-25.

type Group = "product" | "supplier" | "length";
type MinDays = "3" | "5" | "7";

export function TurnoverTab() {
  const { t, fmt, start, end, tick } = useAnalysis();
  const [group, setGroup] = useState<Group>("product");
  const [minDays, setMinDays] = useState<MinDays>("3");
  const through = useFetch<SellThrough>(api("/bi-sync/sell-through", { start_date: start, end_date: end, group_by: group }), tick);
  const speed = useFetch<SelloutSpeed>(api("/bi-sync/sellout-speed", { start_date: start, end_date: end }), tick);
  const idle = useFetch<IdleLots>(api("/bi-sync/idle-lots", { start_date: start, end_date: end, min_days: minDays }), tick);
  const dataFrom = through.data?.data_from ?? speed.data?.data_from ?? idle.data?.data_from ?? null;

  const hours = (h: number) => t.hoursShort(h < 10 ? Math.round(h * 10) / 10 : Math.round(h));
  const groupLabel = group === "supplier" ? t.bySupplier : group === "length" ? t.byLength : t.byProduct;
  const idleCount = idle.data?.rows.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title={t.sellThrough}
          tip={t.sellThroughTip}
          badge={<>
            <SinceChip iso={dataFrom} />
            {through.data?.total?.pct != null && <Chip tone="good">{t.sellThroughTotal(fmt.pct(through.data.total.pct))}</Chip>}
          </>}
          actions={
            <Segmented<Group>
              label={t.sellThrough}
              value={group}
              onChange={setGroup}
              items={[
                { value: "product", label: t.byProduct },
                { value: "supplier", label: t.bySupplier },
                { value: "length", label: t.byLength },
              ]}
            />
          }
          table={through.data?.rows.length ? {
            headers: [groupLabel, t.sellThrough, t.stemsSoldOffered, t.soldOutLots],
            rows: through.data.rows.map(r => [r.label, fmt.pct(r.pct), t.soldOfOffered(fmt.int(r.sold), fmt.int(r.offered)), `${r.sold_out}/${r.listings}`]),
            alignRight: [1, 2, 3],
          } : null}
        >
          <Loadable q={through} height="h-72" isEmpty={d => !d.rows.length}>
            {d => (
              <ProgressRows
                // The 12 most offered, ranked by how much of them sold; the
                // rest stay in the table view.
                rows={d.rows.slice(0, 12).sort((a, b) => b.pct - a.pct).map(r => ({
                  key: r.key,
                  label: r.label,
                  pct: r.pct,
                  sub: t.soldOfOffered(fmt.compact(r.sold), fmt.compact(r.offered)),
                  extra: `${r.sold_out}/${r.listings}`,
                }))}
                formatPct={v => fmt.pct(v)}
                subHeader={t.stemsSoldOffered}
                extraHeader={t.soldOutLots}
              />
            )}
          </Loadable>
        </Panel>

        <Panel
          title={t.selloutSpeed}
          tip={t.selloutSpeedTip}
          badge={<SinceChip iso={dataFrom} />}
          table={speed.data?.products.length ? {
            headers: [t.colProduct, t.selloutSpeed, t.soldOutLots],
            rows: speed.data.products.map(p => [p.label, p.median_hours != null ? hours(p.median_hours) : "—", `${p.sold_out}/${p.listings}`]),
            alignRight: [1, 2],
          } : null}
        >
          <Loadable q={speed} height="h-72" isEmpty={d => !d.products.some(p => p.sold_out)}>
            {d => (
              <DotStrip
                rows={d.products.map(p => ({
                  key: p.product_id,
                  label: p.label,
                  hours: p.hours,
                  median: p.median_hours,
                  side: t.selloutSide(p.median_hours != null ? hours(p.median_hours) : "—", p.sold_out, p.listings),
                }))}
                hourLabel={h => `${h}`}
                dotTip={h => hours(h)}
              />
            )}
          </Loadable>
        </Panel>
      </div>

      <Panel
        title={t.idleLots}
        tip={t.idleLotsTip}
        badge={<>
          <SinceChip iso={dataFrom} />
          {idleCount > 0 && <Chip tone="warn">{idleCount >= 50 ? "50+" : fmt.int(idleCount)}</Chip>}
        </>}
        actions={
          <Segmented<MinDays>
            label={t.idleLots}
            value={minDays}
            onChange={setMinDays}
            items={(["3", "5", "7"] as MinDays[]).map(n => ({ value: n, label: `≥ ${n}`, tip: t.minDaysTip(Number(n)) }))}
          />
        }
      >
        <Loadable
          q={idle}
          height="h-40"
          isEmpty={d => !d.rows.length}
          empty={<EmptyState icon={CircleCheck} text={t.noIdleLots} className="h-40" />}
        >
          {d => (
            <DataTable
              headers={[t.colProduct, t.colSupplier, t.colLength, t.colPrice, t.colDays, t.colStems, t.colUntil]}
              rows={d.rows.map(r => [
                r.product,
                r.supplier,
                r.length != null ? `${r.length} cm` : "—",
                fmt.price(r.price),
                fmt.int(r.days_online),
                fmt.int(r.stems),
                r.available_until ? fmt.day(r.available_until) : "—",
              ])}
              alignRight={[2, 3, 4, 5, 6]}
            />
          )}
        </Loadable>
      </Panel>
    </div>
  );
}
