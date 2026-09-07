"use client";

import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from "react";
import { Lang, translations } from "@/lib/i18n";
import {
  MultiLineChart, ScatterChart, GroupedBarChart, HBarChart, DivergingBarChart,
  Series, ScatterPoint, fmtPrice, fmtNum, fmtPct, makeMonthLabel,
  COLOR_ABOVE,
} from "./analysis/charts";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

const CTRL = "h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors";

// BCP-47 tags for date/number formatting, so figures don't render in the
// browser's language while the rest of the UI is in the user's (2026-09-07).
const LOCALES: Record<Lang, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

interface BiStats {
  stock_entry_dim_count?: number;
  stock_entry_daily_count?: number;
  snapshot_days?: number;
  order_lines_count?: number;
  invoice_customer_count?: number;
}

interface BiSyncRun {
  status: string;
  error: string | null;
  stock_entries_seen: number | null;
  order_lines_seen: number | null;
  mutation_from: string | null;
  messages?: string[];
}

interface ProductPickerItem { product_id: string; description: string | null; row_count: number }
interface SupplierPickerItem { supplier_id: string; name: string | null; row_count: number }

interface LengthPoint {
  length: number;
  avg_price: number;
  avg_supplier_price: number | null;
  spread_pct: number | null;
  quantity: number;
  line_count: number;
}

interface SupplierPricePoint {
  supplier_id: string; name: string; avg_price: number;
  min_price: number; max_price: number; quantity: number; line_count: number;
}

interface VolatilityPoint {
  supplier_id: string; name: string; cv_pct: number | null;
  avg_price: number | null; line_count: number; product_count: number;
}

interface DeviationPoint {
  supplier_id: string; name: string; deviation_pct: number;
  avg_price: number; market_price: number; line_count: number;
}

interface SeasonalityYear {
  year: number;
  months: { month: number; quantity: number; price: number | null }[];
}

interface EventImpact {
  event: string;
  years: {
    year: number;
    volume_lift_pct: number | null;
    price_lift_pct: number | null;
    event_typical_quantity: number | null;
    baseline_typical_quantity: number | null;
    event_days: number;
    baseline_days: number;
  }[];
}

/** Shared shape of the two supplier charts that drop low-volume suppliers. */
interface ScopedResult<T> {
  points: T[];
  total_suppliers?: number;
  excluded?: number;
}

type Copy = (typeof translations)["en"]["analysis"];

type ViewMode = "supplier" | "product";
type Tab = "sales" | "price" | "suppliers" | "seasonality";
type Metric = "quantity" | "price";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultMutationDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Build an API URL, dropping empty/null params so optional filters simply
 *  don't appear rather than being sent as "". */
