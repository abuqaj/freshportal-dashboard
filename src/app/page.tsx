"use client";

import { useState, useEffect } from "react";
import { translations, Lang } from "@/lib/i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import VbnChecker from "@/components/VbnChecker";
import ProductCreator from "@/components/ProductCreator";
import PhotoUploader from "@/components/PhotoUploader";
import HistoryTab from "@/components/HistoryTab";

export default function Dashboard() {
  const [lang, setLangState] = useState<Lang>("en");
  const [tab, setTab] = useState<"vbn" | "create" | "photos" | "history">("vbn");

  useEffect(() => {
    const saved = localStorage.getItem("fp_lang") as Lang | null;
    if (saved && ["en", "nl", "pl", "es"].includes(saved)) setLangState(saved);
  }, []);

  function setLang(l: Lang) { setLangState(l); localStorage.setItem("fp_lang", l); }

  const t = translations[lang];

  return (
    <div className="flex h-screen bg-neutral-50 font-sans">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-white border-r border-neutral-200 flex flex-col">
        <div className="px-5 py-5 border-b border-neutral-200">
          <p className="text-sm font-semibold text-neutral-800 tracking-tight">FreshPortal Product Management</p>
          <p className="text-xs text-neutral-400 mt-0.5">DFG Stamgegevens</p>
        </div>
        <nav className="flex-1 py-3">
          {[
            { id: "vbn",     label: t.nav.vbnChecker,    icon: "🏷️" },
            { id: "create",  label: t.nav.newProducts,   icon: "➕" },
            { id: "photos",  label: t.nav.photoUploader, icon: "🖼️" },
            { id: "history", label: t.nav.history,       icon: "📋" },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id as typeof tab)}
              className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                tab === item.id
                  ? "bg-violet-50 text-violet-700 font-medium border-l-2 border-violet-600"
                  : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
              }`}
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-neutral-200">
          <p className="text-xs text-neutral-400">FreshPortal Product Management</p>
        </div>
      </aside>

      {/* Language switcher — fixed top right */}
      <div className="fixed top-4 right-4 z-40">
        <LanguageSwitcher lang={lang} setLang={setLang} />
      </div>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        {tab === "vbn"     && <VbnChecker     lang={lang} />}
        {tab === "create"  && <ProductCreator lang={lang} />}
        {tab === "photos"  && <PhotoUploader  lang={lang} />}
        {tab === "history" && <HistoryTab     lang={lang} />}
      </main>
    </div>
  );
}
