"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { flushSync } from "react-dom";
import { translations, Lang } from "@/lib/i18n";
import { ProductSearchResult, AIAnalysis, SyncStatus } from "@/lib/types";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface Props {
  lang: Lang;
}

function NameCorrectionHint({ hint, onRevert, fromTemplateLabel, useOriginalLabel }: {
  hint: { original: string; corrected: string };
  onRevert: () => void;
  fromTemplateLabel: string;
  useOriginalLabel: string;
}) {
  const origWords = hint.original.trim().split(/\s+/);
  const corrWords = hint.corrected.trim().split(/\s+/);
  const maxLen = Math.max(origWords.length, corrWords.length);
  const diffs = Array.from({ length: maxLen }, (_, i) => ({
    orig: origWords[i] ?? "",
    corr: corrWords[i] ?? "",
    changed: (origWords[i] ?? "").toLowerCase() !== (corrWords[i] ?? "").toLowerCase(),
  })).filter(d => d.changed);
  if (diffs.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-400">
      <span>{fromTemplateLabel}</span>
      {diffs.map((d, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="text-amber-500 line-through">{d.orig}</span>
          <span className="text-neutral-300">→</span>
          <span className="text-green-600 font-medium">{d.corr}</span>
        </span>
      ))}
      <span>·</span>
      <button type="button" onClick={onRevert} className="text-violet-500 hover:text-violet-700 underline">
        {useOriginalLabel}
      </button>
    </div>
  );
}

