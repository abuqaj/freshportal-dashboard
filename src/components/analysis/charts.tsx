"use client";

import { useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

// The Analysis Tool's own chart forms — the ones Tremor has no component for.
// Lines, areas and grouped bars come from src/components/tremor (2026-10-03);
// what is here is a ranking with its figures beside the bars, sell-through
// on a fixed 0–100% scale, one dot per lot on an hours axis, a log-log
// scatter with its fitted line, a histogram of cents and bars diverging from
// zero. Every word arrives as a prop or a formatter.

// The system palette, in the order the user gave it (2026-09-03). Chart
// series take their colours from tremor/chartUtils.ts, which uses the four
// of these that stay apart on white; the pale steps are for fills.
export const LINE_COLORS = ["#B03A2B", "#F7C4BC", "#1A7D45", "#C4DED0", "#E4E1D8", "#8E8B81", "#000000"];

// ── Ranking ─────────────────────────────────────────────────────────────────
// A sorted list reads as a ranking at a glance (FT Visual Vocabulary,
// "ranking"); bars start at zero, and the figures sit in aligned columns so
// they can be compared without measuring bar lengths.

export interface RankRow { key: string; label: string; value: number; sub?: string; extra?: string }

export function RankBars({ rows, format, valueHeader, extraHeader, onSelect, selectTip }: {
  rows: RankRow[];
  format: (v: number) => string;
  valueHeader?: string;
  extraHeader?: string;
  onSelect?: (row: RankRow) => void;
  selectTip?: string;
}) {
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 0) || 1;
  const hasExtra = rows.some(r => r.extra != null);
  const cols = hasExtra ? "grid-cols-[minmax(0,1fr)_minmax(4.5rem,auto)_minmax(4rem,auto)]" : "grid-cols-[minmax(0,1fr)_minmax(4.5rem,auto)]";
  return (
    <div className="flex flex-col gap-1">
      {(valueHeader || extraHeader) && (
        <div className={cn("grid items-center gap-3 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3", cols)}>
          <span />
          <span className="text-right">{valueHeader}</span>
          {hasExtra && <span className="text-right">{extraHeader}</span>}
        </div>
      )}
      {rows.map(r => {
        const Row = onSelect ? "button" : "div";
        return (
          <Row
            key={r.key}
            type={onSelect ? "button" : undefined}
            title={onSelect ? selectTip : undefined}
            onClick={onSelect ? () => onSelect(r) : undefined}
            className={cn(
              "group grid items-center gap-3 rounded-lg px-1 py-0.5 text-left outline-none",
              cols,
              onSelect && "cursor-pointer hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-emerald/40",
            )}
          >
            <div className="relative h-8 min-w-0">
              <div
                className={cn("absolute inset-y-0 left-0 rounded-md bg-sage transition-[width]", onSelect && "group-hover:bg-emerald/25")}
                style={{ width: `${Math.max(1.5, (Math.abs(r.value) / max) * 100)}%` }}
              />
              <span className="absolute inset-y-0 left-2 right-2 flex items-center truncate text-sm text-ink" title={r.label}>
                {r.label}
              </span>
            </div>
            <span className="text-right text-sm font-semibold tabular-nums text-ink">
              {format(r.value)}
              {r.sub && <span className="block text-[11px] font-normal text-ink-3">{r.sub}</span>}
            </span>
            {hasExtra && <span className="text-right text-xs tabular-nums text-ink-2">{r.extra ?? ""}</span>}
          </Row>
        );
      })}
    </div>
  );
}

// ── Sell-through ────────────────────────────────────────────────────────────
// A share of 0–100%, so every bar is drawn against the same full track —
// unlike a ranking scaled to its largest value.

export interface ProgressRow { key: string; label: string; pct: number; sub: string; extra?: string }

