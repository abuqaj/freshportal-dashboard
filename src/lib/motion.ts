"use client";

import { flushSync } from "react-dom";

// How much the shell moves, decided once per visit and written to
// <html data-motion> for globals.css (user, 2026-10-07: plenty of animation,
// but the portal must still load on a weak computer and a slow line):
//   full  a capable device on a decent line
//   lite  Save-Data, a 2G/3G line, under 4 cores or 4 GB, or slow frames
//         measured on the first animation: no ambient loops, no tilt,
//         shorter transitions
//   off   the system asks for reduced motion
// Everything the shell animates is transform and opacity, so the compositor
// runs it; the two libraries are fetched on demand and nothing waits on them.
export type MotionLevel = "full" | "lite" | "off";

type NavigatorHints = Navigator & {
  connection?: { saveData?: boolean; effectiveType?: string };
  deviceMemory?: number;
};

let level: MotionLevel | null = null;

function detect(): MotionLevel {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "off";
  const nav = navigator as NavigatorHints;
  if (nav.connection?.saveData || /2g|3g/.test(nav.connection?.effectiveType ?? "")) return "lite";
  const cores = nav.hardwareConcurrency || 0;
  const memory = nav.deviceMemory || 0;
  if ((cores && cores < 4) || (memory && memory < 4)) return "lite";
  return "full";
}

function apply(next: MotionLevel) {
  level = next;
  const root = document.documentElement;
  root.dataset.motion = next;
  root.style.setProperty("--vt-dur", next === "full" ? "460ms" : "260ms");
}

/** The level for this visit; the first call decides it. */
export function motionLevel(): MotionLevel {
  if (level) return level;
  if (typeof window === "undefined") return "full";
  const next = detect();
  apply(next);
  if ("startViewTransition" in document) document.documentElement.dataset.vt = "on";
  if (next === "full") probeFrames();
  return next;
}

// Sixty frames right after the first screen: when they average over 26 ms
// (under ~38 fps) the device cannot keep up and the visit drops to lite.
function probeFrames() {
  let n = 0;
  let sum = 0;
  let last = performance.now();
  const step = (now: number) => {
    if (document.hidden) return;
    if (n > 2) sum += now - last;
    last = now;
    if (++n < 64) requestAnimationFrame(step);
    else if (sum / (n - 3) > 26) apply("lite");
  };
  requestAnimationFrame(step);
}

// ── The libraries, fetched when first needed ─────────────────────────────────
// Typed by what the shell calls rather than by each library's own types, so a
// minor version of either does not break the build.
export type MotionLib = {
  animate: (target: Element | Element[], keyframes: Record<string, unknown>, options?: Record<string, unknown>) => unknown;
};
export type AnimeLib = {
  animate: (targets: unknown, params: Record<string, unknown>) => unknown;
  stagger: (value: number) => unknown;
  svg: { createDrawable: (target: unknown) => unknown };
};

let motionLib: MotionLib | null = null;
let animeLib: AnimeLib | null = null;
let libsLoad: Promise<void> | null = null;

// One chunk with both (lib/animation-libs.ts), fetched once.
function loadLibs(): Promise<void> {
  libsLoad ??= import("./animation-libs")
    .then(m => {
      motionLib = { animate: m.motionAnimate as unknown as MotionLib["animate"] };
      animeLib = { animate: m.animeAnimate, stagger: m.animeStagger, svg: m.animeSvg } as unknown as AnimeLib;
    })
    .catch(() => {});
  return libsLoad;
}

export const loadMotion = (): Promise<MotionLib | null> => loadLibs().then(() => motionLib);
export const loadAnime = (): Promise<AnimeLib | null> => loadLibs().then(() => animeLib);

/** A library that is already here, or null; never waits. */
export const motionNow = () => (motionLevel() === "off" ? null : motionLib);
export const animeNow = () => (motionLevel() === "off" ? null : animeLib);

/** The library if it arrives within `ms`, otherwise null. */
export function within<T>(load: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([load, new Promise<null>(r => setTimeout(() => r(null), ms))]);
}

// ── View transitions between screens ─────────────────────────────────────────
// The browser photographs the old screen, React renders the new one inside
// the callback, and elements that share a view-transition-name morph from one
// place to the other (a system tile into the hub header, a module tile into
// the module card). Where the API is missing, or motion is off, the state just
// changes. Names are set only for the transition and removed afterwards, so
// two elements never hold the same one.
type VtDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

