"use client";

import { useState, useCallback, useEffect } from "react";
import { Lang } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface TableSummary {
  columns?: string[];
  row_count?: number;
  sample_rows?: string[][];
  error?: string;
}

interface PullResult {
  files_in_zip?: string[];
  tables?: Record<string, TableSummary>;
  export_url_host?: string;
  zip_size_bytes?: number;
}

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

interface StockEntryDailyPoint {
  day: string;
  count: number;
  avg_price: number | null;
}

interface OrderLineDailyPoint {
  day: string;
  count: number;
  total_quantity: number | null;
  revenue: number | null;
}

interface ChartsData {
  stock_entries_daily: StockEntryDailyPoint[];
  order_lines_daily: OrderLineDailyPoint[];
}

// ── Sales-by-supplier / sales-by-product analysis (redesigned 2026-09-02) ──
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
}

interface Series {
  key: string;
  label: string;
  points: SeriesPoint[];
}

interface SalesSeriesResult {
  series: Series[];
}

function shortDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtPrice(v: number | null | undefined): string {
  return v == null ? "" : `$${v.toFixed(3)}`;
}

// Dependency-free bar chart — one bar per point, height scaled to the series
// max (by absolute value, so negative series like supplier deviation still
// render sensibly), value shown above the bar and an x-axis label below it.
function BarChart<T>({ points, valueOf, labelOf, xLabelOf, barClassName }: {
  points: T[];
  valueOf: (p: T) => number;
  labelOf: (p: T) => string;
  xLabelOf: (p: T) => string;
  barClassName: string;
}) {
  if (!points.length) {
    return <p className="text-xs text-ink-3 px-1 py-6 text-center">No data yet</p>;
  }
  const max = Math.max(1, ...points.map(p => Math.abs(valueOf(p))));
  return (
    <div className="flex items-end gap-1.5 h-36 overflow-x-auto px-1">
      {points.map((p, i) => {
        const v = valueOf(p);
        const heightPct = Math.max(2, (Math.abs(v) / max) * 100);
        return (
          <div key={i} className="flex flex-col items-center gap-1 shrink-0 w-9" title={`${xLabelOf(p)}: ${labelOf(p)}`}>
            <span className="text-[10px] text-ink-3 whitespace-nowrap">{v !== 0 ? labelOf(p) : ""}</span>
            <div className="w-full h-24 flex items-end">
              <div className={`w-full rounded-t-md ${v < 0 ? "bg-red-500/70" : barClassName}`} style={{ height: `${heightPct}%` }} />
            </div>
            <span className="text-[10px] text-ink-3/70 whitespace-nowrap">{xLabelOf(p)}</span>
          </div>
        );
      })}
    </div>
  );
}

const LINE_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

