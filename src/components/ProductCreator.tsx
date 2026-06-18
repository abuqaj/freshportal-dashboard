"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { flushSync } from "react-dom";
import { translations, Lang } from "@/lib/i18n";
import { ProductSearchResult, AIAnalysis, SyncStatus } from "@/lib/types";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface Props {
  lang: Lang;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (j === 0 ? i : 0))
  );
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

// Returns true only when two words differ by ≤2 character edits AND those edits
// are ≤40% of the longer word — i.e. a plausible typo, not a different word.
function isTypo(w1: string, w2: string): boolean {
  const a = w1.toLowerCase(), b = w2.toLowerCase();
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);
  return dist <= 2 && dist <= maxLen * 0.4;
}

function lcsWordDiff(
  origWords: string[],
  corrWords: string[],
): Array<{ type: "same" | "deleted" | "inserted"; word: string }> {
  const m = origWords.length, n = corrWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = origWords[i - 1].toLowerCase() === corrWords[j - 1].toLowerCase()
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const result: Array<{ type: "same" | "deleted" | "inserted"; word: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origWords[i - 1].toLowerCase() === corrWords[j - 1].toLowerCase()) {
      result.unshift({ type: "same", word: corrWords[j - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "inserted", word: corrWords[j - 1] }); j--;
    } else {
      result.unshift({ type: "deleted", word: origWords[i - 1] }); i--;
    }
  }
  return result;
}

