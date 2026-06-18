"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSession, signOut } from "next-auth/react";
import { translations, Lang } from "@/lib/i18n";
import { SyncStatus } from "@/lib/types";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import VbnChecker from "@/components/VbnChecker";
import ProductCreator from "@/components/ProductCreator";
import PhotoUploader from "@/components/PhotoUploader";
import HistoryTab from "@/components/HistoryTab";
import AdminTab from "@/components/AdminTab";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";
type Tab = "vbn" | "create" | "photos" | "history" | "admin";

/* ─── 3-D tilt hook ─── */
function useTilt(strength = 10) {
  const ref = useRef<HTMLDivElement>(null);
  const raf = useRef<number | null>(null);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width  - 0.5) * strength;
      const y = ((e.clientY - rect.top)  / rect.height - 0.5) * strength;
      el.style.transform = `perspective(900px) rotateY(${x}deg) rotateX(${-y}deg) scale(1.035)`;
      el.style.transition = "transform 0.08s ease";
    });
  }, [strength]);

  const onMouseLeave = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    const el = ref.current;
    if (!el) return;
    el.style.transition = "transform 0.5s cubic-bezier(0.34,1.3,0.64,1)";
    el.style.transform = "";
  }, []);

  return { ref, onMouseMove, onMouseLeave };
}

/* ─── Decorative SVG bg inside hub tiles ─── */
function DecoBg({ type }: { type: Tab }) {
  if (type === "vbn") return (
    <svg className="absolute -right-8 -top-8 w-52 h-52 opacity-10 slow-spin" viewBox="0 0 200 200" fill="white">
      <circle cx="100" cy="100" r="80" stroke="white" strokeWidth="2" fill="none"/>
      {[0,45,90,135,180,225,270,315].map((a,i)=>(
        <rect key={i} x="96" y="20" width="8" height="30" rx="4"
          transform={`rotate(${a} 100 100)`} opacity={i%2===0?1:0.5}/>
      ))}
      <circle cx="100" cy="100" r="15" fill="white" opacity="0.6"/>
    </svg>
  );
  if (type === "create") return (
    <svg className="absolute -right-6 -top-6 w-48 h-48 opacity-10" viewBox="0 0 200 200" fill="white">
      {[0,1,2,3,4,5,6,7,8].map(r=>[0,1,2,3,4,5,6,7,8].map(c=>(
        <circle key={`${r}-${c}`} cx={22+c*20} cy={22+r*20} r="5" opacity={((r+c)%3===0)?0.8:0.3}/>
      )))}
    </svg>
  );
  if (type === "photos") return (
    <svg className="absolute -right-4 -bottom-4 w-52 h-52 opacity-10" viewBox="0 0 200 200" fill="none" stroke="white" strokeWidth="2">
      <rect x="20" y="40" width="160" height="120" rx="12"/>
      <circle cx="100" cy="100" r="30"/>
      <rect x="70" y="28" width="60" height="20" rx="6" fill="white"/>
      <circle cx="160" cy="55" r="8" fill="white"/>
    </svg>
  );
  return (
    <svg className="absolute -right-6 -top-6 w-48 h-48 opacity-10" viewBox="0 0 200 200" fill="none" stroke="white" strokeWidth="2">
      {[30,60,90,120,150].map((y,i)=>(
        <line key={i} x1="20" y1={y} x2={80+i*10} y2={y} strokeLinecap="round" strokeWidth={i===4?3:2}/>
      ))}
      <circle cx="150" cy="100" r="40"/>
      <path d="M135 100 l10 10 20-25" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3"/>
    </svg>
  );
}

