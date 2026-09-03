"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Lang } from "@/lib/i18n";
import {
  MultiLineChart, ScatterChart, GroupedBarChart, HBarChart, DivergingBarChart,
  Series, ScatterPoint, fmtPrice, fmtNum, fmtPct, monthLabel,
  COLOR_ABOVE,
} from "./analysis/charts";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

const CTRL = "h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors";

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
    event_avg_quantity: number | null;
    baseline_avg_quantity: number | null;
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

function Card({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
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

function Loading({ when }: { when: boolean }) {
  return when ? <p className="text-xs text-ink-3">Ładowanie…</p> : null;
}

/** Plain-language reading of the price/volume correlation — the number alone
 *  invites over-reading a weak signal as a demand curve. */
function elasticityVerdict(c: number | null): string {
  if (c == null) return "Za mało punktów, żeby cokolwiek policzyć.";
  if (c <= -0.5) return "Silna ujemna zależność — popyt wyraźnie reaguje na cenę.";
  if (c <= -0.2) return "Umiarkowana ujemna zależność — cena ma widoczny, ale nie dominujący wpływ.";
  if (c < 0.2) return "Brak wyraźnej zależności — wolumen w tym okresie nie idzie za ceną.";
  return "Zależność dodatnia — droższe okresy to zarazem większy wolumen, co zwykle znaczy sezon (Walentynki itp.), a nie elastyczność.";
}

export default function AnalysisTool({ lang: _lang }: { lang: Lang }) {
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
    if (prevRunning && !serverRunning) setRefreshTick(t => t + 1);
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
  // otherwise fall to the top seller. The old version cleared an invalid
  // selection to "" and then never re-selected, because the effect doesn't
  // re-run until `products` changes again — leaving the picker blank after
  // narrowing the date range (fixed 2026-09-03).
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
      <option value="">— wybierz produkt —</option>
      {products.map(p => (
        <option key={p.product_id} value={p.product_id}>{p.description || p.product_id} ({p.row_count})</option>
      ))}
    </select>
  );

  const dateRange = (
    <>
      <div>
        <label className="block text-[11px] text-ink-3 mb-1">Od</label>
        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={CTRL} />
      </div>
      <div>
        <label className="block text-[11px] text-ink-3 mb-1">do</label>
        <input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} className={CTRL} />
      </div>
    </>
  );

  // ── Tab: Sprzedaż ───────────────────────────────────────────────────────
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

  // ── Tab: Cena i rentowność ──────────────────────────────────────────────
  const priceActive = tab === "price" && !!analysisProductId;
  const { data: trendData, loading: trendLoading } = useFetch<{ series: Series[] }>(
    priceActive ? api("/bi-sync/price-trend-by-length", { product_id: analysisProductId, start_date: startDate, end_date: endDate }) : null, refreshTick);
  const { data: lengthData, loading: lengthLoading } = useFetch<{ points: LengthPoint[] }>(
    priceActive ? api("/bi-sync/price-vs-length", { product_id: analysisProductId, start_date: startDate, end_date: endDate }) : null, refreshTick);
  const { data: elasticityData, loading: elasticityLoading } = useFetch<{ points: ScatterPoint[]; correlation: number | null }>(
    priceActive ? api("/bi-sync/price-elasticity", { product_id: analysisProductId, start_date: startDate, end_date: endDate }) : null, refreshTick);

  const lengthPoints = lengthData?.points ?? [];
  const lengthCats = lengthPoints.map(p => `${p.length}cm`);

  // ── Tab: Dostawcy ───────────────────────────────────────────────────────
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

  /** "Pokazano N z M — reszta ma za mało linii" — otherwise a ranking that
   *  silently shrinks from 15 suppliers to 3 looks like a bug. */
  function excludedNote(d: ScopedResult<unknown> | null): React.ReactNode {
    if (!d?.excluded) return null;
    return (
      <p className="text-xs text-ink-3">
        Pokazano {d.points.length} z {d.total_suppliers} dostawców w tym zakresie. Pominięto {d.excluded} —
        mają za mało linii sprzedaży, żeby liczba była wiarygodna.
      </p>
    );
  }

  // ── Tab: Sezonowość ─────────────────────────────────────────────────────
  const [seasonScopeAll, setSeasonScopeAll] = useState(true);
  const [seasonMetric, setSeasonMetric] = useState<Metric>("quantity");
  const seasonProductId = seasonScopeAll ? null : analysisProductId;
  const seasonActive = tab === "seasonality";
  const { data: seasonData, loading: seasonLoading } = useFetch<{ years: SeasonalityYear[] }>(
    seasonActive ? api("/bi-sync/seasonality", { product_id: seasonProductId }) : null, refreshTick);
  const { data: eventData, loading: eventLoading } = useFetch<{ events: EventImpact[] }>(
    seasonActive ? api("/bi-sync/event-impact", { product_id: seasonProductId }) : null, refreshTick);

  // One line per year, x = month, so the same months stack on top of each
  // other and a repeating pattern is visible at a glance.
  // Only months the backend actually returned. It no longer pads absent
  // months to zero — a month with nothing synced is a gap in the line, not
  // a month with no sales (we always sell something), which is what made
  // the old chart read as periodic collapses to zero.
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
      categories: events.map(e => e.event),
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
  }, [eventData, eventMetric]);

  const TABS: { id: Tab; label: string }[] = [
    { id: "sales", label: "Sprzedaż" },
    { id: "price", label: "Cena i rentowność" },
    { id: "suppliers", label: "Dostawcy" },
    { id: "seasonality", label: "Sezonowość i popyt" },
  ];

  // An empty product list is not the same as "you haven't picked one yet" —
  // before the 2026-09-03 sync fix every order_line was stored with a NULL
  // product_id, so the list stays empty until the range is re-synced.
  const needProduct = products.length ? (
    <p className="text-xs text-ink-3 py-6 text-center">Wybierz produkt powyżej.</p>
  ) : (
    <p className="text-xs text-ink-3 py-6 text-center max-w-xl mx-auto">
      Brak produktów w tym zakresie dat. Jeśli lista jest pusta również dla szerszego zakresu,
      uruchom ponownie sync — linie sprzedaży zapisane przed poprawką z 2026-09-03 nie mają
      przypisanego produktu i trzeba je pobrać jeszcze raz.
    </p>
  );

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-bold text-ink">Analysis Tool</h2>
        <p className="text-sm text-ink-3 mt-0.5">
          Analiza sprzedaży OZEDS (FreshPortal BI Sync). Wszystkie ceny to zrealizowana cena sprzedaży, nie cena ofertowa.
        </p>
      </div>

      {/* Ingestion — also runs automatically once a day (api_server.py
          _daily_bi_sync). The button is for manual/backfill runs. */}
      <div className="rounded-2xl border-2 border-emerald/25 bg-emerald-light p-4 flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-dark">Data pipeline</p>
          <p className="text-xs text-ink-3 mt-0.5">
            Działa automatycznie raz dziennie. Poniżej ręczny sync/backfill — pobiera wszystko od wybranej daty do dziś
            (API zwraca dane po dacie mutacji, nie utworzenia, więc i tak są lokalnie filtrowane po dacie utworzenia).
          </p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">Sync od</label>
            <input type="date" value={mutationDate} onChange={e => setMutationDate(e.target.value)} className={CTRL} />
          </div>
          <button
            onClick={runBiSync}
            disabled={syncStarting || serverRunning}
            className="h-9 px-4 rounded-lg text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity"
          >
            {syncStarting || serverRunning ? "Syncing…" : "Run BI sync"}
          </button>
          {stats && (
            <span className="text-xs text-ink-3">
              {stats.stock_entry_dim_count?.toLocaleString() ?? 0} stock_entries ·{" "}
              {stats.snapshot_days ?? 0} snapshot day(s) ·{" "}
              {stats.order_lines_count?.toLocaleString() ?? 0} order_lines (OZEDS) ·{" "}
              {stats.invoice_customer_count?.toLocaleString() ?? 0} invoice→customer mappings
            </span>
          )}
        </div>
        {latestRun?.error && (
          <p className="text-xs text-red-500 font-mono whitespace-pre-wrap break-all">{latestRun.error}</p>
        )}
        {!!latestRun?.messages?.length && (
          <details className="text-xs">
            <summary className="cursor-pointer text-ink-3 hover:text-ink">
              Last run log ({latestRun.mutation_from ?? "?"}, {latestRun.status})
            </summary>
            <div className="mt-1 bg-muted rounded-lg p-2 max-h-56 overflow-y-auto font-mono whitespace-pre-wrap break-all text-ink-3">
              {latestRun.messages.map((m, i) => <div key={i}>{m}</div>)}
            </div>
          </details>
        )}
      </div>

      {/* Wraps to further rows instead of scrolling horizontally — a scroll
          container hides tabs off-screen with no affordance. Pill styling
          rather than an underline strip, since a shared bottom border can't
          follow tabs onto a second row. */}
      <div className="flex flex-wrap gap-2">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 h-9 rounded-lg text-sm font-medium whitespace-nowrap border transition-colors ${
              tab === t.id
                ? "bg-emerald text-white border-emerald"
                : "border-border text-ink-3 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Sprzedaż ─────────────────────────────────────────────────────── */}
      {tab === "sales" && (
        <Card
          title="Sprzedaż w czasie"
          hint={`Cena sprzedaży w wybranym zakresie dat. Domyślnie top 10 ${viewMode === "supplier" ? "dostawców" : "produktów"} ogółem — wybierz konkretny wpis, żeby zejść w szczegóły. Najedź na punkt, żeby zobaczyć ilość sprzedanych pudełek.`}
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
                  {m === "supplier" ? "Wg dostawcy" : "Wg produktu"}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <select value={primaryId} onChange={e => setPrimaryId(e.target.value)} className={`${CTRL} max-w-md`}>
              <option value="">{viewMode === "supplier" ? "— wszyscy dostawcy (top 10) —" : "— wszystkie produkty (top 10) —"}</option>
              {viewMode === "supplier"
                ? suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.name || s.supplier_id} ({s.row_count})</option>)
                : products.map(p => <option key={p.product_id} value={p.product_id}>{p.description || p.product_id} ({p.row_count})</option>)}
            </select>

            {viewMode === "product" && primaryId && !!(salesLengths?.lengths ?? []).length && (
              <select value={salesLength} onChange={e => setSalesLength(e.target.value)} className={CTRL}>
                <option value="">wszystkie długości (średnia)</option>
                {(salesLengths?.lengths ?? []).map(l => <option key={l} value={l}>{l}cm</option>)}
              </select>
            )}

            {!!salesSeries.length && (
              <select value={highlightKey} onChange={e => setHighlightKey(e.target.value)} className={`${CTRL} max-w-md`}>
                <option value="">— podświetl linię —</option>
                {salesSeries.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            )}
          </div>

          <Loading when={salesLoading} />
          {!salesLoading && !salesSeries.length && <p className="text-xs text-ink-3">Brak sprzedaży w wybranym zakresie.</p>}
          {!!displaySeries.length && <MultiLineChart series={displaySeries} highlightKey={highlightKey} />}
        </Card>
      )}

      {/* ── Cena i rentowność ────────────────────────────────────────────── */}
      {tab === "price" && (
        <>
          <div className="rounded-2xl border border-border p-4 flex items-end gap-3 flex-wrap">
            {dateRange}
            {productPicker}
          </div>

          <Card
            title="Trend ceny w czasie"
            hint={`Jedna linia na długość łodygi — ${productLabel || "produkt"}. Uzupełnia wykres „Sprzedaż” (tam linie to dostawcy); większość rozrzutu ceny w obrębie jednego produktu bierze się właśnie z długości.`}
          >
            <Loading when={trendLoading} />
            {!analysisProductId ? needProduct : <MultiLineChart series={trendData?.series ?? []} />}
          </Card>

          <Card
            title="Cena vs długość łodygi"
            hint="Średnia cena sprzedaży i cena zakupu towaru na każdej długości — obie w tej samej jednostce, więc stoją na jednej osi."
          >
            <Loading when={lengthLoading} />
            {!analysisProductId ? needProduct : (
              <>
                <GroupedBarChart
                  categories={lengthCats}
                  series={[
                    { key: "sale", label: "Cena sprzedaży", values: lengthPoints.map(p => p.avg_price) },
                    // Only offered when at least one length actually has a
                    // purchase price. supplier_price can be entirely absent
                    // from the export, and an all-null series would still
                    // claim a legend entry and a color while drawing nothing.
                    ...(lengthPoints.some(p => p.avg_supplier_price != null)
                      ? [{ key: "cost", label: "Cena zakupu towaru", values: lengthPoints.map(p => p.avg_supplier_price) }]
                      : []),
                  ]}
                  formatValue={fmtPrice}
                  height={280}
                />
                {!lengthPoints.some(p => p.avg_supplier_price != null) && !!lengthPoints.length && (
                  <p className="text-xs text-ink-3">
                    Brak ceny zakupu w danych — eksport nie zwrócił <code className="font-mono">supplier_price</code> dla
                    żadnej linii tego produktu, więc pokazana jest tylko cena sprzedaży.
                  </p>
                )}
                <p className="text-xs text-ink-3 pt-2 border-t border-border">
                  Świadomie <strong>nie</strong> ma tu wykresu marży. Różnica między tymi słupkami to narzut na samym
                  towarze, a nie marża — pełny koszt zawiera jeszcze prowizje i handling z tabeli
                  <code className="mx-1 font-mono">customer_stock_item_commission</code>
                  (wiersze z <code className="font-mono">cost = 1</code>), której na razie nie pobieramy.
                  Nazwanie tego marżą zawyżałoby wynik.
                </p>
              </>
            )}
          </Card>

          <Card
            title="Elastyczność cenowa (wolumen vs cena)"
            hint={
              <>
                <strong>Co to pokazuje:</strong> każdy punkt to jeden tydzień. W poziomie — średnia cena
                w tym tygodniu. W pionie — ile pudełek wtedy zeszło. Nie ma tu osi czasu: pytanie brzmi
                „czy przy wyższej cenie sprzedajemy mniej”, a nie „co się działo w marcu”.
                <br />
                <strong>Jak czytać:</strong> chmura opadająca w prawo (drożej → mniej sztuk) znaczy, że
                klient reaguje na cenę i podwyżka kosztuje wolumen. Chmura płaska znaczy, że w badanym
                przedziale cena nie rusza popytu — masz przestrzeń cenową. Chmura rosnąca prawie nigdy nie
                znaczy „drożej = lepiej”, tylko że sezon rządzi jednym i drugim (Walentynki: i ceny, i
                wolumen w górę naraz).
                <br />
                <strong>Do czego użyć:</strong> pierwsza sytuacja to argument, żeby nie podnosić ceny na
                tym produkcie; druga — że można spróbować.
                Tygodnie, nie dni, bo dzienne punkty pokazują głównie rytm spływania zamówień.
              </>
            }
          >
            <Loading when={elasticityLoading} />
            {!analysisProductId ? needProduct : (
              <>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-2xl font-bold text-ink tabular-nums">
                    {elasticityData?.correlation != null ? elasticityData.correlation.toFixed(2) : "—"}
                  </span>
                  <span className="text-xs text-ink-3">
                    korelacja cena↔wolumen (−1 = im drożej tym mniej, 0 = brak związku, +1 = razem rosną)
                    · {elasticityVerdict(elasticityData?.correlation ?? null)}
                  </span>
                </div>
                <ScatterChart points={elasticityData?.points ?? []} xAxisLabel="Średnia cena sprzedaży w tygodniu" yAxisLabel="Pudełka" />
              </>
            )}
          </Card>
        </>
      )}

      {/* ── Dostawcy ─────────────────────────────────────────────────────── */}
      {tab === "suppliers" && (
        <>
          <div className="rounded-2xl border border-border p-4 flex items-end gap-3 flex-wrap">
            {dateRange}
            {productPicker}
          </div>

          <Card
            title="Porównanie cen dostawców"
            hint={`Średnia cena sprzedaży na dostawcę — ${productLabel || "produkt"}, sortowane od najtańszego. Słupki liczone od zera; przy zbliżonych cenach patrz na liczby, nie na długość słupka.`}
          >
            <div className="flex items-center gap-3 flex-wrap">
              {!!(analysisLengths?.lengths ?? []).length && (
                <select value={comparisonLength} onChange={e => setComparisonLength(e.target.value)} className={CTRL}>
                  <option value="">wszystkie długości (średnia)</option>
                  {(analysisLengths?.lengths ?? []).map(l => <option key={l} value={l}>{l}cm</option>)}
                </select>
              )}
            </div>
            <Loading when={comparisonLoading} />
            {!analysisProductId ? needProduct : (
              <HBarChart
                points={(comparisonData?.points ?? []).map(p => ({
                  label: p.name,
                  value: p.avg_price,
                  sublabel: `${fmtPrice(p.min_price)}–${fmtPrice(p.max_price)}`,
                  volume: p.quantity,
                }))}
                format={fmtPrice}
                valueHeader="Śr. cena (min–max)"
                volumeHeader="Pudełka"
              />
            )}
          </Card>

          <div className="rounded-2xl border border-border p-4 flex flex-col gap-2">
            <p className="text-xs text-ink-3 max-w-3xl">
              <strong>Zakres dwóch wykresów poniżej.</strong>{" "}
              <em>Wybrany produkt</em> — liczy tylko linie tego jednego produktu, czyli „jak ci dostawcy
              zachowują się konkretnie przy {productLabel || "tym produkcie"}”. <em>Wszystkie produkty</em> —
              liczy cały asortyment każdego dostawcy, czyli „jak ten dostawca zachowuje się w ogóle”,
              również na towarach, których nie ma w wykresie porównania wyżej. Porównanie zawsze liczone
              wewnątrz tej samej pary produkt+długość, więc szerszy zakres nie miesza róż z piwoniami.
            </p>
            <div className="flex rounded-lg border border-border overflow-hidden w-fit">
              <button
                onClick={() => setSupplierScopeAll(false)}
                disabled={!analysisProductId}
                className={`h-9 px-3 text-sm font-medium transition-colors disabled:opacity-40 ${!supplierScopeAll ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
              >
                Wybrany produkt
              </button>
              <button
                onClick={() => setSupplierScopeAll(true)}
                className={`h-9 px-3 text-sm font-medium transition-colors ${supplierScopeAll ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
              >
                Wszystkie produkty
              </button>
            </div>
          </div>

          <Card
            title="Wahania cen (volatility) dostawcy"
            hint="Współczynnik zmienności (odchylenie standardowe / średnia) ceny sprzedaży, w %. Liczony osobno dla każdej pary dostawca–produkt i dopiero potem uśredniany — inaczej mierzyłby asortyment (róże vs piwonie), a nie stabilność cen. Wyżej = mniej przewidywalny. Wariancja wymaga co najmniej 3 linii na produkt, więc dostawcy z pojedynczymi transakcjami nie mogą się tu pojawić — ilu ich było, pisze pod wykresem."
          >
            <Loading when={volatilityLoading} />
            <HBarChart
              points={(volatilityData?.points ?? []).map(p => ({
                label: p.name,
                value: p.cv_pct ?? 0,
                sublabel: `${fmtPrice(p.avg_price)} śr. · ${p.product_count} prod.`,
                volume: p.line_count,
              }))}
              format={v => (v == null ? "—" : `${v.toFixed(1)}%`)}
              color={COLOR_ABOVE}
              valueHeader="Zmienność"
              volumeHeader="Linie"
              emptyText="Za mało linii, żeby policzyć zmienność w tym zakresie."
            />
            {excludedNote(volatilityData)}
          </Card>

          <Card
            title="Odchylenia od średniej rynkowej"
            hint="O ile % dostawca jest droższy/tańszy od średniej dla tego samego produktu i tej samej długości w tym samym okresie. Porównanie liczone per linia, więc różnice asortymentu się nie przenoszą na wynik. „Rynek” to tu wyłącznie nasi właśni dostawcy w tym zakresie dat — nie zewnętrzny benchmark — więc przy jednym dostawcy odchylenie z definicji wyjdzie 0%."
          >
            <Loading when={deviationLoading} />
            <DivergingBarChart
              points={(deviationData?.points ?? []).map(p => ({
                label: p.name,
                value: p.deviation_pct,
                sublabel: `${fmtPrice(p.avg_price)} vs ${fmtPrice(p.market_price)} rynek · ${fmtNum(p.line_count)} linii`,
              }))}
              emptyText="Za mało linii, żeby porównać z rynkiem w tym zakresie."
            />
            {excludedNote(deviationData)}
          </Card>
        </>
      )}

      {/* ── Sezonowość i popyt ───────────────────────────────────────────── */}
      {tab === "seasonality" && (
        <>
          <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
            <p className="text-xs text-ink-3 max-w-3xl">
              Te dwa wykresy celowo ignorują zakres dat powyżej — sezonowość wymaga pełnych lat, nie
              90-dniowego okna. Obejmują <strong>całą zsynchronizowaną historię</strong>, więc jeśli
              masz dane od stycznia 2022, zobaczysz tu 2022 jako osobną linię bez żadnych ustawień.
              Miesiąc, dla którego nic nie zsynchronizowano, zostawia <strong>przerwę w linii</strong> —
              nie jest rysowany jako zero.
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex rounded-lg border border-border overflow-hidden">
                <button
                  onClick={() => setSeasonScopeAll(true)}
                  className={`h-9 px-3 text-sm font-medium transition-colors ${seasonScopeAll ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
                >
                  Wszystkie produkty
                </button>
                <button
                  onClick={() => setSeasonScopeAll(false)}
                  disabled={!analysisProductId}
                  className={`h-9 px-3 text-sm font-medium transition-colors disabled:opacity-40 ${!seasonScopeAll ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
                >
                  Wybrany produkt
                </button>
              </div>
              {!seasonScopeAll && productPicker}
            </div>
          </div>

          <Card
            title="Sezonowość cen i popytu"
            hint="Jedna linia na rok, miesiące na osi X — lata nakładają się na siebie, więc powtarzalny wzorzec widać od razu."
          >
            <div className="flex rounded-lg border border-border overflow-hidden w-fit">
              {(["quantity", "price"] as Metric[]).map(m => (
                <button
                  key={m}
                  onClick={() => setSeasonMetric(m)}
                  className={`h-9 px-3 text-sm font-medium transition-colors ${seasonMetric === m ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
                >
                  {m === "quantity" ? "Wolumen" : "Cena"}
                </button>
              ))}
            </div>
            <Loading when={seasonLoading} />
            <MultiLineChart
              series={seasonSeries}
              xLabel={monthLabel}
              tipLabel={monthLabel}
              formatValue={seasonMetric === "quantity" ? fmtNum : fmtPrice}
              showQuantity={seasonMetric === "price"}
            />
          </Card>

          <Card
            title="Wpływ świąt i wydarzeń"
            hint={
              <>
                <strong>Co to pokazuje:</strong> o ile % lepszy (lub gorszy) był przeciętny dzień w oknie
                sprzedażowym święta niż przeciętny zwykły dzień <em>w tych samych tygodniach</em>. Słupek
                +80% na Walentynkach znaczy: w oknie walentynkowym schodziło dziennie o 80% więcej pudełek
                niż w zwykłe dni tuż obok.
                <br />
                <strong>Okna, nie same daty:</strong> kwiaty na 14 lutego sprzedają się w poprzedzających
                dwóch tygodniach, więc okno to 25 stycznia – 11 lutego, a nie sam 14 lutego.
                <br />
                <strong>Punkt odniesienia:</strong> zwykłe dni w promieniu 45 dni od okna, z wykluczeniem
                innych świąt. Wcześniej porównywaliśmy do średniej z całego roku — stąd absurdalne −63% na
                Walentynki: średnia roczna jest zawyżana przez miesiące lepiej pokryte backfillem, więc
                realny szczyt wychodził na spadek. Rok z niepełnymi danymi w danym oknie jest pomijany,
                a nie pokazywany jako zero.
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
                  {m === "quantity" ? "Wolumen" : "Cena"}
                </button>
              ))}
            </div>
            <Loading when={eventLoading} />
            <GroupedBarChart
              categories={eventChart.categories}
              series={eventChart.series}
              formatValue={fmtPct}
              height={300}
            />
          </Card>

          <div className="rounded-2xl border border-border border-dashed p-4">
            <p className="text-sm font-semibold text-ink">Prognoza popytu</p>
            <p className="text-xs text-ink-3 mt-1">
              Celowo jeszcze nie zbudowana. Sensowna prognoza sezonowa potrzebuje co najmniej dwóch pełnych cykli
              rocznych, a backfill jest w tej chwili niekompletny — wykres na tych danych wyglądałby wiarygodnie
              i byłby zmyślony. Wrócimy do tego po dociągnięciu historii; wtedy naturalnym pierwszym krokiem jest
              seasonal-naive (ten sam tydzień rok temu skorygowany o trend r/r) jako punkt odniesienia.
            </p>
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
