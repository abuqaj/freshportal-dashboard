"use client";

import { useState, useCallback, useRef } from "react";
import { flushSync, createPortal } from "react-dom";
import { translations, Lang } from "@/lib/i18n";
import { VbnResult, Stats, AutoVbnRun } from "@/lib/types";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface Props {
  lang: Lang;
  onAutoVbnChange?: (enabled: boolean, nextRun: string | null) => void;
  initialAutoEnabled?: boolean;
  initialAutoNextRun?: string | null;
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export default function VbnChecker({ lang, onAutoVbnChange, initialAutoEnabled, initialAutoNextRun }: Props) {
  const t = translations[lang];

  const [vbnInput, setVbnInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [results, setResults] = useState<VbnResult[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixMessage, setFixMessage] = useState<string | null>(null);
  const [vbnNameCache, setVbnNameCache] = useState<Record<string, string>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [suggestions, setSuggestions] = useState<{ product_id: string; items: { id: string; name: string }[] } | null>(null);
  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number } | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Auto VBN — initialise from parent's already-fetched value to avoid the loading flash
  const [vbnAutoEnabled, setVbnAutoEnabled] = useState(initialAutoEnabled ?? false);
  const [vbnAutoLastRun, setVbnAutoLastRun] = useState<AutoVbnRun | null>(null);
  const [vbnAutoNextRun, setVbnAutoNextRun] = useState<string | null>(initialAutoNextRun ?? null);
  const [vbnAutoTogglingLoading, setVbnAutoTogglingLoading] = useState(false);
  const [vbnAutoRunNowLoading, setVbnAutoRunNowLoading] = useState(false);
  // true once the fresh fetch from Railway has resolved; false while pending
  const [autoStatusLoaded, setAutoStatusLoaded] = useState(initialAutoEnabled !== undefined);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);

  // Fix result — persists until user explicitly resets (replaces auto-clearing fixSuccess)
  const [fixResult, setFixResult] = useState<{ fixed: number; failed: number; message: string } | null>(null);

  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";

  const loadVbnAutoStatus = useCallback(async () => {
    if (!RAILWAY) return;
    try {
      const res = await fetch(`${RAILWAY}/vbn-auto/status`);
      const data = await res.json();
      setVbnAutoEnabled(data.enabled ?? false);
      setVbnAutoLastRun(data.lastRun ?? null);
      setVbnAutoNextRun(data.nextRun ?? null);
      onAutoVbnChange?.(data.enabled ?? false, data.nextRun ?? null);
    } catch { /* ignore */ }
    finally { setAutoStatusLoaded(true); }
  }, [onAutoVbnChange]);

  useState(() => { loadVbnAutoStatus(); });

  const toggleVbnAuto = useCallback(async (enabled: boolean) => {
    if (!RAILWAY) return;
    setVbnAutoTogglingLoading(true);
    try {
      await fetch(`${RAILWAY}/vbn-auto/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await loadVbnAutoStatus();
    } catch { /* ignore */ }
    setVbnAutoTogglingLoading(false);
  }, [loadVbnAutoStatus]);

  const runVbnAutoNow = useCallback(async () => {
    if (!RAILWAY) return;
    setVbnAutoRunNowLoading(true);
    try {
      await fetch(`${RAILWAY}/vbn-auto/run-now`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 3000));
      await loadVbnAutoStatus();
    } catch { /* ignore */ }
    setVbnAutoRunNowLoading(false);
  }, [loadVbnAutoStatus]);

  const step = fixing ? "fixing"
    : fixResult !== null ? "done"
    : results !== null ? "results"
    : "search";

  function resetAll() {
    setResults(null); setStats(null); setVbnInput(""); setVbnNameCache({});
    setFixResult(null); setFixMessage(null); setCheckError(null);
    setSearchStatus(null);
  }

  function resetToSearch() {
    setResults(null); setStats(null); setFixResult(null);
    setFixMessage(null); setCheckError(null);
  }

  const errorResults = results?.filter((r) => !r.excluded && r.status !== "OK") ?? [];

  async function handleCheck() {
    if (!vbnInput.trim()) return;
    if (!RAILWAY) {
      setCheckError("NEXT_PUBLIC_RAILWAY_API_URL not configured — redeploy Vercel after adding the env var.");
      return;
    }
    flushSync(() => {
      setLoading(true);
      setCheckError(null);
      setResults(null);
      setStats(null);
      setFixMessage(null);
      setStatusMessage(t.common.connecting);
    });

    try {
      const res = await fetch(`${RAILWAY}/vbn-check/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vbn: vbnInput.trim(), lang }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === "status") {
            flushSync(() => setStatusMessage(event.message as string));
          } else if (event.type === "result") {
            const data = event.data as { results: VbnResult[]; stats: Stats };
            const withEdits = data.results.map((r) => ({ ...r, edited_vbn: r.proposed_vbn, excluded: false }));
            setResults(withEdits);
            setStats(data.stats);
            const seedCache: Record<string, string> = {};
            data.results.forEach((r) => {
              if (r.proposed_vbn && r.proposed_vbn_name) seedCache[r.proposed_vbn] = r.proposed_vbn_name;
              if (r.current_vbn && r.official_name) seedCache[r.current_vbn] = r.official_name;
            });
            setVbnNameCache(seedCache);
            fetch("/api/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "vbn_check", vbn_filter: vbnInput.trim(), stats: data.stats, details: { result_count: data.results.length } }),
            }).catch(() => {});
          } else if (event.type === "error") {
            throw new Error(event.message as string);
          }
        }
      }
    } catch (e: unknown) {
      setCheckError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setStatusMessage(null);
    }
  }

  function updateVbn(product_id: string, val: string) {
    setResults((prev) => prev ? prev.map((r) => (r.product_id === product_id ? { ...r, edited_vbn: val } : r)) : prev);
    const trimmed = val.trim();
    if (!trimmed || !RAILWAY) { setSuggestions(null); return; }
    if (debounceTimers.current[product_id]) clearTimeout(debounceTimers.current[product_id]);

    if (/^\d+$/.test(trimmed)) {
      setSuggestions(null);
      setVbnNameCache((prev) => ({ ...prev, [trimmed]: prev[trimmed] && prev[trimmed] !== "…" ? prev[trimmed] : "…" }));
      debounceTimers.current[product_id] = setTimeout(async () => {
        try {
          const res = await fetch(`${RAILWAY}/vbn-name/${trimmed}`);
          const data = await res.json();
          setVbnNameCache((prev) => ({ ...prev, [trimmed]: data.found ? (data.name ?? "") : t.vbn.unknownCode }));
        } catch {
          setVbnNameCache((prev) => ({ ...prev, [trimmed]: "" }));
        }
      }, 600);
    } else {
      debounceTimers.current[product_id] = setTimeout(async () => {
        const el = inputRefs.current[product_id];
        if (el) {
          const rect = el.getBoundingClientRect();
          setDropdownAnchor({ top: rect.bottom + 4, left: rect.left });
        }
        try {
          const res = await fetch(`${RAILWAY}/vbn-search?q=${encodeURIComponent(trimmed)}&limit=15`);
          const data = await res.json();
          setSuggestions({ product_id, items: data.results ?? [] });
        } catch {
          setSuggestions(null);
        }
      }, 500);
    }
  }

  function applySuggestion(product_id: string, id: string, name: string) {
    setResults((prev) => prev ? prev.map((r) => (r.product_id === product_id ? { ...r, edited_vbn: id } : r)) : prev);
    setVbnNameCache((prev) => ({ ...prev, [id]: name }));
    setSuggestions(null);
  }

  function toggleExclude(product_id: string) {
    setResults((prev) => prev ? prev.map((r) => (r.product_id === product_id ? { ...r, excluded: !r.excluded } : r)) : prev);
  }

  async function handleFix() {
    if (!results) return;
    const toFix = results
      .filter((r) => !r.excluded && r.status !== "OK" && r.edited_vbn?.trim())
      .map((r) => ({ product_id: r.product_id, new_vbn: r.edited_vbn!.trim(), old_vbn: r.current_vbn, name: r.name }));

    if (toFix.length === 0) { setFixMessage(t.vbn.nothingToFix); return; }

    flushSync(() => { setFixing(true); setFixMessage(null); });
    try {
      const fixPayload = toFix.map(({ product_id, new_vbn }) => ({ product_id, new_vbn }));
      const res = await fetch(`${RAILWAY}/vbn-fix/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixes: fixPayload, lang }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (event.type === "status") {
            flushSync(() => setFixMessage(event.message as string));
          } else if (event.type === "result") {
            const data = event.data as { fixed: number; failed: number };
            setResults(null); setStats(null); setVbnInput(""); setVbnNameCache({});
            setFixResult({ fixed: data.fixed, failed: data.failed, message: t.vbn.fixedMsg(data.fixed, data.failed) });
            fetch("/api/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "vbn_fix", vbn_filter: null, stats: { fixed: data.fixed, failed: data.failed }, details: { fixes: toFix } }),
            }).catch(() => {});
          } else if (event.type === "error") {
            throw new Error(event.message as string);
          }
        }
      }
    } catch (e: unknown) {
      setFixMessage(`${t.common.error}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFixing(false);
    }
  }

  const AutoVbnCard = () => (
    <div className={`bg-surface rounded-2xl border border-border overflow-hidden shadow-sm relative transition-opacity ${!autoStatusLoaded ? "opacity-60" : ""}`}>
      {!autoStatusLoaded && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/40 rounded-2xl">
          <Spinner className="h-4 w-4 text-ink-3" />
        </div>
      )}
      <div className="px-5 py-4 flex items-start gap-4">
        <div className="flex-shrink-0 mt-0.5">
          <span className={`flex w-8 h-8 items-center justify-center rounded-xl ${vbnAutoEnabled ? "bg-emerald-light" : "bg-muted"}`}>
            <span className={`w-2.5 h-2.5 rounded-full ${vbnAutoEnabled ? "bg-emerald" : "bg-border"}`} />
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink">{t.vbn.autoCheckTitle}</p>
          <p className="text-xs text-ink-3 mt-0.5 leading-relaxed">{t.vbn.autoCheckDesc}</p>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-ink-3">
            {vbnAutoLastRun ? (
              <span>
                {t.vbn.autoCheckLastRun}: <span className="text-ink">{new Date(vbnAutoLastRun.started_at).toLocaleString(localeStr)}</span>
                {vbnAutoLastRun.checked_count != null && (
                  <span className="ml-2 opacity-70">— {vbnAutoLastRun.checked_count} {t.vbn.autoCheckChecked}, {vbnAutoLastRun.fixed_count ?? 0} {t.vbn.autoCheckFixed}</span>
                )}
              </span>
            ) : (
              <span className="opacity-50">{t.vbn.autoCheckNeverRun}</span>
            )}
            {vbnAutoEnabled && vbnAutoNextRun && (
              <span className="text-emerald">{t.vbn.autoCheckNextRun}: {new Date(vbnAutoNextRun).toLocaleString(localeStr)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <button
            onClick={runVbnAutoNow}
            disabled={vbnAutoRunNowLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-ember/40 text-ember bg-ember-light hover:bg-ember/10 disabled:opacity-40 transition-colors"
          >
            {vbnAutoRunNowLoading ? <><Spinner className="h-3 w-3" />{t.vbn.autoCheckRunning}</> : t.vbn.autoCheckRunNow}
          </button>
          <button
            onClick={() => { if (vbnAutoEnabled) { setShowDisableConfirm(true); } else { toggleVbnAuto(true); } }}
            disabled={vbnAutoTogglingLoading || !autoStatusLoaded}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-40 ${vbnAutoEnabled ? "bg-emerald" : "bg-border"}`}
            aria-label={t.vbn.autoCheckTitle}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${vbnAutoEnabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      {/* Disable auto VBN confirmation */}
      {showDisableConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface rounded-2xl shadow-2xl max-w-sm w-full mx-4 p-6">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-10 h-10 rounded-full bg-ember-light flex items-center justify-center flex-shrink-0 border border-ember/30">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path d="M9 3v6M9 13h.01" stroke="#EC4328" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="9" cy="9" r="8" stroke="#EC4328" strokeWidth="1.5"/>
                </svg>
              </div>
              <div>
                <p className="text-base font-semibold text-ink">{t.vbn.autoCheckDisableTitle}</p>
                <p className="text-sm text-ink-3 mt-1">{t.vbn.autoCheckDisableDesc}</p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowDisableConfirm(false)} className="px-4 py-2 text-sm border border-border rounded-xl text-ink-3 hover:bg-ground transition-colors">{t.common.cancel}</button>
              <button onClick={() => { setShowDisableConfirm(false); toggleVbnAuto(false); }} className="px-4 py-2 text-sm bg-ember hover:bg-ember-dark text-white rounded-xl font-medium transition-colors">{t.vbn.autoCheckDisableConfirm}</button>
            </div>
          </div>
        </div>
      )}

      {/* VBN autocomplete dropdown portal */}
      {suggestions && dropdownAnchor && typeof document !== "undefined" && createPortal(
        <div style={{ position: "fixed", top: dropdownAnchor.top, left: dropdownAnchor.left, width: 320, zIndex: 9999 }}
          className="bg-surface border border-border rounded-xl shadow-xl overflow-hidden max-h-64 overflow-y-auto">
          {suggestions.items.length === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-3 italic">{t.vbn.noFloricode}</p>
          ) : suggestions.items.map((s) => (
            <button key={s.id} onMouseDown={() => applySuggestion(suggestions.product_id, s.id, s.name)}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-xs hover:bg-emerald-light border-b border-border last:border-0 transition-colors">
              <span className="font-mono text-emerald font-medium shrink-0 w-12">{s.id}</span>
              <span className="text-ink leading-snug">{s.name}</span>
            </button>
          ))}
        </div>,
        document.body
      )}

      {/* Step container — key triggers card-enter re-animation on step change */}
      <div key={step} className="card-enter">

        {/* ── STEP 1: SEARCH ── */}
        {step === "search" && (
          <div className="p-6 space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-ink tracking-tight">{t.nav.vbnChecker}</h2>
              <p className="text-sm text-ink-3 mt-1">{t.vbn.description}</p>
            </div>

            <AutoVbnCard />

            <div className="bg-surface rounded-2xl border border-border p-5 shadow-sm">
              <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-widest mb-3">{t.vbn.codesLabel}</label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={vbnInput}
                  onChange={(e) => setVbnInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCheck()}
                  placeholder={t.vbn.placeholder}
                  className="border border-border rounded-xl px-4 py-2.5 text-sm flex-1 max-w-64 focus:outline-none focus:ring-2 focus:ring-emerald/30 focus:border-emerald/60 bg-ground placeholder:text-neutral-300 transition-all"
                  autoFocus
                />
                <button
                  onClick={handleCheck}
                  disabled={loading || !vbnInput.trim()}
                  className="flex items-center gap-2 bg-emerald hover:bg-emerald-dark disabled:opacity-40 text-white text-sm font-medium px-6 py-2.5 rounded-xl transition-colors shadow-sm"
                >
                  {loading && <Spinner className="h-4 w-4" />}
                  {loading ? t.vbn.checking : t.vbn.checkBtn}
                </button>
              </div>
              {loading && statusMessage && (
                <div className="mt-3 flex items-center gap-2.5 text-sm text-emerald bg-emerald-light border border-emerald/20 rounded-lg px-4 py-2.5">
                  <Spinner className="h-3.5 w-3.5 flex-shrink-0" />
                  {statusMessage}
                </div>
              )}
              {checkError && (
                <div className="mt-3 flex items-center gap-2 text-sm text-ember-dark bg-ember-light border border-ember/30 rounded-lg px-4 py-2.5">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" stroke="currentColor" strokeWidth="1.2"/><path d="M7 4v3.5M7 10h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                  {checkError}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── STEP 2: RESULTS ── */}
        {step === "results" && results !== null && (
          <div className="flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-border flex items-center gap-3 flex-shrink-0">
              <button onClick={resetToSearch} className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink transition-colors group">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="group-hover:-translate-x-0.5 transition-transform">
                  <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {t.vbn.backToSearch}
              </button>
              <span className="text-border select-none">/</span>
              <h2 className="font-semibold text-ink text-sm">{t.vbn.resultsFor} &ldquo;{vbnInput}&rdquo;</h2>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              {/* Stats */}
              {stats && (
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: t.vbn.statTotal,    value: stats.total,    bg: "bg-surface",       val: "text-ink",        border: "border-border" },
                    { label: t.vbn.statErrors,   value: stats.errors,   bg: "bg-ember-light",   val: "text-ember-dark", border: "border-ember/30" },
                    { label: t.vbn.statWarnings, value: stats.warnings, bg: "bg-amber-50",      val: "text-amber-700",  border: "border-amber-200" },
                    { label: t.vbn.statOk,       value: stats.ok,       bg: "bg-emerald-light", val: "text-emerald",    border: "border-emerald/20" },
                  ].map((s) => (
                    <div key={s.label} className={`${s.bg} border ${s.border} rounded-2xl px-4 py-3 shadow-sm`}>
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400 mb-1">{s.label}</p>
                      <p className={`text-3xl font-bold ${s.val} leading-none`}>{s.value}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Errors table */}
              <div className="bg-surface border border-border rounded-2xl overflow-hidden shadow-sm">
                <div className="px-5 py-3.5 border-b border-border">
                  <span className="text-sm font-semibold text-ink">{t.vbn.errorsTitle}</span>
                  <span className="ml-2 text-xs text-ink-3">({errorResults.length} {t.vbn.toFix})</span>
                </div>
                {errorResults.length === 0 ? (
                  <div className="px-5 py-10 text-center">
                    <div className="w-10 h-10 bg-emerald-light rounded-full flex items-center justify-center mx-auto mb-3">
                      <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 9l5 5 7-8" stroke="#1A7D45" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                    <p className="text-sm text-emerald font-medium">{t.vbn.allOk}</p>
                  </div>
                ) : (
                  <>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-ground border-b border-border text-[10px] text-neutral-400 uppercase tracking-widest">
                          <th className="text-left px-5 py-3 font-semibold">{t.vbn.tableProduct}</th>
                          <th className="text-left px-3 py-3 font-semibold">{t.vbn.tableCurrent}</th>
                          <th className="text-left px-3 py-3 font-semibold">{t.vbn.tableReason}</th>
                          <th className="text-left px-3 py-3 font-semibold">{t.vbn.tableProposed}</th>
                          <th className="px-3 py-3 font-semibold">{t.vbn.tableAction}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {errorResults.map((r) => (
                          <tr key={r.product_id} className={`hover:bg-ground/60 transition-colors ${r.excluded ? "opacity-35" : ""}`}>
                            <td className="px-5 py-3">
                              <p className="font-medium text-ink text-sm leading-snug">{r.name}</p>
                              {r.short_name && <p className="text-xs text-ink-3 mt-0.5">{r.short_name}</p>}
                            </td>
                            <td className="px-3 py-3">
                              <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-mono font-medium ${r.status === "ERROR" ? "bg-ember-light text-ember-dark" : "bg-amber-50 text-amber-700"}`}>{r.current_vbn}</span>
                              {r.official_name && <p className="text-[11px] text-ink-3 mt-0.5 max-w-[120px] truncate">{r.official_name}</p>}
                            </td>
                            <td className="px-3 py-3 max-w-xs">
                              <p className="text-xs text-neutral-500 leading-relaxed">{r.reason || "—"}</p>
                            </td>
                            <td className="px-3 py-3 min-w-[160px]">
                              <input
                                ref={(el) => { inputRefs.current[r.product_id] = el; }}
                                type="text"
                                value={r.edited_vbn ?? ""}
                                onChange={(e) => updateVbn(r.product_id, e.target.value)}
                                onBlur={() => setTimeout(() => setSuggestions(null), 150)}
                                disabled={r.excluded}
                                placeholder={t.vbn.editPlaceholder}
                                className="border border-border rounded-lg px-2.5 py-1.5 text-xs w-36 focus:outline-none focus:ring-1 focus:ring-emerald/40 focus:border-emerald/60 disabled:bg-muted bg-surface transition-all font-mono"
                              />
                              {r.edited_vbn?.trim() && /^\d+$/.test(r.edited_vbn.trim()) && (
                                <p className={`text-[10px] mt-0.5 leading-snug break-words ${
                                  vbnNameCache[r.edited_vbn.trim()]?.startsWith("⚠") ? "text-ember" :
                                  vbnNameCache[r.edited_vbn.trim()] === "…" ? "text-neutral-300 italic" : "text-ink-3"
                                }`}>{vbnNameCache[r.edited_vbn.trim()] ?? ""}</p>
                              )}
                            </td>
                            <td className="px-3 py-3 text-center">
                              <button
                                onClick={() => toggleExclude(r.product_id)}
                                className={`text-xs px-2.5 py-1 rounded-lg border font-medium transition-colors ${
                                  r.excluded ? "border-emerald/30 text-emerald bg-emerald-light hover:bg-emerald/20"
                                  : "border-border text-ink-3 hover:border-ember/30 hover:text-ember hover:bg-ember-light"
                                }`}
                              >{r.excluded ? t.vbn.restore : t.vbn.skip}</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="px-5 py-3.5 bg-ground border-t border-border flex items-center justify-between">
                      <p className="text-xs text-ink-3">
                        <span className="font-semibold text-ink">{errorResults.filter((r) => !r.excluded && r.edited_vbn?.trim()).length}</span>
                        {" "}{t.vbn.willBeUpdated}
                      </p>
                      <div className="flex gap-2.5 items-center">
                        {fixMessage && (
                          <span className="text-xs px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200">{fixMessage}</span>
                        )}
                        <button
                          onClick={handleFix}
                          disabled={fixing}
                          className="flex items-center gap-1.5 bg-emerald hover:bg-emerald-dark disabled:opacity-40 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors shadow-sm"
                        >
                          {t.vbn.fixBtn}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* OK products (collapsed) */}
              {stats && stats.ok > 0 && (
                <details className="bg-surface border border-border rounded-2xl overflow-hidden shadow-sm group">
                  <summary className="px-5 py-3 text-sm text-ink-3 cursor-pointer select-none hover:bg-ground transition-colors flex items-center gap-2">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="transition-transform group-open:rotate-90 flex-shrink-0">
                      <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span className="inline-flex items-center gap-1 text-emerald text-xs font-medium">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      {stats.ok}
                    </span>
                    {t.vbn.okExpand(stats.ok).replace(String(stats.ok), "").trim()}
                  </summary>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-ground border-b border-border text-[10px] uppercase tracking-widest text-ink-3">
                        <th className="text-left px-5 py-2.5 font-semibold">{t.vbn.okName}</th>
                        <th className="text-left px-3 py-2.5 font-semibold">{t.vbn.okVbn}</th>
                        <th className="text-left px-3 py-2.5 font-semibold">{t.vbn.okOfficial}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {results.filter((r) => r.status === "OK").map((r) => (
                        <tr key={r.product_id} className="hover:bg-ground/60 transition-colors">
                          <td className="px-5 py-2.5 text-ink">{r.name}</td>
                          <td className="px-3 py-2.5"><span className="bg-emerald-light text-emerald px-2 py-0.5 rounded-md font-mono text-xs">{r.current_vbn}</span></td>
                          <td className="px-3 py-2.5 text-ink-3">{r.official_name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          </div>
        )}

        {/* ── STEP 3: FIXING ── */}
        {step === "fixing" && (
          <div className="p-12 flex flex-col items-center justify-center gap-6 min-h-72 text-center">
            <svg className="animate-spin w-14 h-14 text-emerald" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-15" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5"/>
              <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <div>
              <p className="text-xs text-ink-3 uppercase tracking-widest mb-2">{t.vbn.fixingTitle}</p>
              {fixMessage && <p className="text-sm text-ink-3 animate-pulse mt-2">{fixMessage}</p>}
            </div>
          </div>
        )}

        {/* ── STEP 4: DONE ── */}
        {step === "done" && fixResult && (
          <div className="p-12 flex flex-col items-center justify-center gap-6 min-h-72 text-center">
            <div className={`w-16 h-16 rounded-full flex items-center justify-center text-2xl border-2 ${fixResult.failed === 0 ? "bg-emerald-light text-emerald border-emerald/30" : "bg-amber-50 text-amber-600 border-amber-200"}`}>
              {fixResult.failed === 0 ? "✓" : "⚠"}
            </div>
            <div>
              <p className="text-base font-bold text-ink">{t.vbn.doneTitle}</p>
              <p className="text-sm text-ink-3 mt-1">{fixResult.message}</p>
              {fixResult.failed > 0 && (
                <p className="text-xs text-amber-600 mt-1">{t.vbn.doneFailed(fixResult.failed)}</p>
              )}
            </div>
            <button
              onClick={resetAll}
              className="px-6 py-2.5 bg-ink hover:bg-ink/80 text-white text-sm font-medium rounded-xl transition-colors"
            >{t.vbn.checkAgain}</button>
          </div>
        )}

      </div>
    </div>
  );
}