function NameCorrectionHint({ hint, onRevert, fromTemplateLabel, useOriginalLabel }: {
  hint: { original: string; corrected: string };
  onRevert: () => void;
  fromTemplateLabel: string;
  useOriginalLabel: string;
}) {
  const origWords = hint.original.trim().split(/\s+/);
  const corrWords = hint.corrected.trim().split(/\s+/);
  const diff = lcsWordDiff(origWords, corrWords);
  if (!diff.some(d => d.type !== "same")) return null;
  return (
    <div className="mt-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5 space-y-1.5">
      <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide">{fromTemplateLabel}</p>
      <div className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-sm leading-snug">
        {diff.map((token, i) =>
          token.type === "same" ? (
            <span key={i} className="text-ink-3">{token.word}</span>
          ) : token.type === "deleted" ? (
            <span key={i} className="text-amber-700 line-through opacity-80">{token.word}</span>
          ) : (
            <span key={i} className="text-emerald font-semibold bg-emerald/10 px-0.5 rounded">{token.word}</span>
          )
        )}
      </div>
      <button type="button" onClick={onRevert} className="text-xs text-amber-700 hover:text-amber-900 underline transition-colors">
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
  const abortRef = useRef<AbortController | null>(null);

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

  function toTitleCase(s: string): string {
    return s.trim().replace(/\b\w/g, c => c.toUpperCase());
  }

  function genProductNumber(name: string): string {
    const words = name.replace(/[^A-Za-z0-9\s]/g, "").toUpperCase().split(/\s+/).filter(Boolean);
    return words.map(w => w.slice(0, 2)).join("").slice(0, 8) || "PROD";
  }

  async function handleProductSearch() {
    if (!createInput.trim() || !RAILWAY) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
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
        signal: ctrl.signal,
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
      if (!(e instanceof Error && e.name === "AbortError")) {
        setSearchError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSearching(false);
      setSearchStatus(null);
    }
  }

  const handleCreateFromTemplate = useCallback((templateId: string, templateName: string, templateVbn = "", templateColor = "") => {
    const name = toTitleCase(createInput);
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
    let showCorrection = false;
    if (!namesMatch) {
      // Show the correction hint only when every changed word is a plausible typo.
      // If the user typed "Britney" and the template has "Miley", those are different
      // variety names — don't overwrite with the template word.
      const origWords = name.trim().split(/\s+/);
      const corrWords = templateName.trim().split(/\s+/);
      const diff = lcsWordDiff(origWords, corrWords);
      const deleted = diff.filter(d => d.type === "deleted").map(d => d.word);
      const inserted = diff.filter(d => d.type === "inserted").map(d => d.word);
      showCorrection = deleted.length === inserted.length &&
        deleted.every((w, i) => isTypo(w, inserted[i]));
    }
    setFinalName(showCorrection ? templateName : name);
    setNameFromTemplate(showCorrection ? { original: name, corrected: templateName } : null);
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
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    flushSync(() => { setCreating(true); setCreateStatus(t.create.creating); setCreateResult(null); setPendingCreate(null); setColorDropdownOpen(false); });
    try {
      const res = await fetch(`${RAILWAY}/product-create/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: templateId, new_name: nameForLog, product_number: numberForLog || null, lang, vbn_code: vbnForCreate || null, color_id: colorForCreate || null }),
        signal: ctrl.signal,
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
            // Log regardless of ok/fail — if ok=false, we still want a record
            fetch("/api/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "product_create",
                vbn_filter: null,
                stats: { ok: d.ok ? 1 : 0 },
                details: { name: nameForLog, product_number: numberForLog, template_id: templateId, template_name: templateName, success: d.ok },
              }),
            }).catch(() => {});
          } else if (event.type === "error") throw new Error(event.message as string);
        }
      }
    } catch (e: unknown) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        setCreateResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setCreating(false);
      setCreateStatus(null);
    }
  }

  // Derived step from existing state
  const step = creating ? "creating"
    : createResult !== null ? "done"
    : pendingCreate !== null ? "confirm"
    : searching ? "loading"
    : searchResults !== null ? "results"
    : "search";

  function resetToSearch() {
    setSearchResults(null);
    setAiAnalysis(null);
    setAiLoading(false);
    setSearchError(null);
    setSearchStatus(null);
  }

  function resetAll() {
    setCreateResult(null);
    setSearchResults(null);
    setAiAnalysis(null);
    setAiLoading(false);
    setPendingCreate(null);
    setCreateInput("");
    setSearchError(null);
    setVbnForCreate("");
    setVbnForCreateInfo(null);
    setColorForCreate("");
    setColorSearch("");
    setColorDropdownOpen(false);
    setNameFromTemplate(null);
    setTemplateColorName("");
  }

  const highMatches = searchResults ? searchResults.filter(r => r.similarity >= 0.80).slice(0, 10) : [];
  const isFallback = highMatches.length === 0 && (searchResults?.length ?? 0) > 0;
  const allDisplayResults = isFallback ? (searchResults ?? []).slice(0, 1) : highMatches;
  const displayResults = showAllResults ? allDisplayResults : allDisplayResults.slice(0, 6);

  const SpinnerSm = () => (
    <svg className="animate-spin h-3.5 w-3.5 text-emerald flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  );

  const AiPanel = () => (
    <div className="w-64 flex-shrink-0 p-5 bg-ground space-y-3 overflow-y-auto min-h-0">
      <p className="text-[11px] font-semibold text-ink-3 uppercase tracking-widest">{t.create.aiTitle}</p>
      {aiLoading ? (
        <div className="flex items-center gap-2 text-xs text-ink-3"><SpinnerSm /><span>{t.create.aiChecking}</span></div>
      ) : aiAnalysis ? (
        <>
          {aiAnalysis.duplicate.found && aiAnalysis.duplicate.product_id ? (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1">
              <p className="text-xs font-semibold text-amber-800">{t.create.aiDuplicate}</p>
              <p className="text-xs text-amber-700">{t.create.aiDuplicateAs} <strong>{aiAnalysis.duplicate.product_name}</strong></p>
              {aiAnalysis.duplicate.confidence && <p className="text-[11px] text-amber-600">{t.create.confidence} {aiAnalysis.duplicate.confidence}</p>}
              {aiAnalysis.duplicate.reason && <p className="text-[11px] text-amber-600">{aiAnalysis.duplicate.reason}</p>}
              <button
                onClick={() => handleCreateFromTemplate(aiAnalysis!.duplicate.product_id!, aiAnalysis!.duplicate.product_name ?? "")}
                className="mt-1 text-[11px] px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors"
              >{t.create.useAsTemplate}</button>
            </div>
          ) : (
            <div className="bg-emerald-light border border-emerald/30 rounded-xl p-3">
              <p className="text-xs text-emerald">{t.create.aiNoDuplicate}</p>
            </div>
          )}
          {aiAnalysis.vbn.code && (
            <div className="bg-surface border border-border rounded-xl p-3 space-y-0.5">
              <p className="text-[11px] font-medium text-ink-3 uppercase tracking-wide">{t.create.aiVbnTitle}</p>
              <p className="text-sm font-bold text-emerald font-mono">{aiAnalysis.vbn.code}</p>
              {aiAnalysis.vbn.name && <p className="text-xs text-ink-3">{aiAnalysis.vbn.name}</p>}
              {aiAnalysis.vbn.confidence && <p className="text-[11px] text-emerald">{t.create.confidence} {aiAnalysis.vbn.confidence}</p>}
              {aiAnalysis.vbn.explanation && <p className="text-[11px] text-ink-3 mt-1">{aiAnalysis.vbn.explanation}</p>}
            </div>
          )}
        </>
      ) : null}
    </div>
  );

  const BackChevron = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  return (
    <div>
      {/* Duplicate warning modal — step 1 */}
      {showDuplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-10 h-10 rounded-full bg-ember-light flex items-center justify-center flex-shrink-0 text-ember text-lg font-bold border border-ember/30">!</div>
              <div>
                <p className="text-base font-semibold text-ink">{t.create.dupWarn1Title}</p>
                <p className="text-sm text-ink-3 mt-1">{t.create.dupWarn1Text(showDuplicateWarning.templateName)}</p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowDuplicateWarning(null)} className="px-4 py-2 text-sm border border-border rounded-xl text-ink-3 hover:bg-ground transition-colors">{t.common.cancel}</button>
              <button
                onClick={() => { handleCreateFromTemplate(showDuplicateWarning.templateId, showDuplicateWarning.templateName, "", showDuplicateWarning.templateColor ?? ""); setSelectedTemplateWas100Pct(true); setShowDuplicateWarning(null); }}
                className="px-4 py-2 text-sm bg-ember hover:bg-ember-dark text-white rounded-xl font-medium transition-colors"
              >{t.create.dupWarn1Confirm}</button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate warning modal — step 2 */}
      {showSecondDuplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-10 h-10 rounded-full bg-ember-light flex items-center justify-center flex-shrink-0 text-ember text-lg font-bold border border-ember/30">!</div>
              <div>
                <p className="text-base font-semibold text-ink">{t.create.dupWarn2Title}</p>
                <p className="text-sm text-ink-3 mt-1">{t.create.dupWarn2Text(finalName)}</p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowSecondDuplicateWarning(false)} className="px-4 py-2 text-sm border border-border rounded-xl text-ink-3 hover:bg-ground transition-colors">{t.create.dupWarn2Cancel}</button>
              <button onClick={() => handleConfirmCreate(true)} className="px-4 py-2 text-sm bg-ember hover:bg-ember-dark text-white rounded-xl font-medium transition-colors">{t.create.dupWarn2Confirm}</button>
            </div>
          </div>
        </div>
      )}

      {/* Step container — key triggers card-enter re-animation on step change */}
      <div key={step} className="card-enter">

        {/* ── STEP 1: SEARCH ── */}
        {step === "search" && (
          <div className="p-10 flex flex-col items-center gap-8 min-h-72">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-ink tracking-tight">{t.nav.newProducts}</h2>
              <p className="text-sm text-ink-3 mt-2 max-w-md">{t.create.description}</p>
            </div>
            <div className="w-full max-w-md">
              <div className="flex gap-2.5">
                <input
                  type="text"
                  value={createInput}
                  onChange={(e) => setCreateInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleProductSearch()}
                  placeholder={t.create.namePlaceholder}
                  className="flex-1 border border-border rounded-xl px-4 py-3 text-sm bg-ground focus:outline-none focus:ring-2 focus:ring-emerald/30 focus:border-emerald/60 focus:bg-surface transition-colors"
                  autoFocus
                />
                <button
                  onClick={handleProductSearch}
                  disabled={!createInput.trim()}
                  className="bg-ember hover:bg-ember-dark disabled:opacity-40 text-white text-sm font-semibold px-5 py-3 rounded-xl transition-colors"
                >{t.create.searchBtn}</button>
              </div>
              {searchError && <p className="mt-3 text-sm text-ember bg-ember-light border border-ember/30 rounded-xl px-4 py-3">⚠ {searchError}</p>}
            </div>
            {syncStatus?.running && (
              <div className="flex items-center gap-2 text-xs text-emerald">
                <SpinnerSm /><span>{t.create.syncRunning}</span>
              </div>
            )}
          </div>
        )}

        {/* ── STEP 2: LOADING ── */}
        {step === "loading" && (
          <div className="p-12 flex flex-col items-center justify-center gap-6 min-h-72 text-center">
            <svg className="animate-spin w-14 h-14 text-emerald" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-15" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5"/>
              <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <div>
              <p className="text-xs text-ink-3 uppercase tracking-widest mb-2">{t.create.searching}</p>
              <p className="text-xl font-bold text-ink">&ldquo;{createInput}&rdquo;</p>
            </div>
            {searchStatus && (
              <p className="text-xs text-ink-3 animate-pulse border-t border-border pt-4 w-full max-w-xs">{searchStatus}</p>
            )}
            <button
              onClick={() => { abortRef.current?.abort(); abortRef.current = null; }}
              className="text-xs text-ink-3 hover:text-ember border border-border hover:border-ember/20 rounded-lg px-4 py-1.5 bg-ground hover:bg-ember-light/50 transition-colors"
            >{t.common.cancel}</button>
          </div>
        )}

        {/* ── STEP 3: RESULTS ── */}
        {step === "results" && searchResults !== null && (
          <div className="flex flex-col">
            <div className="px-6 py-4 border-b border-border flex-shrink-0">
              <h2 className="font-semibold text-ink">{t.create.similarTitle}</h2>
              <p className="text-xs text-ink-3 mt-0.5">
                &ldquo;{createInput}&rdquo;
                {highMatches.length > 0 && <span className="ml-2 bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[11px] font-medium">{t.create.resultsCount(highMatches.length)}</span>}
              </p>
            </div>
            <div className="p-4 space-y-2 overflow-y-auto">
              {searchResults.length === 0 ? (
                <div className="py-10 text-center text-sm text-ink-3">
                  <p className="font-medium">{t.create.noResults}</p>
                  <p className="text-xs mt-1 opacity-60">{t.create.noResultsHint}</p>
                  <button onClick={resetToSearch} className="mt-4 text-xs text-ink-3 hover:text-ink underline">{t.create.backToSearch}</button>
                </div>
              ) : (
                <>
                  {highMatches.length > 0 && <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700">{t.create.warning}</div>}
                  {isFallback && <div className="px-3 py-2 bg-muted border border-border rounded-xl text-xs text-ink-3">{t.create.fallback}</div>}
                  {displayResults.map((r) => (
                    <button
                      key={r.product_id}
                      onClick={() => {
                        if (r.similarity >= 1.0) {
                          setShowDuplicateWarning({ templateId: r.product_id, templateName: r.name, templateColor: r.color ?? "" });
                        } else {
                          handleCreateFromTemplate(r.product_id, r.name, r.vbn_number, r.color ?? "");
                        }
                      }}
                      className={`w-full text-left px-4 py-3 rounded-xl border transition-all hover:shadow-sm group ${r.similarity >= 1.0 ? "border-ember/40 bg-ember-light/30 hover:bg-ember-light/50" : r.similarity >= 0.80 ? "border-amber-200 bg-amber-50/60 hover:bg-amber-50" : "border-border bg-surface hover:bg-ground"}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-sm text-ink truncate">{r.name}</p>
                          {r.short_name && <p className="text-xs text-ink-3 truncate mt-0.5">{r.short_name}</p>}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {r.vbn_number && <span className="text-[11px] font-mono text-ink-3">{r.vbn_number}</span>}
                          <span className={`text-[11px] px-2 py-0.5 rounded-md font-bold ${r.similarity >= 1.0 ? "bg-ember text-white" : r.similarity >= 0.80 ? "bg-amber-500 text-white" : "bg-ink/10 text-ink-3"}`}>
                            {Math.round(r.similarity * 100)}%
                          </span>
                          <span className={`text-xs font-semibold px-3 py-1 rounded-lg border transition-colors whitespace-nowrap ${r.similarity >= 1.0 ? "bg-ember-light text-ember border-ember/30 group-hover:bg-ember group-hover:text-white" : "bg-emerald-light text-emerald border-emerald/30 group-hover:bg-emerald group-hover:text-white"}`}>
                            {t.create.useAsTemplate}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                  {!showAllResults && allDisplayResults.length > 6 && (
                    <button onClick={() => setShowAllResults(true)} className="w-full text-xs text-emerald hover:text-emerald-dark font-medium py-2 text-center">
                      {t.create.showMore(allDisplayResults.length - 6)}
                    </button>
                  )}
                  <div className="pt-2 border-t border-border mt-2">
                    <button onClick={resetToSearch} className="text-xs text-ink-3 hover:text-ink transition-colors">
                      &#8592; {t.create.backToSearch}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── STEP 4: CONFIRM ── */}
        {step === "confirm" && pendingCreate && (
          <div className="flex flex-col">
            <div className="px-6 py-4 border-b border-border flex-shrink-0">
              <h2 className="font-semibold text-ink">{t.create.confirmTitle}</h2>
              <p className="text-xs text-ink-3 mt-0.5">
                {t.create.templateLabel} <span className="font-medium text-ink">{pendingCreate.templateName}</span>
                <span className="ml-1.5 opacity-40">#{pendingCreate.templateId}</span>
                <span className="mx-1.5 opacity-30">·</span>
                <button
                  onClick={() => { setPendingCreate(null); setVbnForCreate(""); setVbnForCreateInfo(null); setColorForCreate(""); setColorSearch(""); setColorDropdownOpen(false); setNameFromTemplate(null); setTemplateColorName(""); }}
                  className="text-emerald hover:text-emerald-dark hover:underline transition-colors"
                >&#8592; {t.create.backToResults}</button>
              </p>
            </div>
            <div className="flex divide-x divide-border max-h-[68vh] min-h-0">
              {/* Form */}
              <div className="flex-1 p-6 space-y-4 overflow-y-auto min-h-0">
                {/* Name */}
                <div>
                  <label className="block text-xs font-medium text-ink-3 mb-1.5">{t.create.nameLabel}</label>
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
                              if (data.available_number) { setProductNumber(data.available_number); setNumberCheckResult({ changed: data.changed, original: data.original_number }); }
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
                                setVbnForCreate(""); setVbnForCreateInfo(null); setVbnForCreateChecking(false);
                              }
                            })
                            .catch(() => setVbnForCreateChecking(false));
                        }
                      }, 1000);
                    }}
                    placeholder={t.create.finalNamePlaceholder}
                    className={`w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 transition-colors ${nameFromTemplate ? "border-amber-300 bg-amber-50/40 focus:ring-amber-300/50 focus:border-amber-400" : "border-border bg-ground focus:ring-emerald/30 focus:border-emerald/60 focus:bg-surface"}`}
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

                {/* Number */}
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-ink-3 mb-1.5">
                    {t.create.numberLabel}
                    {numberChecking && <SpinnerSm />}
                    {!numberChecking && numberCheckResult && !numberCheckResult.changed && <span className="text-emerald">{t.create.numberFree}</span>}
                  </label>
                  <input
                    type="text"
                    value={productNumber}
                    onChange={(e) => { setProductNumber(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)); setNumberCheckResult(null); }}
                    placeholder={t.create.numberPlaceholder}
                    className="w-full border border-border rounded-xl px-4 py-2.5 text-sm font-mono uppercase bg-ground focus:outline-none focus:ring-2 focus:ring-emerald/30 focus:border-emerald/60 focus:bg-surface transition-colors"
                  />
                  {numberCheckResult?.changed && (
                    <p className="mt-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">⚠ {t.create.numberTaken(numberCheckResult.original, productNumber)}</p>
                  )}
                  <p className="mt-1 text-[11px] text-ink-3/50">{t.create.numberHint}</p>
                </div>

                {/* VBN + Color */}
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-ink-3 mb-1.5">
                      {t.create.vbnLabel}
                      {vbnForCreateChecking && <SpinnerSm />}
                      {!vbnForCreateChecking && vbnForCreateInfo && (
                        <span className={vbnForCreateInfo.found ? "text-emerald" : "text-ember"}>{vbnForCreateInfo.found ? "✓" : "✗"}</span>
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
                      className="w-full border border-border rounded-xl px-3 py-2.5 text-sm font-mono bg-ground focus:outline-none focus:ring-2 focus:ring-emerald/30 focus:border-emerald/60 focus:bg-surface transition-colors"
                    />
                    {!vbnForCreateChecking && vbnForCreateInfo && (
                      <p className={`text-[11px] mt-1 truncate ${vbnForCreateInfo.found ? "text-emerald" : "text-ember"}`}>
                        {vbnForCreateInfo.found ? vbnForCreateInfo.name : t.create.vbnNotFound}
                      </p>
                    )}
                  </div>
                  <div className="flex-1" ref={colorDropdownRef}>
                    <label className="flex items-center gap-1.5 text-xs font-medium text-ink-3 mb-1.5">
                      {t.create.colorLabel}
                      {colorListLoading && <SpinnerSm />}
                      {colorForCreate && (
                        <button onClick={() => { setColorForCreate(""); setColorSearch(""); setTemplateColorName(""); }} className="text-ink-3/40 hover:text-ink-3 text-xs ml-auto">✕</button>
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
                        className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-ground focus:outline-none focus:ring-2 focus:ring-emerald/30 focus:border-emerald/60 focus:bg-surface transition-colors disabled:opacity-50"
                      />
                      {colorLoadError && (
                        <div className="mt-1 space-y-0.5">
                          <p className="text-[11px] text-ember break-all">{colorLoadError}</p>
                          <div className="flex gap-2">
                            <button onClick={() => loadColors(false)} className="text-[11px] text-emerald hover:underline">{t.common.retry}</button>
                            <button onClick={() => loadColors(true)} className="text-[11px] text-amber-600 hover:underline">{t.common.forceRefresh}</button>
                          </div>
                        </div>
                      )}
                      {colorDropdownOpen && !colorListLoading && (
                        <div className="absolute z-30 left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-surface border border-border rounded-xl shadow-xl">
                          <button
                            onMouseDown={(e) => { e.preventDefault(); setColorForCreate(""); setColorSearch(""); setColorDropdownOpen(false); setTemplateColorName(""); }}
                            className="w-full text-left px-3 py-2 text-xs text-ink-3 hover:bg-ground border-b border-border"
                          >— {t.create.colorNone}</button>
                          {colorList
                            .filter(c => !colorSearch || c.name.toLowerCase().includes(colorSearch.toLowerCase()))
                            .slice(0, 80)
                            .map(c => (
                              <button
                                key={c.id}
                                onMouseDown={(e) => { e.preventDefault(); setColorForCreate(c.id); setColorSearch(""); setColorDropdownOpen(false); }}
                                className={`w-full text-left px-3 py-2 text-xs hover:bg-emerald-light flex justify-between items-center ${colorForCreate === c.id ? "bg-emerald-light text-emerald font-medium" : "text-ink"}`}
                              >
                                <span>{c.name}</span>
                                <span className="text-ink-3 font-mono text-[10px] ml-2">{c.id}</span>
                              </button>
                            ))
                          }
                          {colorList.filter(c => !colorSearch || c.name.toLowerCase().includes(colorSearch.toLowerCase())).length === 0 && (
                            <p className="px-3 py-2 text-xs text-ink-3 text-center">—</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Create button */}
                <div className="pt-1">
                  <button
                    onClick={() => handleConfirmCreate()}
                    disabled={creating || numberChecking || !finalName.trim() || !productNumber.trim()}
                    className="w-full bg-emerald hover:bg-emerald-dark disabled:opacity-40 text-white text-sm font-semibold py-3 rounded-xl transition-colors"
                  >{numberChecking ? t.create.checkingNumber : t.create.createBtn}</button>
                </div>
              </div>

              {/* AI panel */}
              <AiPanel />
            </div>
          </div>
        )}

        {/* ── STEP 5: CREATING ── */}
        {step === "creating" && (
          <div className="p-12 flex flex-col items-center justify-center gap-6 min-h-72 text-center">
            <svg className="animate-spin w-14 h-14 text-emerald" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-15" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5"/>
              <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <div>
              <p className="text-xs text-ink-3 uppercase tracking-widest mb-2">{t.create.creating}</p>
              <p className="text-xl font-bold text-ink">&ldquo;{finalName}&rdquo;</p>
            </div>
            {createStatus && (
              <p className="text-xs text-ink-3 animate-pulse border-t border-border pt-4 w-full max-w-xs">{createStatus}</p>
            )}
            <button
              onClick={() => { abortRef.current?.abort(); abortRef.current = null; }}
              className="text-xs text-ink-3 hover:text-ember border border-border hover:border-ember/20 rounded-lg px-4 py-1.5 bg-ground hover:bg-ember-light/50 transition-colors"
            >{t.common.cancel}</button>
          </div>
        )}

        {/* ── STEP 6: DONE ── */}
        {step === "done" && createResult && (
          <div className="p-12 flex flex-col items-center justify-center gap-6 min-h-72 text-center">
            <div className={`w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold border-2 ${createResult.ok ? "bg-emerald-light text-emerald border-emerald/30" : "bg-ember-light text-ember border-ember/30"}`}>
              {createResult.ok ? "✓" : "✗"}
            </div>
            <div>
              <p className="text-lg font-bold text-ink">{createResult.message}</p>
              {createResult.ok && createResult.url && (
                <p className="text-xs text-ink-3 mt-1.5 font-mono break-all">{createResult.url}</p>
              )}
            </div>
            <button
              onClick={resetAll}
              className="px-6 py-2.5 bg-ink hover:bg-ink/80 text-white text-sm font-medium rounded-xl transition-colors"
            >{t.create.createAnother}</button>
          </div>
        )}

      </div>
    </div>
  );
}
