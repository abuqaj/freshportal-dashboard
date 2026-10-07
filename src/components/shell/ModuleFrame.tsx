"use client";

import type { ReactNode } from "react";
import type { translations, Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { LOCALES, LiveDot } from "./TopBar";
import type { Tab } from "./modules";

type T = (typeof translations)[Lang];

const MODULE_WIDTH: Record<Tab, string> = {
  vbn:       "max-w-4xl",
  history:   "max-w-4xl",
  create:    "max-w-3xl",
  photos:    "max-w-5xl",
  admin:     "max-w-5xl",
  delivery:  "max-w-7xl",
  analysis:  "max-w-7xl",
  boxweight: "max-w-6xl",
  supplier:  "max-w-4xl",
  knowledge: "max-w-6xl",
};

// The card pads its content, so a new module gets sane margins without
// having to remember. These screens opt out because their layout depends on
// reaching the card edge - full-bleed row dividers, or their own inner card
// - and an outer padding would leave those lines stopping short.
const UNPADDED_TABS: Tab[] = ["vbn", "create", "photos", "history", "admin"];

/**
 * The card a module sits in. The way back and the other modules live in the
 * top bar now; above the card stays only VBN Checker's Auto VBN state. The
 * card is the end of the tile's morph (data-vt-card) and must never keep a
 * transform: a transformed ancestor becomes the frame of the module's
 * `fixed` popups (see tile-enter in globals.css).
 */
export default function ModuleFrame({ tab, t, lang, autoEnabled, autoNextRun, children }: {
  tab: Tab;
  t: T;
  lang: Lang;
  autoEnabled: boolean | null;
  autoNextRun: string | null;
  children: ReactNode;
}) {
  return (
    <div className="shell-fallback-enter flex w-full flex-1 flex-col items-center overflow-y-auto bg-ground px-4 py-5">
      <div className={`w-full ${MODULE_WIDTH[tab]} mb-8`}>
        {tab === "vbn" && (
          <div className="mb-3 flex justify-end">
            {autoEnabled ? (
              <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-emerald/20 bg-sage/60 px-2.5 text-xs font-semibold text-emerald-dark">
                <LiveDot on />
                {t.hub.autoVbnActive}
                {autoNextRun && (
                  <span className="font-medium opacity-75">
                    · {new Date(autoNextRun).toLocaleString(LOCALES[lang], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </span>
            ) : (
              <span className="inline-flex h-[26px] items-center rounded-full border border-border bg-surface px-2.5 text-xs font-semibold text-ink-3">
                {t.hub.moduleAutoOff}
              </span>
            )}
          </div>
        )}
        <div
          data-vt-card
          className={cn(
            "overflow-hidden rounded-3xl border border-border bg-surface shadow-[0_8px_40px_-8px_rgba(0,0,0,0.18)]",
            !UNPADDED_TABS.includes(tab) && "p-4 sm:p-6",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