export function ProgressRows({ rows, formatPct, subHeader, extraHeader }: {
  rows: ProgressRow[];
  formatPct: (v: number) => string;
  subHeader?: string;
  extraHeader?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_minmax(5.5rem,auto)_minmax(3.5rem,auto)] gap-3 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
        <span /><span /><span className="text-right">{subHeader}</span><span className="text-right">{extraHeader}</span>
      </div>
      {rows.map(r => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_3.5rem_minmax(5.5rem,auto)_minmax(3.5rem,auto)] items-center gap-3 px-1">
          <div className="min-w-0">
            <div className="truncate text-sm text-ink" title={r.label}>{r.label}</div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-sage/45">
              <div className="h-full rounded-full bg-emerald" style={{ width: `${Math.min(100, Math.max(0, r.pct))}%` }} />
            </div>
          </div>
          <span className="text-right text-sm font-semibold tabular-nums text-ink">{formatPct(r.pct)}</span>
          <span className="text-right text-xs tabular-nums text-ink-2">{r.sub}</span>
          <span className="text-right text-xs tabular-nums text-ink-3">{r.extra ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

// ── Hours to sell out ───────────────────────────────────────────────────────
// One dot per lot that sold out, on an hours axis that gives the first day
// most of the room (0–6–12–24–48–96–168 h, evenly spaced), and a bar at the
// median. A strip plot keeps every lot visible where a box plot would hide
// how few there are (Data to Viz, "do boxplots hide information").

const HOUR_TICKS = [0, 6, 12, 24, 48, 96, 168];

function hourPos(h: number): number {
  const last = HOUR_TICKS.length - 1;
  if (h >= HOUR_TICKS[last]) return 100;
  for (let i = 0; i < last; i++) {
    if (h <= HOUR_TICKS[i + 1]) {
      const f = (h - HOUR_TICKS[i]) / (HOUR_TICKS[i + 1] - HOUR_TICKS[i]);
      return ((i + Math.max(0, f)) / last) * 100;
    }
  }
  return 100;
}

export interface StripRow { key: string; label: string; hours: number[]; median: number | null; side: string }

export function DotStrip({ rows, hourLabel, dotTip }: {
  rows: StripRow[];
  hourLabel: (h: number) => string;
  dotTip: (h: number) => string;
}) {
  const cols = "grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(5rem,auto)]";
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn("grid gap-3 px-1", cols)}>
        <span />
        <div className="relative h-4 text-[10px] tabular-nums text-ink-3">
          {HOUR_TICKS.map(h => (
            <span key={h} className="absolute -translate-x-1/2" style={{ left: `${hourPos(h)}%` }}>
              {h === HOUR_TICKS[HOUR_TICKS.length - 1] ? `${hourLabel(h)}+` : hourLabel(h)}
            </span>
          ))}
        </div>
        <span />
      </div>
      {rows.map(r => (
        <div key={r.key} className={cn("grid items-center gap-3 rounded-lg px-1 py-1 hover:bg-muted/40", cols)}>
          <span className="truncate text-sm text-ink" title={r.label}>{r.label}</span>
          <div className="relative h-7">
            {HOUR_TICKS.map(h => (
              <span key={h} className="absolute inset-y-1 w-px bg-muted" style={{ left: `${hourPos(h)}%` }} />
            ))}
            <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
            {r.hours.map((h, i) => (
              <span
                key={i}
                title={dotTip(h)}
                className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald/75 ring-2 ring-surface"
                style={{ left: `${hourPos(h)}%` }}
              />
            ))}
            {r.median != null && (
              <span
                title={dotTip(r.median)}
                className="absolute top-1/2 h-5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink"
                style={{ left: `${hourPos(r.median)}%` }}
              />
            )}
          </div>
          <span className="text-right text-xs tabular-nums text-ink-2">{r.side}</span>
        </div>
      ))}
    </div>
  );
}

// ── Log-log scatter (price elasticity) ──────────────────────────────────────
// One dot per week, both axes logarithmic, so a constant elasticity is a
// straight line and its slope is the number in the headline. Weeks left out
// of the fit (holidays) are drawn hollow, not hidden.

export interface ScatterDot { period: string; price: number; quantity: number; excluded?: boolean }

function logTicks(lo: number, hi: number, count = 5): number[] {
  const a = Math.log(lo), b = Math.log(hi);
  return Array.from({ length: count }, (_, i) => Math.exp(a + ((b - a) * i) / (count - 1)));
}

export function LogScatter({ points, elasticity, intercept, formatPrice, formatStems, formatPeriod, xLabel, yLabel, excludedLabel }: {
  points: ScatterDot[];
  elasticity: number | null;
  intercept: number | null;
  formatPrice: (v: number) => string;
  formatStems: (v: number) => string;
  formatPeriod: (iso: string) => string;
  xLabel: string;
  yLabel: string;
  excludedLabel: string;
}) {
  const [hover, setHover] = useState<ScatterDot | null>(null);
  const valid = useMemo(() => points.filter(p => p.price > 0 && p.quantity > 0), [points]);
  const geo = useMemo(() => {
    if (!valid.length) return null;
    const xs = valid.map(p => Math.log(p.price)), ys = valid.map(p => Math.log(p.quantity));
    const pad = (lo: number, hi: number) => { const d = (hi - lo) * 0.08 || 0.1; return [lo - d, hi + d]; };
    const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
    const [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
    return { x0, x1, y0, y1 };
  }, [valid]);
  if (!geo) return null;

  // Room on the left for the stem ticks and the rotated axis title, on the
  // right for the last price label centred on the edge.
  const W = 640, H = 300, L = 78, R = 34, T = 12, B = 40;
  const px = (price: number) => L + ((Math.log(price) - geo.x0) / (geo.x1 - geo.x0)) * (W - L - R);
  const py = (q: number) => T + (1 - (Math.log(q) - geo.y0) / (geo.y1 - geo.y0)) * (H - T - B);
  const xTicks = logTicks(Math.exp(geo.x0), Math.exp(geo.x1));
  const yTicks = logTicks(Math.exp(geo.y0), Math.exp(geo.y1));
  const line = elasticity != null && intercept != null
    ? [geo.x0, geo.x1].map(lx => ({ x: L + ((lx - geo.x0) / (geo.x1 - geo.x0)) * (W - L - R), y: py(Math.exp(intercept + elasticity * lx)) }))
    : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${yLabel} / ${xLabel}`}>
        <defs>
          <clipPath id="elasticity-plot"><rect x={L} y={T} width={W - L - R} height={H - T - B} /></clipPath>
        </defs>
        {yTicks.map((v, i) => (
          <g key={`y${i}`}>
            <line x1={L} x2={W - R} y1={py(v)} y2={py(v)} className="stroke-muted" strokeWidth={1} />
            <text x={L - 8} y={py(v) + 3} textAnchor="end" fontSize={11} className="fill-ink-3">{formatStems(v)}</text>
          </g>
        ))}
        {xTicks.map((v, i) => (
          <text key={`x${i}`} x={px(v)} y={H - B + 16} textAnchor="middle" fontSize={11} className="fill-ink-3">{formatPrice(v)}</text>
        ))}
        <text x={L + (W - L - R) / 2} y={H - 4} textAnchor="middle" fontSize={11} className="fill-ink-2">{xLabel}</text>
        <text x={12} y={T + (H - T - B) / 2} textAnchor="middle" fontSize={11} className="fill-ink-2" transform={`rotate(-90 12 ${T + (H - T - B) / 2})`}>{yLabel}</text>
        {line && (
          <line x1={line[0].x} y1={line[0].y} x2={line[1].x} y2={line[1].y} className="stroke-ink" strokeWidth={2} strokeLinecap="round" clipPath="url(#elasticity-plot)" />
        )}
        {valid.map((p, i) => (
          <g key={i}>
            <circle
              cx={px(p.price)} cy={py(p.quantity)} r={p.excluded ? 4.5 : 5.5}
              className={p.excluded ? "fill-surface stroke-taupe" : "fill-emerald stroke-surface"}
              strokeWidth={p.excluded ? 1.5 : 2}
              fillOpacity={p.excluded ? 1 : 0.8}
            />
            <circle
              cx={px(p.price)} cy={py(p.quantity)} r={12} fill="transparent" pointerEvents="all"
              onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)}
            />
          </g>
        ))}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[120%] rounded-lg bg-ink px-2.5 py-1.5 text-xs text-white shadow-lg"
          style={{ left: `${(px(hover.price) / W) * 100}%`, top: `${(py(hover.quantity) / H) * 100}%` }}
        >
          <div className="font-semibold">{formatPeriod(hover.period)}{hover.excluded ? ` · ${excludedLabel}` : ""}</div>
          <div className="tabular-nums">{formatPrice(hover.price)} · {formatStems(hover.quantity)}</div>
        </div>
      )}
    </div>
  );
}

// ── Histogram of cents ──────────────────────────────────────────────────────
// Sale price minus offer price minus transport, in one-cent bins: the middle
// bar is "sold at the offer price", left of it a discount, right of it a
// surcharge. Position carries the sign; colour repeats it.

export function DeviationHistogram({ bins, formatStems, binTip, edgeLabels }: {
  bins: { cents: number; stems: number }[];
  formatStems: (v: number) => string;
  binTip: (cents: number, stems: string) => string;
  edgeLabels: [string, string];
}) {
  const max = Math.max(...bins.map(b => b.stems), 0) || 1;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-36 items-end gap-[2px] border-b border-border">
        {bins.map(b => (
          <div
            key={b.cents}
            title={binTip(b.cents, formatStems(b.stems))}
            className={cn(
              "flex-1 rounded-t-[3px]",
              b.cents < 0 ? "bg-brick" : b.cents > 0 ? "bg-taupe" : "bg-emerald",
              b.stems === 0 && "opacity-0",
            )}
            style={{ height: `${Math.max(b.stems > 0 ? 2 : 0, (b.stems / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-ink-3">
        <span>{edgeLabels[0]}</span><span>−5</span><span className="font-semibold text-ink-2">0</span><span>+5</span><span>{edgeLabels[1]}</span>
      </div>
    </div>
  );
}

// ── Diverging bars ──────────────────────────────────────────────────────────
// Bars grow left or right of a shared zero: right of it dearer than the
// market (brick), left of it cheaper (emerald). The side already says which,
// so the colour is a second cue, not the only one.

export function DivergingBars({ rows, format, aboveLabel, belowLabel }: {
  rows: { key: string; label: string; value: number; sub?: ReactNode }[];
  format: (v: number) => string;
  aboveLabel: string;
  belowLabel: string;
}) {
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 0) || 1;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[minmax(0,10rem)_1fr_minmax(5rem,auto)] gap-3 px-1 text-[11px] text-ink-3">
        <span />
        <div className="flex justify-between">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-emerald" />{belowLabel}</span>
          <span className="inline-flex items-center gap-1">{aboveLabel}<span className="size-2 rounded-full bg-brick" /></span>
        </div>
        <span />
      </div>
      {rows.map(r => {
        const half = (Math.abs(r.value) / max) * 50;
        const up = r.value >= 0;
        return (
          <div key={r.key} className="grid grid-cols-[minmax(0,10rem)_1fr_minmax(5rem,auto)] items-center gap-3 rounded-lg px-1 py-0.5 hover:bg-muted/40">
            <span className="truncate text-sm text-ink" title={r.label}>{r.label}</span>
            <div className="relative h-6">
              <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
              <div
                className={cn("absolute inset-y-1 rounded-md", up ? "bg-brick" : "bg-emerald")}
                style={{ left: up ? "50%" : `${50 - half}%`, width: `${Math.max(0.6, half)}%` }}
              />
            </div>
            <span className="text-right text-sm font-semibold tabular-nums text-ink">
              {format(r.value)}
              {r.sub && <span className="block text-[11px] font-normal text-ink-3">{r.sub}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
