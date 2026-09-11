"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
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

/** Cartoon leader at the button, in the political-cartoon convention: the
 *  read comes from costume and silhouette — the buttoned Mao-collar tunic and
 *  the squared-off undercut — rather than from exaggerated facial features.
 *  Decorative only: aria-hidden, nothing here is interactive. */
function DeskFigure({ armDown }: { armDown: boolean }) {
  return (
    <svg viewBox="0 0 190 250" aria-hidden="true"
         className="hidden sm:block w-40 lg:w-52 shrink-0 self-end -mr-10 lg:-mr-14 relative z-10 pointer-events-none">
      {/* legs */}
      <path d="M48 250V168h48v82" fill="#23262B" />
      {/* tunic — wide and square, buttoned to the throat */}
      <path d="M36 172c0-40 10-62 34-69l14 2c24 7 34 29 34 67z" fill="#2E3239" />
      <path d="M78 105v66" stroke="#1B1E22" strokeWidth="2" />
      <circle cx="86" cy="122" r="2.3" fill="#C9CDD4" />
      <circle cx="86" cy="138" r="2.3" fill="#C9CDD4" />
      <circle cx="86" cy="154" r="2.3" fill="#C9CDD4" />
      {/* mandarin collar */}
      <path d="M62 104h34l-5 12H67z" fill="#3A3F47" />
      <rect x="62" y="100" width="34" height="7" rx="3" fill="#3A3F47" />

      {/* neck + head */}
      <rect x="68" y="86" width="22" height="18" rx="7" fill="#E8B98F" />
      <ellipse cx="79" cy="58" rx="30" ry="29" fill="#F2C79C" />
      {/* the haircut: shaved close at the sides, flat squared top */}
      <path d="M49 52c0-19 13-31 30-31s30 12 30 31c0 4-3 5-4 2-3-8-12-13-26-13s-23 5-26 13c-1 3-4 2-4-2z" fill="#22242A" />
      <path d="M53 56c2 6 4 9 4 14-4-2-6-7-6-12zM105 56c-2 6-4 9-4 14 4-2 6-7 6-12z" fill="#22242A" />
      {/* face — dot eyes and a flat mouth, same restraint as the brows */}
      <ellipse cx="70" cy="60" rx="2.8" ry="3" fill="#24242A" />
      <ellipse cx="88" cy="60" rx="2.8" ry="3" fill="#24242A" />
      <path d="M64 50l11 3M94 50l-11 3" stroke="#22242A" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M71 76h16" stroke="#A8654F" strokeWidth="3" strokeLinecap="round" />

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
        <path d="M104 130h58" stroke="#2E3239" strokeWidth="22" fill="none" strokeLinecap="round" />
        <path d="M158 130h4" stroke="#3A3F47" strokeWidth="22" fill="none" strokeLinecap="round" />
        <circle cx="172" cy="130" r="12" fill="#F2C79C" />
        {/* the index finger, out ahead of the fist */}
        <path d="M178 130h8" stroke="#F2C79C" strokeWidth="9" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** The three cables, drawn once and then measured. Each runs from beneath the
 *  button down to the battery, winding so the run has somewhere to go. */
const CABLES = [
  "M150 4 C150 40 60 46 60 88 C60 128 168 120 168 162 C168 196 96 194 96 226",
  "M150 4 C150 34 232 44 232 86 C232 126 124 124 124 160 C124 194 96 196 96 226",
  "M150 4 C150 52 146 60 146 96 C146 136 200 140 200 176 C200 206 96 204 96 226",
];

/** How many lit nodes to spread over the cables. Deliberately high: a run can
 *  cover a lot of invoices, and a handful of dots would jump a quarter of the
 *  board at a time. */
const NODE_COUNT = 78;

interface CableNode { x: number; y: number; cable: number }

/** Cable run under the button that fills as the work completes.
 *
 *  `fraction` is real progress, not a timer: nodes light in order and stop
 *  where the run actually is. Node positions are measured off the rendered
 *  paths with getPointAtLength rather than hand-placed, so the dots sit on
 *  the cable exactly and the curves stay free to change. */
function CircuitProgress({
  fraction, done, total, lines, finished, labels,
}: {
  fraction: number; done: number; total: number; lines: number; finished: boolean;
  labels: { working: string; charged: string; ofInvoices: string; linesWritten: string };
}) {
  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const [nodes, setNodes] = useState<CableNode[]>([]);

  useEffect(() => {
    const paths = pathRefs.current.filter(Boolean) as SVGPathElement[];
    if (paths.length !== CABLES.length) return;
    const lengths = paths.map(p => p.getTotalLength());
    const perCable = Math.round(NODE_COUNT / CABLES.length);
    const out: CableNode[] = [];
    // Interleaved by index, not cable after cable: the three fill together,
    // which reads as one circuit energising rather than three in sequence.
    for (let i = 0; i < perCable; i++) {
      for (let c = 0; c < paths.length; c++) {
        const at = paths[c].getPointAtLength(((i + 0.5) / perCable) * lengths[c]);
        out.push({ x: at.x, y: at.y, cable: c });
      }
    }
    setNodes(out);
  }, []);

  const litCount = Math.round(Math.min(1, Math.max(0, fraction)) * nodes.length);
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);

  return (
    <div className="panel-drop w-full max-w-xl mx-auto">
      <svg viewBox="0 0 300 250" className="w-full" aria-hidden="true">
        <defs>
          <linearGradient id="bw-live" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38BDF8" />
            <stop offset="100%" stopColor="#22D3EE" />
          </linearGradient>
          <filter id="bw-glow" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* dead cable */}
        {CABLES.map((d, i) => (
          <path key={`dead-${i}`} ref={el => { pathRefs.current[i] = el; }}
                d={d} fill="none" stroke="#2A3038" strokeWidth="5" strokeLinecap="round" />
        ))}

        {/* live cable, revealed by dash offset up to the current fraction */}
        {CABLES.map((d, i) => (
          <path key={`live-${i}`} d={d} fill="none" stroke="url(#bw-live)" strokeWidth="3"
                strokeLinecap="round" filter="url(#bw-glow)"
                pathLength={1} strokeDasharray={`${Math.max(0, Math.min(1, fraction))} 1`}
                style={{ transition: "stroke-dasharray 420ms ease-out" }} />
        ))}

        {/* energy travelling along the part that is already live */}
        {fraction > 0.02 && !finished && CABLES.map((d, i) => (
          <path key={`flow-${i}`} d={d} fill="none" stroke="#E0F7FF" strokeWidth="1.6"
                strokeLinecap="round" className="cable-flow"
                pathLength={1} strokeDasharray="0.012 0.06"
                style={{ clipPath: "none", opacity: 0.9 }} />
        ))}

        {/* the nodes */}
        {nodes.map((n, i) => {
          const lit = i < litCount;
          return (
            <circle
              key={i} cx={n.x} cy={n.y} r={lit ? 3.1 : 1.9}
              fill={lit ? "#7DE3FF" : "#39414B"}
              filter={lit ? "url(#bw-glow)" : undefined}
              className={lit ? "node-pop" : undefined}
              style={{ transition: "r 200ms ease-out, fill 200ms ease-out" }}
            />
          );
        })}

        {/* battery at the end of the run */}
        <g transform="translate(96 226)">
          <rect x="-26" y="-13" width="52" height="26" rx="6"
                fill="#1B2027" stroke={finished ? "#4ADE80" : "#39414B"} strokeWidth="2.5"
                className={finished ? "battery-pulse" : undefined}
                style={{ color: finished ? "#4ADE80" : undefined }} />
          <rect x="26" y="-5" width="5" height="10" rx="2" fill={finished ? "#4ADE80" : "#39414B"} />
          <rect x="-21" y="-8" width={Math.max(0, 42 * Math.min(1, fraction))} height="16" rx="3"
                fill={finished ? "#4ADE80" : "url(#bw-live)"}
                style={{ transition: "width 420ms ease-out" }} />
        </g>

        {/* the payoff: fireworks that do not make it */}
        {finished && <DudFireworks />}
      </svg>

      <div className="flex items-center justify-center gap-4 flex-wrap text-xs mt-1">
        <span className="font-mono tabular-nums text-ink">{pct}%</span>
        <span className="text-ink-3">{done}/{total} {labels.ofInvoices}</span>
        <span className="text-ink-3">{lines} {labels.linesWritten}</span>
        <span className={finished ? "text-emerald font-semibold" : "text-ink-3"}>
          {finished ? labels.charged : labels.working}
        </span>
      </div>
    </div>
  );
}

