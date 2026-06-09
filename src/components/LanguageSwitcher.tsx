"use client";

import { useEffect, useRef, useState } from "react";
import { LANGUAGES, Lang } from "@/lib/i18n";

export default function LanguageSwitcher({
  lang,
  setLang,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
}) {
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
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white border border-neutral-200 hover:bg-neutral-50 shadow-sm transition-colors text-sm"
      >
        <span className="text-lg leading-none">{current.flag}</span>
        <svg
          className={`w-3 h-3 text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 w-44 bg-white border border-neutral-200 rounded-xl shadow-xl overflow-hidden z-50">
          {others.map((l) => (
            <button
              key={l.code}
              onClick={() => { setLang(l.code); setOpen(false); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-neutral-700 hover:bg-violet-50 hover:text-violet-700 transition-colors"
            >
              <span className="text-lg leading-none">{l.flag}</span>
              <span>{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
