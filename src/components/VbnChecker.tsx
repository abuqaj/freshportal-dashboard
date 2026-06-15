"use client";

import { useState, useCallback, useRef } from "react";
import { flushSync, createPortal } from "react-dom";
import { translations, Lang } from "@/lib/i18n";
import { VbnResult, Stats, AutoVbnRun } from "@/lib/types";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface Props {
  lang: Lang;
}

export default function VbnChecker({ lang }: Props) {
  const t = translations[lang];

  const [vbnInput, setVbnInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [results, setResults] = useState<VbnResult[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixMessage, setFixMessage] = useState<string | null>(null);
  const [fixSuccess, setFixSuccess] = useState<string | null>(null);
  const [vbnNameCache, setVbnNameCache] = useState<Record<string, string>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [suggestions, setSuggestions] = useState<{ product_id: string; items: { id: string; name: string }[] } | null>(null);
  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number } | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Auto VBN
  const [vbnAutoEnabled, setVbnAutoEnabled] = useState(false);
  const [vbnAutoLastRun, setVbnAutoLastRun] = useState<AutoVbnRun | null>(null);
  const [vbnAutoNextRun, setVbnAutoNextRun] = useState<string | null>(null);
  const [vbnAutoTogglingLoading, setVbnAutoTogglingLoading] = useState(false);

  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";

  const loadVbnAutoStatus = useCallback(async () => {
    if (!RAILWAY) return;
    try {
      const res = await fetch(`${RAILWAY}/vbn-auto/status`);
      const data = await res.json();
      setVbnAutoEnabled(data.enabled ?? false);
      setVbnAutoLastRun(data.lastRun ?? null);
      setVbnAutoNextRun(data.nextRun ?? null);
    } catch { /* ignore */ }
  }, []);

  // Expose for parent to call on tab entry
  // (called via useEffect in page.tsx — pass as ref if needed, or just call here)
  // We call it on mount
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
            const msg = t.vbn.fixedMsg(data.fixed, data.failed);
            setResults(null); setStats(null); setVbnInput(""); setVbnNameCache({});
            setFixSuccess(msg);
            setTimeout(() => setFixSuccess(null), 6000);
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

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-neutral-900">VBN Checker</h1>
        <p className="text-sm text-neutral-500 mt-1">{t.vbn.description}</p>
      </div>

      {/* Auto VBN check toggle */}
      <div className="mb-5 bg-white border border-neutral-200 rounded-xl p-5 flex items-start gap-5">
        <div className="flex-1">
          <p className="text-sm font-medium text-neutral-800">{t.vbn.autoCheckTitle}</p>
          <p className="text-xs text-neutral-500 mt-0.5">{t.vbn.autoCheckDesc}</p>
          {vbnAutoLastRun && (
            <p className="text-xs text-neutral-400 mt-2">
              {t.vbn.autoCheckLastRun}: {new Date(vbnAutoLastRun.started_at).toLocaleString(localeStr)}
              {vbnAutoLastRun.checked_count != null && (
                <span className="ml-2 text-neutral-500">
                  — {vbnAutoLastRun.checked_count} {t.vbn.autoCheckChecked}, {vbnAutoLastRun.fixed_count ?? 0} {t.vbn.autoCheckFixed}
                </span>
              )}
            </p>
          )}
          {!vbnAutoLastRun && <p className="text-xs text-neutral-400 mt-2">{t.vbn.autoCheckNeverRun}</p>}
          {vbnAutoEnabled && vbnAutoNextRun && (
            <p className="text-xs text-neutral-400 mt-0.5">
              {t.vbn.autoCheckNextRun}: {new Date(vbnAutoNextRun).toLocaleString(localeStr)}
            </p>
          )}
        </div>
        <button
          onClick={() => toggleVbnAuto(!vbnAutoEnabled)}
          disabled={vbnAutoTogglingLoading}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50 ${vbnAutoEnabled ? "bg-violet-600" : "bg-neutral-200"}`}
          aria-label={t.vbn.autoCheckTitle}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${vbnAutoEnabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>

      {/* Fix success banner */}
      {fixSuccess && (
        <div className="mb-5 flex items-center gap-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl px-5 py-3">
          <span className="text-base">✓</span>
          <span>{fixSuccess}</span>
        </div>
      )}

      {/* Search bar */}
      <div className="bg-white border border-neutral-200 rounded-xl p-5 mb-5">
        <label className="block text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">{t.vbn.codesLabel}</label>
        <div className="flex gap-3">
          <input
            type="text"
            value={vbnInput}
            onChange={(e) => setVbnInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCheck()}
            placeholder={t.vbn.placeholder}
            className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
          />
          <button
            onClick={handleCheck}
            disabled={loading || !vbnInput.trim()}
            className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
          >
            {loading ? t.vbn.checking : t.vbn.checkBtn}
          </button>
        </div>
        {loading && statusMessage && (
          <div className="mt-3 flex items-center gap-3 text-sm text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-4 py-3">
            <svg className="animate-spin h-4 w-4 flex-shrink-0 text-violet-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>{statusMessage}</span>
          </div>
        )}
        {checkError && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">⚠️ {checkError}</p>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-3 mb-5">
          {[
            { label: t.vbn.statTotal,    value: stats.total,    color: "text-neutral-800" },
            { label: t.vbn.statErrors,   value: stats.errors,   color: "text-red-600" },
            { label: t.vbn.statWarnings, value: stats.warnings, color: "text-amber-600" },
            { label: t.vbn.statOk,       value: stats.ok,       color: "text-green-600" },
          ].map((s) => (
            <div key={s.label} className="bg-white border border-neutral-200 rounded-xl p-4">
              <p className="text-xs text-neutral-400 mb-1">{s.label}</p>
              <p className={`text-2xl font-semibold ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Results table */}
      {results && results.length > 0 && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden mb-4">
          <div className="px-5 py-4 border-b border-neutral-100 flex justify-between items-center">
            <p className="text-sm font-medium text-neutral-800">
              {t.vbn.errorsTitle}
              <span className="ml-2 text-xs text-neutral-400">({errorResults.length} {t.vbn.toFix})</span>
            </p>
          </div>
          {errorResults.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-green-600">{t.vbn.allOk}</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-100 text-xs text-neutral-400 uppercase tracking-wide">
                  <th className="text-left px-5 py-3 font-medium">{t.vbn.tableProduct}</th>
                  <th className="text-left px-3 py-3 font-medium">{t.vbn.tableCurrent}</th>
                  <th className="text-left px-3 py-3 font-medium">{t.vbn.tableReason}</th>
                  <th className="text-left px-3 py-3 font-medium">{t.vbn.tableProposed}</th>
                  <th className="px-3 py-3 font-medium">{t.vbn.tableAction}</th>
                </tr>
              </thead>
              <tbody>
                {errorResults.map((r) => (
                  <tr key={r.product_id} className={`border-b border-neutral-50 hover:bg-neutral-50 transition-colors ${r.excluded ? "opacity-40" : ""}`}>
                    <td className="px-5 py-3">
                      <p className="font-medium text-neutral-800">{r.name}</p>
                      <p className="text-xs text-neutral-400">{r.short_name}</p>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${r.status === "ERROR" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>
                        {r.current_vbn}
                      </span>
                      {r.official_name && <p className="text-xs text-neutral-400 mt-0.5 max-w-32 truncate">{r.official_name}</p>}
                    </td>
                    <td className="px-3 py-3 max-w-xs">
                      <p className="text-xs text-neutral-500 leading-snug">{r.reason || "—"}</p>
                    </td>
                    <td className="px-3 py-3 min-w-44">
                      <input
                        ref={(el) => { inputRefs.current[r.product_id] = el; }}
                        type="text"
                        value={r.edited_vbn ?? ""}
                        onChange={(e) => updateVbn(r.product_id, e.target.value)}
                        onBlur={() => setTimeout(() => setSuggestions(null), 150)}
                        disabled={r.excluded}
                        placeholder={t.vbn.editPlaceholder}
                        className="border border-neutral-200 rounded px-2 py-1 text-xs w-36 focus:outline-none focus:ring-1 focus:ring-violet-300 disabled:bg-neutral-50"
                      />
                      {r.edited_vbn?.trim() && /^\d+$/.test(r.edited_vbn.trim()) && (
                        <p className={`text-xs mt-0.5 break-words leading-snug ${vbnNameCache[r.edited_vbn.trim()]?.startsWith("⚠") ? "text-red-400" : vbnNameCache[r.edited_vbn.trim()] === "…" ? "text-neutral-300 italic" : "text-neutral-400"}`}>
                          {vbnNameCache[r.edited_vbn.trim()] ?? ""}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <button
                        onClick={() => toggleExclude(r.product_id)}
                        className={`text-xs px-2.5 py-1 rounded border transition-colors ${r.excluded ? "border-green-200 text-green-600 hover:bg-green-50" : "border-neutral-200 text-neutral-400 hover:border-red-200 hover:text-red-500"}`}
                      >
                        {r.excluded ? t.vbn.restore : t.vbn.skip}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {errorResults.length > 0 && (
            <div className="px-5 py-4 bg-neutral-50 border-t border-neutral-100 flex items-center justify-between">
              <p className="text-xs text-neutral-500">
                {errorResults.filter((r) => !r.excluded && r.edited_vbn?.trim()).length} {t.vbn.willBeUpdated}
              </p>
              <div className="flex gap-2 items-center">
                {fixMessage && (
                  <span className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg ${fixMessage.startsWith("✓") ? "bg-green-50 text-green-700" : fixMessage.startsWith("Błąd") ? "bg-red-50 text-red-600" : "bg-violet-50 text-violet-700"}`}>
                    {fixing && (
                      <svg className="animate-spin h-3 w-3 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    )}
                    {fixMessage}
                  </span>
                )}
                <button
                  onClick={handleFix}
                  disabled={fixing}
                  className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  {fixing ? t.vbn.fixing : t.vbn.fixBtn}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* OK products collapsed */}
      {results && stats && stats.ok > 0 && (
        <details className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          <summary className="px-5 py-3 text-sm text-neutral-500 cursor-pointer hover:bg-neutral-50">
            {t.vbn.okExpand(stats.ok)}
          </summary>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-neutral-100 text-neutral-400">
                <th className="text-left px-5 py-2">{t.vbn.okName}</th>
                <th className="text-left px-3 py-2">{t.vbn.okVbn}</th>
                <th className="text-left px-3 py-2">{t.vbn.okOfficial}</th>
              </tr>
            </thead>
            <tbody>
              {results.filter((r) => r.status === "OK").map((r) => (
                <tr key={r.product_id} className="border-b border-neutral-50">
                  <td className="px-5 py-2 text-neutral-700">{r.name}</td>
                  <td className="px-3 py-2"><span className="bg-green-50 text-green-700 px-2 py-0.5 rounded text-xs">{r.current_vbn}</span></td>
                  <td className="px-3 py-2 text-neutral-400">{r.official_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {/* Portal dropdown for VBN name autocomplete */}
      {suggestions && dropdownAnchor && typeof document !== "undefined" && createPortal(
        <div
          style={{ position: "fixed", top: dropdownAnchor.top, left: dropdownAnchor.left, width: 320, zIndex: 9999 }}
          className="bg-white border border-neutral-200 rounded-lg shadow-xl overflow-hidden max-h-64 overflow-y-auto"
        >
          {suggestions.items.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-400">{t.vbn.noFloricode}</p>
          ) : (
            suggestions.items.map((s) => (
              <button
                key={s.id}
                onMouseDown={() => applySuggestion(suggestions.product_id, s.id, s.name)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-violet-50 border-b border-neutral-50 last:border-0 transition-colors"
              >
                <span className="font-mono text-violet-600 shrink-0">{s.id}</span>
                <span className="text-neutral-700 leading-snug">{s.name}</span>
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
