"use client";

import { useEffect, useRef, useState } from "react";

// What the delivery screen says a temporary PDF format costs, and how many
// times the real spend its counter shows. Both are well above what a draft
// really costs (about 0.60 USD), so that people think twice before paying
// for one (user, 2026-09-30). Admin → PDF formats shows the real figures.
export const LAYOUT_DRAFT_PRICE_SHOWN_USD = 5;
export const LAYOUT_DRAFT_SPEND_SHOWN_FACTOR = 10;

/** A clerk throwing banknotes into a bin while a temporary format is
 *  drafted, and the money spent so far. `usd` is the draft's real spend as
 *  the server last reported it; each new figure is counted up to over
 *  `catchUpMs` (the poll interval), so the count runs on between polls
 *  instead of jumping, and the clerk throws only while it runs. */
export default function LayoutDraftMeter({ usd, catchUpMs, spentLabel }: {
  usd: number;
  catchUpMs: number;
  spentLabel: string;
}) {
  const target = usd * LAYOUT_DRAFT_SPEND_SHOWN_FACTOR;
  const shownRef = useRef(0);
  const [shown, setShown] = useState(0);
  const [counting, setCounting] = useState(false);

  useEffect(() => {
    const from = shownRef.current;
    // Never counts back: a turn's estimate errs low, and its exact figure
    // only ever adds to it.
    const to = Math.max(from, target);
    if (to === from) {
      setCounting(false);
      return;
    }
    setCounting(true);
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - start) / catchUpMs);
      shownRef.current = from + (to - from) * k;
      setShown(shownRef.current);
      if (k < 1) frame = requestAnimationFrame(step);
      else setCounting(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, catchUpMs]);

  return (
    <div className="flex flex-col items-center gap-3">
      <svg viewBox="0 0 200 140" className="w-44 h-auto" data-counting={counting} aria-hidden="true">
        <rect x="8" y="122" width="124" height="8" rx="4" className="fill-sand" />

        {/* The clerk, in an accountant's green eyeshade, eyes on the bin */}
        <path d="M48 122 C48 96 56 82 80 82 C104 82 112 96 112 122 Z" className="fill-ink-2" />
        <circle cx="80" cy="58" r="17" className="fill-blush stroke-ink-2" strokeWidth="1.5" />
        <path d="M61 51 Q80 38 99 51 Q80 46 61 51 Z" className="fill-emerald stroke-emerald-dark" strokeWidth="1" />
        <circle cx="78" cy="60" r="1.8" className="fill-ink" />
        <circle cx="88" cy="60" r="1.8" className="fill-ink" />
        <path d="M78 67 q4 2.5 8 0" fill="none" className="stroke-ink-2" strokeWidth="1.5" strokeLinecap="round" />

        {/* The stack in one hand */}
        <path d="M102 92 Q112 100 116 108" fill="none" className="stroke-ink-2" strokeWidth="9" strokeLinecap="round" />
        {[100, 97, 94, 91].map((y, i) => (
          <rect key={y} x={98 + (i % 2)} y={y} width="36" height="14" rx="2" className="fill-emerald stroke-emerald-dark" strokeWidth="1" />
        ))}
        <circle cx="117" cy="98" r="3.5" className="fill-emerald-light" />
        <circle cx="116" cy="110" r="5" className="fill-blush stroke-ink-2" strokeWidth="1" />

        {/* Notes on their way into the bin, one per flick */}
        {[0, 1].map(i => (
          <g key={i} className="ldm-toss" style={{ animationDelay: `${-i * 0.35}s` }}>
            <rect x="98" y="88" width="36" height="14" rx="2" className="fill-emerald stroke-emerald-dark" strokeWidth="1" />
            <circle cx="116" cy="95" r="3.5" className="fill-emerald-light" />
          </g>
        ))}

        {/* The other hand, flicking the notes off */}
        <g className="ldm-flick">
          <path d="M58 94 Q78 104 96 94" fill="none" className="stroke-ink-2" strokeWidth="9" strokeLinecap="round" />
          <circle cx="98" cy="93" r="5" className="fill-blush stroke-ink-2" strokeWidth="1" />
        </g>

        {/* The bin, with what went in before showing over the rim */}
        <rect x="145" y="84" width="20" height="12" rx="1.5" transform="rotate(-20 155 90)" className="fill-emerald stroke-emerald-dark" strokeWidth="1" />
        <rect x="155" y="83" width="20" height="12" rx="1.5" transform="rotate(15 165 89)" className="fill-emerald stroke-emerald-dark" strokeWidth="1" />
        <path d="M141 98 H175 L171 132 H145 Z" className="fill-taupe" />
        <path d="M151 104 V127 M158 104 V127 M165 104 V127" className="stroke-sand" strokeWidth="2" strokeLinecap="round" />
        <rect x="138" y="94" width="40" height="6" rx="2" className="fill-ink-2" />
      </svg>
      <div className="flex flex-col items-center">
        <span className="text-[11px] uppercase tracking-wide text-ink-3">{spentLabel}</span>
        <span className="text-3xl font-bold tabular-nums text-brick">${shown.toFixed(2)}</span>
      </div>
    </div>
  );
}
