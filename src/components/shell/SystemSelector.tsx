"use client";

import type { CSSProperties } from "react";
import { ArrowRight, Check, Globe, Info } from "lucide-react";
import type { translations, Lang } from "@/lib/i18n";
import type { FPSystem } from "@/lib/systems";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { playIcon } from "@/lib/motion";
import { MODULES, ModuleIcon, moduleColors, type Tab } from "./modules";
import { useTilt } from "./useTilt";

type T = (typeof translations)[Lang];

const host = (s: FPSystem) => s.url.replace("https://", "");

/**
 * The system choice. A brand's tile carries its flag, darkened towards the
 * caption, or its logo on white, with the modules it offers in their own
 * colours; the test tenant is a dashed row below, an environment rather than
 * a brand. `stillId` names the tile the hub header is morphing back into, so
 * it does not also rise in.
 */
export default function SystemSelector({ t, systems, currentId, stillId, modulesOf, onSelect }: {
  t: T;
  systems: FPSystem[];
  currentId: string;
  stillId: string | null;
  modulesOf: (systemId: string) => Tab[];
  onSelect: (s: FPSystem) => void;
}) {
  const brands = systems.filter(s => !s.environment);
  const environments = systems.filter(s => s.environment);
  const cols = brands.length >= 3 ? "md:grid-cols-3" : brands.length === 2 ? "md:grid-cols-2" : "";
  return (
    <div className="flex-1 overflow-y-auto bg-ground">
      <div className="mx-auto w-full max-w-[1000px] px-4 pb-12 pt-6">
        <div className="mb-[18px] flex items-center gap-2.5">
          <span className="grid size-[38px] flex-none place-items-center rounded-xl bg-sage text-emerald-dark"><Globe className="size-[18px]" /></span>
          <h1 className="text-[22px] font-bold tracking-tight text-ink">{t.hub.selectSystemTitle}</h1>
          <Tip content={t.hub.selectSystemDesc}>
            <span tabIndex={0} aria-label={t.hub.selectSystemDesc} className="grid size-7 place-items-center rounded-lg text-ink-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-emerald/40">
              <Info className="size-4" />
            </span>
          </Tip>
        </div>
        <div className={cn("grid grid-cols-2 gap-2.5 sm:gap-4", cols)}>
          {brands.map((s, i) => (
            <SystemTile
              key={s.id} t={t} system={s} index={i} on={s.id === currentId} still={s.id === stillId} modules={modulesOf(s.id)} onSelect={onSelect}
              // Two to a row on a phone: an odd last tile takes the row rather than standing alone.
              wide={brands.length % 2 === 1 && i === brands.length - 1}
            />
          ))}
          {environments.map((s, i) => {
            const on = s.id === currentId;
            return (
              <button
                key={s.id}
                type="button"
                data-sys-tile={s.id}
                data-enter={s.id === stillId ? undefined : ""}
                style={{ "--i": brands.length + i } as CSSProperties}
                onClick={() => onSelect(s)}
                className={cn(
                  "col-span-full flex items-center gap-3.5 rounded-[20px] border border-dashed border-border p-2.5 pr-3 text-left transition-colors hover:bg-surface",
                  on && "border-solid border-emerald",
                )}
              >
                <span data-vt-art className="relative size-14 flex-none overflow-hidden rounded-[14px] bg-white ring-1 ring-muted">
                  <img src={s.svgPath} alt="" decoding="async" draggable={false} className="absolute inset-0 size-full object-contain p-2" />
                </span>
                <Tip content={host(s)}><span data-vt-name className="text-[15px] font-bold text-ink">{s.name}</span></Tip>
                <span className="hidden h-[26px] items-center rounded-full bg-sand px-2.5 text-xs font-semibold text-ink-2 sm:inline-flex">{t.shell.testEnv}</span>
                <ModuleChips t={t} modules={modulesOf(s.id)} plain />
                <span className="ml-auto grid size-[34px] flex-none place-items-center rounded-full bg-ground text-ink-2"><ArrowRight className="size-4" /></span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SystemTile({ t, system, index, on, still, wide, modules, onSelect }: {
  t: T; system: FPSystem; index: number; on: boolean; still: boolean; wide: boolean; modules: Tab[]; onSelect: (s: FPSystem) => void;
}) {
  const tilt = useTilt<HTMLButtonElement>(7);
  const logo = system.art === "logo";
  return (
    <button
      type="button"
      ref={tilt.ref}
      onMouseEnter={tilt.onMouseEnter}
      onMouseMove={tilt.onMouseMove}
      onMouseLeave={tilt.onMouseLeave}
      onClick={() => onSelect(system)}
      data-sys-tile={system.id}
      data-enter={still ? undefined : ""}
      style={{ "--i": index } as CSSProperties}
      aria-label={system.name}
      className={cn("sys-tile", logo ? "is-logo" : system.fallbackGradient, on && "is-on", wide && "max-md:col-span-2")}
    >
      <span className="sys-art" data-vt-art>
        <img src={system.svgPath} alt="" decoding="async" draggable={false} />
        <span className="sys-scrim" />
        <span className="sys-spot" />
      </span>
      {on && <span className="sys-check"><Check className="size-[15px]" strokeWidth={2.6} /></span>}
      <span className="sys-cap">
        <span className="flex min-w-0 flex-1 flex-col gap-[9px]">
          <Tip content={host(system)}><span className="sys-name" data-vt-name>{system.name}</span></Tip>
          <ModuleChips t={t} modules={modules} />
        </span>
        <span className="sys-go"><ArrowRight className="size-4" /></span>
      </span>
    </button>
  );
}

function ModuleChips({ t, modules, plain }: { t: T; modules: Tab[]; plain?: boolean }) {
  if (modules.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-[5px]">
      {modules.map(m => (
        <Tip key={m} content={MODULES[m].label(t)}>
          <span className={cn("mod-chip", plain && "is-plain")} style={moduleColors(m)} onPointerEnter={e => playIcon(e.currentTarget.querySelector("svg"))}>
            <ModuleIcon id={m} />
          </span>
        </Tip>
      ))}
    </span>
  );
}
