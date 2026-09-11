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
  /** What a human calls the invoice; invoice_id remains the key. */
  sequence?: string;
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
  sequence: string | null;
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

/** Cartoon leader at the button, in the political-cartoon convention: the
 *  read comes from costume and silhouette — the buttoned Mao-collar tunic and
 *  the squared-off undercut — rather than from exaggerated facial features.
 *  Decorative only: aria-hidden, nothing here is interactive. */
function DeskFigure({ armDown }: { armDown: boolean }) {
  return (
    <svg viewBox="0 0 190 190" aria-hidden="true"
         className="hidden sm:block w-36 lg:w-44 shrink-0 self-end -mr-10 lg:-mr-14 relative z-10 pointer-events-none">
      {/* Stubby legs. The whole drawing was re-laid-out in a shorter viewBox
          rather than trimming the legs in place - shortening them alone would
          have left the tunic hanging above the feet. */}
      <path d="M52 190v-22h40v22" fill="#23262B" />
      {/* tunic - wide and square, buttoned to the throat */}
      <path d="M34 172c0-46 12-72 38-80l14 2c26 8 38 34 38 78z" fill="#2E3239" />
      <path d="M78 96v76" stroke="#1B1E22" strokeWidth="2" />
      <circle cx="86" cy="118" r="2.3" fill="#C9CDD4" />
      <circle cx="86" cy="136" r="2.3" fill="#C9CDD4" />
      <circle cx="86" cy="154" r="2.3" fill="#C9CDD4" />
      {/* mandarin collar, sitting straight under the jaw - no neck */}
      <path d="M60 92h38l-6 12H66z" fill="#3A3F47" />
      <rect x="60" y="86" width="38" height="8" rx="4" fill="#3A3F47" />

      {/* head */}
      <ellipse cx="79" cy="54" rx="31" ry="32" fill="#F0B45A" />
      {/* the haircut: shaved close at the sides, flat squared top */}
      <path d="M48 48c0-20 14-33 31-33s31 13 31 33c0 4-3 5-4 2-3-9-13-14-27-14s-24 5-27 14c-1 3-4 2-4-2z" fill="#22242A" />
      <path d="M52 52c2 7 4 10 4 15-4-2-6-8-6-13zM106 52c-2 7-4 10-4 15 4-2 6-8 6-13z" fill="#22242A" />
      {/* face - dot eyes and a flat mouth, same restraint as the brows */}
      <ellipse cx="69" cy="56" rx="2.9" ry="3.1" fill="#24242A" />
      <ellipse cx="89" cy="56" rx="2.9" ry="3.1" fill="#24242A" />
      <path d="M63 46l11 3M95 46l-11 3" stroke="#22242A" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M70 73h18" stroke="#B06A34" strokeWidth="3" strokeLinecap="round" />

      {/* Reaching arm. Its own group so it can swing from the shoulder, and
          drawn last so the sleeve sits over the torso rather than behind it.
          transform-box: fill-box is required - without it transform-origin
          resolves against the SVG viewport and the arm pivots off-screen. */}
      <g
        style={{
          transformBox: "fill-box",
          transformOrigin: "6% 24%",
          transform: `rotate(${armDown ? 24 : -5}deg)`,
          transition: "transform 260ms cubic-bezier(.34,1.4,.64,1)",
        }}
      >
        <path d="M106 122h56" stroke="#2E3239" strokeWidth="22" fill="none" strokeLinecap="round" />
        <path d="M158 122h4" stroke="#3A3F47" strokeWidth="22" fill="none" strokeLinecap="round" />
        <circle cx="172" cy="122" r="12" fill="#F0B45A" />
        {/* the index finger, out ahead of the fist */}
        <path d="M178 122h8" stroke="#F0B45A" strokeWidth="9" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** Battery that fills as the work completes.
 *
 *  `fraction` is real progress, not a timer: it is invoices actually done
 *  over invoices found, streamed from the run itself. */
function CircuitProgress({
  fraction, done, total, lines, finished, labels,
}: {
  fraction: number; done: number; total: number; lines: number; finished: boolean;
  labels: { working: string; charged: string; ofInvoices: string; linesWritten: string };
}) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const pct = Math.round(clamped * 100);

  return (
    <div className="panel-drop flex flex-col items-center gap-3">
      <svg viewBox="0 0 120 58" className="w-40" aria-hidden="true">
        <defs>
          <linearGradient id="bw-live" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#38BDF8" />
            <stop offset="100%" stopColor="#22D3EE" />
          </linearGradient>
        </defs>
        <rect x="4" y="10" width="100" height="38" rx="8"
              fill="#1B2027" stroke={finished ? "#4ADE80" : "#39414B"} strokeWidth="3"
              className={finished ? "battery-pulse" : undefined}
              style={{ color: finished ? "#4ADE80" : undefined }} />
        <rect x="105" y="22" width="8" height="14" rx="3" fill={finished ? "#4ADE80" : "#39414B"} />
        <rect x="10" y="16" width={Math.max(0, 88 * clamped)} height="26" rx="4"
              fill={finished ? "#4ADE80" : "url(#bw-live)"}
              style={{ transition: "width 420ms ease-out" }} />
      </svg>

      <div className="flex items-center justify-center gap-4 flex-wrap text-xs">
        <span className="font-mono tabular-nums text-ink text-base font-semibold">{pct}%</span>
        <span className="text-ink-3">{done}/{total} {labels.ofInvoices}</span>
        <span className="text-ink-3">{lines} {labels.linesWritten}</span>
        <span className={finished ? "text-emerald font-semibold" : "text-ink-3"}>
          {finished ? labels.charged : labels.working}
        </span>
      </div>
    </div>
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
  const [progress, setProgress] = useState({ done: 0, total: 0, lines: 0 });
  // Kept separate from `processed`: the circuit should finish the moment
  // the run ends, not when the results table happens to render.
  const [finished, setFinished] = useState(false);

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
    setProgress({ done: 0, total: 0, lines: 0 });
    setFinished(false);

    // Streamed, not the blocking endpoint: the circuit needs the denominator
    // before the work starts and a tick per invoice, which a single response
    // at the end cannot give.
    const path = "/kenya/box-weight/run/stream";
    const started = performance.now();
    const at = new Date().toLocaleTimeString();
    try {
      const res = await fetch(`${RAILWAY}${path}`, { method: "POST" });
      if (!res.ok || !res.body) {
        const text = await res.text();
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* HTML error page */ }
        const summary = (parsed as { detail?: string } | null)?.detail ?? (text.slice(0, 200) || res.statusText);
        logCall({ at, method: "POST", path, status: res.status, ms: Math.round(performance.now() - started), summary });
        setError(`${path} → ${res.status}: ${summary}`);
        setBusy("");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: { processed: ProcessedRow[] } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === "progress") {
            setProgress({
              done: Number(event.done ?? 0),
              total: Number(event.total ?? 0),
              lines: Number(event.lines ?? 0),
            });
          } else if (event.type === "result") {
            result = event.data as { processed: ProcessedRow[] };
          } else if (event.type === "error") {
            setError(String(event.message ?? "unknown error"));
          }
        }
      }

      const ms = Math.round(performance.now() - started);
      if (result) {
        setProcessed(result.processed);
        setFinished(true);
        logCall({ at, method: "POST", path, status: 200, ms,
                  summary: t.callRunSummary(
                    String(result.processed.filter(p => p.status === "ok").length),
                    String(result.processed.length)) });
      }
    } catch (e) {
      const summary = e instanceof Error ? e.message : String(e);
      logCall({ at, method: "POST", path, status: "network", ms: Math.round(performance.now() - started), summary });
      setError(`${path} → ${summary}`);
    } finally {
      setBusy("");
      loadLog();
    }
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

        {(running || finished) && (
          <CircuitProgress
            fraction={progress.total > 0 ? progress.done / progress.total : (finished ? 1 : 0)}
            done={progress.done}
            total={progress.total}
            lines={progress.lines}
            finished={finished}
            labels={{ working: t.circuitWorking, charged: t.circuitCharged,
                      ofInvoices: t.circuitInvoices, linesWritten: t.circuitLines }}
          />
        )}
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
                      <td className="py-1.5 pr-3 font-mono text-ink">{p.sequence || p.invoice_id}</td>
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
                      <td className="py-1.5 pr-3 font-mono text-ink">{r.sequence || r.invoice_id}</td>
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
