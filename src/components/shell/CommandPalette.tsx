"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import type { translations, Lang } from "@/lib/i18n";
import type { FPSystem } from "@/lib/systems";
import { cn } from "@/lib/utils";
import { motionLevel, motionNow } from "@/lib/motion";
import { ModuleIcon, moduleColors, type Tab } from "./modules";
import { ArtDot } from "./TopBar";

type T = (typeof translations)[Lang];

export type PaletteItem =
  | { kind: "module"; id: Tab; system: FPSystem; label: string; sub: string }
  | { kind: "system"; system: FPSystem; label: string; sub: string };

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Ctrl K (kokonutui's action search bar): type part of a module's or a
 * system's name, pick with the arrows and Enter. Modules of the other systems
 * the user has are listed too and switch the system on the way.
 */
export default function CommandPalette({ t, items, onPick, onClose }: {
  t: T;
  items: PaletteItem[];
  onPick: (item: PaletteItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const q = norm(query.trim());
    const match = (i: PaletteItem) => !q || norm(i.label).includes(q) || norm(i.sub).includes(q);
    const modules = items.filter(i => i.kind === "module" && match(i));
    const systems = items.filter(i => i.kind === "system" && match(i));
    return { modules, systems, all: [...modules, ...systems] };
  }, [items, query]);
  const at = Math.min(index, Math.max(shown.all.length - 1, 0));

  // Opens with a spring when Motion is here, the popup keyframe otherwise.
  useEffect(() => {
    const el = panel.current;
    if (!el || motionLevel() === "off") return;
    const m = motionNow();
    if (m) {
      try {
        m.animate(el, { opacity: [0, 1], transform: ["translateY(-12px) scale(0.97)", "translateY(0px) scale(1)"] }, { type: "spring", stiffness: 520, damping: 34 });
        return;
      } catch {}
    }
    el.classList.add("css-in");
  }, []);

  useEffect(() => {
    list.current?.querySelector("[data-on]")?.scrollIntoView({ block: "nearest" });
  }, [at, query]);

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setIndex(Math.min(at + 1, shown.all.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex(Math.max(at - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const item = shown.all[at]; if (item) onPick(item); }
  }

  const row = (item: PaletteItem, k: number) => (
    <button
      key={item.kind === "module" ? `${item.system.id}:${item.id}` : item.system.id}
      type="button"
      data-on={k === at ? "" : undefined}
      onMouseMove={() => k !== at && setIndex(k)}
      onClick={() => onPick(item)}
      className={cn("flex w-full items-center gap-[11px] rounded-[11px] px-2.5 py-2 text-left", k === at && "bg-sand/55")}
    >
      {item.kind === "module" ? (
        <span className="grid size-[30px] flex-none place-items-center rounded-[10px] bg-[linear-gradient(135deg,var(--g1),var(--g2))] text-white [--ic-bg:var(--g1)]" style={moduleColors(item.id)}>
          <ModuleIcon id={item.id} className="size-4" />
        </span>
      ) : (
        <ArtDot system={item.system} className="size-[30px] rounded-[10px]" />
      )}
      <span className="flex min-w-0 flex-col">
        <b className="text-[13.5px] font-semibold text-ink">{item.label}</b>
        <small className="truncate text-[11.5px] text-ink-3">{item.sub}</small>
      </span>
      {k === at && <CornerDownLeft className="ml-auto size-4 flex-none text-ink-3" />}
    </button>
  );
  const head = (text: string) => <p className="px-2.5 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.06em] text-ink-3">{text}</p>;

  return (
    <div className="palette-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={t.shell.search} className="palette-panel">
        <div className="flex h-[54px] items-center gap-2.5 border-b border-muted px-3.5 text-ink-3">
          <Search className="size-[18px] flex-none" />
          <input
            autoFocus
            value={query}
            onChange={e => { setQuery(e.target.value); setIndex(0); }}
            onKeyDown={onKey}
            placeholder={t.shell.searchPlaceholder}
            aria-label={t.shell.search}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3/70"
          />
          <kbd className="rounded-md border border-border bg-ground px-1.5 py-0.5 font-sans text-[10.5px] font-semibold text-ink-3">Esc</kbd>
        </div>
        <div ref={list} className="max-h-[min(360px,55vh)] overflow-y-auto p-1.5">
          {shown.all.length === 0 && <p className="p-6 text-center text-sm text-ink-3">{t.shell.noResults}</p>}
          {shown.modules.length > 0 && head(t.shell.modules)}
          {shown.modules.map((item, k) => row(item, k))}
          {shown.systems.length > 0 && head(t.shell.systems)}
          {shown.systems.map((item, k) => row(item, shown.modules.length + k))}
        </div>
      </div>
    </div>
  );
}