/** Rockets launched from the battery that stall mid-climb and burst on the
 *  way down. Positions and drifts are fixed rather than random so the scene
 *  is the same every run — a firework that lands somewhere different each
 *  time reads as a glitch. */
const DUDS = [
  { x: 96,  delay: 0.0,  drift: -26, hue: "#FCD34D" },
  { x: 96,  delay: 0.18, drift: 20,  hue: "#F472B6" },
  { x: 96,  delay: 0.32, drift: -8,  hue: "#60A5FA" },
  { x: 96,  delay: 0.46, drift: 34,  hue: "#4ADE80" },
  { x: 96,  delay: 0.6,  drift: -38, hue: "#FB923C" },
];

function DudFireworks() {
  return (
    <g>
      {DUDS.map((d, i) => (
        <g key={i} className="dud-drift"
           style={{ ["--drift"]: `${d.drift}px`, animationDelay: `${d.delay}s`,
                    transformBox: "fill-box", transformOrigin: "center" } as CSSProperties}>
          <g transform={`translate(${d.x} 214)`}>
            <g className="dud-flight" style={{ animationDelay: `${d.delay}s`,
                                               transformBox: "fill-box", transformOrigin: "center" }}>
              <circle r="2.6" fill={d.hue} filter="url(#bw-glow)" />
            </g>
            <g className="dud-burst" style={{ animationDelay: `${d.delay}s`,
                                              transformBox: "fill-box", transformOrigin: "center" }}
               transform="translate(0 26)">
              <circle r="4" fill="none" stroke={d.hue} strokeWidth="1.6" />
            </g>
            {[0, 60, 120, 180, 240, 300].map(angle => (
              <g key={angle} className="dud-spark"
                 style={{
                   ["--sx"]: `${Math.cos((angle * Math.PI) / 180) * 15}px`,
                   ["--sy"]: `${Math.sin((angle * Math.PI) / 180) * 15}px`,
                   animationDelay: `${d.delay}s`,
                   transformBox: "fill-box", transformOrigin: "center",
                 } as CSSProperties}
                 transform="translate(0 26)">
                <circle r="1.5" fill={d.hue} />
              </g>
            ))}
          </g>
        </g>
      ))}
    </g>
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
