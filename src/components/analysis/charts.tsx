"use client";

import { useState } from "react";

// Chart primitives for the Analysis Tool. Dependency-free SVG/HTML — no
// charting library, deliberately (see AnalysisTool.tsx). Split out of that
// file 2026-09-03 when the second batch of analyses landed and it stopped
// being readable as one module.

// User-specified palette (fixed order — 2026-09-03). Assigned by position,
// never cycled per-render, so a series keeps its color as filters change.
export const LINE_COLORS = ["#B03A2B", "#F7C4BC", "#1A7D45", "#C4DED0", "#E4E1D8", "#8E8B81", "#000000"];

// Semantic pair for the diverging chart — from the same palette.
export const COLOR_ABOVE = "#B03A2B";  // above market = expensive
export const COLOR_BELOW = "#1A7D45";  // below market = cheap
export const COLOR_NEUTRAL = "#8E8B81";

const MONTHS_PL = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];

export function shortDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "1".."12" -> "sty".."gru" — x-axis labels for the seasonality chart. */
export function monthLabel(m: string): string {
  return MONTHS_PL[Number(m) - 1] ?? m;
}

export function fmtPrice(v: number | null | undefined): string {
  return v == null ? "—" : `$${v.toFixed(3)}`;
}

export function fmtNum(v: number | null | undefined): string {
  return v == null ? "—" : Math.round(v).toLocaleString();
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export interface SeriesPoint {
  day: string;
  value: number;
  quantity: number;
}

export interface Series {
  key: string;
  label: string;
  points: SeriesPoint[];
}

function Empty({ text = "Brak danych w tym zakresie" }: { text?: string }) {
  return <p className="text-xs text-ink-3 px-1 py-10 text-center">{text}</p>;
}

/** Absolutely-positioned tooltip; coordinates are % of the chart box so it
 *  tracks correctly as the responsive SVG scales. */
function Tip({ leftPct, topPct, children }: { leftPct: number; topPct: number; children: React.ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-lg bg-ink text-white text-xs px-2.5 py-1.5 shadow-lg whitespace-nowrap"
      style={{ left: `${leftPct}%`, top: `${topPct}%`, transform: "translate(-50%, -130%)" }}
    >
      {children}
    </div>
  );
}

function Legend({ items, highlightKey }: { items: { key: string; label: string; color: string }[]; highlightKey?: string }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2 px-2">
      {items.map(it => (
        <span
          key={it.key}
          className={`inline-flex items-center gap-1.5 text-xs ${highlightKey === it.key ? "text-ink font-semibold" : "text-ink-3"}`}
        >
          <span className="w-2.5 h-2.5 rounded-full shrink-0 border border-border" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ── Multi-series line chart ────────────────────────────────────────────────
// x = shared ordered category (day, or month for seasonality), evenly spaced
// by position rather than by real date gaps. The tooltip is React-driven
// rather than an SVG <title>: a transparent-filled hit circle receives no
// pointer events under the default `pointer-events: visiblePainted`, which
// is why the original <title> tooltip silently never fired (fixed 2026-09-03
// via pointerEvents="all").
export function MultiLineChart({
  series,
  highlightKey,
  height = 320,
  xLabel = shortDay,
  formatValue = fmtPrice,
  showQuantity = true,
}: {
  series: Series[];
  highlightKey?: string;
  height?: number;
  xLabel?: (v: string) => string;
  formatValue?: (v: number | null | undefined) => string;
  showQuantity?: boolean;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; series: Series; point: SeriesPoint } | null>(null);
  const nonEmpty = series.filter(s => s.points.length > 0);
  if (!nonEmpty.length) return <Empty />;

  const allDays = Array.from(new Set(nonEmpty.flatMap(s => s.points.map(p => p.day)))).sort();
  const allValues = nonEmpty.flatMap(s => s.points.map(p => p.value));
  const maxV = Math.max(...allValues);
  const minV = Math.min(0, ...allValues);
  const range = maxV - minV || 1;

  const width = 1000;
  const padL = 56, padR = 12, padT = 16, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xFor = (day: string) => {
    const idx = allDays.indexOf(day);
    return padL + (allDays.length <= 1 ? plotW / 2 : (idx / (allDays.length - 1)) * plotW);
  };
  const yFor = (v: number) => padT + plotH - ((v - minV) / range) * plotH;

  const yTickCount = 6;
  const yTicks = Array.from({ length: yTickCount }, (_, i) => minV + (range * i) / (yTickCount - 1));

  // Up to 8 evenly-spaced labels — denser than first/mid/last, which was
  // unreadable over a multi-year range.
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
            <text x={2} y={yFor(v) + 3} fontSize={10} className="fill-ink-3">{formatValue(v)}</text>
          </g>
        ))}
        {xTickIdx.map(i => (
          <text key={i} x={xFor(allDays[i])} y={height - 6} fontSize={10} textAnchor="middle" className="fill-ink-3">
            {xLabel(allDays[i])}
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
        <Tip leftPct={(hover.x / width) * 100} topPct={(hover.y / height) * 100}>
          <div className="font-semibold">{hover.series.label}</div>
          <div>{xLabel(hover.point.day)} · {formatValue(hover.point.value)}</div>
          {showQuantity && <div>{fmtNum(hover.point.quantity)} pudełek sprzedanych</div>}
        </Tip>
      )}
      <Legend
        items={nonEmpty.map((s, si) => ({ key: s.key, label: s.label, color: LINE_COLORS[si % LINE_COLORS.length] }))}
        highlightKey={highlightKey}
      />
    </div>
  );
}

// ── Scatter ───────────────────────────────────────────────────────────────
// For the price-elasticity cloud: one dot per period, x = price, y = volume.
// A time series can't show this relationship — the question is how the two
// measures move against each other, not against the calendar.
export interface ScatterPoint {
  period: string;
  price: number;
  quantity: number;
}

export function ScatterChart({
  points,
  height = 320,
  xAxisLabel = "Średnia cena",
  yAxisLabel = "Wolumen",
}: {
  points: ScatterPoint[];
  height?: number;
  xAxisLabel?: string;
  yAxisLabel?: string;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; p: ScatterPoint } | null>(null);
  if (!points.length) return <Empty />;

  const width = 1000;
  const padL = 62, padR = 16, padT = 16, padB = 42;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xs = points.map(p => p.price);
  const ys = points.map(p => p.quantity);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = 0, yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const xFor = (v: number) => padL + ((v - xMin) / xRange) * plotW;
  const yFor = (v: number) => padT + plotH - ((v - yMin) / yRange) * plotH;

  const tickCount = 6;
  const yTicks = Array.from({ length: tickCount }, (_, i) => yMin + (yRange * i) / (tickCount - 1));
  const xTicks = Array.from({ length: tickCount }, (_, i) => xMin + (xRange * i) / (tickCount - 1));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={yFor(v)} y2={yFor(v)} className="stroke-border" strokeWidth={1} />
            <text x={2} y={yFor(v) + 3} fontSize={10} className="fill-ink-3">{fmtNum(v)}</text>
          </g>
        ))}
        {xTicks.map((v, i) => (
          <text key={i} x={xFor(v)} y={height - 18} fontSize={10} textAnchor="middle" className="fill-ink-3">
            {fmtPrice(v)}
          </text>
        ))}
        <text x={padL + plotW / 2} y={height - 3} fontSize={10} textAnchor="middle" className="fill-ink-3">{xAxisLabel}</text>
        <text x={10} y={padT - 4} fontSize={10} className="fill-ink-3">{yAxisLabel}</text>
        {points.map((p, i) => (
          <circle
            key={i}
            cx={xFor(p.price)}
            cy={yFor(p.quantity)}
            r={hover?.p === p ? 7 : 5}
            fill={LINE_COLORS[0]}
            fillOpacity={0.65}
            stroke={LINE_COLORS[0]}
            pointerEvents="all"
            onMouseEnter={() => setHover({ x: xFor(p.price), y: yFor(p.quantity), p })}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hover && (
        <Tip leftPct={(hover.x / width) * 100} topPct={(hover.y / height) * 100}>
          <div className="font-semibold">{shortDay(hover.p.period)}</div>
          <div>{fmtPrice(hover.p.price)} · {fmtNum(hover.p.quantity)} pudełek</div>
        </Tip>
      )}
    </div>
  );
}

