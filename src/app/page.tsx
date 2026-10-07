"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { translations, Lang } from "@/lib/i18n";
import { SyncStatus } from "@/lib/types";
import VbnChecker from "@/components/VbnChecker";
import ProductCreator from "@/components/ProductCreator";
import PhotoUploader from "@/components/PhotoUploader";
import HistoryTab from "@/components/HistoryTab";
import AdminTab from "@/components/AdminTab";
import DeliveryImporter from "@/components/DeliveryImporter";
import AnalysisTool from "@/components/AnalysisTool";
import KenyaBoxWeight from "@/components/KenyaBoxWeight";
import KenyaSupplier from "@/components/KenyaSupplier";
import KnowledgeBase from "@/components/KnowledgeBase";
import { FP_SYSTEMS, FPSystem } from "@/lib/systems";
import { useSystem } from "@/contexts/SystemContext";
import TopBar from "@/components/shell/TopBar";
import ModuleStrip from "@/components/shell/ModuleStrip";
import SystemSelector from "@/components/shell/SystemSelector";
import Hub from "@/components/shell/Hub";
import ModuleFrame from "@/components/shell/ModuleFrame";
import CommandPalette, { type PaletteItem } from "@/components/shell/CommandPalette";
import { MODULES, SYSTEM_TABS, TOOL_TABS, type Tab } from "@/components/shell/modules";
import { activeStripTab, loadAnime, loadMotion, motionLevel, nameFor, viewTransition } from "@/lib/motion";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

// Where the screen on show came from. The hub's tiles do not rise in when a
// module card is morphing back into one of them, nor does the system tile the
// hub header is morphing back into.
type Came = "start" | "module" | "hub" | "elsewhere";

// The elements a morph runs between (globals.css ::view-transition-*).
const tileOf = (id: string) => document.querySelector(`[data-sys-tile="${id}"]`);
const moduleTileOf = (id: Tab) => document.querySelector(`[data-mod-tile="${id}"]`);
const nameSystemTile = (id: string) => {
  const tile = tileOf(id);
  nameFor(tile?.querySelector("[data-vt-art]"), "sys-art");
  nameFor(tile?.querySelector("[data-vt-name]"), "sys-name");
};
const nameBanner = () => {
  nameFor(document.querySelector("[data-banner] [data-vt-art]"), "sys-art");
  nameFor(document.querySelector("[data-banner] [data-vt-name]"), "sys-name");
};
const nameModuleTile = (id: Tab) => {
  const tile = moduleTileOf(id);
  nameFor(tile, "mod-card");
  nameFor(tile?.querySelector("[data-vt-badge]"), "mod-icon");
};
const nameModuleCard = () => {
  nameFor(document.querySelector("[data-vt-card]"), "mod-card");
  nameFor(activeStripTab(), "mod-icon");
};

