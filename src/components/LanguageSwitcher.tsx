"use client";

import { useEffect, useRef, useState } from "react";
import { LANGUAGES, Lang } from "@/lib/i18n";

function FlagImg({ countryCode, label }: { countryCode: string; label: string }) {
  return (
    <img
      src={`https://flagcdn.com/w40/${countryCode}.png`}
      srcSet={`https://flagcdn.com/w80/${countryCode}.png 2x`}
      width={20}
      height={15}
      alt={label}
      className="rounded-sm object-cover flex-shrink-0"
      style={{ width: 20, height: 15 }}
    />
  );
}

export default function LanguageSwitcher({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const current = LANGUAGES.find((l) => l.code === lang)!;
  const others = LANGUAGES.filter((l) => l.code !== lang);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={current.label}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted border border-border hover:bg-ground transition-colors"
      >
        <FlagImg countryCode={current.countryCode} label={current.label} />
        <span className="text-xs text-ink font-medium">{current.label}</span>
        <svg
          className={`w-3 h-3 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 w-44 bg-surface border border-border rounded-xl shadow-xl overflow-hidden z-50">
          {others.map((l) => (
            <button
              key={l.code}
              onClick={() => { setLang(l.code); setOpen(false); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-ink hover:bg-ground hover:text-ember transition-colors"
            >
              <FlagImg countryCode={l.countryCode} label={l.label} />
              <span>{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