export function nameFor(el: Element | null | undefined, name: string) {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return;
  el.style.viewTransitionName = name;
  el.setAttribute("data-vt-named", "");
}

export function clearNames() {
  document.querySelectorAll<HTMLElement | SVGElement>("[data-vt-named]").forEach(el => {
    el.style.viewTransitionName = "";
    el.removeAttribute("data-vt-named");
  });
}

export function viewTransition(update: () => void, names?: { before?: () => void; after?: () => void }) {
  const doc = document as VtDocument;
  if (!doc.startViewTransition || motionLevel() === "off" || document.hidden) {
    flushSync(update);
    clearNames();
    return;
  }
  names?.before?.();
  try {
    const vt = doc.startViewTransition(() => {
      clearNames();
      flushSync(update);
      names?.after?.();
    });
    vt.finished.finally(clearNames);
  } catch {
    flushSync(update);
    clearNames();
  }
}

/** The open tab of whichever module strip is on screen (top bar or bottom dock). */
export function activeStripTab(): Element | undefined {
  return [...document.querySelectorAll("[data-strip] [aria-current='page']")].find(el => el.getClientRects().length > 0);
}

// ── Small motions ────────────────────────────────────────────────────────────

/** A shake for a refused form: Motion when it is here, a CSS keyframe otherwise. */
export function shake(el: HTMLElement | null) {
  if (!el || motionLevel() === "off") return;
  const m = motionNow();
  if (m) {
    try {
      m.animate(el, { transform: ["translateX(0px)", "translateX(-10px)", "translateX(9px)", "translateX(-6px)", "translateX(4px)", "translateX(0px)"] }, { duration: 0.42, ease: "easeInOut" });
      return;
    } catch {}
  }
  el.classList.remove("shell-shake");
  void el.offsetWidth;
  el.classList.add("shell-shake");
}

/** Draws an SVG path in, as a pen would: the ticks and the logo trace. */
export function drawPath(path: Element | null | undefined, duration = 420) {
  const a = animeNow();
  if (!a || !path) return false;
  try {
    a.animate(a.svg.createDrawable(path), { draw: ["0 0", "0 1"], duration, ease: "outQuad" });
    return true;
  } catch {
    return false;
  }
}

const playing = new WeakSet<Element>();

/**
 * Moves a module icon's own parts on hover (ModuleIcon names them): the tick
 * redraws, the clock hand turns, the bars grow, the bag swings. anime.js when
 * it has arrived, the same moves as CSS keyframes until then.
 */
export function playIcon(svgEl: Element | null | undefined) {
  if (!svgEl || playing.has(svgEl) || motionLevel() === "off") return;
  playing.add(svgEl);
  setTimeout(() => playing.delete(svgEl), 800);
  const a = animeNow();
  if (!a) {
    void loadAnime();
    svgEl.classList.remove("ic-css");
    void (svgEl as HTMLElement).getBoundingClientRect();
    svgEl.classList.add("ic-css");
    return;
  }
  const q = (sel: string) => [...svgEl.querySelectorAll(sel)];
  try {
    if (q(".ic-draw").length) a.animate(a.svg.createDrawable(q(".ic-draw")), { draw: ["0 0", "0 1"], duration: 560, ease: "inOutQuad" });
    if (q(".ic-spin").length) a.animate(q(".ic-spin"), { rotate: [0, 360], duration: 760, ease: "inOutCubic" });
    if (q(".ic-bar").length) a.animate(q(".ic-bar"), { scaleY: [0.15, 1], duration: 520, delay: a.stagger(70), ease: "outBack(1.8)" });
    if (q(".ic-pop").length) a.animate(q(".ic-pop"), { scale: [{ to: 1.3, duration: 160 }, { to: 1, duration: 300 }], ease: "outQuad" });
    if (q(".ic-lift").length) a.animate(q(".ic-lift"), { translateY: [{ to: -2.5, duration: 160 }, { to: 0, duration: 460 }], ease: "outQuad" });
    if (q(".ic-swing").length) a.animate(q(".ic-swing"), { rotate: [{ to: -12, duration: 140 }, { to: 9, duration: 150 }, { to: -5, duration: 140 }, { to: 0, duration: 200 }], ease: "inOutSine" });
  } catch {
    svgEl.classList.add("ic-css");
  }
}
