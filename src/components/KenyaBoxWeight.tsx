"use client";

import { useState, useCallback } from "react";
import { Lang, translations } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

const CTRL = "h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors";

interface CustomerRow {
  customer_id: string;
  label: string | null;
  enabled: boolean;
  open_invoices?: number;
}

interface ProcessedRow {
  invoice_id: string;
  customer_id?: string;
  status: "ok" | "skipped" | "failed";
  detail?: string;
  total_weight?: number | null;
  box_count?: number | null;
  weight_per_box?: number | null;
  lines_written?: number;
}

interface LogRow {
  invoice_id: string;
  total_weight: string | number | null;
  box_count: string | number | null;
  weight_per_box: string | number | null;
  lines_written: number | null;
  status: string | null;
  detail: string | null;
  checked_at: string | null;
}

/** One line in the on-screen call log. Every request the module makes is
 *  recorded here — this module writes to live invoices, so "what did it
 *  just do, and did the server agree" has to be visible without opening
 *  devtools. */
interface CallEntry {
  at: string;
  method: string;
  path: string;
  status: number | string;
  ms: number;
  summary: string;
}

const STATUS_STYLE: Record<string, string> = {
  ok:      "bg-emerald/10 text-emerald",
  skipped: "bg-amber-500/10 text-amber-600",
  failed:  "bg-red-500/10 text-red-600",
};

function fmt(value: string | number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? `${n}${suffix}` : String(value);
}