export default function ProductCreator({ lang }: Props) {
  const t = translations[lang];

  const [createInput, setCreateInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<ProductSearchResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<{ ok: boolean; message: string; url?: string } | null>(null);
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AIAnalysis | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<{ templateId: string; templateName: string } | null>(null);
  const [finalName, setFinalName] = useState("");
  const [productNumber, setProductNumber] = useState("");
  const [numberChecking, setNumberChecking] = useState(false);
  const [numberCheckResult, setNumberCheckResult] = useState<{ changed: boolean; original: string } | null>(null);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState<{ templateId: string; templateName: string; templateColor?: string } | null>(null);
  const [templateColorName, setTemplateColorName] = useState("");
  const [selectedTemplateWas100Pct, setSelectedTemplateWas100Pct] = useState(false);
  const [showSecondDuplicateWarning, setShowSecondDuplicateWarning] = useState(false);
  const [showAllResults, setShowAllResults] = useState(false);
  const [nameFromTemplate, setNameFromTemplate] = useState<{ original: string; corrected: string } | null>(null);

  const [vbnForCreate, setVbnForCreate] = useState("");
  const [vbnForCreateInfo, setVbnForCreateInfo] = useState<{ found: boolean; name: string } | null>(null);
  const [vbnForCreateChecking, setVbnForCreateChecking] = useState(false);
  const vbnForCreateDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [colorList, setColorList] = useState<{ id: string; name: string }[]>([]);
  const [colorListLoading, setColorListLoading] = useState(false);
  const [colorLoadError, setColorLoadError] = useState<string | null>(null);
  const [colorForCreate, setColorForCreate] = useState("");
  const [colorSearch, setColorSearch] = useState("");
  const [colorDropdownOpen, setColorDropdownOpen] = useState(false);
  const colorDropdownRef = useRef<HTMLDivElement>(null);

  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncTriggering, setSyncTriggering] = useState(false);

  const nameChangeDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFormName = useRef<string>("");

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (colorDropdownRef.current && !colorDropdownRef.current.contains(e.target as Node)) {
        setColorDropdownOpen(false);
        setColorSearch("");
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  // Load sync status on mount
  useEffect(() => {
    if (colorList.length === 0 && !colorListLoading) loadColors();
    if (RAILWAY) {
      fetch(`${RAILWAY}/sync/status`)
        .then(r => r.json())
        .then((d: SyncStatus) => setSyncStatus(d))
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-select color from template once colorList is loaded
  useEffect(() => {
    if (!templateColorName || colorList.length === 0 || colorForCreate) return;
    const match = colorList.find((c: { id: string; name: string }) => c.name.toLowerCase() === templateColorName.toLowerCase());
    if (match) setColorForCreate(match.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorList, templateColorName]);

  function loadColors(forceRefresh = false) {
    if (colorListLoading || !RAILWAY) return;
    setColorListLoading(true);
    setColorLoadError(null);
    const url = forceRefresh ? `${RAILWAY}/floricode/colors/refresh` : `${RAILWAY}/floricode/colors`;
    fetch(url)
      .then(async r => {
        if (!r.ok) {
          let detail = `HTTP ${r.status}`;
          try { detail = (await r.json()).detail ?? detail; } catch { /* ignore */ }
          throw new Error(detail);
        }
        return r.json();
      })
      .then((d: { colors: { id: string; name: string }[] }) => setColorList(d.colors ?? []))
      .catch((e: unknown) => setColorLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setColorListLoading(false));
  }

  async function triggerSync() {
    if (!RAILWAY || syncTriggering) return;
    setSyncTriggering(true);
    try {
      await fetch(`${RAILWAY}/sync/run`, { method: "POST" });
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const r = await fetch(`${RAILWAY}/sync/status`);
          const d: SyncStatus = await r.json();
          setSyncStatus(d);
          if (!d.running || attempts > 180) clearInterval(poll);
        } catch { clearInterval(poll); }
        finally { if (!syncStatus?.running) setSyncTriggering(false); }
      }, 5000);
    } catch {
      setSyncTriggering(false);
    }
  }

  function wordJaccard(a: string, b: string): number {
    const wordsA = a.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const wordsB = b.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (wordsA.length === 0 && wordsB.length === 0) return 1;
    const maxWords = Math.max(wordsA.length, wordsB.length);
    if (maxWords === 0) return 1;
    function fuzzyWordSim(w1: string, w2: string): number {
      if (w1 === w2) return 1;
      const longer = w1.length >= w2.length ? w1 : w2;
      const shorter = w1.length < w2.length ? w1 : w2;
      if (longer.length === 0) return 1;
      let matches = 0, si = 0;
      for (let li = 0; li < longer.length && si < shorter.length; li++) {
        if (longer[li] === shorter[si]) { matches++; si++; }
      }
      return (2 * matches) / (longer.length + shorter.length);
    }
    const usedB = new Set<number>();
    let totalSim = 0;
    for (const wA of wordsA) {
      let bestSim = 0, bestJ = -1;
      for (let j = 0; j < wordsB.length; j++) {
        if (usedB.has(j)) continue;
        const s = fuzzyWordSim(wA, wordsB[j]);
        if (s > bestSim) { bestSim = s; bestJ = j; }
      }
      if (bestJ >= 0 && bestSim >= 0.80) { totalSim += bestSim; usedB.add(bestJ); }
    }
    return totalSim / maxWords;
  }

  function genProductNumber(name: string): string {
    const words = name.replace(/[^A-Za-z0-9\s]/g, "").toUpperCase().split(/\s+/).filter(Boolean);
    return words.map(w => w.slice(0, 2)).join("").slice(0, 8) || "PROD";
  }

  async function handleProductSearch() {
    if (!createInput.trim() || !RAILWAY) return;
    flushSync(() => {
      setSearching(true);
      setSearchResults(null);
      setSearchError(null);
      setCreateResult(null);
      setSearchStatus(t.common.connecting);
      setAiAnalysis(null);
      setAiLoading(false);
      setSelectedTemplateWas100Pct(false);
      setShowAllResults(false);
      setPendingCreate(null);
      setVbnForCreate("");
      setVbnForCreateInfo(null);
    });
    try {
      const res = await fetch(`${RAILWAY}/product-search/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createInput.trim(), lang }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? `HTTP ${res.status}`);
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
            flushSync(() => setSearchStatus(event.message as string));
          } else if (event.type === "result") {
            const d = event.data as { results: ProductSearchResult[] };
            const results = d.results ?? [];
            setSearchResults(results);
            setSearchStatus(null);
            if (results.length > 0 && RAILWAY) {
              setAiLoading(true);
              fetch(`${RAILWAY}/product-ai-analyze`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: createInput.trim(), candidates: results.slice(0, 6) }),
              })
                .then((r) => r.json())
                .then((data: AIAnalysis) => { setAiAnalysis(data); setAiLoading(false); })
                .catch(() => setAiLoading(false));
            }
          } else if (event.type === "error") {
            throw new Error(event.message as string);
          }
        }
      }
    } catch (e: unknown) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
      setSearchStatus(null);
    }
  }

  const handleCreateFromTemplate = useCallback((templateId: string, templateName: string, templateVbn = "", templateColor = "") => {
    const name = createInput.trim();
    const initialNumber = genProductNumber(name);
    initialFormName.current = name;
    setPendingCreate({ templateId, templateName });

    setColorForCreate("");
    setColorSearch("");
    setTemplateColorName(templateColor);
    if (templateColor && colorList.length > 0) {
      const colorMatch = colorList.find((c: { id: string; name: string }) => c.name.toLowerCase() === templateColor.toLowerCase());
      if (colorMatch) setColorForCreate(colorMatch.id);
    }

    const namesMatch = name.toLowerCase() === templateName.toLowerCase();
    setFinalName(namesMatch ? name : templateName);
    setNameFromTemplate(namesMatch ? null : { original: name, corrected: templateName });
    setProductNumber(initialNumber);
    setCreateResult(null);
    setNumberChecking(true);
    setNumberCheckResult(null);

    setVbnForCreate(templateVbn);
    setVbnForCreateInfo(null);
    setVbnForCreateChecking(true);

    if (RAILWAY && searchResults && searchResults.length > 0) {
      fetch(`${RAILWAY}/product-ai-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, candidates: searchResults.slice(0, 6), preferred_vbn: templateVbn || null }),
      })
        .then(r => r.json())
        .then((data: AIAnalysis) => {
          const code = data?.vbn?.code ?? null;
          setVbnForCreate(code ?? "");
          setVbnForCreateInfo(null);
          if (code && RAILWAY) {
            fetch(`${RAILWAY}/vbn-name/${code}`)
              .then(r => r.json())
              .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
              .catch(() => {})
              .finally(() => setVbnForCreateChecking(false));
          } else {
            setVbnForCreateChecking(false);
          }
        })
        .catch(() => {
          if (templateVbn) {
            fetch(`${RAILWAY}/vbn-name/${templateVbn}`)
              .then(r => r.json())
              .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
              .catch(() => {})
              .finally(() => setVbnForCreateChecking(false));
          } else {
            setVbnForCreateChecking(false);
          }
        });
    } else if (templateVbn && RAILWAY) {
      fetch(`${RAILWAY}/vbn-name/${templateVbn}`)
        .then(r => r.json())
        .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
        .catch(() => {})
        .finally(() => setVbnForCreateChecking(false));
    } else {
      setVbnForCreateChecking(false);
    }

    fetch(`${RAILWAY}/product-number-suggest?number=${encodeURIComponent(initialNumber)}&name=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((data: { available_number: string | null; original_number: string; changed: boolean }) => {
        if (data.available_number) {
          setProductNumber(data.available_number);
          setNumberCheckResult({ changed: data.changed, original: data.original_number });
        }
      })
      .catch(() => {})
      .finally(() => setNumberChecking(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createInput, colorList, searchResults]);

  async function handleConfirmCreate(skipWarning = false) {
    if (!pendingCreate || !RAILWAY) return;
    if (
      !skipWarning &&
      selectedTemplateWas100Pct &&
      finalName.trim().toLowerCase() === createInput.trim().toLowerCase()
    ) {
      setShowSecondDuplicateWarning(true);
      return;
    }
    setShowSecondDuplicateWarning(false);
    const { templateId, templateName } = pendingCreate;
    const nameForLog = finalName.trim();
    const numberForLog = productNumber.trim();
    flushSync(() => { setCreating(true); setCreateStatus(t.create.creating); setCreateResult(null); setPendingCreate(null); setColorDropdownOpen(false); });
    try {
      const res = await fetch(`${RAILWAY}/product-create/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: templateId, new_name: nameForLog, product_number: numberForLog || null, lang, vbn_code: vbnForCreate || null, color_id: colorForCreate || null }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
          if (event.type === "status") flushSync(() => setCreateStatus(event.message as string));
          else if (event.type === "result") {
            const d = event.data as { ok: boolean; message: string; url?: string };
            setCreateResult(d);
            if (d.ok) {
              fetch("/api/log", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "product_create",
                  vbn_filter: null,
                  stats: {},
                  details: { name: nameForLog, product_number: numberForLog, template_id: templateId, template_name: templateName },
                }),
              }).catch(() => {});
            }
          } else if (event.type === "error") throw new Error(event.message as string);
        }
      }
    } catch (e: unknown) {
      setCreateResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
      setCreateStatus(null);
    }
  }

  return (
    <div className="min-h-screen bg-cream">
      {/* Header */}
      <div className="bg-bark px-8 pt-8 pb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-sage-light tracking-tight">{t.nav.newProducts}</h1>
          <p className="text-sm text-sage mt-1 opacity-80">{t.create.description}</p>
        </div>
        {/* Sync status badge */}
        <div className="flex-shrink-0 text-right mb-1">
          {syncStatus ? (
            <div className="flex flex-col items-end gap-1">
              <div className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg font-medium ${
                syncStatus.running ? "bg-petal/20 text-petal border border-petal/30"
                : syncStatus.product_count > 0 ? "bg-leaf/20 text-leaf border border-leaf/30"
                : "bg-bark-hover text-sage border border-bark-border"
              }`}>
                {syncStatus.running && (
                  <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                )}
                {syncStatus.running ? t.create.syncRunning
                  : syncStatus.product_count > 0 ? t.create.syncProducts(syncStatus.product_count)
                  : t.create.syncEmpty}
              </div>
              {syncStatus.last_sync?.finished_at && !syncStatus.running && (
                <p className="text-[10px] text-sage opacity-60">
                  {t.create.syncLastSync} {new Date(syncStatus.last_sync.finished_at).toLocaleString()}
                </p>
              )}
              <button
                onClick={triggerSync}
                disabled={syncTriggering || syncStatus.running}
                className="text-[11px] text-petal hover:text-petal-dark disabled:opacity-40 underline"
              >
                {syncTriggering || syncStatus.running ? t.create.syncRunning : t.create.syncNow}
              </button>
            </div>
          ) : (
            <div className="text-xs text-sage opacity-40">{t.create.syncLoading}</div>
          )}
        </div>
      </div>

      <div className="px-8 py-6 max-w-3xl">

      {/* Search bar */}
      <div className="bg-white border border-cream-dark rounded-2xl p-5 mb-4 shadow-sm">
        <label className="block text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">{t.create.nameLabel}</label>
        <div className="flex gap-3">
          <input
            type="text"
            value={createInput}
            onChange={(e) => setCreateInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleProductSearch()}
            placeholder={t.create.namePlaceholder}
            className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-petal/30 focus:border-petal/60"
          />
          <button
            onClick={handleProductSearch}
            disabled={searching || !createInput.trim()}
            className="bg-petal hover:bg-petal-dark disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
          >
            {searching ? t.create.searching : t.create.searchBtn}
          </button>
        </div>
        {searching && searchStatus && (
          <div className="mt-3 flex items-center gap-3 text-sm text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-4 py-3">
            <svg className="animate-spin h-4 w-4 flex-shrink-0 text-violet-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>{searchStatus}</span>
          </div>
        )}
        {searchError && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">⚠️ {searchError}</p>
        )}
      </div>

      {createResult && (
        <div className={`mb-5 rounded-xl px-5 py-4 border text-sm ${createResult.ok ? "bg-green-50 border-green-200 text-green-700" : "bg-red-50 border-red-200 text-red-600"}`}>
          <p className="font-medium">{createResult.ok ? "✓ " : "⚠ "}{createResult.message}</p>
          {createResult.ok && createResult.url && <p className="text-xs mt-1 opacity-70">URL: {createResult.url}</p>}
        </div>
      )}

      {creating && createStatus && (
        <div className="mb-5 flex items-center gap-3 text-sm text-violet-700 bg-violet-50 border border-violet-200 rounded-xl px-5 py-3">
          <svg className="animate-spin h-4 w-4 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>{createStatus}</span>
        </div>
      )}

      {/* Search results */}
      {searchResults !== null && (() => {
        const highMatches = searchResults.filter(r => r.similarity >= 0.80).slice(0, 10);
        const isFallback = highMatches.length === 0 && searchResults.length > 0;
        const allDisplayResults = isFallback ? searchResults.slice(0, 1) : highMatches;
        const displayResults = showAllResults ? allDisplayResults : allDisplayResults.slice(0, 5);
        const hasMore = allDisplayResults.length > 5 && !showAllResults;
        return (
          <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-100">
              <p className="text-sm font-medium text-neutral-800">
                {t.create.similarTitle}
                {highMatches.length > 0 && <span className="ml-2 text-xs text-neutral-400">{t.create.resultsCount(highMatches.length)}</span>}
              </p>
            </div>
            {searchResults.length === 0 ? (
              <div className="px-5 py-6 text-sm text-neutral-500 text-center">
                {t.create.noResults}
                <br />
                <span className="text-xs text-neutral-400 mt-1 block">{t.create.noResultsHint}</span>
              </div>
            ) : (
              <>
                {highMatches.length > 0 && (
                  <div className="px-5 py-3 bg-amber-50 border-b border-amber-100 text-xs text-amber-700">{t.create.warning}</div>
                )}
                {isFallback && (
                  <div className="px-5 py-3 bg-neutral-50 border-b border-neutral-100 text-xs text-neutral-500">{t.create.fallback}</div>
                )}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100 text-xs text-neutral-400 uppercase tracking-wide">
                      <th className="text-left px-5 py-3 font-medium">{t.create.tableProduct}</th>
                      <th className="text-left px-3 py-3 font-medium">{t.create.tableVbn}</th>
                      <th className="text-left px-3 py-3 font-medium">{t.create.tableSim}</th>
                      <th className="px-3 py-3 font-medium">{t.create.tableAction}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayResults.map((r) => (
                      <tr key={r.product_id} className="border-b border-neutral-50 hover:bg-neutral-50">
                        <td className="px-5 py-3">
                          <p className="font-medium text-neutral-800">{r.name}</p>
                          <p className="text-xs text-neutral-400">{r.short_name}</p>
                        </td>
                        <td className="px-3 py-3 text-xs font-mono text-neutral-500">{r.vbn_number || "—"}</td>
                        <td className="px-3 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                            r.similarity >= 1.0 ? "bg-green-50 text-green-700"
                            : r.similarity >= 0.80 ? "bg-amber-50 text-amber-700"
                            : "bg-neutral-100 text-neutral-500"
                          }`}>
                            {Math.round(r.similarity * 100)}%
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <button
                            onClick={() => {
                              if (r.similarity >= 1.0) {
                                setShowDuplicateWarning({ templateId: r.product_id, templateName: r.name, templateColor: r.color ?? "" });
                              } else {
                                handleCreateFromTemplate(r.product_id, r.name, r.vbn_number, r.color ?? "");
                              }
                            }}
                            disabled={creating}
                            className="text-xs px-3 py-1.5 bg-petal hover:bg-petal-dark disabled:opacity-50 text-white rounded-lg transition-colors"
                          >
                            {t.create.useAsTemplate}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {hasMore && (
                  <div className="px-5 py-3 border-t border-neutral-100 text-center">
                    <button onClick={() => setShowAllResults(true)} className="text-xs text-violet-600 hover:text-violet-700 font-medium">
                      {t.create.showMore(allDisplayResults.length - 5)}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}

      {/* Confirmation form */}
      {pendingCreate && (
        <div className="mt-4 bg-white border-2 border-violet-300 rounded-xl p-5">
          <p className="text-sm font-semibold text-neutral-800 mb-1">{t.create.confirmTitle}</p>
          <p className="text-xs text-neutral-500 mb-3">
            {t.create.templateLabel} <span className="font-medium text-neutral-700">{pendingCreate.templateName}</span>
            <span className="ml-2 text-neutral-400">(ID: {pendingCreate.templateId})</span>
          </p>
          <div className="flex flex-col gap-3">
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-neutral-400 mb-1">{t.create.nameLabel}</label>
                <input
                  type="text"
                  value={finalName}
                  onChange={(e) => {
                    const newName = e.target.value;
                    setFinalName(newName);
                    setNumberCheckResult(null);
                    if (nameChangeDebounce.current) clearTimeout(nameChangeDebounce.current);
                    nameChangeDebounce.current = setTimeout(() => {
                      const trimmed = newName.trim();
                      const sim = wordJaccard(initialFormName.current, trimmed);
                      if (sim < 0.60) {
                        const newBase = genProductNumber(trimmed);
                        setProductNumber(newBase);
                        setNumberChecking(true);
                        fetch(`${RAILWAY}/product-number-suggest?number=${encodeURIComponent(newBase)}&name=${encodeURIComponent(trimmed)}`)
                          .then((r) => r.json())
                          .then((data: { available_number: string | null; original_number: string; changed: boolean }) => {
                            if (data.available_number) {
                              setProductNumber(data.available_number);
                              setNumberCheckResult({ changed: data.changed, original: data.original_number });
                            }
                          })
                          .catch(() => {})
                          .finally(() => setNumberChecking(false));
                      }
                      if (trimmed && RAILWAY && searchResults && searchResults.length > 0) {
                        setVbnForCreateChecking(true);
                        setVbnForCreateInfo(null);
                        fetch(`${RAILWAY}/product-ai-analyze`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ name: trimmed, candidates: searchResults.slice(0, 6), preferred_vbn: vbnForCreate || null }),
                        })
                          .then(r => r.json())
                          .then((data: AIAnalysis) => {
                            const code = data?.vbn?.code ?? null;
                            if (code) {
                              setVbnForCreate(code);
                              setVbnForCreateInfo(null);
                              fetch(`${RAILWAY}/vbn-name/${code}`)
                                .then(r => r.json())
                                .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
                                .catch(() => {})
                                .finally(() => setVbnForCreateChecking(false));
                            } else {
                              setVbnForCreate("");
                              setVbnForCreateInfo(null);
                              setVbnForCreateChecking(false);
                            }
                          })
                          .catch(() => setVbnForCreateChecking(false));
                      }
                    }, 1000);
                  }}
                  placeholder={t.create.finalNamePlaceholder}
                  className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-petal/30 focus:border-petal/60"
                  autoFocus
                />
                {nameFromTemplate && (
                  <NameCorrectionHint
                    hint={nameFromTemplate}
                    onRevert={() => { setFinalName(nameFromTemplate.original); setNameFromTemplate(null); }}
                    fromTemplateLabel={t.create.nameFromTemplate}
                    useOriginalLabel={t.create.useOriginal}
                  />
                )}
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1 flex items-center gap-1.5">
                  {t.create.numberLabel}
                  {numberChecking && (
                    <svg className="animate-spin h-3 w-3 text-violet-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {!numberChecking && numberCheckResult && !numberCheckResult.changed && (
                    <span className="text-green-600 text-xs">{t.create.numberFree}</span>
                  )}
                </label>
                <input
                  type="text"
                  value={productNumber}
                  onChange={(e) => { setProductNumber(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)); setNumberCheckResult(null); }}
                  placeholder={t.create.numberPlaceholder}
                  className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm w-36 font-mono uppercase focus:outline-none focus:ring-2 focus:ring-petal/30 focus:border-petal/60"
                />
              </div>
            </div>
            {numberCheckResult?.changed && (
              <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <span>⚠</span>
                <span>{t.create.numberTaken(numberCheckResult.original, productNumber)}</span>
              </div>
            )}

            <div className="flex gap-3">
              {/* VBN input */}
              <div className="flex-1">
                <label className="block text-xs text-neutral-400 mb-1 flex items-center gap-1.5">
                  {t.create.vbnLabel}
                  {vbnForCreateChecking && (
                    <svg className="animate-spin h-3 w-3 text-violet-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {!vbnForCreateChecking && vbnForCreateInfo && (
                    <span className={vbnForCreateInfo.found ? "text-green-600" : "text-red-500"}>
                      {vbnForCreateInfo.found ? "✓" : "✗"}
                    </span>
                  )}
                </label>
                <input
                  type="text"
                  value={vbnForCreate}
                  onChange={(e) => {
                    const code = e.target.value.replace(/\D/g, "").slice(0, 6);
                    setVbnForCreate(code);
                    setVbnForCreateInfo(null);
                    if (vbnForCreateDebounce.current) clearTimeout(vbnForCreateDebounce.current);
                    if (code.length >= 3 && RAILWAY) {
                      vbnForCreateDebounce.current = setTimeout(() => {
                        setVbnForCreateChecking(true);
                        fetch(`${RAILWAY}/vbn-name/${code}`)
                          .then(r => r.json())
                          .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
                          .catch(() => {})
                          .finally(() => setVbnForCreateChecking(false));
                      }, 500);
                    }
                  }}
                  placeholder={t.create.vbnPlaceholder}
                  className="border border-neutral-200 rounded-lg px-3 py-2.5 text-sm w-full font-mono focus:outline-none focus:ring-2 focus:ring-petal/30 focus:border-petal/60"
                />
                {!vbnForCreateChecking && vbnForCreateInfo && (
                  <p className={`text-xs mt-0.5 truncate ${vbnForCreateInfo.found ? "text-green-600" : "text-red-500"}`}>
                    {vbnForCreateInfo.found ? vbnForCreateInfo.name : t.create.vbnNotFound}
                  </p>
                )}
              </div>

              {/* Color dropdown */}
              <div className="flex-1" ref={colorDropdownRef}>
                <label className="block text-xs text-neutral-400 mb-1 flex items-center gap-1.5">
                  {t.create.colorLabel}
                  {colorListLoading && (
                    <svg className="animate-spin h-3 w-3 text-violet-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {colorForCreate && (
                    <button onClick={() => { setColorForCreate(""); setColorSearch(""); setTemplateColorName(""); }} className="text-neutral-300 hover:text-neutral-500 text-xs">✕</button>
                  )}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={colorSearch !== "" ? colorSearch : (colorList.find(c => c.id === colorForCreate)?.name ?? "")}
                    onChange={(e) => { setColorSearch(e.target.value); setColorDropdownOpen(true); }}
                    onFocus={() => { setColorSearch(""); setColorDropdownOpen(true); }}
                    placeholder={colorListLoading ? t.create.colorLoading : colorForCreate ? "" : t.create.colorPlaceholder}
                    disabled={colorListLoading}
                    className="border border-neutral-200 rounded-lg px-3 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-petal/30 focus:border-petal/60 disabled:bg-neutral-50"
                  />
                  {colorLoadError && (
                    <div className="flex flex-col gap-0.5 mt-0.5">
                      <p className="text-xs text-red-500 break-all">{colorLoadError}</p>
                      <div className="flex gap-2">
                        <button onClick={() => loadColors(false)} className="text-xs text-violet-600 hover:underline">{t.common.retry}</button>
                        <button onClick={() => loadColors(true)} className="text-xs text-amber-600 hover:underline">{t.common.forceRefresh}</button>
                      </div>
                    </div>
                  )}
                  {!colorListLoading && !colorLoadError && colorList.length === 0 && (
                    <button onClick={() => loadColors()} className="text-xs text-violet-500 hover:underline mt-0.5">{t.common.loadColors}</button>
                  )}
                  {colorDropdownOpen && !colorListLoading && (
                    <div className="absolute z-30 left-0 right-0 mt-1 max-h-52 overflow-y-auto bg-white border border-neutral-200 rounded-xl shadow-xl">
                      <button
                        onMouseDown={(e) => { e.preventDefault(); setColorForCreate(""); setColorSearch(""); setColorDropdownOpen(false); setTemplateColorName(""); }}
                        className="w-full text-left px-3 py-2 text-xs text-neutral-400 hover:bg-neutral-50 border-b border-neutral-100"
                      >
                        — {t.create.colorNone}
                      </button>
                      {colorList
                        .filter(c => !colorSearch || c.name.toLowerCase().includes(colorSearch.toLowerCase()))
                        .slice(0, 80)
                        .map(c => (
                          <button
                            key={c.id}
                            onMouseDown={(e) => { e.preventDefault(); setColorForCreate(c.id); setColorSearch(""); setColorDropdownOpen(false); }}
                            className={`w-full text-left px-3 py-2 text-xs hover:bg-violet-50 flex justify-between items-center ${colorForCreate === c.id ? "bg-violet-50 text-violet-700 font-medium" : "text-neutral-700"}`}
                          >
                            <span>{c.name}</span>
                            <span className="text-neutral-300 font-mono text-xs ml-2">{c.id}</span>
                          </button>
                        ))
                      }
                      {colorList.filter(c => !colorSearch || c.name.toLowerCase().includes(colorSearch.toLowerCase())).length === 0 && (
                        <p className="px-3 py-2 text-xs text-neutral-400 text-center">—</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => handleConfirmCreate()}
                disabled={creating || numberChecking || !finalName.trim() || !productNumber.trim()}
                className="bg-petal hover:bg-petal-dark disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
              >
                {creating ? t.create.creating : numberChecking ? t.create.checkingNumber : t.create.createBtn}
              </button>
              <button
                onClick={() => { setPendingCreate(null); setVbnForCreate(""); setVbnForCreateInfo(null); setColorForCreate(""); setColorSearch(""); setColorDropdownOpen(false); setNameFromTemplate(null); setTemplateColorName(""); }}
                className="border border-neutral-200 text-neutral-500 hover:bg-neutral-50 text-sm px-4 py-2.5 rounded-lg transition-colors"
              >
                {t.common.cancel}
              </button>
            </div>
            <p className="text-xs text-neutral-400">{t.create.numberHint}</p>
          </div>
        </div>
      )}

      {/* AI Analysis */}
      {searchResults !== null && (aiLoading || aiAnalysis) && (
        <div className="mt-4 bg-white border border-neutral-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-neutral-100 flex items-center gap-2">
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wide">{t.create.aiTitle}</span>
            {aiLoading && (
              <svg className="animate-spin h-3 w-3 text-violet-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
          </div>
          {aiLoading ? (
            <p className="px-5 py-4 text-sm text-neutral-400">{t.create.aiChecking}</p>
          ) : aiAnalysis && (
            <div className="p-5 flex flex-col gap-3">
              {aiAnalysis.duplicate.found && aiAnalysis.duplicate.product_id ? (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                  <p className="text-sm font-semibold text-amber-800">{t.create.aiDuplicate}</p>
                  <p className="text-sm text-amber-700 mt-0.5">
                    {t.create.aiDuplicateAs}{" "}
                    <strong>{aiAnalysis.duplicate.product_name}</strong>
                    {aiAnalysis.duplicate.confidence && (
                      <span className="ml-2 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100">
                        {t.create.confidence} {aiAnalysis.duplicate.confidence}
                      </span>
                    )}
                  </p>
                  {aiAnalysis.duplicate.reason && <p className="text-xs text-amber-600 mt-1">{aiAnalysis.duplicate.reason}</p>}
                  <button
                    onClick={() => handleCreateFromTemplate(aiAnalysis!.duplicate.product_id!, aiAnalysis!.duplicate.product_name ?? "")}
                    disabled={creating}
                    className="mt-2 text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {t.create.useAsTemplate}
                  </button>
                </div>
              ) : (
                <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                  <p className="text-sm text-green-700">{t.create.aiNoDuplicate}</p>
                </div>
              )}
              {aiAnalysis.vbn.code && (
                <div className="bg-violet-50 border border-violet-200 rounded-lg px-4 py-3">
                  <p className="text-xs font-medium text-violet-500 uppercase tracking-wide mb-1">{t.create.aiVbnTitle}</p>
                  <p className="text-sm font-semibold text-violet-800">
                    <span className="font-mono">{aiAnalysis.vbn.code}</span>
                    {aiAnalysis.vbn.name && <span className="font-normal"> — {aiAnalysis.vbn.name}</span>}
                    {aiAnalysis.vbn.confidence && (
                      <span className="ml-2 text-xs font-medium px-1.5 py-0.5 rounded bg-violet-100 text-violet-600">
                        {aiAnalysis.vbn.confidence}
                      </span>
                    )}
                  </p>
                  {aiAnalysis.vbn.explanation && <p className="text-xs text-violet-600 mt-1">{aiAnalysis.vbn.explanation}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Duplicate warning modal — step 1 */}
      {showDuplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0 text-2xl">⚠️</div>
              <div>
                <p className="text-lg font-semibold text-neutral-900">{t.create.dupWarn1Title}</p>
                <p className="text-sm text-neutral-600 mt-1">{t.create.dupWarn1Text(showDuplicateWarning.templateName)}</p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowDuplicateWarning(null)} className="px-4 py-2 text-sm border border-neutral-200 rounded-lg text-neutral-600 hover:bg-neutral-50 transition-colors">
                {t.common.cancel}
              </button>
              <button
                onClick={() => {
                  handleCreateFromTemplate(showDuplicateWarning.templateId, showDuplicateWarning.templateName, "", showDuplicateWarning.templateColor ?? "");
                  setSelectedTemplateWas100Pct(true);
                  setShowDuplicateWarning(null);
                }}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                {t.create.dupWarn1Confirm}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate warning modal — step 2 */}
      {showSecondDuplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0 text-2xl">⚠️</div>
              <div>
                <p className="text-lg font-semibold text-neutral-900">{t.create.dupWarn2Title}</p>
                <p className="text-sm text-neutral-600 mt-1">{t.create.dupWarn2Text(finalName)}</p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowSecondDuplicateWarning(false)} className="px-4 py-2 text-sm border border-neutral-200 rounded-lg text-neutral-600 hover:bg-neutral-50 transition-colors">
                {t.create.dupWarn2Cancel}
              </button>
              <button onClick={() => handleConfirmCreate(true)} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors">
                {t.create.dupWarn2Confirm}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