// Dependency-free multi-series line chart — x=day (shared across all series,
// evenly spaced by position not by actual date gaps), y=value, up to 7
// colored lines with a legend below. Points are only drawn where a series
// actually has data for that day — consecutive available points are
// connected directly, so a gap in a series draws a straight line across it
// rather than showing a hole (acceptable for a first pass; the tooltip on
// each dot still shows the exact day/value so gaps aren't hidden entirely).
function MultiLineChart({ series, height = 280 }: { series: Series[]; height?: number }) {
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
  const padL = 46, padR = 12, padT = 12, padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xFor = (day: string) => {
    const idx = allDays.indexOf(day);
    return padL + (allDays.length <= 1 ? plotW / 2 : (idx / (allDays.length - 1)) * plotW);
  };
  const yFor = (v: number) => padT + plotH - ((v - minV) / range) * plotH;

  const yTicks = [minV, minV + range / 2, maxV];
  const xTickIdx = Array.from(new Set([0, Math.floor((allDays.length - 1) / 2), allDays.length - 1]));

  return (
    <div>
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
          const color = LINE_COLORS[si % LINE_COLORS.length];
          const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(p.day)} ${yFor(p.value)}`).join(" ");
          return (
            <g key={s.key}>
              <path d={d} fill="none" stroke={color} strokeWidth={2} />
              {s.points.map((p, i) => (
                <circle key={i} cx={xFor(p.day)} cy={yFor(p.value)} r={3} fill={color}>
                  <title>{`${s.label} — ${p.day}: ${fmtPrice(p.value)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2 px-2">
        {nonEmpty.map((s, si) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-ink-3">
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

// TEMP scaffolding (2026-08-26) — this whole screen is a harness to prove the
// BI Sync connection works and that the pulled data can be read correctly,
// ahead of building the real webshop sales/stock analysis module described
// in the design doc. Replace the buttons/table dump below once that build starts.
export default function AnalysisTool({ lang: _lang }: { lang: Lang }) {
  const [mutationDate, setMutationDate] = useState(defaultMutationDate());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PullResult | null>(null);
  const [error, setError] = useState("");

  // Real ingestion (bi_stock_entry_dim / bi_stock_entry_daily / bi_order_lines)
  // — manual trigger for now, will become a daily scheduled job once the
  // pipeline is validated (2026-08-27).
  const [stats, setStats] = useState<BiStats | null>(null);
  const [latestRun, setLatestRun] = useState<BiSyncRun | null>(null);
  const [syncStarting, setSyncStarting] = useState(false);
  const [charts, setCharts] = useState<ChartsData | null>(null);
  const [backfillEndDate, setBackfillEndDate] = useState(defaultMutationDate());

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

  const loadCharts = useCallback(async () => {
    try {
      const res = await fetch(`${RAILWAY}/bi-sync/charts?days=30`);
      if (!res.ok) return;
      setCharts(await res.json());
    } catch { /* ignore */ }
  }, []);

  // Sales-by-supplier / sales-by-product (redesigned 2026-09-02).
  const [suppliers, setSuppliers] = useState<SupplierPickerItem[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [bySupplier, setBySupplier] = useState<SalesSeriesResult | null>(null);
  const [bySupplierLoading, setBySupplierLoading] = useState(false);

  const [products, setProducts] = useState<ProductOnlyPickerItem[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [productLengths, setProductLengths] = useState<number[]>([]);
  const [selectedLength, setSelectedLength] = useState(""); // "" = all lengths (averaged)
  const [byProduct, setByProduct] = useState<SalesSeriesResult | null>(null);
  const [byProductLoading, setByProductLoading] = useState(false);

  useEffect(() => {
    fetch(`${RAILWAY}/bi-sync/suppliers?limit=200`)
      .then(r => r.ok ? r.json() : { suppliers: [] })
      .then(d => setSuppliers(d.suppliers ?? []))
      .catch(() => {});
    fetch(`${RAILWAY}/bi-sync/products?limit=300`)
      .then(r => r.ok ? r.json() : { products: [] })
      .then(d => setProducts(d.products ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedSupplierId) { setBySupplier(null); return; }
    setBySupplierLoading(true);
    const url = new URL(`${RAILWAY}/bi-sync/sales-by-supplier`);
    url.searchParams.set("supplier_id", selectedSupplierId);
    url.searchParams.set("days", "90");
    fetch(url.toString())
      .then(r => r.ok ? r.json() : null)
      .then(setBySupplier)
      .catch(() => setBySupplier(null))
      .finally(() => setBySupplierLoading(false));
  }, [selectedSupplierId]);

  // Fetch the lengths a selected product is offered in, to populate the
  // optional length-refinement dropdown; resets the length choice whenever
  // the product itself changes.
  useEffect(() => {
    setSelectedLength("");
    if (!selectedProductId) { setProductLengths([]); return; }
    const url = new URL(`${RAILWAY}/bi-sync/product-lengths`);
    url.searchParams.set("product_id", selectedProductId);
    fetch(url.toString())
      .then(r => r.ok ? r.json() : { lengths: [] })
      .then(d => setProductLengths(d.lengths ?? []))
      .catch(() => setProductLengths([]));
  }, [selectedProductId]);

  useEffect(() => {
    if (!selectedProductId) { setByProduct(null); return; }
    setByProductLoading(true);
    const url = new URL(`${RAILWAY}/bi-sync/sales-by-product`);
    url.searchParams.set("product_id", selectedProductId);
    if (selectedLength) url.searchParams.set("length", selectedLength);
    url.searchParams.set("days", "90");
    fetch(url.toString())
      .then(r => r.ok ? r.json() : null)
      .then(setByProduct)
      .catch(() => setByProduct(null))
      .finally(() => setByProductLoading(false));
  }, [selectedProductId, selectedLength]);

  useEffect(() => { loadBiHistory(); loadCharts(); }, [loadBiHistory, loadCharts]);

  const syncRunning = serverRunning;

  useEffect(() => {
    if (!syncRunning) return;
    const poll = setInterval(() => { loadBiHistory(); loadCharts(); }, 4000);
    return () => clearInterval(poll);
  }, [syncRunning, loadBiHistory, loadCharts]);

  async function runBiSync() {
    setSyncStarting(true);
    try {
      const url = new URL(`${RAILWAY}/bi-sync/run`);
      url.searchParams.set("mutation_datetime", mutationDate);
      await fetch(url.toString(), { method: "POST" });
      await loadBiHistory();
      await loadCharts();
    } finally {
      setSyncStarting(false);
    }
  }

  async function runBiSyncRange() {
    setSyncStarting(true);
    try {
      const url = new URL(`${RAILWAY}/bi-sync/run-range`);
      url.searchParams.set("start_date", mutationDate);
      url.searchParams.set("end_date", backfillEndDate);
      await fetch(url.toString(), { method: "POST" });
      await loadBiHistory();
      await loadCharts();
    } finally {
      setSyncStarting(false);
    }
  }

  const pull = useCallback(async (tables: string) => {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const url = new URL(`${RAILWAY}/bi-sync/debug-pull`);
      url.searchParams.set("mutation_datetime", mutationDate);
      if (tables) url.searchParams.set("tables", tables);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(await res.text());
      const data: PullResult = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [mutationDate]);

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-bold text-ink">Analysis Tool</h2>
        <p className="text-sm text-ink-3 mt-0.5">
          In development. This screen is a temporary test harness for the BI Sync connection
          (stock_entry / order_lines pull) — not the real analytics UI yet.
        </p>
      </div>

      {/* Real ingestion — now also runs automatically once a day (api_server.py
          _daily_bi_sync, ~180s after each server start then every 24h,
          mutation_datetime = yesterday). Button below is for manual/backfill runs. */}
      <div className="rounded-2xl border-2 border-emerald/25 bg-emerald-light p-4 flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-dark">Data pipeline (bi_stock_entry_dim / daily / bi_order_lines)</p>
          <p className="text-xs text-ink-3 mt-0.5">
            Runs automatically once a day (yesterday's data). Use the button below for a manual/backfill run
            on a specific date — pulls the export for the date above, upserts stock_entry into the
            dim/daily mirror tables, and order_lines scoped to customer 12 (OZ-Hami Direct Sales / OZEDS).
          </p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">Date</label>
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

        {/* Backfill a range — one export pull per day (order_lines is scoped to
            exactly one creation day per run), so this just loops run_bi_sync
            server-side instead of clicking "Run BI sync" once per day. */}
        <div className="flex items-end gap-3 flex-wrap pt-3 border-t border-emerald/15">
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">Backfill: {mutationDate} (Date above) →</label>
            <input
              type="date"
              value={backfillEndDate}
              onChange={e => setBackfillEndDate(e.target.value)}
              className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors"
            />
          </div>
          <button
            onClick={runBiSyncRange}
            disabled={syncStarting || syncRunning || backfillEndDate < mutationDate}
            className="h-9 px-4 rounded-lg text-sm font-semibold text-white bg-blue-600 disabled:opacity-40 transition-opacity"
          >
            {syncStarting || syncRunning ? "Running…" : "Backfill range"}
          </button>
          <span className="text-xs text-ink-3">Runs one sync per day in the range, sequentially — can take a while for multi-week backfills.</span>
        </div>
        {latestRun?.error && (
          <p className="text-xs text-red-500 font-mono whitespace-pre-wrap break-all">{latestRun.error}</p>
        )}
        {!!latestRun?.messages?.length && (
          <details className="text-xs" open={!syncRunning}>
            <summary className="cursor-pointer text-ink-3 hover:text-ink">
              Last run log ({latestRun.mutation_from ?? "?"}, {latestRun.status})
            </summary>
            <div className="mt-1 bg-muted rounded-lg p-2 max-h-56 overflow-y-auto font-mono whitespace-pre-wrap break-all text-ink-3">
              {latestRun.messages.map((m, i) => <div key={i}>{m}</div>)}
            </div>
          </details>
        )}
      </div>

      {/* First charts — daily trend from whatever's accumulated so far.
          Empty/sparse until a few days of automated syncs have landed. */}
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-border p-4">
          <p className="text-sm font-semibold text-ink">Live stock_entries per day</p>
          <p className="text-xs text-ink-3 mt-0.5 mb-2">bi_stock_entry_daily — count of visible=0, non-default-lot rows per snapshot</p>
          <BarChart
            points={charts?.stock_entries_daily ?? []}
            valueOf={(p: StockEntryDailyPoint) => p.count}
            labelOf={(p: StockEntryDailyPoint) => p.count.toLocaleString()}
            xLabelOf={(p: StockEntryDailyPoint) => shortDay(p.day)}
            barClassName="bg-emerald/70"
          />
        </div>
        <div className="rounded-2xl border border-border p-4">
          <p className="text-sm font-semibold text-ink">OZEDS order_lines per day</p>
          <p className="text-xs text-ink-3 mt-0.5 mb-2">bi_order_lines — count of lines created that day, customer 12 only</p>
          <BarChart
            points={charts?.order_lines_daily ?? []}
            valueOf={(p: OrderLineDailyPoint) => p.count}
            labelOf={(p: OrderLineDailyPoint) => p.count.toLocaleString()}
            xLabelOf={(p: OrderLineDailyPoint) => shortDay(p.day)}
            barClassName="bg-blue-500/70"
          />
        </div>
      </div>

      {/* Sales analysis (redesigned 2026-09-02) — realized sale price
          (bi_order_lines.store_price, customer 12/OZEDS only). Two angles:
          by supplier (lines = products that supplier sold) and by product
          (lines = suppliers who sold it, optionally scoped to one length —
          otherwise averaged across every length sold). Up to 7 lines each. */}
      <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Sprzedaż wg dostawcy</p>
          <p className="text-xs text-ink-3 mt-0.5">Cena sprzedaży w czasie, jedna linia na produkt (top 7), OZEDS, ost. 90 dni.</p>
        </div>
        <select
          value={selectedSupplierId}
          onChange={e => setSelectedSupplierId(e.target.value)}
          className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors max-w-md"
        >
          <option value="">— wybierz dostawcę —</option>
          {suppliers.map(s => (
            <option key={s.supplier_id} value={s.supplier_id}>
              {s.name || s.supplier_id} ({s.row_count})
            </option>
          ))}
        </select>
        {bySupplierLoading && <p className="text-xs text-ink-3">Loading…</p>}
        {bySupplier && <MultiLineChart series={bySupplier.series} />}
      </div>

      <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Sprzedaż wg produktu</p>
          <p className="text-xs text-ink-3 mt-0.5">
            Cena sprzedaży w czasie, jedna linia na dostawcę (top 7), OZEDS, ost. 90 dni.
            Bez wyboru długości — średnia ze wszystkich długości tego produktu.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={selectedProductId}
            onChange={e => setSelectedProductId(e.target.value)}
            className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors max-w-md"
          >
            <option value="">— wybierz produkt —</option>
            {products.map(p => (
              <option key={p.product_id} value={p.product_id}>
                {p.description || p.product_id} ({p.row_count})
              </option>
            ))}
          </select>
          {selectedProductId && (
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
        </div>
        {byProductLoading && <p className="text-xs text-ink-3">Loading…</p>}
        {byProduct && <MultiLineChart series={byProduct.series} />}
      </div>

      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-xs text-ink-3 mb-1">mutation_datetime (since)</label>
          <input
            type="date"
            value={mutationDate}
            onChange={e => setMutationDate(e.target.value)}
            className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors"
          />
        </div>
        <button
          onClick={() => pull("stock_entry,order_line")}
          disabled={loading}
          className="h-9 px-4 rounded-lg text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity"
        >
          {loading ? "Pulling…" : "Pull stock_entry + order_lines"}
        </button>
        <button
          onClick={() => pull("")}
          disabled={loading}
          className="h-9 px-4 rounded-lg text-sm font-medium border border-border text-ink-3 hover:text-ink disabled:opacity-40 transition-colors"
        >
          {loading ? "Pulling…" : "List all files in export"}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-500/8 border border-red-500/20 text-xs font-mono text-red-500 whitespace-pre-wrap break-all">
          {error}
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-4">
          <div className="text-xs text-ink-3">
            zip: {result.zip_size_bytes?.toLocaleString() ?? "?"} bytes · host: {result.export_url_host ?? "?"} · files in zip: {result.files_in_zip?.length ?? 0}
          </div>

          {!!result.files_in_zip?.length && (
            <details className="text-xs">
              <summary className="cursor-pointer text-ink-3 hover:text-ink">All files in zip ({result.files_in_zip.length})</summary>
              <div className="mt-1 bg-muted rounded-lg p-2 max-h-40 overflow-y-auto font-mono">
                {result.files_in_zip.map((f, i) => <div key={i} className="text-ink-3">{f}</div>)}
              </div>
            </details>
          )}

          {Object.entries(result.tables ?? {}).map(([name, tbl]) => (
            <div key={name} className="rounded-xl border border-border overflow-hidden">
              <div className="px-3 py-2 bg-muted text-sm font-semibold text-ink">{name}</div>
              {tbl.error ? (
                <p className="px-3 py-2 text-xs text-red-500">{tbl.error}</p>
              ) : (
                <div className="p-3 overflow-x-auto">
                  <p className="text-xs text-ink-3 mb-2">
                    {tbl.row_count?.toLocaleString() ?? "?"} rows · {tbl.columns?.length ?? 0} columns
                  </p>
                  <table className="text-xs font-mono border-collapse">
                    <thead>
                      <tr>
                        {tbl.columns?.map((c, i) => (
                          <th key={i} className="px-2 py-1 text-left border-b border-border text-ink-3 whitespace-nowrap">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tbl.sample_rows?.map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, ci) => (
                            <td key={ci} className="px-2 py-1 border-b border-border/50 text-ink whitespace-nowrap">{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
