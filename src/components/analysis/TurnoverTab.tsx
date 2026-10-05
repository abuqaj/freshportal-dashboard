"use client";

import { useEffect, useState } from "react";
import { CircleCheck, EyeOff, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popup } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DotStrip, ProgressRows } from "./charts";
import { SinceChip } from "./OfferTab";
import { Chip, DismissChip, EmptyState, Loadable, Panel, Segmented, api, useAnalysis, useFetch } from "./shared";
import type { IdleLots, ProductListings, SelloutSpeed, SellThrough } from "./types";

// Rotacja: what came of the offer — how much of it sold (sell-through), how
// fast it sold out, and what sat online without a single sale. All of it
// rests on the offer recorded since 2026-09-25.

type Group = "product" | "supplier" | "length";
type MinDays = "3" | "5" | "7";
interface Hidden { id: string; name: string }

/** Suppliers hidden from Idle lots, remembered in this browser (user,
 *  2026-10-05). Only a convenience: storage may be missing or full, and the
 *  list then simply starts empty. */
const HIDDEN_KEY = "analysis.idleLots.hiddenSuppliers";

function loadHidden(): Hidden[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(h => h && typeof h.id === "string") : [];
  } catch {
    return [];
  }
}

function saveHidden(list: Hidden[]) {
  try { window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(list)); } catch { /* not remembered, still applied */ }
}

export function TurnoverTab() {
  const { t, fmt, start, end, tick } = useAnalysis();
  const [group, setGroup] = useState<Group>("product");
  const [minDays, setMinDays] = useState<MinDays>("3");
  const [hidden, setHidden] = useState<Hidden[]>([]);
  useEffect(() => { setHidden(loadHidden()); }, []);
  const updateHidden = (list: Hidden[]) => { setHidden(list); saveHidden(list); };
  const [listingsOf, setListingsOf] = useState<{ id: string; label: string } | null>(null);

  const through = useFetch<SellThrough>(api("/bi-sync/sell-through", { start_date: start, end_date: end, group_by: group }), tick);
  const speed = useFetch<SelloutSpeed>(api("/bi-sync/sellout-speed", { start_date: start, end_date: end }), tick);
  const idle = useFetch<IdleLots>(api("/bi-sync/idle-lots", {
    start_date: start, end_date: end, min_days: minDays, exclude_suppliers: hidden.map(h => h.id).join(","),
  }), tick);
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
            rows: through.data.rows.map(r => [r.label, fmt.pct(r.pct), t.soldOfOffered(fmt.int(r.sold), fmt.int(r.offered)), t.soldOutOf(r.sold_out, r.listings)]),
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
                  extra: t.soldOutOf(r.sold_out, r.listings),
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
            headers: [t.colProduct, t.colMedian, t.soldOutLots],
            rows: speed.data.products.map(p => [p.label, p.median_hours != null ? hours(p.median_hours) : "—", t.soldOutOf(p.sold_out, p.listings)]),
            alignRight: [1, 2],
          } : null}
        >
          <Loadable q={speed} height="h-72" isEmpty={d => !d.products.some(p => p.sold_out)}>
            {d => (
              <DotStrip
                rows={d.products.map(p => ({
                  key: p.product_id,
                  label: p.label,
                  dots: (p.lots ?? p.hours.map(h => ({ hours: h, supplier: null, length: null }))).map(lot => ({
                    hours: lot.hours,
                    tip: [hours(lot.hours), lot.supplier, lot.length != null ? `${lot.length} cm` : null].filter(Boolean).join(" · "),
                  })),
                  median: p.median_hours,
                  medianText: p.median_hours != null ? hours(p.median_hours) : "—",
                  share: t.soldOutOf(p.sold_out, p.listings),
                  shareTip: t.soldOutOfTip(p.sold_out, p.listings),
                }))}
                hourLabel={h => `${h}`}
                legend={{ lot: t.legendLot, median: t.legendMedian }}
                headers={{ median: t.colMedian, share: t.soldOutLots }}
                axisLabel={t.selloutAxis}
                medianTip={text => `${t.legendMedian}: ${text}`}
                onShare={key => {
                  const p = d.products.find(x => x.product_id === key);
                  if (p) setListingsOf({ id: p.product_id, label: p.label });
                }}
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
        {!!hidden.length && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
            <Tip content={t.hiddenTip}>
              <span tabIndex={0} className="inline-flex items-center gap-1 outline-none"><EyeOff className="size-3.5" />{t.hiddenSuppliers}:</span>
            </Tip>
            {hidden.map(h => (
              <DismissChip key={h.id} label={`${t.showAgain}: ${h.name}`} onDismiss={() => updateHidden(hidden.filter(x => x.id !== h.id))}>
                {h.name}
              </DismissChip>
            ))}
          </div>
        )}
        <Loadable
          q={idle}
          height="h-40"
          isEmpty={d => !d.rows.length}
          empty={<EmptyState icon={CircleCheck} text={t.noIdleLots} className="h-40" />}
        >
          {d => (
            <IdleTable
              rows={d.rows}
              onHide={(id, name) => { if (!hidden.some(h => h.id === id)) updateHidden([...hidden, { id, name }]); }}
            />
          )}
        </Loadable>
      </Panel>

      {listingsOf && <ListingsDialog product={listingsOf} onClose={() => setListingsOf(null)} />}
    </div>
  );
}

