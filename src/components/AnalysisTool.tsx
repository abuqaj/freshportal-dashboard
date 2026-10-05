"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useSession } from "next-auth/react";
import {
  CalendarDays, CalendarRange, Clock, DatabaseZap, Gauge, LayoutDashboard, LoaderCircle,
  Package, Store, Tag, TrendingUp, Truck, TriangleAlert, Users,
} from "lucide-react";

import { Lang, translations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tip } from "@/components/ui/tooltip";
import {
  ALL_CUSTOMERS, AnalysisProvider, Chip, Combobox, LOCALES, REFERENCE_CUSTOMER,
  addDays, api, isoDay, makeFormat, useAnalysis, useFetch,
  type AnalysisContextValue, type PickerItem, type Tab,
} from "./analysis/shared";
import { OverviewTab } from "./analysis/OverviewTab";
import { OfferTab } from "./analysis/OfferTab";
import { TurnoverTab } from "./analysis/TurnoverTab";
import { SalesTab } from "./analysis/SalesTab";
import { PricesTab } from "./analysis/PricesTab";
import { SuppliersTab } from "./analysis/SuppliersTab";
import { SeasonTab } from "./analysis/SeasonTab";
import { SyncDialog } from "./analysis/SyncDialog";
import type { SyncHistory } from "./analysis/types";

// Analysis Tool — webshop sales, the offer and its prices, per stem.
// Rebuilt 2026-10-03 on Tremor charts and shadcn/ui pieces in the system
// palette: one filter row scopes every tab (period, customer, product), each
// analysis sits in its own panel with a short title and its explanation
// behind an ⓘ, and the data sync is an admin's icon, not a panel everyone
// scrolls past. Tabs follow the questions the data can answer (FT Visual
// Vocabulary): the overview, what was offered, how it sold through, sales
// over time, prices, suppliers, and the season.

type Preset = "7" | "30" | "90" | "365" | "custom";

const TABS: { id: Tab; icon: ComponentType<{ className?: string }>; label: (t: typeof translations.en.analysis) => string; product?: "required" | "optional" }[] = [
  { id: "overview", icon: LayoutDashboard, label: t => t.tabOverview },
  { id: "offer", icon: Store, label: t => t.tabOffer, product: "optional" },
  { id: "turnover", icon: Gauge, label: t => t.tabTurnover },
  { id: "sales", icon: TrendingUp, label: t => t.tabSales },
  { id: "prices", icon: Tag, label: t => t.tabPrices, product: "required" },
  { id: "suppliers", icon: Truck, label: t => t.tabSuppliers, product: "optional" },
  { id: "season", icon: CalendarDays, label: t => t.tabSeason, product: "optional" },
];