/* ─── Root ─── */
export default function Dashboard() {
  const { data: session, status: sessionStatus } = useSession();
  const { system, setSystem } = useSystem();
  const [lang, setLangState] = useState<Lang>("en");
  const [tab, setTab] = useState<Tab | null>(null);
  const [hubStep, setHubStep] = useState<"system" | "module">("system");
  const [came, setCame] = useState<Came>("start");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [autoEnabled, setAutoEnabled] = useState<boolean | null>(null);
  const [autoNextRun, setAutoNextRun] = useState<string | null>(null);
  const [productCount, setProductCount] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [railwayOnline, setRailwayOnline] = useState<boolean | null>(null);

  const permissions = session?.user?.permissions ?? [];
  const isAdmin = permissions.includes("admin:manage");
  const username = session?.user?.name ?? undefined;

  // Compute which systems this user can access via system:* permissions
  const accessibleSystems = (() => {
    const sysIds = permissions.filter(p => p.startsWith("system:")).map(p => p.replace("system:", ""));
    return sysIds.length > 0
      ? FP_SYSTEMS.filter(s => sysIds.includes(s.id))
      : (isAdmin ? FP_SYSTEMS : []);
  })();

  // A system's own modules the user may open, and the tools every system shows.
  const allowed = (id: Tab) => isAdmin || permissions.includes(MODULES[id].perm);
  const systemTabsOf = (systemId: string) => (SYSTEM_TABS[systemId] ?? []).filter(allowed);
  const toolTabs = TOOL_TABS.filter(allowed);

  useEffect(() => {
    const saved = localStorage.getItem("fp_lang") as Lang | null;
    if (saved && ["en","nl","pl","es"].includes(saved)) setLangState(saved);
  }, []);

  // The motion level for this visit, and the two animation libraries fetched
  // once the screen is up, so nothing on it waits for them.
  useEffect(() => {
    motionLevel();
    const idle = (cb: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(cb) : setTimeout(cb, 1200));
    idle(() => { void loadMotion(); void loadAnime(); });
  }, []);

  // Ctrl K (⌘K) opens the search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(open => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-select system when there's only one accessible, or skip selector for no-system users
  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    if (accessibleSystems.length === 1) {
      setSystem(accessibleSystems[0]);
      setHubStep("module");
    } else if (accessibleSystems.length === 0) {
      setHubStep("module");
    }
    // The login page's view transition waits for this before it shows the shell.
    window.dispatchEvent(new Event("fp:shell-ready"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus]);

  useEffect(() => {
    if (!RAILWAY || sessionStatus !== "authenticated") return;
    fetch(`${RAILWAY}/vbn-auto/status`)
      .then(r => r.json())
      .then(d => { setAutoEnabled(d.enabled ?? false); setAutoNextRun(d.nextRun ?? null); setRailwayOnline(true); })
      .catch(() => { setRailwayOnline(false); });
    fetch(`${RAILWAY}/sync/status`)
      .then(r => r.json())
      .then(d => { if (d.product_count != null) setProductCount(d.product_count); setSyncStatus(d as SyncStatus); })
      .catch(() => {});
  }, [sessionStatus]);

  function setLang(l: Lang) { setLangState(l); localStorage.setItem("fp_lang", l); }

  const t = translations[lang];

  const handleAutoVbnChange = useCallback((enabled: boolean, nextRun: string | null) => {
    setAutoEnabled(enabled);
    setAutoNextRun(nextRun);
  }, []);

  const screen: "systems" | "hub" | "module" = tab
    ? "module"
    : hubStep === "system" && accessibleSystems.length > 1 ? "systems" : "hub";

  /* ─── Moving between screens ─── */

  // A system tile opens its hub: the flag becomes the header's flag.
  function pickSystem(sys: FPSystem) {
    viewTransition(() => { setCame("elsewhere"); setSystem(sys); setHubStep("module"); setTab(null); },
      { before: () => nameSystemTile(sys.id), after: nameBanner });
  }

  // Another system from the top bar or the search: a plain cross-fade.
  function switchSystem(sys: FPSystem) {
    if (sys.id === system.id && !tab) return;
    viewTransition(() => { setCame("elsewhere"); setSystem(sys); setHubStep("module"); setTab(null); });
  }

  // Back to the system choice; from the hub the header flies back into its tile.
  function toSystems() {
    const fromHub = !tab;
    viewTransition(() => { setCame("hub"); setTab(null); setHubStep("system"); },
      fromHub ? { before: nameBanner, after: () => nameSystemTile(system.id) } : undefined);
  }

  // A module tile grows into the module's card and its icon flies into the
  // strip; between modules the card reshapes and the strip's ring moves.
  function openModule(id: Tab, sys?: FPSystem) {
    if (sys && sys.id !== system.id) {
      viewTransition(() => { setCame("elsewhere"); setSystem(sys); setHubStep("module"); setTab(id); });
      return;
    }
    if (tab === id) return;
    if (screen === "hub") viewTransition(() => setTab(id), { before: () => nameModuleTile(id), after: nameModuleCard });
    else if (tab) viewTransition(() => setTab(id), { before: nameModuleCard, after: nameModuleCard });
    else viewTransition(() => { setHubStep("module"); setTab(id); });
  }

  // From a module back to the hub: the card shrinks into its tile.
  function goHub() {
    if (tab) {
      const from = tab;
      viewTransition(() => { setCame("module"); setTab(null); }, { before: nameModuleCard, after: () => nameModuleTile(from) });
    } else if (screen === "systems") {
      viewTransition(() => { setCame("elsewhere"); setHubStep("module"); });
    }
  }

  function pickFromSearch(item: PaletteItem) {
    setPaletteOpen(false);
    if (item.kind === "module") openModule(item.id, item.system);
    else if (screen === "systems") pickSystem(item.system);
    else if (item.system.id !== system.id) switchSystem(item.system);
    else if (tab) goHub();
  }

  // Search: the system's modules first, the tools, then the modules of the
  // user's other systems, then the systems themselves.
  function searchItems(): PaletteItem[] {
    const module = (id: Tab, sys: FPSystem, named: boolean): PaletteItem => ({
      kind: "module", id, system: sys, label: MODULES[id].label(t),
      sub: named ? `${sys.name} · ${MODULES[id].desc(t)}` : MODULES[id].desc(t),
    });
    const here = screen === "systems" ? [] : systemTabsOf(system.id).map(id => module(id, system, false));
    const tools = toolTabs.map(id => module(id, system, false));
    const elsewhere = accessibleSystems
      .filter(s => screen === "systems" || s.id !== system.id)
      .flatMap(s => systemTabsOf(s.id).map(id => module(id, s, true)));
    const systems: PaletteItem[] = accessibleSystems.map(s => ({ kind: "system", system: s, label: s.name, sub: s.url.replace("https://", "") }));
    return [...here, ...tools, ...elsewhere, ...systems];
  }

  // Show spinner while session loads
  if (sessionStatus === "loading") {
    return (
      <div className="h-screen bg-ground flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-emerald border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const strip = screen === "systems" ? null : (
    <ModuleStrip
      t={t}
      current={tab ?? "hub"}
      systemTabs={systemTabsOf(system.id)}
      toolTabs={toolTabs}
      onSelect={id => (id === "hub" ? goHub() : openModule(id))}
    />
  );

  return (
    <div className="h-dvh bg-surface flex flex-col overflow-hidden font-sans antialiased">
      <TopBar
        t={t}
        lang={lang}
        setLang={setLang}
        systems={accessibleSystems}
        system={system}
        showSystem={screen !== "systems" && accessibleSystems.length > 0}
        strip={strip}
        onHome={goHub}
        onPickSystem={switchSystem}
        onAllSystems={toSystems}
        onSearch={() => setPaletteOpen(true)}
        syncStatus={syncStatus}
        railwayOnline={railwayOnline}
        autoEnabled={autoEnabled}
        autoNextRun={autoNextRun}
        username={username}
        isAdmin={isAdmin}
      />

      <div className="flex-1 overflow-hidden flex flex-col">
        {screen === "systems" ? (
          <SystemSelector
            t={t}
            systems={accessibleSystems}
            currentId={system.id}
            stillId={came === "hub" ? system.id : null}
            modulesOf={systemTabsOf}
            onSelect={pickSystem}
          />
        ) : screen === "hub" ? (
          <Hub
            t={t}
            lang={lang}
            system={system}
            systemTabs={systemTabsOf(system.id)}
            toolTabs={toolTabs}
            autoEnabled={autoEnabled}
            autoNextRun={autoNextRun}
            productCount={productCount}
            isAdmin={isAdmin}
            animate={came !== "module"}
            canChangeSystem={accessibleSystems.length > 1}
            onChangeSystem={toSystems}
            onOpen={id => openModule(id)}
          />
        ) : tab && (
          <ModuleFrame tab={tab} t={t} lang={lang} autoEnabled={autoEnabled} autoNextRun={autoNextRun}>
            {tab === "vbn"      && <VbnChecker       lang={lang} onAutoVbnChange={handleAutoVbnChange} initialAutoEnabled={autoEnabled} initialAutoNextRun={autoNextRun}/>}
            {tab === "create"   && <ProductCreator  lang={lang}/>}
            {tab === "photos"   && <PhotoUploader   lang={lang}/>}
            {tab === "history"  && <HistoryTab      lang={lang}/>}
            {tab === "admin"    && <AdminTab        currentUsername={username}/>}
            {tab === "delivery"  && <DeliveryImporter lang={lang}/>}
            {tab === "analysis"  && <AnalysisTool     lang={lang}/>}
            {tab === "boxweight" && <KenyaBoxWeight   lang={lang}/>}
            {tab === "supplier"  && <KenyaSupplier    lang={lang}/>}
            {tab === "knowledge" && <KnowledgeBase    lang={lang}/>}
          </ModuleFrame>
        )}
      </div>

      {/* The module strip moves to a bottom dock on a phone. */}
      {strip && <nav className="flex flex-none justify-center border-t border-border bg-surface px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:hidden">{strip}</nav>}

      {paletteOpen && <CommandPalette t={t} items={searchItems()} onPick={pickFromSearch} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