// ── Grouped vertical bars ─────────────────────────────────────────────────
// x = an ordinal category (stem length, holiday), one bar per series within
// each group. Handles negative values with a real zero baseline, so the
// event-impact lifts read correctly in both directions.
export function GroupedBarChart({
  categories,
  series,
  height = 300,
  formatValue = fmtPrice,
  showValueLabels = true,
}: {
  categories: string[];
  series: { key: string; label: string; values: (number | null)[] }[];
  height?: number;
  formatValue?: (v: number | null | undefined) => string;
  showValueLabels?: boolean;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; cat: string; label: string; value: number } | null>(null);
  const all = series.flatMap(s => s.values).filter((v): v is number => v != null);
  if (!categories.length || !all.length) return <Empty />;

  const width = 1000;
  const padL = 56, padR = 12, padT = 20, padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxV = Math.max(0, ...all);
  const minV = Math.min(0, ...all);
  const range = maxV - minV || 1;
  const yFor = (v: number) => padT + plotH - ((v - minV) / range) * plotH;
  const zeroY = yFor(0);

  const groupW = plotW / categories.length;
  const innerW = groupW * 0.72;
  const barW = innerW / series.length;

  const yTickCount = 6;
  const yTicks = Array.from({ length: yTickCount }, (_, i) => minV + (range * i) / (yTickCount - 1));
  const labelsFit = showValueLabels && categories.length * series.length <= 20;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={yFor(v)} y2={yFor(v)} className="stroke-border" strokeWidth={1} />
            <text x={2} y={yFor(v) + 3} fontSize={10} className="fill-ink-3">{formatValue(v)}</text>
          </g>
        ))}
        {minV < 0 && <line x1={padL} x2={width - padR} y1={zeroY} y2={zeroY} stroke="currentColor" className="text-ink-3" strokeWidth={1.5} />}
        {categories.map((cat, ci) => {
          const groupCenter = padL + groupW * (ci + 0.5);
          return (
            <g key={cat}>
              {series.map((s, si) => {
                const v = s.values[ci];
                if (v == null) return null;
                const x = groupCenter - innerW / 2 + si * barW;
                const y = v >= 0 ? yFor(v) : zeroY;
                const h = Math.max(1, Math.abs(yFor(v) - zeroY));
                const color = LINE_COLORS[si % LINE_COLORS.length];
                return (
                  <g key={s.key}>
                    <rect
                      x={x + 1}
                      y={y}
                      width={Math.max(1, barW - 2)}
                      height={h}
                      rx={3}
                      fill={color}
                      stroke="var(--color-surface, #fff)"
                      strokeWidth={1}
                      pointerEvents="all"
                      onMouseEnter={() => setHover({ x: x + barW / 2, y, cat, label: s.label, value: v })}
                      onMouseLeave={() => setHover(null)}
                    />
                    {labelsFit && (
                      <text
                        x={x + barW / 2}
                        y={v >= 0 ? y - 4 : y + h + 11}
                        fontSize={9}
                        textAnchor="middle"
                        className="fill-ink-3"
                      >
                        {formatValue(v)}
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={groupCenter} y={height - 22} fontSize={11} textAnchor="middle" className="fill-ink">{cat}</text>
            </g>
          );
        })}
      </svg>
      {hover && (
        <Tip leftPct={(hover.x / width) * 100} topPct={(hover.y / height) * 100}>
          <div className="font-semibold">{hover.cat}</div>
          <div>{hover.label}: {formatValue(hover.value)}</div>
        </Tip>
      )}
      {series.length > 1 && (
        <Legend items={series.map((s, si) => ({ key: s.key, label: s.label, color: LINE_COLORS[si % LINE_COLORS.length] }))} />
      )}
    </div>
  );
}

// ── Horizontal bars (ranking) ─────────────────────────────────────────────
// HTML rather than SVG: long supplier names need real text truncation and
// wrapping behaviour, which is painful in SVG and free here. Bars are always
// 0-based — a truncated bar axis exaggerates small differences.
export function HBarChart({
  points,
  format = fmtPrice,
  color = COLOR_BELOW,
  emptyText,
}: {
  points: { label: string; value: number; sublabel?: string }[];
  format?: (v: number | null | undefined) => string;
  color?: string;
  emptyText?: string;
}) {
  if (!points.length) return <Empty text={emptyText} />;
  const max = Math.max(...points.map(p => Math.abs(p.value))) || 1;

  return (
    <div className="flex flex-col gap-1.5">
      {points.map((p, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate text-ink" title={p.label}>{p.label}</span>
          <div className="h-5 bg-muted rounded-md overflow-hidden">
            <div
              className="h-full rounded-md transition-[width]"
              style={{ width: `${Math.max(1, (Math.abs(p.value) / max) * 100)}%`, background: color }}
            />
          </div>
          <span className="text-ink tabular-nums font-medium whitespace-nowrap">
            {format(p.value)}
            {p.sublabel && <span className="text-ink-3 font-normal ml-1.5">{p.sublabel}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Diverging bars ────────────────────────────────────────────────────────
// Bars grow left/right from a shared zero line, colored by sign. The sign is
// the whole point of the market-deviation view ("dearer or cheaper than
// everyone else"), so it carries a color as well as a direction.
export function DivergingBarChart({
  points,
  format = fmtPct,
  emptyText,
  aboveLabel = "powyżej rynku",
  belowLabel = "poniżej rynku",
}: {
  points: { label: string; value: number; sublabel?: string }[];
  format?: (v: number | null | undefined) => string;
  emptyText?: string;
  aboveLabel?: string;
  belowLabel?: string;
}) {
  if (!points.length) return <Empty text={emptyText} />;
  const max = Math.max(...points.map(p => Math.abs(p.value))) || 1;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-xs text-ink-3 pl-[11.5rem]">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: COLOR_BELOW }} />{belowLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: COLOR_ABOVE }} />{aboveLabel}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {points.map((p, i) => {
          const pct = (Math.abs(p.value) / max) * 50; // half-width each side
          const positive = p.value >= 0;
          return (
            <div key={i} className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 text-xs">
              <span className="truncate text-ink" title={p.label}>{p.label}</span>
              <div className="relative h-5 bg-muted rounded-md">
                <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                <div
                  className="absolute inset-y-0 rounded-md"
                  style={{
                    background: positive ? COLOR_ABOVE : COLOR_BELOW,
                    left: positive ? "50%" : `${50 - pct}%`,
                    width: `${Math.max(0.5, pct)}%`,
                  }}
                />
              </div>
              <span className="text-ink tabular-nums font-medium whitespace-nowrap">
                {format(p.value)}
                {p.sublabel && <span className="text-ink-3 font-normal ml-1.5">{p.sublabel}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
