"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ArrowLeftRight, ArrowRight, ChevronRight, Shield } from "lucide-react";
import type { translations, Lang } from "@/lib/i18n";
import type { FPSystem } from "@/lib/systems";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { playIcon } from "@/lib/motion";
import { MODULES, ModuleIcon, moduleColors, type Tab } from "./modules";
import { LOCALES, LiveDot } from "./TopBar";

type T = (typeof translations)[Lang];

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

/**
 * The modules of the chosen system. A header names the system (its flag, the
 * name, Auto VBN where it runs, the switch to another system); the system's
 * own modules are tiles in their own colours with the name and one short
 * fact, the description in a tooltip; History, Admin and the knowledge base
 * sit below as tools. `animate` is off when the hub comes back from a module,
 * whose card is morphing into its tile.
 */
export default function Hub({
  t, lang, system, systemTabs, toolTabs, autoEnabled, autoNextRun, productCount, isAdmin, animate, canChangeSystem, onChangeSystem, onOpen,
}: {
  t: T;
  lang: Lang;
  system: FPSystem;
  systemTabs: Tab[];
  toolTabs: Tab[];
  autoEnabled: boolean | null;
  autoNextRun: string | null;
  productCount: number | null;
  isAdmin: boolean;
  animate: boolean;
  canChangeSystem: boolean;
  onChangeSystem: () => void;
  onOpen: (id: Tab) => void;
}) {
  // PDF invoices no layout reads, and temporary layouts nobody has checked:
  // IT hears of them on its own tile (user, 2026-09-28).
  const [pdfForIt, setPdfForIt] = useState(0);
  useEffect(() => {
    if (!isAdmin || !RAILWAY) return;
    fetch(`${RAILWAY}/delivery/pdf-layouts/pending-count`)
      .then(r => (r.ok ? r.json() : { count: 0 }))
      .then(d => setPdfForIt(Number(d.count) || 0))
      .catch(() => {});
  }, [isAdmin]);

  const stat = (id: Tab): string => {
    switch (id) {
      case "vbn":       return autoEnabled ? t.hub.vbnStatOn.replace(/^●\s*/, "") : t.hub.vbnStatOff;
      // The product count comes from our copy of Stamgegevens, so on any other
      // system it would be someone else's number — name the portal instead.
      case "create":    return system.id === "stamgegevens"
        ? (productCount != null ? t.hub.catalogueStat(productCount) : t.hub.catalogueLoading)
        : t.hub.onSystem(system.name);
      case "photos":    return t.hub.photosStat;
      case "history":   return t.hub.historyStat;
      case "admin":     return t.hub.adminStat;
      case "delivery":  return t.hub.deliveryStat;
      case "analysis":  return t.hub.analysisStat;
      case "boxweight": return t.hub.boxWeightStat;
      case "supplier":  return t.hub.supplierStat;
      case "knowledge": return t.hub.knowledgeStat;
    }
  };
  const count = (id: Tab) => (id === "admin" ? pdfForIt : 0);
  const tip = (id: Tab) => MODULES[id].desc(t) + (count(id) > 0 ? ` · ${t.hub.adminPdfPending(count(id))}` : "");
  // Tiles rise in one after another (globals.css [data-enter], --i the place).
  const enter = (i: number) => (animate ? { "data-enter": "", style: { "--i": i } as CSSProperties } : {});

  const logo = system.art === "logo";
  const showAuto = system.id === "stamgegevens" && systemTabs.includes("vbn") && autoEnabled !== null;
  const nextRun = autoNextRun
    ? new Date(autoNextRun).toLocaleString(LOCALES[lang], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : undefined;
  const width = systemTabs.length >= 3 ? 1060 : systemTabs.length === 2 ? 860 : 620;

  return (
    <div className="flex-1 overflow-y-auto bg-ground">
      <div className="mx-auto w-full px-4 pb-12 pt-6" style={{ maxWidth: width }}>
        <div data-banner className="mb-5 flex items-center gap-4 rounded-[22px] border border-border bg-surface p-3 max-sm:gap-3 max-sm:p-2.5">
          <span data-vt-art className={cn("hub-art", logo && "is-logo")}>
            <img src={system.svgPath} alt="" decoding="async" draggable={false} />
            <span className="hub-art-scrim" />
          </span>
          <div className="min-w-0">
            <Tip content={system.url.replace("https://", "")}>
              <h1 data-vt-name className="w-fit max-w-full truncate text-2xl font-bold leading-tight tracking-tight text-ink max-sm:text-[19px]">{system.name}</h1>
            </Tip>
          </div>
          <div className="ml-auto flex flex-none items-center gap-2">
            {showAuto && (
              <Tip content={autoEnabled ? nextRun : undefined}>
                <span className={cn(
                  "inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold",
                  autoEnabled ? "border-emerald/20 bg-sage/60 text-emerald-dark" : "border-border bg-surface text-ink-3",
                )}>
                  <LiveDot on={!!autoEnabled} />
                  <span className="max-sm:hidden">{autoEnabled ? t.hub.autoVbnActive : t.hub.autoVbnDisabled}</span>
                </span>
              </Tip>
            )}
            {canChangeSystem && (
              <Tip content={t.shell.changeSystem}>
                <button type="button" onClick={onChangeSystem} aria-label={t.shell.changeSystem}
                  className="grid size-9 place-items-center rounded-xl text-ink-2 transition-[background-color,color,scale] hover:bg-ground hover:text-ink active:scale-90">
                  <ArrowLeftRight className="size-[18px]" />
                </button>
              </Tip>
            )}
          </div>
        </div>

        {systemTabs.length > 0 && (
          <div className={cn("grid grid-cols-1 gap-4", systemTabs.length >= 3 ? "md:grid-cols-3" : systemTabs.length === 2 ? "md:grid-cols-2" : "")}>
            {systemTabs.map((id, i) => (
              <Tip key={id} content={tip(id)} delay={600}>
                <button
                  type="button"
                  data-mod-tile={id}
                  {...enter(i)}
                  style={moduleColors(id, animate ? ({ "--i": i } as CSSProperties) : undefined)}
                  onClick={() => onOpen(id)}
                  onPointerEnter={e => playIcon(e.currentTarget.querySelector("[data-vt-badge] svg"))}
                  className="mod-tile"
                >
                  <span className="mod-tile-top">
                    <span data-vt-badge className="mod-badge">
                      <ModuleIcon id={id} />
                      {count(id) > 0 && <b className="shell-count">{count(id)}</b>}
                    </span>
                    <span className="mod-go"><ArrowRight className="size-[18px]" /></span>
                  </span>
                  <span className="mod-tile-text">
                    <span className="text-[19px] font-bold leading-tight tracking-tight">{MODULES[id].label(t)}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-white/80">
                      {id === "vbn" && autoEnabled !== null && <LiveDot on={!!autoEnabled} />}
                      <span className="truncate">{stat(id)}</span>
                    </span>
                  </span>
                  <span className="mod-tile-wm" aria-hidden="true"><ModuleIcon id={id} /></span>
                </button>
              </Tip>
            ))}
          </div>
        )}

        {toolTabs.length > 0 && (
          <>
            <div
              {...enter(systemTabs.length)}
              className="mb-2.5 mt-[26px] flex items-center gap-2 px-0.5 text-[11px] font-bold uppercase tracking-[0.07em] text-taupe after:h-px after:flex-1 after:bg-sand after:content-['']"
            >
              <Shield className="size-3.5" />
              {t.shell.tools}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {toolTabs.map((id, i) => (
                <Tip key={id} content={tip(id)} delay={500}>
                  <button
                    type="button"
                    data-mod-tile={id}
                    {...enter(systemTabs.length + 1 + i)}
                    style={moduleColors(id, animate ? ({ "--i": systemTabs.length + 1 + i } as CSSProperties) : undefined)}
                    onClick={() => onOpen(id)}
                    onPointerEnter={e => playIcon(e.currentTarget.querySelector("[data-vt-badge] svg"))}
                    className="tool-tile"
                  >
                    <span data-vt-badge className="tool-badge">
                      <ModuleIcon id={id} />
                      {count(id) > 0 && <b className="shell-count">{count(id)}</b>}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold text-ink">{MODULES[id].label(t)}</span>
                      <span className="block truncate text-[11.5px] text-ink-3">{stat(id)}</span>
                    </span>
                    <ChevronRight className="tool-chev" />
                  </button>
                </Tip>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