/** Idle lots with a last column to hide a lot's supplier from the list — an
 *  eye in the header says the column is there for that (user, 2026-10-05). */
function IdleTable({ rows, onHide }: { rows: IdleLots["rows"]; onHide: (supplierId: string, name: string) => void }) {
  const { t, fmt } = useAnalysis();
  const head = [t.colProduct, t.colSupplier, t.colLength, t.colPrice, t.colDays, t.colStems, t.colUntil];
  const right = new Set([2, 3, 4, 5, 6]);
  return (
    <div className="max-h-80 overflow-auto rounded-xl border border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-muted text-ink-3">
          <tr>
            {head.map((h, i) => <th key={i} className={cn("px-3 py-2 text-left font-semibold", right.has(i) && "text-right")}>{h}</th>)}
            <th className="w-10 px-2 py-2">
              <Tip content={t.hideColumnTip}>
                <span tabIndex={0} aria-label={t.hideColumnTip} className="inline-flex text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald/40">
                  <EyeOff className="size-3.5" />
                </span>
              </Tip>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.stock_entry_id} className="border-t border-muted hover:bg-muted/40">
              <td className="px-3 py-1.5 text-ink">{r.product}</td>
              <td className="px-3 py-1.5 text-ink">{r.supplier}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.length != null ? `${r.length} cm` : "—"}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmt.price(r.price)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmt.int(r.days_online)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmt.int(r.stems)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.available_until ? fmt.day(r.available_until) : "—"}</td>
              <td className="px-2 py-1 text-center">
                {r.supplier_id && (
                  <Tip content={t.hideSupplier}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t.hideSupplier}: ${r.supplier}`}
                      onClick={() => onHide(r.supplier_id!, r.supplier)}
                      className="text-ink-3 hover:bg-blush/40 hover:text-brick"
                    >
                      <EyeOff className="size-3.5" />
                    </Button>
                  </Tip>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every lot of one product in the period, behind the "2 of 41" — which ones
 *  sold out, from which supplier, how fast (user, 2026-10-05). */
function ListingsDialog({ product, onClose }: { product: { id: string; label: string }; onClose: () => void }) {
  const { t, fmt, start, end } = useAnalysis();
  const q = useFetch<ProductListings>(api("/bi-sync/product-listings", { product_id: product.id, start_date: start, end_date: end }));
  const hours = (h: number) => t.hoursShort(h < 10 ? Math.round(h * 10) / 10 : Math.round(h));
  const soldOut = q.data?.rows.filter(r => r.sold_out_at).length ?? 0;
  return (
    <Popup
      title={t.listingsTitle(product.label)}
      onClose={onClose}
      className="inset-x-4 top-1/2 mx-auto flex max-h-[calc(100vh-2rem)] max-w-4xl -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-2xl border-2 border-emerald bg-surface p-6 shadow-[0_16px_48px_rgba(17,26,20,0.35)]"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-ink">{t.listingsTitle(product.label)}</h2>
          {q.data && <div className="mt-1"><Chip tone="good">{t.soldOutLots}: {t.soldOutOf(soldOut, q.data.rows.length)}</Chip></div>}
        </div>
        <Button variant="ghost" size="icon" className="ml-auto" onClick={onClose} aria-label={t.close}>
          <X className="size-4" />
        </Button>
      </div>
      <Loadable q={q} height="h-40" isEmpty={d => !d.rows.length}>
        {d => (
          <div className="max-h-[60vh] overflow-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-ink-3">
                <tr>
                  {[t.colSupplier, t.colLength, t.colPrice, t.colOnline, t.colSoldOutAt, t.colAfter, t.stemsSoldOffered].map((h, i) => (
                    <th key={i} className={cn("px-3 py-2 text-left font-semibold", i >= 1 && i !== 3 && "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.rows.map(r => (
                  <tr key={`${r.stock_entry_id}-${r.available_from}`} className={cn("border-t border-muted", r.sold_out_at && "bg-sage/20")}>
                    <td className="px-3 py-1.5 text-ink">{r.supplier ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.length != null ? `${r.length} cm` : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmt.price(r.price)}</td>
                    <td className="px-3 py-1.5 tabular-nums">
                      {r.available_from ? fmt.day(r.available_from) : "—"} – {r.available_until ? fmt.day(r.available_until) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.sold_out_at ? (
                        <span className="inline-flex items-center gap-1 font-medium text-emerald-dark">
                          <CircleCheck className="size-3.5" />{fmt.day(r.sold_out_at)} {r.sold_out_at.slice(11, 16)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.hours != null ? hours(r.hours) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{t.soldOfOffered(fmt.int(r.sold), fmt.int(r.offered))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loadable>
    </Popup>
  );
}
