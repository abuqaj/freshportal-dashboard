"use client";

import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { motionLevel } from "@/lib/motion";

// The tiles' own transitions, restated whenever the tilt writes its own, so
// the lift and the press keep animating while the tile tilts.
const TILE_TRANSITIONS = "translate 0.3s cubic-bezier(0.22,1,0.36,1), scale 0.18s cubic-bezier(0.34,1.36,0.64,1), box-shadow 0.2s";

/* ─── 3-D tilt, with the light that follows the pointer ─── */
/** A frame of the gesture writes the transform and nothing else. The tilt used
 *  to re-declare the transition on every mouse move, which dirties the
 *  element's style each frame, and it left the card unpromoted, so the browser
 *  redrew the whole tile — artwork included — instead of re-composing a layer
 *  it already had. That is invisible on a gradient tile and very visible on a
 *  system tile carrying a full-bleed flag. The promotion is taken on the way in
 *  and handed back once the card has settled, so a hover that is over does not
 *  keep a layer per tile. Full motion and a fine pointer only (lib/motion.ts);
 *  the pointer's place also goes to --mx / --my for the spotlight. */
export function useTilt<E extends HTMLElement>(strength = 7) {
  const ref = useRef<E>(null);
  const raf = useRef<number | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(false);

  const onMouseEnter = useCallback(() => {
    const el = ref.current;
    live.current = motionLevel() === "full" && matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (!el || !live.current) return;
    if (settle.current) { clearTimeout(settle.current); settle.current = null; }
    el.style.willChange = "transform";
    el.style.transition = `transform 0.08s ease, ${TILE_TRANSITIONS}`;
  }, []);

  const onMouseMove = useCallback((e: MouseEvent<E>) => {
    const el = ref.current;
    if (!el || !live.current) return;
    const { clientX, clientY } = e;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const rect = el.getBoundingClientRect();
      const px = (clientX - rect.left) / rect.width;
      const py = (clientY - rect.top) / rect.height;
      el.style.transform = `perspective(900px) rotateY(${((px - 0.5) * strength).toFixed(2)}deg) rotateX(${(-(py - 0.5) * strength).toFixed(2)}deg)`;
      el.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
      el.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
    });
  }, [strength]);

  const onMouseLeave = useCallback(() => {
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = null; }
    const el = ref.current;
    if (!el || !live.current) return;
    el.style.transition = `transform 0.5s cubic-bezier(0.34,1.3,0.64,1), ${TILE_TRANSITIONS}`;
    el.style.transform = "";
    settle.current = setTimeout(() => {
      el.style.willChange = "";
      el.style.transition = "";
      settle.current = null;
    }, 520);
  }, []);

  useEffect(() => {
    const pending = raf, settling = settle;
    return () => {
      if (pending.current) cancelAnimationFrame(pending.current);
      if (settling.current) clearTimeout(settling.current);
    };
  }, []);

  return { ref, onMouseEnter, onMouseMove, onMouseLeave };
}