/* ─── Hub tile ─── */
function Tile({
  id, label, desc, gradient, icon, stat, statColor = "text-white/60",
  index, onClick,
}: {
  id: Tab; label: string; desc: string; gradient: string;
  icon: React.ReactNode; stat?: string; statColor?: string;
  index: number; onClick: () => void;
}) {
  const tilt = useTilt(10);
  return (
    <div
      ref={tilt.ref}
      onMouseMove={tilt.onMouseMove}
      onMouseLeave={tilt.onMouseLeave}
      onClick={onClick}
      style={{ animationDelay: `${index * 90}ms` }}
      className={`tile-enter tile-shine relative overflow-hidden rounded-3xl cursor-pointer ${gradient} group`}
    >
      <DecoBg type={id} />
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/8 transition-colors duration-300 rounded-3xl" />
      <div className="relative z-10 flex flex-col h-full p-7 min-h-[220px]">
        <div className="mb-auto">
          <div className="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center group-hover:bg-white/25 transition-colors duration-300 mb-5 group-hover:scale-110 transition-transform">
            {icon}
          </div>
          <h2 className="text-xl font-bold text-white tracking-tight leading-tight">{label}</h2>
          <p className="text-sm text-white/65 mt-1.5 leading-relaxed">{desc}</p>
        </div>
        <div className="flex items-end justify-between mt-6">
          {stat && <span className={`text-xs font-medium ${statColor}`}>{stat}</span>}
          <div className="ml-auto w-8 h-8 rounded-full bg-white/20 flex items-center justify-center
                          group-hover:bg-white/35 group-hover:translate-x-1 transition-all duration-300">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 7h8M8 4l3 3-3 3" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Logo mark ─── */
function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      {[0,72,144,216,288].map((deg,i) => (
        <ellipse key={i} cx="14" cy="14" rx="3.5" ry="7.5"
          fill="#1A7D45" opacity={i === 0 ? 1 : 0.7}
          transform={`rotate(${deg} 14 14) translate(0 -5.5)`}/>
      ))}
      <circle cx="14" cy="14" r="3.2" fill="#EC4328"/>
    </svg>
  );
}

