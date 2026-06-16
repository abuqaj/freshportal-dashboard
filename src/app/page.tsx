"use client";

import { useState, useEffect } from "react";
import { translations, Lang } from "@/lib/i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import VbnChecker from "@/components/VbnChecker";
import ProductCreator from "@/components/ProductCreator";
import PhotoUploader from "@/components/PhotoUploader";
import HistoryTab from "@/components/HistoryTab";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

function PetalLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* 5 petals radiating from center */}
      {[0, 72, 144, 216, 288].map((deg, i) => (
        <ellipse
          key={i}
          cx="14" cy="14"
          rx="3.5" ry="7"
          fill="#e05a4e"
          fillOpacity="0.85"
          transform={`rotate(${deg} 14 14) translate(0 -5)`}
        />
      ))}
      <circle cx="14" cy="14" r="3" fill="#f0a090" />
    </svg>
  );
}

function BotanicalPattern() {
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none select-none"
      viewBox="0 0 220 800"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* Stem 1 */}
      <path d="M40 780 Q35 680 55 580 Q70 500 50 400" stroke="#4a8060" strokeWidth="1.2" strokeLinecap="round" opacity="0.4"/>
      <path d="M50 650 Q25 620 15 590 Q30 605 50 650" fill="#4a8060" opacity="0.3"/>
      <path d="M48 590 Q75 565 85 535 Q68 555 48 590" fill="#4a8060" opacity="0.3"/>
      <path d="M52 510 Q28 490 18 460 Q34 478 52 510" fill="#4a8060" opacity="0.25"/>
      {/* Stem 2 */}
      <path d="M170 750 Q175 640 155 530 Q140 450 160 360" stroke="#4a8060" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
      <path d="M158 620 Q185 598 195 570 Q178 587 158 620" fill="#4a8060" opacity="0.25"/>
      <path d="M160 545 Q134 522 124 495 Q140 512 160 545" fill="#4a8060" opacity="0.25"/>
      {/* Stem 3 */}
      <path d="M90 800 Q85 700 100 600 Q110 530 95 450" stroke="#4a8060" strokeWidth="0.8" strokeLinecap="round" opacity="0.2"/>
      <path d="M97 680 Q72 660 62 635 Q78 650 97 680" fill="#4a8060" opacity="0.2"/>
      {/* Tiny flower top of stem 1 */}
      {[0,72,144,216,288].map((deg, i) => (
        <ellipse key={i} cx="50" cy="400" rx="4" ry="8"
          fill="#e05a4e" fillOpacity="0.18"
          transform={`rotate(${deg} 50 400) translate(0 -6)`}/>
      ))}
      <circle cx="50" cy="400" r="3" fill="#e05a4e" opacity="0.2"/>
      {/* Tiny flower top of stem 2 */}
      {[0,72,144,216,288].map((deg, i) => (
        <ellipse key={i} cx="160" cy="360" rx="3" ry="6"
          fill="#e05a4e" fillOpacity="0.15"
          transform={`rotate(${deg} 160 360) translate(0 -5)`}/>
      ))}
      <circle cx="160" cy="360" r="2.5" fill="#e05a4e" opacity="0.18"/>
      {/* Upper area stems */}
      <path d="M130 200 Q125 130 140 70" stroke="#4a8060" strokeWidth="0.8" strokeLinecap="round" opacity="0.2"/>
      <path d="M136 140 Q155 118 162 95 Q148 112 136 140" fill="#4a8060" opacity="0.18"/>
      <path d="M138 100 Q118 82 112 60 Q124 76 138 100" fill="#4a8060" opacity="0.18"/>
    </svg>
  );
}