export default function AnalysisTool({ lang }: { lang: Lang }) {
  const t = translations[lang].analysis;
  const locale = LOCALES[lang];
  const fmt = useMemo(() => makeFormat(locale), [locale]);
  const { data: session } = useSession();
  const isAdmin = ((session?.user as { permissions?: string[] } | undefined)?.permissions ?? []).includes("admin:manage");

  const [tab, setTab] = useState<Tab>("overview");
  const today = isoDay(new Date());
  const [preset, setPreset] = useState<Preset>("30");
  const [custom, setCustom] = useState({ start: addDays(today, -29), end: today });
  const start = preset === "custom" ? custom.start : addDays(today, -(Number(preset) - 1));
  const end = preset === "custom" ? custom.end : today;
  const [customerId, setCustomerId] = useState(REFERENCE_CUSTOMER);

  // ── Data freshness and the sync ──────────────────────────────────────────
  const [history, setHistory] = useState<SyncHistory | null>(null);
  const [tick, setTick] = useState(0);
  const [syncOpen, setSyncOpen] = useState(false);
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(api("/bi-sync/history", { limit: 5 }));
      if (res.ok) setHistory(await res.json());
    } catch { /* the chip just stays as it was */ }
  }, []);
  const running = !!history?.running;
  useEffect(() => {
    loadHistory();
    const id = setInterval(loadHistory, running ? 4000 : 120_000);
    return () => clearInterval(id);
  }, [loadHistory, running]);
  // A sync that just finished refreshes every chart once.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) setTick(n => n + 1);
    wasRunning.current = running;
  }, [running]);

  const lastOk = history?.history?.find(h => h.status === "ok" && h.finished_at) ?? null;
  const lastFailed = history?.history?.[0]?.status === "error";

  // ── Pickers ──────────────────────────────────────────────────────────────
  const customers = useFetch<{ customers: { customer_id: string; name: string | null; row_count: number }[] }>(
    api("/bi-sync/customers", { start_date: start, end_date: end }), tick);
  const customerItems: PickerItem[] = (customers.data?.customers ?? []).map(c => ({ value: c.customer_id, label: c.name || c.customer_id, meta: fmt.int(c.row_count) }));

  const productsQ = useFetch<{ products: { product_id: string; description: string | null; row_count: number }[] }>(
    api("/bi-sync/products", { limit: 300, start_date: start, end_date: end, customer_id: customerId }), tick);
  const products: PickerItem[] = useMemo(
    () => (productsQ.data?.products ?? []).map(p => ({ value: p.product_id, label: p.description || p.product_id, meta: fmt.int(p.row_count) })),
    [productsQ.data, fmt],
  );

  // The product opens on the best seller. A product that falls out of the
  // (date-scoped) list goes back to it; "all products", once chosen, stays.
  const [productId, setProductIdRaw] = useState("");
  const chosenAll = useRef(false);
  const setProductId = useCallback((id: string) => { chosenAll.current = id === ""; setProductIdRaw(id); }, []);
  useEffect(() => {
    if (!products.length) return;
    setProductIdRaw(prev => {
      if (prev && products.some(p => p.value === prev)) return prev;
      return prev === "" && chosenAll.current ? "" : products[0].value;
    });
  }, [products]);
  const productLabel = products.find(p => p.value === productId)?.label ?? productId;

  const [salesSeed, setSalesSeed] = useState<{ supplierId?: string } | null>(null);
  const clearSalesSeed = useCallback(() => setSalesSeed(null), []);
  const goTo = useCallback((next: Tab, seed?: { supplierId?: string }) => {
    if (seed) setSalesSeed(seed);
    setTab(next);
  }, []);

  const ctx: AnalysisContextValue = {
    t, fmt, locale, start, end, customerId, productId, productLabel, products,
    setProductId, goTo, salesSeed, clearSalesSeed, tick,
  };
  const current = TABS.find(x => x.id === tab)!;

  return (
    <AnalysisProvider value={ctx}>
      <div className="flex flex-col gap-4">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight text-ink">{t.title}</h2>
            <p className="mt-0.5 text-sm text-ink-3">{t.subtitle}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {running ? (
              <Chip tone="info" icon={LoaderCircle}>{t.syncRunning}</Chip>
            ) : lastFailed ? (
              <Chip tone="warn" icon={TriangleAlert} tip={history?.history?.[0]?.error ?? undefined}>{t.syncError}</Chip>
            ) : lastOk?.finished_at ? (
              <Chip tone="good" icon={Clock} tip={t.dataAtTip(fmt.dateTime(lastOk.finished_at))}>
                {t.dataAt(lastOk.finished_at.slice(0, 10) === today ? fmt.time(lastOk.finished_at) : fmt.dateTime(lastOk.finished_at))}
              </Chip>
            ) : null}
            {isAdmin && (
              <Tip content={t.syncOpen}>
                <Button variant="outline" size="icon" onClick={() => setSyncOpen(true)} aria-label={t.syncOpen}>
                  <DatabaseZap className="size-4" />
                </Button>
              </Tip>
            )}
          </div>
        </header>

        <nav role="tablist" aria-label={t.title} className="flex flex-wrap gap-1 rounded-2xl bg-muted p-1">
          {TABS.map(x => {
            const Icon = x.icon;
            const active = x.id === tab;
            return (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(x.id)}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald/40",
                  active ? "bg-surface text-emerald-dark shadow-[0_1px_3px_rgba(17,26,20,0.12)]" : "text-ink-3 hover:bg-surface/60 hover:text-ink",
                )}
              >
                <Icon className="size-4" />
                {x.label(t)}
              </button>
            );
          })}
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            aria-label={t.period}
            value={preset === "custom" ? "" : preset}
            onValueChange={v => { if (v) setPreset(v as Preset); }}
          >
            {(["7", "30", "90"] as const).map(n => (
              <ToggleGroupItem key={n} value={n}>{t.periodDays(Number(n))}</ToggleGroupItem>
            ))}
            <ToggleGroupItem value="365">{t.periodYear}</ToggleGroupItem>
          </ToggleGroup>
          <RangePicker
            start={start}
            end={end}
            active={preset === "custom"}
            onApply={(s, e) => { setCustom({ start: s, end: e }); setPreset("custom"); }}
          />
          <Combobox
            label={t.customer}
            icon={Users}
            items={customerItems}
            value={customerId === ALL_CUSTOMERS ? "" : customerId}
            onChange={v => setCustomerId(v || ALL_CUSTOMERS)}
            allLabel={t.allCustomers}
            className="w-52"
          />
          {customerId === ALL_CUSTOMERS && <Chip tone="warn" icon={TriangleAlert} tip={t.mixedPricesTip}>{t.mixedPrices}</Chip>}
          {current.product && (
            <Combobox
              label={t.product}
              icon={Package}
              items={products}
              value={productId}
              onChange={setProductId}
              allLabel={current.product === "optional" ? t.allProducts : undefined}
              placeholder={t.product}
              className="w-72"
            />
          )}
        </div>

        <div role="tabpanel" className="min-w-0">
          {tab === "overview" && <OverviewTab />}
          {tab === "offer" && <OfferTab />}
          {tab === "turnover" && <TurnoverTab />}
          {tab === "sales" && <SalesTab />}
          {tab === "prices" && <PricesTab />}
          {tab === "suppliers" && <SuppliersTab />}
          {tab === "season" && <SeasonTab />}
        </div>

        {syncOpen && isAdmin && (
          <SyncDialog history={history} onClose={() => setSyncOpen(false)} onStarted={loadHistory} />
        )}
      </div>
    </AnalysisProvider>
  );
}