/* ─── Persistent top bar ─── */
function TopBar({ lang, setLang, tab, t, syncStatus, railwayOnline, username }: {
  lang: Lang; setLang: (l: Lang) => void;
  tab: Tab | null; t: (typeof translations)[Lang];
  syncStatus: SyncStatus | null; railwayOnline: boolean | null;
  username?: string;
}) {
  const tabLabel = tab === "vbn" ? t.nav.vbnChecker
    : tab === "create" ? t.nav.newProducts
    : tab === "photos" ? t.nav.photoUploader
    : tab === "history" ? t.nav.history
    : tab === "admin" ? "Admin"
    : null;

  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-surface flex-shrink-0">
      <div className="flex items-center gap-3">
        <LogoMark size={24}/>
        <span className="text-sm font-bold text-ink">FreshPortal</span>
        {tab && tabLabel && (
          <>
            <span className="text-border text-sm select-none">/</span>
            <span className="text-sm font-medium text-ink-3">{tabLabel}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        {/* Sync running spinner */}
        {syncStatus?.running && (
          <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/>
              <path fill="currentColor" className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            Sync
          </span>
        )}
        {/* DB count pill */}
        {syncStatus != null && syncStatus.product_count > 0 && (
          <span className="text-[11px] text-ink-3 bg-muted border border-border px-2 py-0.5 rounded-full font-medium tabular-nums">
            {t.hub.topbarDb(syncStatus.product_count)}
          </span>
        )}
        {/* VBN online / offline dot */}
        {railwayOnline !== null && (
          <span className="flex items-center gap-1.5 text-[11px]">
            {railwayOnline ? (
              <>
                <span className="relative w-1.5 h-1.5 flex-shrink-0">
                  <span className="absolute inset-0 rounded-full bg-emerald pulse-ring"/>
                  <span className="relative w-1.5 h-1.5 rounded-full bg-emerald block"/>
                </span>
                <span className="text-emerald font-semibold">VBN</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-ink-3/40 block"/>
                <span className="text-ink-3/50 font-medium">VBN</span>
              </>
            )}
          </span>
        )}
        {username && (
          <span className="text-[11px] text-ink-3 border border-border bg-muted px-2 py-0.5 rounded-full">
            {username}
          </span>
        )}
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="h-7 px-2.5 rounded-lg text-[11px] font-medium text-ink-3 hover:text-ink border border-border bg-muted hover:bg-border/40 transition-colors"
        >
          Sign out
        </button>
        <LanguageSwitcher lang={lang} setLang={setLang}/>
      </div>
    </div>
  );
}

/* ─── Module card wrapper ─── */
const MODULE_WIDTH: Record<Tab, string> = {
  vbn:     "max-w-4xl",
  history: "max-w-4xl",
  create:  "max-w-3xl",
  photos:  "max-w-2xl",
  admin:   "max-w-3xl",
};

function ModuleCard({ tab, onBack, autoEnabled, autoNextRun, lang, t, children }: {
  tab: Tab; onBack: () => void; autoEnabled: boolean | null; autoNextRun: string | null;
  lang: Lang; t: (typeof translations)[Lang]; children: React.ReactNode;
}) {
  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";
  const w = MODULE_WIDTH[tab];
  return (
    <div className="module-enter w-full flex-1 flex flex-col items-center overflow-y-auto py-6 px-4 bg-ground">
      {/* Back + optional auto VBN badge */}
      <div className={`w-full ${w} flex items-center justify-between mb-4`}>
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink transition-colors group"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            className="group-hover:-translate-x-0.5 transition-transform">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t.hub.back}
        </button>

        {tab === "vbn" && (
          autoEnabled ? (
            <span className="flex items-center gap-1.5 text-xs text-emerald bg-emerald-light border border-emerald/20 px-2.5 py-1 rounded-full">
              <span className="relative w-1.5 h-1.5 flex-shrink-0">
                <span className="absolute inset-0 rounded-full bg-emerald pulse-ring"/>
                <span className="relative w-1.5 h-1.5 rounded-full bg-emerald block"/>
              </span>
              {t.hub.autoVbnActive}
              {autoNextRun && (
                <span className="text-emerald/70 ml-1">
                  · {new Date(autoNextRun).toLocaleString(localeStr, {day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}
                </span>
              )}
            </span>
          ) : (
            <span className="text-xs text-ink-3 bg-muted px-2.5 py-1 rounded-full border border-border">
              {t.hub.moduleAutoOff}
            </span>
          )
        )}
      </div>

      {/* Content */}
      <div className={`w-full ${w} bg-surface rounded-3xl border border-border shadow-[0_8px_40px_-8px_rgba(0,0,0,0.18)] overflow-hidden mb-8`}>
        {children}
      </div>
    </div>
  );
}

/* ─── Hub home screen ─── */
function Hub({ lang, setLang, t, autoEnabled, productCount, onSelect, permissions }: {
  lang: Lang; setLang: (l: Lang) => void; t: (typeof translations)[Lang];
  autoEnabled: boolean | null; productCount: number | null; onSelect: (tab: Tab) => void;
  permissions: string[];
}) {
  const isAdmin = permissions.includes("admin:manage");

  const allTiles: { id: Tab; perm: string; label: string; desc: string; gradient: string; stat?: string; statColor?: string; icon: React.ReactNode }[] = [
    {
      id: "vbn",
      perm: "vbn:check",
      label: t.nav.vbnChecker,
      desc: t.hub.vbnDesc,
      gradient: "bg-gradient-to-br from-emerald to-[#0D5430]",
      stat: autoEnabled ? t.hub.vbnStatOn : t.hub.vbnStatOff,
      statColor: autoEnabled ? "text-white/80" : "text-white/40",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M9 12l2 2 4-4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M7 4H4a2 2 0 00-2 2v14a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2h-3" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
          <rect x="7" y="2" width="10" height="4" rx="1" stroke="white" strokeWidth="1.8"/>
        </svg>
      ),
    },
    {
      id: "create",
      perm: "products:create",
      label: t.nav.newProducts,
      desc: t.hub.createDesc,
      gradient: "bg-gradient-to-br from-ember to-[#B83220]",
      stat: productCount != null ? t.hub.catalogueStat(productCount) : t.hub.catalogueLoading,
      statColor: "text-white/70",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="2" y="2" width="20" height="20" rx="4" stroke="white" strokeWidth="1.8"/>
          <path d="M12 8v8M8 12h8" stroke="white" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      ),
    },
    {
      id: "photos",
      perm: "photos:upload",
      label: t.nav.photoUploader,
      desc: t.hub.photosDesc,
      gradient: "bg-gradient-to-br from-[#145E35] to-[#073D22]",
      stat: t.hub.photosStat,
      statColor: "text-white/60",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="1" y="5" width="22" height="15" rx="3" stroke="white" strokeWidth="1.8"/>
          <circle cx="12" cy="12" r="4" stroke="white" strokeWidth="1.8"/>
          <circle cx="12" cy="12" r="1.5" fill="white"/>
          <path d="M8 5l2-3h4l2 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
    {
      id: "history",
      perm: "admin:manage",
      label: t.nav.history,
      desc: t.hub.historyDesc,
      gradient: "bg-gradient-to-br from-[#C43320] to-[#8B1E14]",
      stat: t.hub.historyStat,
      statColor: "text-white/60",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="white" strokeWidth="1.8"/>
          <path d="M12 7v5.5l3.5 2" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
    {
      id: "admin",
      perm: "admin:manage",
      label: "Admin",
      desc: "Manage users and access control",
      gradient: "bg-gradient-to-br from-[#374151] to-[#111827]",
      stat: "Users & groups",
      statColor: "text-white/60",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="8" r="4" stroke="white" strokeWidth="1.8"/>
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
          <circle cx="19" cy="7" r="2.5" fill="white" opacity="0.7"/>
          <path d="M19 5.5v3M17.5 7h3" stroke="#374151" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      ),
    },
  ];

  const tiles = allTiles.filter(tile => permissions.includes(tile.perm));

  const colsClass = tiles.length <= 2 ? "grid-cols-2" : "grid-cols-3";
  const maxWClass = tiles.length <= 2 ? "max-w-3xl" : "max-w-5xl";

  return (
    <div className="hub-enter flex-1 flex flex-col items-center justify-center px-8 py-10 bg-ground overflow-y-auto">
      <div className={`w-full ${maxWClass}`}>
        <h1 className="text-3xl font-bold text-ink mb-2 tracking-tight">{t.hub.title}</h1>
        <p className="text-sm text-ink-3 mb-10">{t.hub.subtitle}</p>
        <div className={`grid ${colsClass} gap-5`}>
          {tiles.map((tile, i) => (
            <Tile
              key={tile.id}
              index={i}
              id={tile.id}
              label={tile.label}
              desc={tile.desc}
              gradient={tile.gradient}
              icon={tile.icon}
              stat={tile.stat}
              statColor={tile.statColor}
              onClick={() => onSelect(tile.id)}
            />
          ))}
        </div>
      </div>

      <div className="mt-10 flex items-center gap-3 text-[10px] text-ink-3">
        <span>{t.hub.footer} · {new Date().getFullYear()}</span>
        <span className="w-px h-3 bg-border"/>
        <span className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${autoEnabled ? "bg-emerald" : "bg-muted"}`}/>
          {autoEnabled ? t.hub.autoVbnActive : t.hub.autoVbnDisabled}
        </span>
      </div>
    </div>
  );
}

/* ─── Root ─── */
export default function Dashboard() {
  const { data: session, status: sessionStatus } = useSession();
  const [lang, setLangState] = useState<Lang>("en");
  const [tab, setTab] = useState<Tab | null>(null);
  const [autoEnabled, setAutoEnabled] = useState<boolean | null>(null);
  const [autoNextRun, setAutoNextRun] = useState<string | null>(null);
  const [productCount, setProductCount] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [railwayOnline, setRailwayOnline] = useState<boolean | null>(null);

  const permissions = session?.user?.permissions ?? [];
  const username = session?.user?.name ?? undefined;

  useEffect(() => {
    const saved = localStorage.getItem("fp_lang") as Lang | null;
    if (saved && ["en","nl","pl","es"].includes(saved)) setLangState(saved);
  }, []);

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

  function goBack() { setTab(null); }

  const handleAutoVbnChange = useCallback((enabled: boolean, nextRun: string | null) => {
    setAutoEnabled(enabled);
    setAutoNextRun(nextRun);
  }, []);

  // Show spinner while session loads
  if (sessionStatus === "loading") {
    return (
      <div className="h-screen bg-ground flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-emerald border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-screen bg-surface flex flex-col overflow-hidden font-sans antialiased">
      {/* Persistent top bar — always visible */}
      <TopBar lang={lang} setLang={setLang} tab={tab} t={t} syncStatus={syncStatus} railwayOnline={railwayOnline} username={username}/>

      {/* Main content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {!tab ? (
          <Hub
            lang={lang}
            setLang={setLang}
            t={t}
            autoEnabled={autoEnabled}
            productCount={productCount}
            onSelect={(t) => setTab(t)}
            permissions={permissions}
          />
        ) : (
          <ModuleCard
            tab={tab}
            onBack={goBack}
            autoEnabled={autoEnabled}
            autoNextRun={autoNextRun}
            lang={lang}
            t={t}
          >
            {tab === "vbn"     && <VbnChecker     lang={lang} onAutoVbnChange={handleAutoVbnChange} initialAutoEnabled={autoEnabled} initialAutoNextRun={autoNextRun}/>}
            {tab === "create"  && <ProductCreator lang={lang}/>}
            {tab === "photos"  && <PhotoUploader  lang={lang}/>}
            {tab === "history" && <HistoryTab     lang={lang}/>}
            {tab === "admin"   && <AdminTab       currentUsername={username}/>}
          </ModuleCard>
        )}
      </div>
    </div>
  );
}