export default function Dashboard() {
  const [lang, setLangState] = useState<Lang>("en");
  const [tab, setTab] = useState<"vbn" | "create" | "photos" | "history">("vbn");
  const [autoVbnEnabled, setAutoVbnEnabled] = useState(false);
  const [autoVbnNextRun, setAutoVbnNextRun] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("fp_lang") as Lang | null;
    if (saved && ["en", "nl", "pl", "es"].includes(saved)) setLangState(saved);
  }, []);

  useEffect(() => {
    if (!RAILWAY) return;
    fetch(`${RAILWAY}/vbn-auto/status`)
      .then(r => r.json())
      .then(d => { setAutoVbnEnabled(d.enabled ?? false); setAutoVbnNextRun(d.nextRun ?? null); })
      .catch(() => {});
  }, []);

  function setLang(l: Lang) { setLangState(l); localStorage.setItem("fp_lang", l); }

  const t = translations[lang];
  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";

  const navItems = [
    {
      id: "vbn", label: t.nav.vbnChecker,
      icon: (active: boolean) => (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 4h12M2 8h8M2 12h5" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.5" strokeLinecap="round"/>
          <circle cx="13" cy="10" r="2.5" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.3"/>
          <path d="M15 12l1.5 1.5" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      ),
    },
    {
      id: "create", label: t.nav.newProducts,
      icon: (active: boolean) => (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.3"/>
          <path d="M8 5v6M5 8h6" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      ),
    },
    {
      id: "photos", label: t.nav.photoUploader,
      icon: (active: boolean) => (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="3" width="14" height="10" rx="2" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.3"/>
          <circle cx="5.5" cy="6.5" r="1.2" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.2"/>
          <path d="M1 10l4-3 3 2.5 2.5-2 4.5 3.5" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
    {
      id: "history", label: t.nav.history,
      icon: (active: boolean) => (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.5" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.3"/>
          <path d="M8 5v3.5l2.5 1.5" stroke={active ? "#e05a4e" : "#7a9e82"} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
  ];

  return (
    <div className="flex h-screen bg-cream overflow-hidden">
      {/* ── Sidebar ── */}
      <aside className="relative w-[220px] flex-shrink-0 bg-bark flex flex-col overflow-hidden select-none">
        {/* Botanical SVG background */}
        <div className="absolute inset-0 overflow-hidden">
          <BotanicalPattern />
        </div>

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3 px-5 pt-6 pb-5 border-b border-bark-border">
          <PetalLogo />
          <div>
            <p className="text-[12px] font-semibold text-sage-light leading-tight tracking-wide">FreshPortal</p>
            <p className="text-[10px] text-sage leading-tight">DFG Stamgegevens</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="relative z-10 flex-1 pt-3 pb-2">
          {navItems.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id as typeof tab)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-[13px] font-medium transition-all duration-150 relative ${
                  active
                    ? "text-petal bg-bark-hover"
                    : "text-sage-light hover:text-sage-light hover:bg-bark-light"
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-petal rounded-r-full" />
                )}
                {item.icon(active)}
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Auto VBN status pill */}
        <div className="relative z-10 mx-4 mb-4 rounded-xl bg-bark-hover border border-bark-border p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${autoVbnEnabled ? "bg-leaf pulse-dot" : "bg-sage opacity-40"}`} />
            <span className="text-[11px] font-semibold text-sage-light uppercase tracking-wider">Auto VBN</span>
          </div>
          {autoVbnEnabled && autoVbnNextRun ? (
            <p className="text-[10px] text-sage leading-tight">
              Next: {new Date(autoVbnNextRun).toLocaleString(localeStr, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
            </p>
          ) : (
            <p className="text-[10px] text-sage leading-tight opacity-60">{autoVbnEnabled ? "Active — daily" : "Disabled"}</p>
          )}
        </div>

        {/* Language switcher */}
        <div className="relative z-10 px-4 pb-5 border-t border-bark-border pt-3">
          <LanguageSwitcher lang={lang} setLang={setLang} />
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-y-auto bg-cream">
        {tab === "vbn"     && <VbnChecker     lang={lang} onAutoVbnChange={(enabled, nextRun) => { setAutoVbnEnabled(enabled); setAutoVbnNextRun(nextRun); }} />}
        {tab === "create"  && <ProductCreator lang={lang} />}
        {tab === "photos"  && <PhotoUploader  lang={lang} />}
        {tab === "history" && <HistoryTab     lang={lang} />}
      </main>
    </div>
  );
}
