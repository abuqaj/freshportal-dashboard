"use client";

import { useState, useCallback, useEffect } from "react";
import { Lang } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

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

// ── Sales-by-supplier / sales-by-product analysis (redesigned 2026-09-02/03) ──
interface ProductOnlyPickerItem {
  product_id: string;
  description: string | null;
  row_count: number;
}

interface SupplierPickerItem {
  supplier_id: string;
  name: string | null;
  row_count: number;
}

interface SeriesPoint {
  day: string;
  value: number;
  quantity: number;
}

interface Series {
  key: string;
  label: string;
  points: SeriesPoint[];
}

interface SalesSeriesResult {
  series: Series[];
}

type ViewMode = "supplier" | "product";

function shortDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtPrice(v: number | null | undefined): string {
  return v == null ? "" : `$${v.toFixed(3)}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// User-specified 7-color line palette (fixed order — 2026-09-03).
const LINE_COLORS = ["#B03A2B", "#F7C4BC", "#1A7D45", "#C4DED0", "#E4E1D8", "#8E8B81", "#000000"];

// Dependency-free multi-series line chart — x=day (shared across all series,
// evenly spaced by position not by actual date gaps), y=value, colored lines
// with a legend below. A custom React-state-driven HTML tooltip replaces the
// native SVG <title> mechanism, which never fired: the invisible larger hit
// circle used fill="transparent", and SVG shapes only receive pointer events
// on "painted" (visibly filled) areas by default — pointerEvents="all" below
// forces hit-testing on it regardless of fill (found + fixed 2026-09-03).
// `highlightKey` (optional) draws that one series thicker with a glow and
// dims every other series, for the "highlight one entity" picker.
function MultiLineChart({ series, highlightKey, height = 320 }: { series: Series[]; highlightKey?: string; height?: number }) {
  const [hover, setHover] = useState<{ x: number; y: number; series: Series; point: SeriesPoint } | null>(null);
  const nonEmpty = series.filter(s => s.points.length > 0);
  if (!nonEmpty.length) {
    return <p className="text-xs text-ink-3 px-1 py-10 text-center">No data yet</p>;
  }

  const allDays = Array.from(new Set(nonEmpty.flatMap(s => s.points.map(p => p.day)))).sort();
  const allValues = nonEmpty.flatMap(s => s.points.map(p => p.value));
  const maxV = Math.max(...allValues);
  const minV = Math.min(0, ...allValues);
  const range = maxV - minV || 1;

  const width = 1000;
  const padL = 50, padR = 12, padT = 16, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xFor = (day: string) => {
    const idx = allDays.indexOf(day);
    return padL + (allDays.length <= 1 ? plotW / 2 : (idx / (allDays.length - 1)) * plotW);
  };
  const yFor = (v: number) => padT + plotH - ((v - minV) / range) * plotH;

  // 6 evenly-spaced ticks (was 3) — user asked for "a couple more" on the y-axis.
  const yTickCount = 6;
  const yTicks = Array.from({ length: yTickCount }, (_, i) => minV + (range * i) / (yTickCount - 1));

  // Up to 8 evenly-spaced ticks by index (was 3: first/mid/last) — denser
  // labeling especially matters for wide date ranges (requested 2026-09-03).
  const xTickCount = Math.min(8, allDays.length);
  const xTickIdx = Array.from(new Set(
    Array.from({ length: xTickCount }, (_, i) => Math.round((i / Math.max(1, xTickCount - 1)) * (allDays.length - 1)))
  ));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={yFor(v)} y2={yFor(v)} className="stroke-border" strokeWidth={1} />
            <text x={2} y={yFor(v) + 3} fontSize={10} className="fill-ink-3">{fmtPrice(v)}</text>
          </g>
        ))}
        {xTickIdx.map(i => (
          <text key={i} x={xFor(allDays[i])} y={height - 6} fontSize={10} textAnchor="middle" className="fill-ink-3">
            {shortDay(allDays[i])}
          </text>
        ))}
        {nonEmpty.map((s, si) => {
          const isHighlighted = highlightKey === s.key;
          const isDimmed = !!highlightKey && !isHighlighted;
          const color = LINE_COLORS[si % LINE_COLORS.length];
          const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(p.day)} ${yFor(p.value)}`).join(" ");
          return (
            <g
              key={s.key}
              opacity={isDimmed ? 0.35 : 1}
              style={isHighlighted ? { filter: `drop-shadow(0 0 7px ${color})` } : undefined}
            >
              <path d={d} fill="none" stroke={color} strokeWidth={isHighlighted ? 4 : 2} />
              {s.points.map((p, i) => (
                <g key={i}>
                  <circle cx={xFor(p.day)} cy={yFor(p.value)} r={isHighlighted ? 5 : 3} fill={color} />
                  {/* Larger invisible hit target — pointerEvents="all" forces hover to
                      fire despite the transparent fill (the actual root cause fix). */}
                  <circle
                    cx={xFor(p.day)}
                    cy={yFor(p.value)}
                    r={10}
                    fill="transparent"
                    pointerEvents="all"
                    onMouseEnter={() => setHover({ x: xFor(p.day), y: yFor(p.value), series: s, point: p })}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              ))}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg bg-ink text-white text-xs px-2.5 py-1.5 shadow-lg whitespace-nowrap"
          style={{ left: `${(hover.x / width) * 100}%`, top: `${(hover.y / height) * 100}%`, transform: "translate(-50%, -130%)" }}
        >
          <div className="font-semibold">{hover.series.label}</div>
          <div>{shortDay(hover.point.day)} · {fmtPrice(hover.point.value)}</div>
          <div>{hover.point.quantity.toLocaleString()} pudełek sprzedanych</div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2 px-2">
        {nonEmpty.map((s, si) => (
          <span key={s.key} className={`inline-flex items-center gap-1.5 text-xs ${highlightKey === s.key ? "text-ink font-semibold" : "text-ink-3"}`}>
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: LINE_COLORS[si % LINE_COLORS.length] }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function defaultMutationDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default function AnalysisTool({ lang: _lang }: { lang: Lang }) {
  const [mutationDate, setMutationDate] = useState(defaultMutationDate());

  // Real ingestion (bi_stock_entry_dim / bi_stock_entry_daily / bi_order_lines)
  // — manual trigger, also runs automatically once a day. The trigger is a
  // single "sync from this date" input — every export call returns data
  // mutated since that date up to now regardless (not a single-day
  // snapshot), so a range pull to today is always what "backfill" means
  // here; the result still gets locally filtered by creation date either
  // way (simplified from a two-date "backfill range" UI, 2026-09-03).
  const [stats, setStats] = useState<BiStats | null>(null);
  const [latestRun, setLatestRun] = useState<BiSyncRun | null>(null);
  const [syncStarting, setSyncStarting] = useState(false);

  // Backend's live is_bi_sync_running() flag — not derived from latestRun.status,
  // since that's the *latest bi_sync_log row*, which flips back to "ok" between
  // each day of a multi-day range backfill (a new "running" row only appears once
  // the next day's sync actually starts). Polling on that alone would drop the
  // poll loop mid-backfill the moment one day finishes (found 2026-09-02).
  const [serverRunning, setServerRunning] = useState(false);

  const loadBiHistory = useCallback(async () => {
    try {
      const res = await fetch(`${RAILWAY}/bi-sync/history?limit=1`);
      if (!res.ok) return;
      const data = await res.json();
      setStats(data.stats ?? null);
      setLatestRun(data.history?.[0] ?? null);
      setServerRunning(!!data.running);
    } catch { /* ignore */ }
  }, []);

  // Sales-by-supplier / sales-by-product, unified into one window
  // (redesigned 2026-09-03): a mode toggle picks whether the primary
  // picker is a supplier or a product; the chart's other lines (products
  // for supplier-mode, suppliers for product-mode) come back already
  // scoped from the backend, so the "highlight" picker below sources its
  // options directly from that fetched series list — no extra network
  // call, and it's automatically restricted to entities that actually
  // co-sold with the primary selection (the cascading-filter requirement
  // falls out of this for free in both directions).
  const [salesStartDate, setSalesStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  });
  const [salesEndDate, setSalesEndDate] = useState(() => todayIso());

  const [viewMode, setViewMode] = useState<ViewMode>("supplier");
  const [primaryId, setPrimaryId] = useState("");
  const [highlightKey, setHighlightKey] = useState("");

  const [suppliers, setSuppliers] = useState<SupplierPickerItem[]>([]);
  const [products, setProducts] = useState<ProductOnlyPickerItem[]>([]);
  const [productLengths, setProductLengths] = useState<number[]>([]);
  const [selectedLength, setSelectedLength] = useState(""); // "" = all lengths (averaged)

  const [salesSeries, setSalesSeries] = useState<SalesSeriesResult | null>(null);
  const [salesLoading, setSalesLoading] = useState(false);

  // Picker row_count updates with the date range (requested 2026-09-02) —
  // both lists are fetched regardless of the active mode so switching modes
  // doesn't need a fresh network round-trip.
  const loadSuppliers = useCallback(async () => {
    try {
      const url = new URL(`${RAILWAY}/bi-sync/suppliers`);
      url.searchParams.set("limit", "200");
      url.searchParams.set("start_date", salesStartDate);
      url.searchParams.set("end_date", salesEndDate);
      const res = await fetch(url.toString());
      setSuppliers(res.ok ? (await res.json()).suppliers ?? [] : []);
    } catch { /* ignore */ }
  }, [salesStartDate, salesEndDate]);

  const loadProducts = useCallback(async () => {
    try {
      const url = new URL(`${RAILWAY}/bi-sync/products`);
      url.searchParams.set("limit", "300");
      url.searchParams.set("start_date", salesStartDate);
      url.searchParams.set("end_date", salesEndDate);
      const res = await fetch(url.toString());
      setProducts(res.ok ? (await res.json()).products ?? [] : []);
    } catch { /* ignore */ }
  }, [salesStartDate, salesEndDate]);

  const loadPickers = useCallback(async () => {
    await Promise.all([loadSuppliers(), loadProducts()]);
  }, [loadSuppliers, loadProducts]);

  useEffect(() => { loadPickers(); }, [loadPickers]);

  // Selected primary no longer present in the (possibly date-range-refreshed)
  // list -> clear it, same guard the old cascading-product picker had.
  useEffect(() => {
    const ids = viewMode === "supplier" ? suppliers.map(s => s.supplier_id) : products.map(p => p.product_id);
    setPrimaryId(prev => (prev && !ids.includes(prev)) ? "" : prev);
  }, [viewMode, suppliers, products]);

  // Switching mode clears the primary selection — a supplier_id and a
  // product_id are never interchangeable.
  useEffect(() => {
    setPrimaryId("");
    setHighlightKey("");
  }, [viewMode]);

  // Lengths available for the selected product — product mode only.
  useEffect(() => {
    setSelectedLength("");
    if (viewMode !== "product" || !primaryId) { setProductLengths([]); return; }
    const url = new URL(`${RAILWAY}/bi-sync/product-lengths`);
    url.searchParams.set("product_id", primaryId);
    fetch(url.toString())
      .then(r => r.ok ? r.json() : { lengths: [] })
      .then(d => setProductLengths(d.lengths ?? []))
      .catch(() => setProductLengths([]));
  }, [viewMode, primaryId]);

  // No primary selection yet -> load a default overview (top suppliers/
  // products overall) instead of leaving the chart blank until the user
  // picks something (requested 2026-09-03). Same {series:[...]} response
  // shape either way, so the chart renders identically.
  useEffect(() => {
    setSalesLoading(true);
    let url: URL;
    if (primaryId) {
      const endpoint = viewMode === "supplier" ? "sales-by-supplier" : "sales-by-product";
      url = new URL(`${RAILWAY}/bi-sync/${endpoint}`);
      url.searchParams.set(viewMode === "supplier" ? "supplier_id" : "product_id", primaryId);
      if (viewMode === "product" && selectedLength) url.searchParams.set("length", selectedLength);
    } else {
      url = new URL(`${RAILWAY}/bi-sync/sales-overview`);
      url.searchParams.set("group_by", viewMode);
    }
    url.searchParams.set("start_date", salesStartDate);
    url.searchParams.set("end_date", salesEndDate);
    fetch(url.toString())
      .then(r => r.ok ? r.json() : null)
      .then(setSalesSeries)
      .catch(() => setSalesSeries(null))
      .finally(() => setSalesLoading(false));
  }, [viewMode, primaryId, selectedLength, salesStartDate, salesEndDate]);

  // Highlight picker is sourced from the already-fetched series — clear it
  // if the newly-fetched series no longer contains that key.
  useEffect(() => {
    const keys = salesSeries?.series.map(s => s.key) ?? [];
    setHighlightKey(prev => (prev && !keys.includes(prev)) ? "" : prev);
  }, [salesSeries]);

  useEffect(() => { loadBiHistory(); }, [loadBiHistory]);

  const syncRunning = serverRunning;

  useEffect(() => {
    if (!syncRunning) return;
    const poll = setInterval(() => { loadBiHistory(); loadPickers(); }, 4000);
    return () => clearInterval(poll);
  }, [syncRunning, loadBiHistory, loadPickers]);

  async function runBiSync() {
    setSyncStarting(true);
    try {
      const url = new URL(`${RAILWAY}/bi-sync/run-range`);
      url.searchParams.set("start_date", mutationDate);
      url.searchParams.set("end_date", todayIso());
      await fetch(url.toString(), { method: "POST" });
      await loadBiHistory();
      await loadPickers();
    } finally {
      setSyncStarting(false);
    }
  }

  const fullSeries = salesSeries?.series ?? [];
  const highlighted = fullSeries.find(s => s.key === highlightKey);
  const others = highlighted ? fullSeries.filter(s => s.key !== highlightKey).slice(0, 3) : fullSeries.slice(0, 5);
  const displaySeries = highlighted ? [...others, highlighted] : others;

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-bold text-ink">Analysis Tool</h2>
        <p className="text-sm text-ink-3 mt-0.5">
          Analiza sprzedaży OZEDS (FreshPortal BI Sync) — cena sprzedaży w czasie, wg dostawcy lub produktu.
        </p>
      </div>

      {/* Real ingestion — also runs automatically once a day (api_server.py
          _daily_bi_sync, ~180s after each server start then every 24h,
          mutation_datetime = yesterday). Button below is for manual/backfill runs. */}
      <div className="rounded-2xl border-2 border-emerald/25 bg-emerald-light p-4 flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-dark">Data pipeline (bi_stock_entry_dim / daily / bi_order_lines)</p>
          <p className="text-xs text-ink-3 mt-0.5">
            Działa automatycznie raz dziennie. Poniżej: ręczny sync/backfill — pobiera wszystko od wybranej daty do dziś
            (API zwraca dane po dacie mutacji, nie utworzenia, więc i tak są lokalnie filtrowane po dacie utworzenia).
          </p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">Sync od</label>
            <input
              type="date"
              value={mutationDate}
              onChange={e => setMutationDate(e.target.value)}
              className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors"
            />
          </div>
          <button
            onClick={runBiSync}
            disabled={syncStarting || syncRunning}
            className="h-9 px-4 rounded-lg text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity"
          >
            {syncStarting || syncRunning ? "Syncing…" : "Run BI sync"}
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

      {/* Unified sales window (redesigned 2026-09-03) — realized sale price
          (bi_order_lines.store_price, customer 12/OZEDS only). Mode toggle
          picks the primary entity; the highlight picker emphasizes one of
          the already-fetched lines (top 3 others shown alongside it, dimmed,
          for comparison — or top 5 with no highlight). */}
      <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Sprzedaż w czasie</p>
          <p className="text-xs text-ink-3 mt-0.5">
            Cena sprzedaży (OZEDS) w wybranym zakresie dat. Domyślnie top 10 {viewMode === "supplier" ? "dostawców" : "produktów"} ogółem —
            wybierz konkretnego {viewMode === "supplier" ? "dostawcę" : "produkt"} poniżej, żeby zobaczyć szczegóły. Najedź na punkt, żeby zobaczyć ilość sprzedanych pudełek.
          </p>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">Sprzedaż od</label>
            <input
              type="date"
              value={salesStartDate}
              onChange={e => setSalesStartDate(e.target.value)}
              className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">do</label>
            <input
              type="date"
              value={salesEndDate}
              min={salesStartDate}
              onChange={e => setSalesEndDate(e.target.value)}
              className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors"
            />
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button
              onClick={() => setViewMode("supplier")}
              className={`h-9 px-3 text-sm font-medium transition-colors ${viewMode === "supplier" ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
            >
              Wg dostawcy
            </button>
            <button
              onClick={() => setViewMode("product")}
              className={`h-9 px-3 text-sm font-medium transition-colors ${viewMode === "product" ? "bg-emerald text-white" : "text-ink-3 hover:text-ink"}`}
            >
              Wg produktu
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={primaryId}
            onChange={e => setPrimaryId(e.target.value)}
            className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors max-w-md"
          >
            <option value="">{viewMode === "supplier" ? "— wybierz dostawcę —" : "— wybierz produkt —"}</option>
            {viewMode === "supplier"
              ? suppliers.map(s => (
                <option key={s.supplier_id} value={s.supplier_id}>{s.name || s.supplier_id} ({s.row_count})</option>
              ))
              : products.map(p => (
                <option key={p.product_id} value={p.product_id}>{p.description || p.product_id} ({p.row_count})</option>
              ))}
          </select>

          {viewMode === "product" && primaryId && (
            <select
              value={selectedLength}
              onChange={e => setSelectedLength(e.target.value)}
              className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors"
            >
              <option value="">wszystkie długości (średnia)</option>
              {productLengths.map(l => (
                <option key={l} value={l}>{l}cm</option>
              ))}
            </select>
          )}

          {!!fullSeries.length && (
            <select
              value={highlightKey}
              onChange={e => setHighlightKey(e.target.value)}
              className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors max-w-md"
            >
              <option value="">— podświetl linię —</option>
              {fullSeries.map(s => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          )}
        </div>

        {salesLoading && <p className="text-xs text-ink-3">Loading…</p>}
        {!salesLoading && !fullSeries.length && (
          <p className="text-xs text-ink-3">Brak sprzedaży w wybranym zakresie.</p>
        )}
        {!!displaySeries.length && <MultiLineChart series={displaySeries} highlightKey={highlightKey} />}
      </div>
    </div>
  );
}