function api(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const url = new URL(`${RAILWAY}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Fetch-on-url-change. `url === null` means "not needed right now" (inactive
 *  tab, or a required picker still empty) and clears the data without a
 *  request. `tick` forces a refetch after a sync lands. */
function useFetch<T>(url: string | null, tick = 0): { data: T | null; loading: boolean } {
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

function Card({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        {hint && <p className="text-xs text-ink-3 mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Loading({ when, text }: { when: boolean; text: string }) {
  return when ? <p className="text-xs text-ink-3">{text}</p> : null;
}

/** Plain-language reading of the price/volume correlation — the number alone
 *  invites over-reading a weak signal as a demand curve. */
function elasticityVerdict(c: number | null, t: Copy): string {
  if (c == null) return t.verdictTooFew;
  if (c <= -0.5) return t.verdictStrongNeg;
  if (c <= -0.2) return t.verdictModNeg;
  if (c < 0.2) return t.verdictNone;
  return t.verdictPos;
}

export default function AnalysisTool({ lang }: { lang: Lang }) {
  const t = translations[lang].analysis;
  const locale = LOCALES[lang];
  const monthLbl = useMemo(() => makeMonthLabel(t.months), [t]);

  const [tab, setTab] = useState<Tab>("sales");

  // ── Data pipeline ───────────────────────────────────────────────────────
  const [mutationDate, setMutationDate] = useState(defaultMutationDate());
  const [stats, setStats] = useState<BiStats | null>(null);
  const [latestRun, setLatestRun] = useState<BiSyncRun | null>(null);
  const [syncStarting, setSyncStarting] = useState(false);
  // Backend's live is_bi_sync_running() flag — not derived from latestRun.status,
  // which flips back to "ok" between days of a multi-day backfill and would
  // drop the poll loop mid-run (found 2026-09-02).
  const [serverRunning, setServerRunning] = useState(false);
  // Bumped when a sync finishes, to refetch every picker/chart.
  const [refreshTick, setRefreshTick] = useState(0);

  const loadBiHistory = useCallback(async () => {
    try {
      const res = await fetch(api("/bi-sync/history", { limit: 1 }));
      if (!res.ok) return;
      const data = await res.json();
      setStats(data.stats ?? null);
      setLatestRun(data.history?.[0] ?? null);
      setServerRunning(!!data.running);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadBiHistory(); }, [loadBiHistory]);

  useEffect(() => {
    if (!serverRunning) return;
    const poll = setInterval(loadBiHistory, 4000);
    return () => clearInterval(poll);
  }, [serverRunning, loadBiHistory]);

  // Sync just finished -> refresh everything downstream once.
  const prevRunning = usePrevious(serverRunning);
  useEffect(() => {
    if (prevRunning && !serverRunning) setRefreshTick(n => n + 1);
  }, [prevRunning, serverRunning]);

  async function runBiSync() {
    setSyncStarting(true);
    try {
      await fetch(api("/bi-sync/run-range", { start_date: mutationDate, end_date: todayIso() }), { method: "POST" });
      await loadBiHistory();
    } finally {
      setSyncStarting(false);
    }
  }

  // ── Shared filters ──────────────────────────────────────────────────────
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => todayIso());

  const { data: suppliersData } = useFetch<{ suppliers: SupplierPickerItem[] }>(
    api("/bi-sync/suppliers", { limit: 200, start_date: startDate, end_date: endDate }), refreshTick);
  const { data: productsData } = useFetch<{ products: ProductPickerItem[] }>(
    api("/bi-sync/products", { limit: 300, start_date: startDate, end_date: endDate }), refreshTick);
  const suppliers = suppliersData?.suppliers ?? [];
  const products = productsData?.products ?? [];

  // The analysis tabs all key off one product; keeping it separate from the
  // sales tab's own picker means switching tabs never silently rewrites the
  // other tab's selection.
  const [analysisProductId, setAnalysisProductId] = useState("");
  // Keep the selection only while it's still in the (date-filtered) list,
  // otherwise fall to the top seller. Clearing to "" without re-selecting
  // left the picker blank after narrowing the date range, because the effect
  // doesn't re-run until `products` changes again (fixed 2026-09-03).
  useEffect(() => {
    setAnalysisProductId(prev =>
      prev && products.some(p => p.product_id === prev) ? prev : (products[0]?.product_id ?? ""));
  }, [products]);

  const productLabel = useMemo(
    () => products.find(p => p.product_id === analysisProductId)?.description || analysisProductId,
    [products, analysisProductId],
  );

  const productPicker = (
    <select value={analysisProductId} onChange={e => setAnalysisProductId(e.target.value)} className={`${CTRL} max-w-md`}>
      <option value="">{t.selectProduct}</option>
      {products.map(p => (
        <option key={p.product_id} value={p.product_id}>{p.description || p.product_id} ({p.row_count})</option>
      ))}
    </select>
  );

  const dateRange = (
    <>
      <div>
        <label className="block text-[11px] text-ink-3 mb-1">{t.dateFrom}</label>
        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={CTRL} />
      </div>
      <div>
        <label className="block text-[11px] text-ink-3 mb-1">{t.dateTo}</label>
        <input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} className={CTRL} />
      </div>
    </>
  );

  // ── Tab: Sales ──────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>("supplier");
  const [primaryId, setPrimaryId] = useState("");
  const [highlightKey, setHighlightKey] = useState("");
  const [salesLength, setSalesLength] = useState("");

  useEffect(() => { setPrimaryId(""); setHighlightKey(""); }, [viewMode]);
  useEffect(() => {
    const ids = viewMode === "supplier" ? suppliers.map(s => s.supplier_id) : products.map(p => p.product_id);
    if (ids.length) setPrimaryId(prev => (prev && !ids.includes(prev)) ? "" : prev);
  }, [viewMode, suppliers, products]);
  useEffect(() => { setSalesLength(""); }, [primaryId]);

  // Date-scoped: offering a length that only sold outside the active range
  // would render an empty chart with nothing explaining why.
  const { data: salesLengths } = useFetch<{ lengths: number[] }>(
    viewMode === "product" && primaryId
      ? api("/bi-sync/product-lengths", { product_id: primaryId, start_date: startDate, end_date: endDate })
      : null, refreshTick);

  // Drop a length that the (date-scoped) list no longer offers — otherwise
  // narrowing the dates leaves a stale filter selected and the chart comes
  // back empty with no visible reason. Must sit after the fetch above:
  // `salesLengths` is a const, so referencing it earlier is a temporal
  // dead zone error, not just a lint nit.
  useEffect(() => {
    const ls = salesLengths?.lengths;
    if (!ls) return;
    setSalesLength(prev => (prev && !ls.includes(Number(prev)) ? "" : prev));
  }, [salesLengths]);

  // No selection yet -> a top-N overview rather than a blank panel.
  const salesUrl = primaryId
    ? api(`/bi-sync/${viewMode === "supplier" ? "sales-by-supplier" : "sales-by-product"}`, {
        [viewMode === "supplier" ? "supplier_id" : "product_id"]: primaryId,
        start_date: startDate, end_date: endDate,
        length: viewMode === "product" ? salesLength : null,
      })
    : api("/bi-sync/sales-overview", { group_by: viewMode, start_date: startDate, end_date: endDate });
  const { data: salesData, loading: salesLoading } = useFetch<{ series: Series[] }>(
    tab === "sales" ? salesUrl : null, refreshTick);

  const salesSeries = salesData?.series ?? [];
  useEffect(() => {
    const keys = salesSeries.map(s => s.key);
    setHighlightKey(prev => (prev && !keys.includes(prev)) ? "" : prev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesData]);

  // Highlighted line + top 3 others for comparison; top 5 when nothing is
  // highlighted. Sourced from the already-fetched series, so the highlight
  // picker costs no extra request and is inherently limited to entities that
  // actually co-sold with the primary selection.
  const highlighted = salesSeries.find(s => s.key === highlightKey);
  const others = highlighted ? salesSeries.filter(s => s.key !== highlightKey).slice(0, 3) : salesSeries.slice(0, 5);
  const displaySeries = highlighted ? [...others, highlighted] : others;

  // ── Tab: Price & profitability ──────────────────────────────────────────
  const priceActive = tab === "price" && !!analysisProductId;
  const { data: trendData, loading: trendLoading } = useFetch<{ series: Series[] }>(
    priceActive ? api("/bi-sync/price-trend-by-length", { product_id: analysisProductId, start_date: startDate, end_date: endDate }) : null, refreshTick);
  const { data: lengthData, loading: lengthLoading } = useFetch<{ points: LengthPoint[] }>(
    priceActive ? api("/bi-sync/price-vs-length", { product_id: analysisProductId, start_date: startDate, end_date: endDate }) : null, refreshTick);
  const { data: elasticityData, loading: elasticityLoading } = useFetch<{ points: ScatterPoint[]; correlation: number | null }>(
    priceActive ? api("/bi-sync/price-elasticity", { product_id: analysisProductId, start_date: startDate, end_date: endDate }) : null, refreshTick);

  const lengthPoints = lengthData?.points ?? [];
  const lengthCats = lengthPoints.map(p => `${p.length}cm`);
  const hasCostData = lengthPoints.some(p => p.avg_supplier_price != null);

  // ── Tab: Suppliers ──────────────────────────────────────────────────────
  const [comparisonLength, setComparisonLength] = useState("");
  useEffect(() => { setComparisonLength(""); }, [analysisProductId]);

  const suppliersActive = tab === "suppliers";
  const { data: analysisLengths } = useFetch<{ lengths: number[] }>(
    suppliersActive && analysisProductId
      ? api("/bi-sync/product-lengths", { product_id: analysisProductId, start_date: startDate, end_date: endDate })
      : null, refreshTick);
  // Same stale-filter guard as the sales tab's length select.
  useEffect(() => {
    const ls = analysisLengths?.lengths;
    if (!ls) return;
    setComparisonLength(prev => (prev && !ls.includes(Number(prev)) ? "" : prev));
  }, [analysisLengths]);
  const { data: comparisonData, loading: comparisonLoading } = useFetch<{ points: SupplierPricePoint[] }>(
    suppliersActive && analysisProductId
      ? api("/bi-sync/supplier-price-comparison", { product_id: analysisProductId, start_date: startDate, end_date: endDate, length: comparisonLength })
      : null, refreshTick);

  // Volatility and market deviation work with or without a product filter —
  // a scope toggle rather than a hard requirement.
  const [supplierScopeAll, setSupplierScopeAll] = useState(false);
  const supplierScopeId = supplierScopeAll ? null : analysisProductId;
  const { data: volatilityData, loading: volatilityLoading } = useFetch<ScopedResult<VolatilityPoint>>(
    suppliersActive ? api("/bi-sync/supplier-volatility", { start_date: startDate, end_date: endDate, product_id: supplierScopeId }) : null, refreshTick);
  const { data: deviationData, loading: deviationLoading } = useFetch<ScopedResult<DeviationPoint>>(
    suppliersActive ? api("/bi-sync/supplier-market-deviation", { start_date: startDate, end_date: endDate, product_id: supplierScopeId }) : null, refreshTick);

  /** "Showing N of M — the rest have too few lines" — otherwise a ranking
   *  that silently shrinks from 15 suppliers to 3 looks like a bug. */
  function excludedNote(d: ScopedResult<unknown> | null): ReactNode {
    if (!d?.excluded) return null;
    return (
      <p className="text-xs text-ink-3">
        {t.excludedNote(String(d.points.length), String(d.total_suppliers ?? 0), String(d.excluded))}
      </p>
    );
  }

  // ── Tab: Seasonality ────────────────────────────────────────────────────
  const [seasonScopeAll, setSeasonScopeAll] = useState(true);
  const [seasonMetric, setSeasonMetric] = useState<Metric>("quantity");
  const seasonProductId = seasonScopeAll ? null : analysisProductId;
  const seasonActive = tab === "seasonality";
  const { data: seasonData, loading: seasonLoading } = useFetch<{ years: SeasonalityYear[] }>(
    seasonActive ? api("/bi-sync/seasonality", { product_id: seasonProductId }) : null, refreshTick);
  const { data: eventData, loading: eventLoading } = useFetch<{ events: EventImpact[] }>(
    seasonActive ? api("/bi-sync/event-impact", { product_id: seasonProductId }) : null, refreshTick);

  // One line per year, x = month, so the same months stack on top of each
  // other and a repeating pattern is visible at a glance. Only months the
  // backend actually returned — it no longer pads absent months to zero,
  // because a month with nothing synced is a gap, not a month with no sales.
  const seasonSeries: Series[] = useMemo(() => (seasonData?.years ?? []).map(y => ({
    key: String(y.year),
    label: String(y.year),
    points: y.months
      .filter(m => (seasonMetric === "quantity" ? m.quantity > 0 : m.price != null))
      .map(m => ({
        day: String(m.month).padStart(2, "0"),
        value: seasonMetric === "quantity" ? m.quantity : (m.price ?? 0),
        quantity: m.quantity,
      })),
  })), [seasonData, seasonMetric]);

  const [eventMetric, setEventMetric] = useState<Metric>("quantity");
  const eventChart = useMemo(() => {
    const events = eventData?.events ?? [];
    const years = Array.from(new Set(events.flatMap(e => e.years.map(y => y.year)))).sort();
    return {
      // `e.event` is a language-neutral key from the API (db.py _BI_EVENTS),
      // not display copy — fall back to the raw key if a new event lands
      // before its translation does.
      categories: events.map(e => t.eventNames[e.event] ?? e.event),
      series: years.map(year => ({
        key: String(year),
        label: String(year),
        values: events.map(e => {
          const row = e.years.find(y => y.year === year);
          if (!row) return null;
          return eventMetric === "quantity" ? row.volume_lift_pct : row.price_lift_pct;
        }),
      })),
    };
  }, [eventData, eventMetric, t]);

  const TABS: { id: Tab; label: string }[] = [
    { id: "sales", label: t.tabSales },
    { id: "price", label: t.tabPrice },
    { id: "suppliers", label: t.tabSuppliers },
    { id: "seasonality", label: t.tabSeasonality },
  ];

  // An empty product list is not the same as "you haven't picked one yet" —
  // before the 2026-09-03 sync fix every order_line was stored with a NULL
  // product_id, so the list stays empty until the range is re-synced.
  const needProduct = products.length ? (
    <p className="text-xs text-ink-3 py-6 text-center">{t.pickProductAbove}</p>
  ) : (
    <p className="text-xs text-ink-3 py-6 text-center max-w-xl mx-auto">{t.noProductsInRange}</p>
  );

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-bold text-ink">{t.title}</h2>
        <p className="text-sm text-ink-3 mt-0.5">{t.subtitle}</p>
      </div>

      {/* Ingestion — also runs automatically once a day (api_server.py
          _daily_bi_sync). The button is for manual/backfill runs. */}
      <div className="rounded-2xl border-2 border-emerald/25 bg-emerald-light p-4 flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-dark">{t.pipelineTitle}</p>
          <p className="text-xs text-ink-3 mt-0.5">{t.pipelineDesc}</p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">{t.syncFrom}</label>
            <input type="date" value={mutationDate} onChange={e => setMutationDate(e.target.value)} className={CTRL} />
          </div>
          <button
            onClick={runBiSync}
            disabled={syncStarting || serverRunning}
            className="h-9 px-4 rounded-lg text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity"
          >
            {syncStarting || serverRunning ? t.syncing : t.runSync}
          </button>
          {stats && (
            <span className="text-xs text-ink-3">
              {fmtNum(stats.stock_entry_dim_count ?? 0, locale)} {t.statStockEntries} ·{" "}
              {t.statSnapshotDays(String(stats.snapshot_days ?? 0))} ·{" "}
              {fmtNum(stats.order_lines_count ?? 0, locale)} {t.statOrderLines} ·{" "}
              {fmtNum(stats.invoice_customer_count ?? 0, locale)} {t.statInvoiceMaps}
            </span>
          )}
        </div>
        {latestRun?.error && (
          <p className="text-xs text-red-500 font-mono whitespace-pre-wrap break-all">{latestRun.error}</p>
        )}
        {!!latestRun?.messages?.length && (
          <details className="text-xs">
            <summary className="cursor-pointer text-ink-3 hover:text-ink">
              {t.lastRunLog(latestRun.mutation_from ?? "?", latestRun.status)}
            </summary>
            <div className="mt-1 bg-muted rounded-lg p-2 max-h-56 overflow-y-auto font-mono whitespace-pre-wrap break-all text-ink-3">
              {latestRun.messages.map((m, i) => <div key={i}>{m}</div>)}
            </div>
          </details>
        )}
      </div>

      {/* Wraps to further rows instead of scrolling horizontally — a scroll
          container hides tabs off-screen with no affordance. */}
      <div className="flex flex-wrap gap-2">
        {TABS.map(tb => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`px-4 h-9 rounded-lg text-sm font-medium whitespace-nowrap border transition-colors ${
              tab === tb.id
                ? "bg-emerald text-white border-emerald"
                : "border-border text-ink-3 hover:text-ink"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* ── Sales ────────────────────────────────────────────────────────── */}
      {tab === "sales" && (
        <Card
          title={t.salesTitle}
          hint={t.salesHint(viewMode === "supplier" ? t.salesKindSupplier : t.salesKindProduct)}
        >
          <div className="flex items-end gap-3 flex-wrap">
            {dateRange}
            <div className="flex rounded-lg border border-border overflow-hidden">
              {(["supplier", "product"] as ViewMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`h-9 px-3 text-sm font-medium transition-colors ${viewMode === m ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
                >
                  {m === "supplier" ? t.bySupplier : t.byProduct}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <select value={primaryId} onChange={e => setPrimaryId(e.target.value)} className={`${CTRL} max-w-md`}>
              <option value="">{viewMode === "supplier" ? t.allSuppliersTop : t.allProductsTop}</option>
              {viewMode === "supplier"
                ? suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.name || s.supplier_id} ({s.row_count})</option>)
                : products.map(p => <option key={p.product_id} value={p.product_id}>{p.description || p.product_id} ({p.row_count})</option>)}
            </select>

            {viewMode === "product" && primaryId && !!(salesLengths?.lengths ?? []).length && (
              <select value={salesLength} onChange={e => setSalesLength(e.target.value)} className={CTRL}>
                <option value="">{t.allLengths}</option>
                {(salesLengths?.lengths ?? []).map(l => <option key={l} value={l}>{l}cm</option>)}
              </select>
            )}

            {!!salesSeries.length && (
              <select value={highlightKey} onChange={e => setHighlightKey(e.target.value)} className={`${CTRL} max-w-md`}>
                <option value="">{t.highlightLine}</option>
                {salesSeries.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            )}
          </div>

          <Loading when={salesLoading} text={t.loading} />
          {!salesLoading && !salesSeries.length && <p className="text-xs text-ink-3">{t.noSalesInRange}</p>}
          {!!displaySeries.length && (
            <MultiLineChart
              series={displaySeries}
              highlightKey={highlightKey}
              locale={locale}
              emptyText={t.noDataRange}
              soldLabel={t.soldBoxes}
            />
          )}
        </Card>
      )}

      {/* ── Price & profitability ────────────────────────────────────────── */}
      {tab === "price" && (
        <>
          <div className="rounded-2xl border border-border p-4 flex items-end gap-3 flex-wrap">
            {dateRange}
            {productPicker}
          </div>

          <Card title={t.trendTitle} hint={t.trendHint(productLabel || t.selectProduct)}>
            <Loading when={trendLoading} text={t.loading} />
            {!analysisProductId ? needProduct : (
              <MultiLineChart
                series={trendData?.series ?? []}
                locale={locale}
                emptyText={t.noDataRange}
                soldLabel={t.soldBoxes}
              />
            )}
          </Card>

          <Card title={t.lengthTitle} hint={t.lengthHint}>
            <Loading when={lengthLoading} text={t.loading} />
            {!analysisProductId ? needProduct : (
              <>
                <GroupedBarChart
                  categories={lengthCats}
                  series={[
                    { key: "sale", label: t.seriesSalePrice, values: lengthPoints.map(p => p.avg_price) },
                    // Only offered when at least one length actually has a
                    // purchase price. supplier_price can be entirely absent
                    // from the export, and an all-null series would still
                    // claim a legend entry and a color while drawing nothing.
                    ...(hasCostData
                      ? [{ key: "cost", label: t.seriesCostPrice, values: lengthPoints.map(p => p.avg_supplier_price) }]
                      : []),
                  ]}
                  formatValue={fmtPrice}
                  height={280}
                  emptyText={t.noDataRange}
                />
                {!hasCostData && !!lengthPoints.length && (
                  <p className="text-xs text-ink-3">{t.noCostData}</p>
                )}
                <p className="text-xs text-ink-3 pt-2 border-t border-border">
                  {t.marginNoteA} <strong>{t.marginNoteNo}</strong> {t.marginNoteB}
                  <code className="mx-1 font-mono">customer_stock_item_commission</code>
                  {t.marginNoteC} <code className="font-mono">cost = 1</code>
                  {t.marginNoteD}
                </p>
              </>
            )}
          </Card>

          <Card
            title={t.elasticityTitle}
            hint={
              <>
                <strong>{t.whatItShows}</strong> {t.elasticityWhat}
                <br />
                <strong>{t.howToRead}</strong> {t.elasticityHow}
                <br />
                <strong>{t.whatToUse}</strong> {t.elasticityUse}
              </>
            }
          >
            <Loading when={elasticityLoading} text={t.loading} />
            {!analysisProductId ? needProduct : (
              <>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-2xl font-bold text-ink tabular-nums">
                    {elasticityData?.correlation != null ? elasticityData.correlation.toFixed(2) : "—"}
                  </span>
                  <span className="text-xs text-ink-3">
                    {t.correlationLabel} · {elasticityVerdict(elasticityData?.correlation ?? null, t)}
                  </span>
                </div>
                <ScatterChart
                  points={elasticityData?.points ?? []}
                  xAxisLabel={t.avgWeekPrice}
                  yAxisLabel={t.boxes}
                  locale={locale}
                  emptyText={t.noDataRange}
                  boxesLabel={t.soldBoxes}
                />
              </>
            )}
          </Card>
        </>
      )}

      {/* ── Suppliers ────────────────────────────────────────────────────── */}
      {tab === "suppliers" && (
        <>
          <div className="rounded-2xl border border-border p-4 flex items-end gap-3 flex-wrap">
            {dateRange}
            {productPicker}
          </div>

          <Card title={t.comparisonTitle} hint={t.comparisonHint(productLabel || t.selectProduct)}>
            <div className="flex items-center gap-3 flex-wrap">
              {!!(analysisLengths?.lengths ?? []).length && (
                <select value={comparisonLength} onChange={e => setComparisonLength(e.target.value)} className={CTRL}>
                  <option value="">{t.allLengths}</option>
                  {(analysisLengths?.lengths ?? []).map(l => <option key={l} value={l}>{l}cm</option>)}
                </select>
              )}
            </div>
            <Loading when={comparisonLoading} text={t.loading} />
            {!analysisProductId ? needProduct : (
              <HBarChart
                points={(comparisonData?.points ?? []).map(p => ({
                  label: p.name,
                  value: p.avg_price,
                  sublabel: `${fmtPrice(p.min_price)}–${fmtPrice(p.max_price)}`,
                  volume: p.quantity,
                }))}
                format={fmtPrice}
                valueHeader={t.avgPriceMinMax}
                volumeHeader={t.boxes}
                locale={locale}
                emptyText={t.noDataRange}
              />
            )}
          </Card>

          <div className="rounded-2xl border border-border p-4 flex flex-col gap-2">
            <p className="text-xs text-ink-3 max-w-3xl">
              <strong>{t.scopeHeading}</strong>{" "}
              <em>{t.scopeSelected}</em> {t.scopeSelectedDesc(productLabel || t.selectProduct)}
              <em>{t.scopeAll}</em> {t.scopeAllDesc}
            </p>
            <div className="flex rounded-lg border border-border overflow-hidden w-fit">
              <button
                onClick={() => setSupplierScopeAll(false)}
                disabled={!analysisProductId}
                className={`h-9 px-3 text-sm font-medium transition-colors disabled:opacity-40 ${!supplierScopeAll ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
              >
                {t.scopeSelected}
              </button>
              <button
                onClick={() => setSupplierScopeAll(true)}
                className={`h-9 px-3 text-sm font-medium transition-colors ${supplierScopeAll ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
              >
                {t.scopeAll}
              </button>
            </div>
          </div>

          <Card title={t.volatilityTitle} hint={t.volatilityHint}>
            <Loading when={volatilityLoading} text={t.loading} />
            <HBarChart
              points={(volatilityData?.points ?? []).map(p => ({
                label: p.name,
                value: p.cv_pct ?? 0,
                sublabel: `${fmtPrice(p.avg_price)} · ${p.product_count}`,
                volume: p.line_count,
              }))}
              format={v => (v == null ? "—" : `${v.toFixed(1)}%`)}
              color={COLOR_ABOVE}
              valueHeader={t.volatilityCol}
              volumeHeader={t.linesCol}
              locale={locale}
              emptyText={t.volatilityEmpty}
            />
            {excludedNote(volatilityData)}
          </Card>

          <Card title={t.deviationTitle} hint={t.deviationHint}>
            <Loading when={deviationLoading} text={t.loading} />
            <DivergingBarChart
              points={(deviationData?.points ?? []).map(p => ({
                label: p.name,
                value: p.deviation_pct,
                sublabel: `${fmtPrice(p.avg_price)} vs ${fmtPrice(p.market_price)} ${t.marketWord} · ${fmtNum(p.line_count, locale)} ${t.linesWord}`,
              }))}
              aboveLabel={t.aboveMarket}
              belowLabel={t.belowMarket}
              emptyText={t.deviationEmpty}
            />
            {excludedNote(deviationData)}
          </Card>
        </>
      )}

      {/* ── Seasonality & demand ─────────────────────────────────────────── */}
      {tab === "seasonality" && (
        <>
          <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
            <p className="text-xs text-ink-3 max-w-3xl">
              {t.seasonNoteA} <strong>{t.seasonNoteWhole}</strong>{t.seasonNoteB}{" "}
              <strong>{t.seasonNoteGap}</strong> {t.seasonNoteC}
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex rounded-lg border border-border overflow-hidden">
                <button
                  onClick={() => setSeasonScopeAll(true)}
                  className={`h-9 px-3 text-sm font-medium transition-colors ${seasonScopeAll ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
                >
                  {t.scopeAll}
                </button>
                <button
                  onClick={() => setSeasonScopeAll(false)}
                  disabled={!analysisProductId}
                  className={`h-9 px-3 text-sm font-medium transition-colors disabled:opacity-40 ${!seasonScopeAll ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
                >
                  {t.scopeSelected}
                </button>
              </div>
              {!seasonScopeAll && productPicker}
            </div>
          </div>

          <Card title={t.seasonalityTitle} hint={t.seasonalityHint}>
            <div className="flex rounded-lg border border-border overflow-hidden w-fit">
              {(["quantity", "price"] as Metric[]).map(m => (
                <button
                  key={m}
                  onClick={() => setSeasonMetric(m)}
                  className={`h-9 px-3 text-sm font-medium transition-colors ${seasonMetric === m ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
                >
                  {m === "quantity" ? t.metricVolume : t.metricPrice}
                </button>
              ))}
            </div>
            <Loading when={seasonLoading} text={t.loading} />
            <MultiLineChart
              series={seasonSeries}
              xLabel={monthLbl}
              tipLabel={monthLbl}
              formatValue={seasonMetric === "quantity" ? (v => fmtNum(v, locale)) : fmtPrice}
              showQuantity={seasonMetric === "price"}
              locale={locale}
              emptyText={t.noDataRange}
              soldLabel={t.soldBoxes}
            />
          </Card>

          <Card
            title={t.eventsTitle}
            hint={
              <>
                <strong>{t.whatItShows}</strong> {t.eventsWhat}
                <br />
                <strong>{t.eventsWindowsLabel}</strong> {t.eventsWindows}
                <br />
                <strong>{t.eventsBaselineLabel}</strong> {t.eventsBaseline}
              </>
            }
          >
            <div className="flex rounded-lg border border-border overflow-hidden w-fit">
              {(["quantity", "price"] as Metric[]).map(m => (
                <button
                  key={m}
                  onClick={() => setEventMetric(m)}
                  className={`h-9 px-3 text-sm font-medium transition-colors ${eventMetric === m ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
                >
                  {m === "quantity" ? t.metricVolume : t.metricPrice}
                </button>
              ))}
            </div>
            <Loading when={eventLoading} text={t.loading} />
            <GroupedBarChart
              categories={eventChart.categories}
              series={eventChart.series}
              formatValue={fmtPct}
              height={300}
              emptyText={t.noDataRange}
            />
          </Card>

          <div className="rounded-2xl border border-border border-dashed p-4">
            <p className="text-sm font-semibold text-ink">{t.forecastTitle}</p>
            <p className="text-xs text-ink-3 mt-1">{t.forecastBody}</p>
          </div>
        </>
      )}
    </div>
  );
}

/** Previous value across renders — used to detect the running -> finished
 *  edge of a sync, so downstream charts refetch exactly once when it lands. */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => { ref.current = value; }, [value]);
  return ref.current;
}
