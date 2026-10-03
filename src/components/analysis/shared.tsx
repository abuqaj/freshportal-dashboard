"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Check, ChevronsUpDown, Info, Minus, Search, Table2, ChartColumn } from "lucide-react";

import type { Lang, translations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tip } from "@/components/ui/tooltip";
import { SparkAreaChart } from "@/components/tremor/SparkChart";

// Shared pieces of the Analysis Tool (rebuilt 2026-10-03): the context every
// tab reads its filters from, data fetching, number formats and the panel,
// tile, picker and state components the tabs are made of. Words only ever
// arrive through `t`, so the module stays translatable.

export type Copy = (typeof translations)["en"]["analysis"];

export type Tab = "overview" | "offer" | "turnover" | "sales" | "prices" | "suppliers" | "season";

/** Customer scope meaning "don't filter" — BI_ALL_CUSTOMERS in db.py. */
export const ALL_CUSTOMERS = "__all__";
/** OZEDS: the opening scope, and the customer the offer price belongs to. */
export const REFERENCE_CUSTOMER = "12";

// BCP-47 tags for dates and numbers, so figures follow the chosen language
// rather than the browser's.
export const LOCALES: Record<Lang, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

/** API URL with empty params left out, so an unset filter is simply absent. */
export function api(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const url = new URL(`${RAILWAY}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export interface Query<T> { data: T | null; loading: boolean }

/** Fetch on URL change. `null` means "not needed now" and clears the data.
 *  The previous result stays while the next one loads, so a chart dims
 *  instead of jumping to a skeleton on every filter change. */
export function useFetch<T>(url: string | null, tick = 0): Query<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url) { setData(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url, tick]);
  return { data, loading };
}

// ── Dates ───────────────────────────────────────────────────────────────────

export function isoDay(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoDay(d);
}

/** Every day from `start` to `end`, inclusive. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < 1200; d = addDays(d, 1)) out.push(d);
  return out;
}

// ── Number and date formats ─────────────────────────────────────────────────

export function makeFormat(locale: string) {
  const price = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const moneyCompact = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1 });
  const int = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const one = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const two = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const asDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`);
  return {
    /** € per stem, to the tenth of a cent. */
    price: (v: number | null | undefined) => (v == null ? "—" : price.format(v)),
    money: (v: number | null | undefined) => (v == null ? "—" : money.format(v)),
    moneyCompact: (v: number | null | undefined) => (v == null ? "—" : moneyCompact.format(v)),
    int: (v: number | null | undefined) => (v == null ? "—" : int.format(Math.round(v))),
    compact: (v: number | null | undefined) => (v == null ? "—" : compact.format(v)),
    one: (v: number | null | undefined) => (v == null ? "—" : one.format(v)),
    two: (v: number | null | undefined) => (v == null ? "—" : two.format(v)),
    pct: (v: number | null | undefined) => (v == null ? "—" : `${one.format(v)}%`),
    signedPct: (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${one.format(v)}%`),
    day: (iso: string) => asDate(iso).toLocaleDateString(locale, { day: "numeric", month: "short" }),
    dayYear: (iso: string) => asDate(iso).toLocaleDateString(locale, { day: "numeric", month: "short", year: "2-digit" }),
    dayLong: (iso: string) => asDate(iso).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" }),
    dateTime: (iso: string) => new Date(iso).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    time: (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
  };
}

export type Fmt = ReturnType<typeof makeFormat>;

/** Day labeller for a chart axis: the year joins in once a range is long
 *  enough for a day and month to repeat. */
export function dayLabeller(fmt: Fmt, days: string[]): (iso: string) => string {
  const long = days.length > 300 || (days.length > 1 && days[0].slice(0, 4) !== days[days.length - 1].slice(0, 4) && days.length > 60);
  return long ? fmt.dayYear : fmt.day;
}

// ── Context ─────────────────────────────────────────────────────────────────

export interface PickerItem { value: string; label: string; meta?: string }

export interface AnalysisContextValue {
  t: Copy;
  fmt: Fmt;
  locale: string;
  start: string;
  end: string;
  customerId: string;
  productId: string;
  productLabel: string;
  products: PickerItem[];
  setProductId: (id: string) => void;
  goTo: (tab: Tab, seed?: { supplierId?: string }) => void;
  salesSeed: { supplierId?: string } | null;
  clearSalesSeed: () => void;
  tick: number;
}

const AnalysisContext = createContext<AnalysisContextValue | null>(null);
export const AnalysisProvider = AnalysisContext.Provider;

export function useAnalysis(): AnalysisContextValue {
  const ctx = useContext(AnalysisContext);
  if (!ctx) throw new Error("useAnalysis outside AnalysisProvider");
  return ctx;
}

// ── Small building blocks ───────────────────────────────────────────────────

/** An ⓘ that carries the explanation, so a panel's title can stay short. */
export function InfoTip({ content }: { content: ReactNode }) {
  return (
    <Tip content={content}>
      <span tabIndex={0} className="inline-flex size-5 cursor-help items-center justify-center rounded-full text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-emerald/40">
        <Info className="size-3.5" aria-hidden />
      </span>
    </Tip>
  );
}

type Tone = "neutral" | "good" | "warn" | "info";
const TONES: Record<Tone, string> = {
  neutral: "border-sand bg-sand/50 text-ink-2",
  good: "border-sage bg-sage/50 text-emerald-dark",
  warn: "border-blush bg-blush/40 text-brick",
  info: "border-border bg-muted text-ink-3",
};

/** A short fact next to a title: a word or two, the detail in its tooltip. */
export function Chip({ tone = "neutral", icon: Icon, children, tip }: {
  tone?: Tone; icon?: ComponentType<{ className?: string }>; children: ReactNode; tip?: ReactNode;
}) {
  const chip = (
    <span tabIndex={tip ? 0 : undefined} className={cn("inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-emerald/40", TONES[tone])}>
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  );
  return <Tip content={tip}>{chip}</Tip>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-muted", className)} />;
}

export function EmptyState({ icon: Icon = ChartColumn, text, className }: {
  icon?: ComponentType<{ className?: string }>; text: ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-ink-3", className)}>
      <Icon className="size-6 text-taupe" />
      <span className="max-w-xs">{text}</span>
    </div>
  );
}

/** A query's three states in one place: a skeleton the first time, the
 *  empty state when there is nothing, and the content — dimmed while the
 *  next result loads. */
export function Loadable<T>({ q, height = "h-64", isEmpty, empty, children }: {
  q: Query<T>;
  height?: string;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  children: (d: T) => ReactNode;
}) {
  const { t } = useAnalysis();
  if (!q.data) return q.loading ? <Skeleton className={height} /> : <EmptyState text={t.noData} className={height} />;
  if (isEmpty?.(q.data)) return <>{empty ?? <EmptyState text={t.noData} className={height} />}</>;
  return <div className={cn("min-w-0 transition-opacity", q.loading && "opacity-50")}>{children(q.data)}</div>;
}

export interface TableView { headers: string[]; rows: (string | number)[][]; alignRight?: number[] }

export function DataTable({ headers, rows, alignRight = [] }: TableView) {
  return (
    <div className="max-h-80 overflow-auto rounded-xl border border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted text-ink-3">
          <tr>{headers.map((h, i) => <th key={i} className={cn("px-3 py-2 text-left font-semibold", alignRight.includes(i) && "text-right")}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t border-muted">
              {r.map((c, ci) => <td key={ci} className={cn("px-3 py-1.5 text-ink", alignRight.includes(ci) && "text-right tabular-nums")}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A card holding one analysis: a short title, its explanation behind ⓘ,
 *  an optional fact chip, controls on the right and, where given, a table
 *  twin of the chart one click away. */
export function Panel({ title, tip, badge, actions, table, className, children }: {
  title: string;
  tip?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  table?: TableView | null;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useAnalysis();
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={cn("flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(17,26,20,0.04)] sm:p-5", className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="truncate text-sm font-semibold text-ink">{title}</h3>
          {tip && <InfoTip content={tip} />}
          {badge}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions}
          {table && (
            <Tip content={asTable ? t.showChart : t.showTable}>
              <Button variant="ghost" size="icon" aria-pressed={asTable} onClick={() => setAsTable(v => !v)}>
                {asTable ? <ChartColumn className="size-4" /> : <Table2 className="size-4" />}
              </Button>
            </Tip>
          )}
        </div>
      </header>
      {asTable && table ? <DataTable {...table} /> : children}
    </section>
  );
}

/** One-of-n control — a segmented toggle that cannot be emptied. The
 *  tooltip sits on the label inside the item: on the item itself the
 *  tooltip's own data-state replaced the toggle's "on", and the chosen item
 *  lost its colour. */
export function Segmented<V extends string>({ value, onChange, items, label }: {
  value: V;
  onChange: (v: V) => void;
  items: { value: V; label: ReactNode; tip?: string; disabled?: boolean }[];
  label: string;
}) {
  return (
    <ToggleGroup type="single" value={value} aria-label={label} onValueChange={v => { if (v) onChange(v as V); }}>
      {items.map(it => (
        <ToggleGroupItem key={it.value} value={it.value} disabled={it.disabled} aria-label={it.tip ?? (typeof it.label === "string" ? it.label : it.value)}>
          <Tip content={it.tip}><span>{it.label}</span></Tip>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Searchable picker for long lists (products, suppliers, customers). */
export function Combobox({ items, value, onChange, allLabel, placeholder, icon: Icon, className, label }: {
  items: PickerItem[];
  value: string;
  onChange: (v: string) => void;
  /** Offered as the first entry, with value "", when "none chosen" is valid. */
  allLabel?: string;
  placeholder?: string;
  icon?: ComponentType<{ className?: string }>;
  className?: string;
  label: string;
}) {
  const { t } = useAnalysis();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = items.find(i => i.value === value);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? items.filter(i => i.label.toLowerCase().includes(q)) : items;
    return list.slice(0, 200);
  }, [items, query]);
  const choose = (v: string) => { onChange(v); setOpen(false); setQuery(""); };
  const text = selected?.label ?? (value ? value : (allLabel ?? placeholder ?? ""));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex h-9 min-w-0 max-w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm text-ink outline-none transition-colors hover:border-emerald/40 focus-visible:ring-2 focus-visible:ring-emerald/40",
            className,
          )}
        >
          {Icon && <Icon className="size-4 shrink-0 text-ink-3" />}
          <span className={cn("truncate", !selected && !value && "text-ink-3")}>{text}</span>
          <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-ink-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center gap-2 border-b border-muted px-3">
          <Search className="size-4 text-ink-3" />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && shown[0]) choose(shown[0].value); }}
            placeholder={t.search}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1" role="listbox">
          {allLabel && !query && (
            <PickerRow label={allLabel} active={value === ""} onClick={() => choose("")} />
          )}
          {shown.map(i => (
            <PickerRow key={i.value} label={i.label} meta={i.meta} active={i.value === value} onClick={() => choose(i.value)} />
          ))}
          {!shown.length && <p className="px-3 py-6 text-center text-xs text-ink-3">{t.noMatch}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PickerRow({ label, meta, active, onClick }: { label: string; meta?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted",
        active && "font-medium text-emerald-dark",
      )}
    >
      <Check className={cn("size-3.5 shrink-0", active ? "text-emerald" : "invisible")} />
      <span className="truncate">{label}</span>
      {meta && <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-3">{meta}</span>}
    </button>
  );
}

/** Change against the period before, coloured by whether up is good. */
export function Delta({ value, upIsGood = true, tip }: { value: number | null; upIsGood?: boolean | null; tip?: string }) {
  const { fmt } = useAnalysis();
  if (value == null || !isFinite(value)) return null;
  const flat = Math.abs(value) < 0.05;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  const good = upIsGood == null || flat ? null : (value > 0) === upIsGood;
  return (
    <Tip content={tip}>
      <span
        tabIndex={0}
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums outline-none",
          good === true && "bg-sage/60 text-emerald-dark",
          good === false && "bg-blush/50 text-brick",
          good === null && "bg-muted text-ink-2",
        )}
      >
        <Icon className="size-3.5" />
        {fmt.signedPct(value)}
      </span>
    </Tip>
  );
}

/** A headline figure: label, value, change and a sparkline of its days. */
export function KpiCard({ icon: Icon, label, value, exact, delta, sub, spark, onClick, tip }: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  exact?: string;
  delta?: ReactNode;
  sub?: ReactNode;
  spark?: { data: { x: string; v: number | null }[] } | null;
  onClick?: () => void;
  tip?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-xs font-medium text-ink-3">
        <span className="inline-flex size-6 items-center justify-center rounded-lg bg-sage/50 text-emerald-dark"><Icon className="size-3.5" /></span>
        <span className="truncate">{label}</span>
        {tip && <InfoTip content={tip} />}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-2xl font-bold tracking-tight text-ink" title={exact}>{value}</div>
          <div className="mt-1 flex min-h-5 flex-wrap items-center gap-1.5 text-xs text-ink-3">{delta}{sub}</div>
        </div>
        {spark && spark.data.length > 1 && (
          <SparkAreaChart
            data={spark.data}
            index="x"
            categories={["v"]}
            colors={["emerald"]}
            className="h-10 w-24 shrink-0"
          />
        )}
      </div>
    </>
  );
  const cls = "flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-4 text-left shadow-[0_1px_2px_rgba(17,26,20,0.04)]";
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, "cursor-pointer outline-none transition-colors hover:border-emerald/40 focus-visible:ring-2 focus-visible:ring-emerald/40")}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Chips to pick one stem length, or all of them. */
export function LengthChips({ lengths, value, onChange }: { lengths: number[]; value: string; onChange: (v: string) => void }) {
  const { t } = useAnalysis();
  if (!lengths.length) return null;
  return (
    <Segmented
      label={t.length}
      value={value || "all"}
      onChange={v => onChange(v === "all" ? "" : v)}
      items={[{ value: "all", label: t.allLengthsShort }, ...lengths.map(l => ({ value: String(l), label: `${l}` }))]}
    />
  );
}

/** The tooltip box the Tremor charts use, in one style for every chart. */
export function TooltipBox({ title, rows }: {
  title: ReactNode;
  rows: { color?: string; label: ReactNode; value: ReactNode; muted?: boolean }[];
}) {
  return (
    <div className="min-w-44 rounded-xl border border-border bg-surface text-xs shadow-lg">
      <div className="border-b border-muted px-3 py-2 font-semibold text-ink">{title}</div>
      <div className="space-y-1 px-3 py-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-6">
            <span className={cn("flex items-center gap-1.5", r.muted ? "text-ink-3" : "text-ink-2")}>
              {r.color && <span className={cn("h-[3px] w-3 rounded-full", r.color)} />}
              {r.label}
            </span>
            <span className={cn("font-semibold tabular-nums", r.muted ? "text-ink-3" : "text-ink")}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
