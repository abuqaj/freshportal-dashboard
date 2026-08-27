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
}

interface BiSyncRun {
  status: string;
  error: string | null;
  stock_entries_seen: number | null;
  order_lines_seen: number | null;
  mutation_from: string | null;
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

  const loadBiHistory = useCallback(async () => {
    try {
      const res = await fetch(`${RAILWAY}/bi-sync/history?limit=1`);
      if (!res.ok) return;
      const data = await res.json();
      setStats(data.stats ?? null);
      setLatestRun(data.history?.[0] ?? null);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadBiHistory(); }, [loadBiHistory]);

  const syncRunning = latestRun?.status === "running";

  useEffect(() => {
    if (!syncRunning) return;
    const poll = setInterval(loadBiHistory, 4000);
    return () => clearInterval(poll);
  }, [syncRunning, loadBiHistory]);

  async function runBiSync() {
    setSyncStarting(true);
    try {
      const url = new URL(`${RAILWAY}/bi-sync/run`);
      url.searchParams.set("mutation_datetime", mutationDate);
      await fetch(url.toString(), { method: "POST" });
      await loadBiHistory();
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

      {/* Real ingestion — manual trigger for now, daily scheduled job later */}
      <div className="rounded-2xl border-2 border-emerald/25 bg-emerald-light p-4 flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-dark">Data pipeline (bi_stock_entry_dim / daily / bi_order_lines)</p>
          <p className="text-xs text-ink-3 mt-0.5">
            Manual trigger for now — pulls the export for the date above, upserts stock_entry into the
            dim/daily mirror tables, and order_lines scoped to customer 12 (OZ-Hami Direct Sales / OZEDS).
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
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
              {stats.order_lines_count?.toLocaleString() ?? 0} order_lines (OZEDS)
            </span>
          )}
        </div>
        {latestRun?.error && (
          <p className="text-xs text-red-500 font-mono whitespace-pre-wrap break-all">{latestRun.error}</p>
        )}
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
          onClick={() => pull("stock_entry,order_lines")}
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
