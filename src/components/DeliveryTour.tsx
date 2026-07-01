"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface TourStep {
  targetRef?: React.RefObject<HTMLElement | null>;
  title: string;
  body: string;
}

interface TourTranslations {
  tourNext: string;
  tourSkip: string;
  tourFinish: string;
}

interface Props {
  steps: TourStep[];
  stepIndex: number;
  onNext: () => void;
  onSkip: () => void;
  t: TourTranslations;
}

const PAD = 10;
const TW = 320;
const TH = 190;

export default function DeliveryTour({ steps, stepIndex, onNext, onSkip, t }: Props) {
  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    setRect(null); // clear old position immediately on step change
    const el = step?.targetRef?.current;
    if (!el) return;

    el.scrollIntoView({ behavior: "smooth", block: "nearest" });

    const measure = () => setRect(el.getBoundingClientRect());

    // Wait for any CSS animations and scrolling to settle
    const timer = setTimeout(measure, 350);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, { capture: true } as EventListenerOptions);
    };
  }, [stepIndex, step]);

  if (!step || !mounted) return null;

  let spotlightStyle: React.CSSProperties = {};
  let tooltipStyle: React.CSSProperties = {};

  if (rect) {
    const sr = {
      top: rect.top - PAD,
      left: rect.left - PAD,
      width: rect.width + PAD * 2,
      height: rect.height + PAD * 2,
    };
    spotlightStyle = {
      position: "fixed",
      top: sr.top,
      left: sr.left,
      width: sr.width,
      height: sr.height,
      borderRadius: 14,
      boxShadow: "0 0 0 9999px rgba(0,0,0,0.65)",
      zIndex: 9998,
      pointerEvents: "none",
      transition: "top 0.25s ease, left 0.25s ease, width 0.25s ease, height 0.25s ease",
    };

    const spaceBelow = window.innerHeight - (sr.top + sr.height + 12);
    const placeAbove = spaceBelow < TH + 8;

    let ttTop = placeAbove ? sr.top - TH - 12 : sr.top + sr.height + 12;
    let ttLeft = sr.left;

    if (ttLeft + TW > window.innerWidth - 12) ttLeft = window.innerWidth - TW - 12;
    if (ttLeft < 12) ttLeft = 12;
    if (ttTop < 12) ttTop = 12;

    tooltipStyle = {
      position: "fixed",
      top: ttTop,
      left: ttLeft,
      width: TW,
      zIndex: 9999,
      transition: "top 0.25s ease, left 0.25s ease",
    };
  } else {
    // No target — show centered tooltip with full dark overlay
    tooltipStyle = {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: TW,
      zIndex: 9999,
    };
  }

  const content = (
    <>
      {/* Click blocker */}
      <div className="fixed inset-0" style={{ zIndex: 9996 }} />

      {/* Dark overlay when no spotlight target */}
      {!rect && (
        <div
          className="fixed inset-0"
          style={{ zIndex: 9997, background: "rgba(0,0,0,0.65)", pointerEvents: "none" }}
        />
      )}

      {/* Spotlight — box-shadow creates dark area around the target element */}
      {rect && <div style={spotlightStyle} />}

      {/* Tooltip card */}
      <div
        style={tooltipStyle}
        className="bg-surface border border-border rounded-2xl shadow-2xl p-4 flex flex-col gap-3"
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-ink-3">
            {stepIndex + 1} / {steps.length}
          </span>
          <button
            onClick={onSkip}
            className="text-[11px] text-ink-3 hover:text-ink transition-colors"
          >
            {t.tourSkip}
          </button>
        </div>

        <div>
          <p className="text-sm font-semibold text-ink">{step.title}</p>
          <p className="text-xs text-ink-3 mt-1.5 leading-relaxed">{step.body}</p>
        </div>

        {/* Progress dots */}
        <div className="flex items-center gap-1 flex-wrap">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all ${
                i === stepIndex
                  ? "w-5 h-1.5 bg-emerald"
                  : i < stepIndex
                  ? "w-1.5 h-1.5 bg-emerald/40"
                  : "w-1.5 h-1.5 bg-border"
              }`}
            />
          ))}
        </div>

        <button
          onClick={onNext}
          className="self-end h-8 px-4 rounded-xl text-sm font-semibold text-white bg-emerald hover:bg-emerald/90 transition-colors"
        >
          {isLast ? t.tourFinish : t.tourNext}
        </button>
      </div>
    </>
  );

  return createPortal(content, document.body);
}
