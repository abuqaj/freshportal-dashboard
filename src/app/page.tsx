"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { translations, Lang } from "@/lib/i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import VbnChecker from "@/components/VbnChecker";
import ProductCreator from "@/components/ProductCreator";
import PhotoUploader from "@/components/PhotoUploader";
import HistoryTab from "@/components/HistoryTab";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";
type Tab = "vbn" | "create" | "photos" | "history";

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

/* ─── Decorative tile background SVGs ─── */
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

/* ─── Single tile ─── */
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
      {/* Decorative bg */}
      <DecoBg type={id} />

      {/* Gradient overlay on hover */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/8 transition-colors duration-300 rounded-3xl" />

      {/* Content */}
      <div className="relative z-10 flex flex-col h-full p-7 min-h-[220px]">
        {/* Icon */}
        <div className="mb-auto">
          <div className="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center group-hover:bg-white/25 transition-colors duration-300 mb-5 group-hover:scale-110 transition-transform">
            {icon}
          </div>
          <h2 className="text-xl font-bold text-white tracking-tight leading-tight">{label}</h2>
          <p className="text-sm text-white/65 mt-1.5 leading-relaxed">{desc}</p>
        </div>

        {/* Bottom */}
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

/* ─── Petal logo mark ─── */
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

/* ─── Module top bar (when a tab is active) ─── */
const MODULE_META: Record<Tab, { label: string; color: string; textColor: string }> = {
  vbn:     { label: "VBN Checker",   color: "bg-emerald",  textColor: "text-white" },
  create:  { label: "New Products",  color: "bg-ember",    textColor: "text-white" },
  photos:  { label: "Photo Upload",  color: "bg-[#145E35]",textColor: "text-white" },
  history: { label: "History",       color: "bg-[#C43320]",textColor: "text-white" },
};

function ModuleBar({
  tab, onBack, lang, autoEnabled, autoNextRun,
}: {
  tab: Tab; onBack: () => void; lang: Lang;
  autoEnabled: boolean; autoNextRun: string | null;
}) {
  const meta = MODULE_META[tab];
  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";
  return (
    <div className={`${meta.color} flex items-center gap-4 px-5 py-3 flex-shrink-0`}>
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-white/80 hover:text-white transition-colors text-sm font-medium group"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          className="group-hover:-translate-x-0.5 transition-transform">
          <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Hub
      </button>
      <div className="w-px h-4 bg-white/25"/>
      <span className={`text-sm font-semibold ${meta.textColor}`}>{meta.label}</span>
      {tab === "vbn" && (
        <div className="ml-auto flex items-center gap-2">
          {autoEnabled ? (
            <span className="flex items-center gap-1.5 text-xs text-white/80 bg-white/15 px-2.5 py-1 rounded-full">
              <span className="relative w-2 h-2 flex-shrink-0">
                <span className="absolute inset-0 rounded-full bg-white pulse-ring"/>
                <span className="relative w-2 h-2 rounded-full bg-white block"/>
              </span>
              Auto VBN{autoNextRun ? ` · ${new Date(autoNextRun).toLocaleString(localeStr, {day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}` : ""}
            </span>
          ) : (
            <span className="text-xs text-white/50">Auto VBN off</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Hub home screen ─── */
function Hub({
  lang, setLang, t, autoEnabled, productCount, onSelect,
}: {
  lang: Lang; setLang: (l: Lang) => void; t: ReturnType<typeof translations[Lang]>;
  autoEnabled: boolean; productCount: number | null; onSelect: (tab: Tab) => void;
}) {
  const tiles = [
    {
      id: "vbn" as Tab,
      label: t.nav.vbnChecker,
      desc: "Verify & auto-fix VBN codes",
      gradient: "bg-gradient-to-br from-emerald to-[#0D5430]",
      stat: autoEnabled ? "● Auto active · daily" : "Auto VBN off",
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
      id: "create" as Tab,
      label: t.nav.newProducts,
      desc: "Add products with AI suggestions",
      gradient: "bg-gradient-to-br from-ember to-[#B83220]",
      stat: productCount != null ? `${productCount.toLocaleString()} in catalogue` : "Loading…",
      statColor: "text-white/70",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="2" y="2" width="20" height="20" rx="4" stroke="white" strokeWidth="1.8"/>
          <path d="M12 8v8M8 12h8" stroke="white" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      ),
    },
    {
      id: "photos" as Tab,
      label: t.nav.photoUploader,
      desc: "Upload & assign product photos",
      gradient: "bg-gradient-to-br from-[#145E35] to-[#073D22]",
      stat: "Drop photos to assign",
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
      id: "history" as Tab,
      label: t.nav.history,
      desc: "Browse operation logs & runs",
      gradient: "bg-gradient-to-br from-[#C43320] to-[#8B1E14]",
      stat: "VBN · Sync · Auto VBN",
      statColor: "text-white/60",
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="white" strokeWidth="1.8"/>
          <path d="M12 7v5.5l3.5 2" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
  ];

  return (
    <div className="hub-enter flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-8 py-4 border-b border-border bg-surface flex-shrink-0">
        <div className="flex items-center gap-3">
          <LogoMark size={28}/>
          <div>
            <p className="text-sm font-bold text-ink leading-none">FreshPortal</p>
            <p className="text-[10px] text-ink-3 mt-0.5">DFG Stamgegevens</p>
          </div>
        </div>
        <LanguageSwitcher lang={lang} setLang={setLang}/>
      </div>

      {/* Tile grid */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 bg-ground">
        <div className="w-full max-w-3xl">
          <h1 className="text-3xl font-bold text-ink mb-2 tracking-tight">
            What are you working on?
          </h1>
          <p className="text-sm text-ink-3 mb-10">Select a module to get started.</p>

          <div className="grid grid-cols-2 gap-5">
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
      </div>

      {/* Bottom strip */}
      <div className="flex items-center justify-between px-8 py-2.5 border-t border-border bg-surface flex-shrink-0">
        <span className="text-[10px] text-ink-3 font-mono">
          FreshPortal Product Management · {new Date().getFullYear()}
        </span>
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${autoEnabled ? "bg-emerald" : "bg-muted"}`}/>
          <span className="text-[10px] text-ink-3">
            Auto VBN {autoEnabled ? "active" : "disabled"}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── Root ─── */
export default function Dashboard() {
  const [lang, setLangState] = useState<Lang>("en");
  const [tab, setTab] = useState<Tab | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoNextRun, setAutoNextRun] = useState<string | null>(null);
  const [productCount, setProductCount] = useState<number | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("fp_lang") as Lang | null;
    if (saved && ["en","nl","pl","es"].includes(saved)) setLangState(saved);
  }, []);

  useEffect(() => {
    if (!RAILWAY) return;
    fetch(`${RAILWAY}/vbn-auto/status`)
      .then(r => r.json())
      .then(d => { setAutoEnabled(d.enabled ?? false); setAutoNextRun(d.nextRun ?? null); })
      .catch(() => {});
    fetch(`${RAILWAY}/sync/status`)
      .then(r => r.json())
      .then(d => { if (d.product_count != null) setProductCount(d.product_count); })
      .catch(() => {});
  }, []);

  function setLang(l: Lang) { setLangState(l); localStorage.setItem("fp_lang", l); }

  const t = translations[lang];

  /* Back to hub */
  function goBack() { setTab(null); }

  const handleAutoVbnChange = useCallback((enabled: boolean, nextRun: string | null) => {
    setAutoEnabled(enabled);
    setAutoNextRun(nextRun);
  }, []);

  return (
    <div className="h-screen bg-surface flex flex-col overflow-hidden font-sans antialiased">
      {/* Module top bar (only when tab is open) */}
      {tab && (
        <ModuleBar
          tab={tab}
          onBack={goBack}
          lang={lang}
          autoEnabled={autoEnabled}
          autoNextRun={autoNextRun}
        />
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {!tab ? (
          <Hub
            lang={lang}
            setLang={setLang}
            t={t}
            autoEnabled={autoEnabled}
            productCount={productCount}
            onSelect={(t) => setTab(t)}
          />
        ) : (
          <div className="module-enter h-full overflow-y-auto bg-ground">
            {tab === "vbn"     && <VbnChecker     lang={lang} onAutoVbnChange={handleAutoVbnChange}/>}
            {tab === "create"  && <ProductCreator lang={lang}/>}
            {tab === "photos"  && <PhotoUploader  lang={lang}/>}
            {tab === "history" && <HistoryTab     lang={lang}/>}
          </div>
        )}
      </div>
    </div>
  );
}