/** The custom period: a calendar button showing the active range, opening
 *  two dates and an apply button. */
function RangePicker({ start, end, active, onApply }: {
  start: string; end: string; active: boolean; onApply: (start: string, end: string) => void;
}) {
  const { t, fmt } = useAnalysis();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState(end);
  useEffect(() => { if (open) { setFrom(start); setTo(end); } }, [open, start, end]);
  const valid = !!from && !!to && from <= to;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip content={t.periodCustom}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-sm tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald/40",
              active ? "border-emerald bg-emerald text-white" : "border-border bg-surface text-ink hover:border-emerald/40",
            )}
          >
            <CalendarRange className="size-4" />
            {fmt.day(start)} – {fmt.day(end)}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="flex w-64 flex-col gap-3 p-3">
        <label className="flex flex-col gap-1 text-[11px] text-ink-3">
          {t.dateFrom}
          <input id="analysis-range-from" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)}
            className="h-9 rounded-xl border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-emerald/50" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-ink-3">
          {t.dateTo}
          <input id="analysis-range-to" type="date" value={to} min={from} onChange={e => setTo(e.target.value)}
            className="h-9 rounded-xl border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-emerald/50" />
        </label>
        <Button variant="primary" size="sm" disabled={!valid} onClick={() => { onApply(from, to); setOpen(false); }}>
          {t.apply}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
