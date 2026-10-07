import type { CSSProperties, ReactNode } from "react";
import type { translations, Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type T = (typeof translations)[Lang];

export type Tab = "vbn" | "create" | "photos" | "history" | "admin" | "delivery" | "analysis" | "boxweight" | "supplier" | "knowledge";

// Which modules each system offers. A module listed here shows up only on the
// systems that list it; anything not listed anywhere (history, admin,
// knowledge) reads from our own database and shows everywhere.
//
// The test tenant offers New Products alone: its endpoints follow the selected
// system, while VBN Check/Fix and Photo Uploader always run against
// Stamgegevens and would quietly work on live data under a "Test" heading.
export const SYSTEM_TABS: Record<string, Tab[]> = {
  stamgegevens: ["vbn", "create", "photos"],
  ecuador:      ["delivery", "analysis"],
  kenya:        ["boxweight", "supplier"],
  test:         ["create"],
};

const SYSTEM_SCOPED_TABS = new Set<Tab>(Object.values(SYSTEM_TABS).flat());

export function systemOffers(systemId: string, tab: Tab): boolean {
  return !SYSTEM_SCOPED_TABS.has(tab) || (SYSTEM_TABS[systemId] ?? []).includes(tab);
}

// The modules every system shows: the hub groups them as tools, below the
// system's own modules.
export const TOOL_TABS: Tab[] = ["history", "admin", "knowledge"];

export const MODULE_ORDER: Tab[] = ["vbn", "create", "photos", "history", "admin", "delivery", "analysis", "boxweight", "supplier", "knowledge"];

// Each module keeps the gradient its tile has always had (user, 2026-10-07:
// "niech zostaną takie jakie były"); the tile, its icon in the module strip,
// on a system tile and in search all wear it.
export const MODULES: Record<Tab, { perm: string; from: string; to: string; label: (t: T) => string; desc: (t: T) => string }> = {
  vbn:       { perm: "vbn:check",        from: "#1A7D45", to: "#0D5430", label: t => t.nav.vbnChecker,       desc: t => t.hub.vbnDesc },
  create:    { perm: "products:create",  from: "#EC4328", to: "#B83220", label: t => t.nav.newProducts,      desc: t => t.hub.createDesc },
  photos:    { perm: "photos:upload",    from: "#145E35", to: "#073D22", label: t => t.nav.photoUploader,    desc: t => t.hub.photosDesc },
  history:   { perm: "admin:manage",     from: "#C43320", to: "#8B1E14", label: t => t.nav.history,          desc: t => t.hub.historyDesc },
  admin:     { perm: "admin:manage",     from: "#374151", to: "#111827", label: t => t.hub.adminLabel,       desc: t => t.hub.adminDesc },
  delivery:  { perm: "delivery:import",  from: "#0F4C8A", to: "#0A2E54", label: t => t.nav.deliveryImporter, desc: t => t.hub.deliveryDesc },
  analysis:  { perm: "analysis:view",    from: "#7C3AED", to: "#4C1D95", label: t => t.nav.analysisTool,     desc: t => t.hub.analysisDesc },
  boxweight: { perm: "boxweight:run",    from: "#0891B2", to: "#155E75", label: t => t.nav.kenyaBoxWeight,   desc: t => t.hub.boxWeightDesc },
  supplier:  { perm: "supplier:add",     from: "#B45309", to: "#7C2D12", label: t => t.nav.kenyaSupplier,    desc: t => t.hub.supplierDesc },
  knowledge: { perm: "knowledge:review", from: "#BE185D", to: "#831843", label: t => t.nav.knowledgeBase,    desc: t => t.hub.knowledgeDesc },
};

/** The module's gradient as the CSS variables globals.css reads (--g1, --g2). */
export function moduleColors(id: Tab, extra?: CSSProperties): CSSProperties {
  return { "--g1": MODULES[id].from, "--g2": MODULES[id].to, ...extra } as CSSProperties;
}

// The module drawings, as page.tsx had them, with their parts named for the
// hover moves in lib/motion.ts `playIcon`: ic-draw redraws, ic-spin turns
// about the centre, ic-bar grows from the floor, ic-pop swells, ic-lift hops,
// ic-swing sways from the handle.
const PARTS: Record<Tab, ReactNode> = {
  vbn: (
    <>
      <path className="ic-draw" d="M9 12l2 2 4-4" strokeWidth={2} />
      <path d="M7 4H4a2 2 0 00-2 2v14a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2h-3" />
      <rect x="7" y="2" width="10" height="4" rx="1" />
    </>
  ),
  create: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="4" />
      <path className="ic-spin" d="M12 8v8M8 12h8" strokeWidth={2} />
    </>
  ),
  photos: (
    <>
      <rect x="1" y="5" width="22" height="15" rx="3" />
      <circle className="ic-pop" cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <path d="M8 5l2-3h4l2 3" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path className="ic-spin" d="M12 7v5.5l3.5 2" />
    </>
  ),
  admin: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
      <g className="ic-pop">
        <circle cx="19" cy="7" r="2.5" fill="currentColor" stroke="none" opacity="0.7" />
        <path d="M19 5.5v3M17.5 7h3" strokeWidth={1.2} style={{ stroke: "var(--ic-bg, #374151)" }} />
      </g>
    </>
  ),
  delivery: (
    <>
      <g className="ic-lift">
        <rect x="2" y="7" width="20" height="14" rx="3" />
        <path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2" />
      </g>
      <path className="ic-draw" d="M12 12v4M10 14h4" />
    </>
  ),
  analysis: (
    <>
      <path className="ic-bar" d="M4 20V10" />
      <path className="ic-bar" d="M12 20V4" />
      <path className="ic-bar" d="M20 20v-7" />
    </>
  ),
  boxweight: (
    <g className="ic-swing">
      <path d="M4 8h16l-2 12H6L4 8z" />
      <path d="M9 8V6a3 3 0 016 0v2" />
    </g>
  ),
  supplier: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path className="ic-draw" d="M9 11h6M9 15h4" />
    </>
  ),
  knowledge: (
    <>
      <path d="M5 4h9a3 3 0 013 3v13H8a3 3 0 01-3-3V4z" />
      <path className="ic-draw" d="M5 17a3 3 0 013-3h9M9 8h5" />
    </>
  ),
};

export function ModuleIcon({ id, className }: { id: Tab; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("module-icon", className)}
    >
      {PARTS[id]}
    </svg>
  );
}
