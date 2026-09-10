"use client";

import { useState, useEffect } from "react";
import { Lang, translations } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

const CTRL = "h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors";

interface CustomerRow {
  customer_id: string;
  label: string | null;
  enabled: boolean;
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

/** Cartoon figure reaching for the button, as a nod to the desk-button meme
 *  the design was asked for. Purely decorative: aria-hidden, and nothing here
 *  is interactive — the button next to it is the only control.
 *
 *  The arm is its own group so it can swing from the shoulder. Rotating it
 *  needs an explicit transform-box: without it the transform-origin below is
 *  resolved against the SVG viewport rather than the group's own box, and
 *  the arm swings from somewhere off in the corner. */
function DeskFigure({ armDown }: { armDown: boolean }) {
  return (
    <svg viewBox="0 0 190 250" aria-hidden="true"
         className="hidden sm:block w-40 lg:w-52 shrink-0 self-end -mr-10 lg:-mr-14 relative z-10 pointer-events-none">
      {/* torso + legs */}
      <path d="M46 250V162h52v88" fill="#1E2740" />
      <path d="M40 164c0-38 9-60 30-67l16 2c21 7 30 27 30 65z" fill="#28324F" />
      {/* shirt + the long red tie */}
      <path d="M62 96h22l-5 28-6 9-6-9z" fill="#F5F7FB" />
      <path d="M73 104l8 7-6 40-2 8-2-8-6-40z" fill="#C8102E" />
      {/* neck + head — ruddier than a neutral skin tone, per the reference */}
      <rect x="63" y="80" width="20" height="20" rx="7" fill="#D98A63" />
      <ellipse cx="73" cy="54" rx="28" ry="32" fill="#E89A72" />
      {/* blonde swoosh */}
      <path d="M45 42c2-19 17-29 30-29s27 9 28 23c-6-7-15-9-23-7-11 3-20 10-27 18-3 4-7 1-8-5z" fill="#EBCF7B" />
      {/* stern face: brows angled in, mouth flat and slightly down */}
      <path d="M58 44l12 4M88 44l-12 4" stroke="#7A5230" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="63" cy="55" rx="2.7" ry="3.3" fill="#24242A" />
      <ellipse cx="83" cy="55" rx="2.7" ry="3.3" fill="#24242A" />
      <path d="M64 73q9 -3 18 0" stroke="#8E4636" strokeWidth="3" fill="none" strokeLinecap="round" />

      {/* Reaching arm. Its own group so it can swing from the shoulder, and
          drawn last so the sleeve sits over the torso rather than behind it.
          transform-box: fill-box is required — without it transform-origin
          resolves against the SVG viewport and the arm pivots off-screen. */}
      <g
        style={{
          transformBox: "fill-box",
          transformOrigin: "6% 24%",
          transform: `rotate(${armDown ? 24 : -5}deg)`,
          transition: "transform 260ms cubic-bezier(.34,1.4,.64,1)",
        }}
      >
        <path d="M100 122h62" stroke="#28324F" strokeWidth="22" fill="none" strokeLinecap="round" />
        <path d="M158 122h6" stroke="#F5F7FB" strokeWidth="22" fill="none" strokeLinecap="round" />
        <circle cx="174" cy="122" r="12" fill="#E89A72" />
        {/* the index finger, out ahead of the fist */}
        <path d="M180 122h8" stroke="#E89A72" strokeWidth="9" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}

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
  const [pressed, setPressed] = useState(false);

  function logCall(entry: CallEntry) {
    setCalls(c => [entry, ...c].slice(0, 50));
  }

  /** Every call goes through here so the log can never drift from what was
   *  actually sent — including failures, which are the ones worth seeing.
   *
   *  The parsed body is kept as `unknown` alongside the typed one: reading
   *  FastAPI's error `detail` off a value typed as the caller's success
   *  shape would be a cast between two types that do not overlap. */
  async function call<T>(
    method: "GET" | "POST", path: string, body?: unknown, summarise?: (d: T) => string,
  ): Promise<T | null> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    const at = new Date().toLocaleTimeString();
    try {
      const res = await fetch(`${RAILWAY}${path}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* HTML error page */ }
      const data = parsed as T | null;
      const summary = res.ok
        ? (data && summarise ? summarise(data) : "OK")
        : ((parsed as { detail?: string } | null)?.detail ?? (text.slice(0, 200) || res.statusText));
      logCall({ at, method, path, status: res.status, ms: ms(), summary });
      if (!res.ok) { setError(`${path} → ${res.status}: ${summary}`); return null; }
      return data;
    } catch (e) {
      const summary = e instanceof Error ? e.message : String(e);
      logCall({ at, method, path, status: "network", ms: ms(), summary });
      setError(`${path} → ${summary}`);
      return null;
    }
  }

  async function loadCustomers() {
    setBusy(t.busyLoading);
    setError("");
    const data = await call<{ customers: CustomerRow[] }>(
      "GET", "/kenya/box-weight/customers", undefined,
      d => t.callGotCustomers(String(d.customers.filter(c => c.enabled).length)));
    if (data) setCustomers(data.customers.filter(c => c.enabled));
    setBusy("");
  }

  // Which customers are in scope is an admin setting, not a per-run choice,
  // so it is only read here — the list is edited in Admin > Customers > Kenya.
  useEffect(() => { loadCustomers(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

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
    setBusy(t.busyRunning);
    setError("");
    setProcessed(null);
    // No limit: the button says it corrects the available invoices, so it
    // corrects all of them. The backend still skips anything already done
    // with an unchanged weight and box count, so pressing it twice is cheap.
    const data = await call<{ processed: ProcessedRow[]; skipped: { invoice_id: string; reason: string }[] }>(
      "POST", "/kenya/box-weight/run", undefined,
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

  const enabledCount = customers?.length ?? 0;
  const customerNames = (customers ?? []).map(c => c.label || c.customer_id);
  const running = busy === t.busyRunning;
  // The hand stays down for the whole run, not just the press, so the figure
  // reads as "holding it down while it works" rather than twitching once.
  const armDown = pressed || running;

  return (
    <div className="flex flex-col gap-4">
      {/* ── The one control ───────────────────────────────────────────────
          Everything else on this screen reports; this is the only thing that
          acts. The customers whose invoices will be touched are printed on
          the button itself rather than in a panel above it, so the scope of
          the action cannot be read separately from the action. */}
      <div className="rounded-2xl border border-border py-12 px-6 flex flex-col items-center gap-5">
        {/* items-center, not items-end: the hand sits at roughly the middle
            of the figure's height, so centring the two puts it level with the
            button rather than reaching up at it from below. */}
        <div className="flex items-center justify-center w-full max-w-3xl">
        <DeskFigure armDown={armDown} />
        {/* Bezel — the housing the button sits in. Depth is drawn with
            stacked box-shadows rather than a bottom border: a border cannot
            animate its own collapse, and the travel has to look like the cap
            descending into the housing, not the whole control shrinking.
            Alpha is written as 8-digit hex because Tailwind arbitrary values
            cannot carry the commas inside rgba(). */}
        <div className="shrink-0 w-[22rem] h-[22rem] rounded-full p-5 flex items-center justify-center
                        bg-gradient-to-b from-[#3A3A40] to-[#131316]
                        shadow-[0_24px_48px_-16px_#00000099] ring-1 ring-black/50">
          <button
            onClick={runCorrection}
            onPointerDown={() => setPressed(true)}
            onPointerUp={() => setPressed(false)}
            onPointerLeave={() => setPressed(false)}
            disabled={!!busy || enabledCount === 0}
            className={`w-full h-full rounded-full px-8 flex flex-col items-center justify-center gap-2 select-none
                        text-white bg-gradient-to-b from-[#E8483A] to-[#A31710]
                        shadow-[inset_0_3px_0_0_#ffffff59,inset_0_-2px_0_0_#00000040,0_10px_0_0_#7A0F0A,0_18px_26px_-8px_#000000a6]
                        transition-[transform,box-shadow] duration-75 ease-out
                        hover:from-[#F2523F] hover:to-[#B31A12]
                        active:translate-y-[9px]
                        active:shadow-[inset_0_2px_0_0_#ffffff33,inset_0_-1px_0_0_#00000040,0_1px_0_0_#7A0F0A,0_4px_8px_-4px_#000000a6]
                        focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/40
                        disabled:active:translate-y-0
                        disabled:active:shadow-[inset_0_3px_0_0_#ffffff59,inset_0_-2px_0_0_#00000040,0_10px_0_0_#7A0F0A,0_18px_26px_-8px_#000000a6]
                        ${running
                          ? "animate-pulse cursor-wait"
                          : "disabled:opacity-40 disabled:cursor-not-allowed"}`}
          >
            <span className="text-xl lg:text-2xl font-extrabold uppercase tracking-wide text-center leading-tight drop-shadow-[0_2px_2px_#00000066]">
              {running ? t.btnRunning : t.btnRun}
            </span>
            <span className="text-[10px] text-white/70 uppercase tracking-widest">{t.forCustomers}</span>
            {/* Names, not ids — a bare number on the button tells the
                operator nothing about whose invoices are about to change. */}
            <span className="text-xs font-semibold text-center leading-snug max-h-20 overflow-y-auto px-2">
              {enabledCount === 0 ? t.customersNone : customerNames.join(" · ")}
            </span>
          </button>
        </div>
        </div>

        {enabledCount === 0 && (
          <p className="text-xs text-ink-3 text-center max-w-md">{t.customersManagedInAdmin}</p>
        )}
        {running && <p className="text-xs text-ink-3">{busy}</p>}
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

      {/* ── Everything below is diagnostics, folded away by default ───────
          The operator needs one button and the result of pressing it; the
          call log and stored history are for working out why a run did not
          do what was expected. */}
      <details className="rounded-2xl border border-border">
        <summary className="px-4 py-3 text-sm font-semibold text-ink cursor-pointer select-none">
          {t.technicalTitle}
        </summary>
        <div className="px-4 pb-4 flex flex-col gap-4">

      <div className="flex gap-2 flex-wrap pt-1">
        <button onClick={runDebugPull} disabled={!!busy}
          className={`${CTRL} disabled:opacity-50`}>{t.btnDebug}</button>
        <button onClick={loadLog} disabled={!!busy}
          className={`${CTRL} disabled:opacity-50`}>{t.btnLoadLog}</button>
        <button onClick={loadCustomers} disabled={!!busy}
          className={`${CTRL} disabled:opacity-50`}>{t.btnLoadSaved}</button>
      </div>

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
      </details>
    </div>
  );
}