export default function KenyaBoxWeight({ lang }: { lang: Lang }) {
  const t = translations[lang].kenyaBoxWeight;

  const [calls, setCalls] = useState<CallEntry[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[] | null>(null);
  const [processed, setProcessed] = useState<ProcessedRow[] | null>(null);
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [limit, setLimit] = useState("1");

  /** Every call goes through here so the log can never drift from what was
   *  actually sent — including failures, which are the ones worth seeing. */
  const call = useCallback(async <T,>(
    method: "GET" | "POST", path: string, body?: unknown, summarise?: (d: T) => string,
  ): Promise<T | null> => {
    const started = performance.now();
    let status: number | string = "—";
    try {
      const res = await fetch(`${RAILWAY}${path}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      status = res.status;
      const text = await res.text();
      let data: T | null = null;
      try { data = text ? JSON.parse(text) as T : null; } catch { /* non-JSON error page */ }
      const summary = res.ok
        ? (data && summarise ? summarise(data) : "OK")
        : ((data as { detail?: string } | null)?.detail ?? text.slice(0, 200) || res.statusText);
      setCalls(c => [{
        at: new Date().toLocaleTimeString(), method, path, status,
        ms: Math.round(performance.now() - started), summary,
      }, ...c].slice(0, 50));
      if (!res.ok) { setError(`${path} → ${status}: ${summary}`); return null; }
      return data;
    } catch (e) {
      const summary = e instanceof Error ? e.message : String(e);
      setCalls(c => [{
        at: new Date().toLocaleTimeString(), method, path, status: "network",
        ms: Math.round(performance.now() - started), summary,
      }, ...c].slice(0, 50));
      setError(`${path} → ${summary}`);
      return null;
    }
  }, []);

  async function loadCustomers(includeOpen: boolean) {
    setBusy(includeOpen ? t.busyPullingCustomers : t.busyLoading);
    setError("");
    const data = await call<{ customers: CustomerRow[] }>(
      "GET", `/kenya/box-weight/customers?include_open=${includeOpen}`,
      undefined, d => t.callGotCustomers(String(d.customers.length)));
    if (data) setCustomers(data.customers);
    setBusy("");
  }

  async function toggleCustomer(row: CustomerRow, enabled: boolean) {
    setError("");
    // Optimistic: the checkbox is the only thing that changes, and a failed
    // POST surfaces in the call log and the error banner below.
    setCustomers(cs => (cs ?? []).map(c =>
      c.customer_id === row.customer_id ? { ...c, enabled } : c));
    await call("POST", "/kenya/box-weight/customers",
      { customer_id: row.customer_id, enabled }, () => t.callToggled(row.customer_id, String(enabled)));
  }

  async function runDebugPull() {
    setBusy(t.busyDebug);
    setError("");
    await call<{ tables: Record<string, { row_count: number }>; open_invoices_by_customer: Record<string, number> }>(
      "GET", "/kenya/box-weight/debug-pull", undefined,
      d => t.callDebugSummary(
        String(d.tables?.invoice?.row_count ?? 0),
        String(d.tables?.customer_stock_item?.row_count ?? 0),
        String(Object.keys(d.open_invoices_by_customer ?? {}).length)));
    setBusy("");
  }

  async function runCorrection() {
    const n = limit.trim();
    setBusy(t.busyRunning);
    setError("");
    setProcessed(null);
    const qs = n && Number(n) > 0 ? `?limit=${Number(n)}` : "";
    const data = await call<{ processed: ProcessedRow[]; skipped: { invoice_id: string; reason: string }[] }>(
      "POST", `/kenya/box-weight/run${qs}`, undefined,
      d => t.callRunSummary(
        String(d.processed.filter(p => p.status === "ok").length),
        String(d.processed.length)));
    if (data) setProcessed(data.processed);
    setBusy("");
    loadLog();
  }

  async function loadLog() {
    const data = await call<{ log: LogRow[] }>(
      "GET", "/kenya/box-weight/log?limit=100", undefined,
      d => t.callGotLog(String(d.log.length)));
    if (data) setLog(data.log);
  }

  const enabledCount = (customers ?? []).filter(c => c.enabled).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border p-4 flex flex-col gap-2">
        <p className="text-sm font-semibold text-ink">{t.title}</p>
        <p className="text-xs text-ink-3 max-w-3xl">{t.intro}</p>
        <p className="text-xs text-amber-600 max-w-3xl">{t.writeWarning}</p>
      </div>

      {/* ── Customers ─────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-ink">{t.customersTitle}</p>
            <p className="text-xs text-ink-3">{t.customersHint}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => loadCustomers(false)} disabled={!!busy}
              className={`${CTRL} disabled:opacity-50`}>{t.btnLoadSaved}</button>
            <button onClick={() => loadCustomers(true)} disabled={!!busy}
              className={`${CTRL} disabled:opacity-50`}>{t.btnDiscover}</button>
          </div>
        </div>

        {customers === null ? (
          <p className="text-xs text-ink-3">{t.customersEmpty}</p>
        ) : customers.length === 0 ? (
          <p className="text-xs text-ink-3">{t.customersNone}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {customers.map(c => (
              <label key={c.customer_id}
                className="flex items-center gap-2 text-xs border border-border rounded-lg px-3 h-9 cursor-pointer">
                <input type="checkbox" checked={c.enabled}
                  onChange={e => toggleCustomer(c, e.target.checked)} />
                <span className="text-ink">{c.label || c.customer_id}</span>
                {c.open_invoices !== undefined && (
                  <span className="text-ink-3">({t.openInvoices(String(c.open_invoices))})</span>
                )}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ── Run ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">{t.limitLabel}</label>
            <input value={limit} onChange={e => setLimit(e.target.value)}
              inputMode="numeric" className={`${CTRL} w-28`} placeholder={t.limitAll} />
          </div>
          <button
            onClick={runCorrection}
            disabled={!!busy || enabledCount === 0}
            className="h-9 px-4 rounded-lg text-sm font-medium bg-emerald text-white disabled:opacity-50 transition-colors"
          >
            {busy === t.busyRunning ? t.btnRunning : t.btnRun}
          </button>
          <button onClick={runDebugPull} disabled={!!busy}
            className={`${CTRL} disabled:opacity-50`}>{t.btnDebug}</button>
          <button onClick={loadLog} disabled={!!busy}
            className={`${CTRL} disabled:opacity-50`}>{t.btnLoadLog}</button>
        </div>
        {enabledCount === 0 && <p className="text-xs text-ink-3">{t.needCustomer}</p>}
        {!!busy && <p className="text-xs text-ink-3">{busy}</p>}
        {!!error && <p className="text-xs text-red-600 break-all">{error}</p>}
      </div>

      {/* ── This run's outcome ────────────────────────────────────────── */}
      {processed && (
        <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
          <p className="text-sm font-semibold text-ink">{t.resultTitle}</p>
          {processed.length === 0 ? (
            <p className="text-xs text-ink-3">{t.resultEmpty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-ink-3">
                  <tr className="text-left">
                    <th className="py-1 pr-3">{t.colInvoice}</th>
                    <th className="py-1 pr-3">{t.colStatus}</th>
                    <th className="py-1 pr-3 text-right">{t.colWeight}</th>
                    <th className="py-1 pr-3 text-right">{t.colBoxes}</th>
                    <th className="py-1 pr-3 text-right">{t.colPerBox}</th>
                    <th className="py-1 pr-3 text-right">{t.colLines}</th>
                    <th className="py-1">{t.colDetail}</th>
                  </tr>
                </thead>
                <tbody>
                  {processed.map(p => (
                    <tr key={p.invoice_id} className="border-t border-border">
                      <td className="py-1.5 pr-3 font-mono text-ink">{p.invoice_id}</td>
                      <td className="py-1.5 pr-3">
                        <span className={`px-2 py-0.5 rounded-md font-semibold ${STATUS_STYLE[p.status] ?? ""}`}>
                          {p.status}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-right">{fmt(p.total_weight, " kg")}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(p.box_count)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(p.weight_per_box, " kg")}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(p.lines_written)}</td>
                      <td className="py-1.5 text-ink-3">{p.detail || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Call log ──────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-ink">{t.callLogTitle}</p>
            <p className="text-xs text-ink-3">{t.callLogHint}</p>
          </div>
          {calls.length > 0 && (
            <button onClick={() => setCalls([])} className={CTRL}>{t.btnClear}</button>
          )}
        </div>
        {calls.length === 0 ? (
          <p className="text-xs text-ink-3">{t.callLogEmpty}</p>
        ) : (
          <div className="flex flex-col gap-1 font-mono text-[11px]">
            {calls.map((c, i) => (
              <div key={i} className="flex gap-2 border-t border-border pt-1">
                <span className="text-ink-3 shrink-0">{c.at}</span>
                <span className="text-ink-3 shrink-0">{c.method}</span>
                <span className={`shrink-0 font-semibold ${c.status === 200 ? "text-emerald" : "text-red-600"}`}>
                  {c.status}
                </span>
                <span className="text-ink-3 shrink-0">{c.ms}ms</span>
                <span className="text-ink shrink-0">{c.path}</span>
                <span className="text-ink-3 break-all">{c.summary}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Persisted history ─────────────────────────────────────────── */}
      {log && (
        <div className="rounded-2xl border border-border p-4 flex flex-col gap-3">
          <p className="text-sm font-semibold text-ink">{t.historyTitle}</p>
          {log.length === 0 ? (
            <p className="text-xs text-ink-3">{t.historyEmpty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-ink-3">
                  <tr className="text-left">
                    <th className="py-1 pr-3">{t.colInvoice}</th>
                    <th className="py-1 pr-3">{t.colStatus}</th>
                    <th className="py-1 pr-3 text-right">{t.colWeight}</th>
                    <th className="py-1 pr-3 text-right">{t.colBoxes}</th>
                    <th className="py-1 pr-3 text-right">{t.colPerBox}</th>
                    <th className="py-1 pr-3">{t.colChecked}</th>
                    <th className="py-1">{t.colDetail}</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map(r => (
                    <tr key={r.invoice_id} className="border-t border-border">
                      <td className="py-1.5 pr-3 font-mono text-ink">{r.invoice_id}</td>
                      <td className="py-1.5 pr-3">
                        <span className={`px-2 py-0.5 rounded-md font-semibold ${STATUS_STYLE[r.status ?? ""] ?? ""}`}>
                          {r.status ?? "—"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-right">{fmt(r.total_weight, " kg")}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(r.box_count)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(r.weight_per_box, " kg")}</td>
                      <td className="py-1.5 pr-3 text-ink-3">
                        {r.checked_at ? new Date(r.checked_at).toLocaleString() : "—"}
                      </td>
                      <td className="py-1.5 text-ink-3">{r.detail || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
