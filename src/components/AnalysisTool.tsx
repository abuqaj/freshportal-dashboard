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

function shortDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Dependency-free bar chart — one bar per point, height scaled to the series
// max, value shown above the bar and the day label below it.
function BarChart<T extends { day: string }>({ points, valueOf, labelOf, barClassName }: {
  points: T[];
  valueOf: (p: T) => number;
  labelOf: (p: T) => string;
  barClassName: string;
}) {
  if (!points.length) {
    return <p className="text-xs text-ink-3 px-1 py-6 text-center">No data yet</p>;
  }
  const max = Math.max(1, ...points.map(p => valueOf(p)));
  return (
    <div className="flex items-end gap-1.5 h-36 overflow-x-auto px-1">
      {points.map((p, i) => {
        const v = valueOf(p);
        const heightPct = Math.max(2, (v / max) * 100);
        return (
          <div key={i} className="flex flex-col items-center gap-1 shrink-0 w-9" title={`${p.day}: ${labelOf(p)}`}>
            <span className="text-[10px] text-ink-3 whitespace-nowrap">{v > 0 ? labelOf(p) : ""}</span>
            <div className="w-full h-24 flex items-end">
              <div className={`w-full rounded-t-md ${barClassName}`} style={{ height: `${heightPct}%` }} />
            </div>
            <span className="text-[10px] text-ink-3/70 whitespace-nowrap">{shortDay(p.day)}</span>
          </div>
        );
      })}
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
            barClassName="bg-blue-500/70"
          />
        </div>
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
