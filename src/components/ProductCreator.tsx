"use client";

import { useState, useCallback, useRef, useEffect, type ComponentType, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeft, Check, ChevronDown, CircleAlert, CircleHelp, Copy, Database, ExternalLink, Hash, ListChecks, Loader2, PackagePlus,
  Palette, Pencil, Plus, RefreshCw, RotateCcw, Search, SearchX, Sparkles, Store, Tag, TriangleAlert, Undo2, Wand2, X,
} from "lucide-react";
import { translations, Lang } from "@/lib/i18n";
import { ProductSearchResult, AIAnalysis, SyncStatus, CreateResult, CreateWarning } from "@/lib/types";
import { useSystem } from "@/contexts/SystemContext";
import { DEFAULT_SYSTEM } from "@/lib/systems";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import {
  Chip, Code, ConfirmDialog, DoneState, EmptyState, GoButton, IconButton, InfoTip, ModuleHeader, Panel, ProgressWait, RunnerWait, Section, Steps,
} from "@/components/ui/kit";
import { preloadMascot } from "@/components/MascotRunner";
import { cn } from "@/lib/utils";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";
// Product numbers are at most 7 characters (product_creator.NUMBER_MAX_LEN).
const NUMBER_MAX_LEN = 7;
// Results at or above this count as "this product may already exist"; below
// it they are templates to copy from. Mirrors product_creator.DUPLICATE_SCORE.
const DUPLICATE_SCORE = 0.80;

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
    <div className="mt-2 space-y-1.5 rounded-xl border border-taupe/40 bg-sand/45 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-3">
        <Wand2 className="size-3.5" />{fromTemplateLabel.replace(/^↑\s*/, "").replace(/\s*·\s*$/, "")}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-sm leading-snug">
        {diff.map((token, i) =>
          token.type === "same" ? (
            <span key={i} className="text-ink-3">{token.word}</span>
          ) : token.type === "deleted" ? (
            <span key={i} className="text-brick line-through opacity-80">{token.word}</span>
          ) : (
            <span key={i} className="rounded bg-sage/60 px-0.5 font-semibold text-emerald-dark">{token.word}</span>
          )
        )}
      </div>
      <button type="button" onClick={onRevert} className="inline-flex items-center gap-1 text-xs font-semibold text-ink-3 transition-colors hover:text-ink">
        <Undo2 className="size-3.5" />{useOriginalLabel}
      </button>
    </div>
  );
}

const LABEL = "mb-1.5 block text-xs font-semibold text-ink-3";
const INPUT = "h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3/50 disabled:opacity-50";

/** A field as the module kit draws one: an icon, the input, and a slot at the
 *  end for its state (checking, free, found). */
function FieldBox({ icon: Ico, tone, end, className, children }: {
  icon: ComponentType<{ className?: string }>; tone?: "warn" | "bad"; end?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <div className={cn(
      "flex h-11 items-center gap-2.5 rounded-[13px] border bg-ground px-3 transition-colors focus-within:bg-surface focus-within:ring-4",
      tone === "bad" ? "border-brick/45 focus-within:ring-brick/12"
        : tone === "warn" ? "border-taupe/60 bg-sand/40 focus-within:ring-taupe/20"
        : "border-border focus-within:border-emerald/55 focus-within:ring-emerald/12",
      className,
    )}>
      <Ico className="size-[17px] flex-none text-ink-3" />
      {children}
      {end && <span className="flex flex-none items-center">{end}</span>}
    </div>
  );
}

function SpinIcon({ className }: { className?: string }) {
  return <Loader2 className={cn(className, "animate-spin")} />;
}

/** A line under a field: what blocks (brick) or what changed (a warning). */
function Note({ tone = "bad", children }: { tone?: "bad" | "warn"; children: ReactNode }) {
  return (
    <p role={tone === "bad" ? "alert" : undefined}
      className={cn("mt-2 flex items-start gap-1.5 text-[12.5px] font-semibold", tone === "bad" ? "text-brick" : "text-ink-2")}>
      {tone === "bad"
        ? <CircleAlert className="mt-px size-[15px] flex-none" />
        : <TriangleAlert className="mt-px size-[15px] flex-none text-brick" />}
      <span>{children}</span>
    </p>
  );
}

export default function ProductCreator({ lang }: Props) {
  const t = translations[lang];
  // Every request this module makes carries the selected system, so say which
  // portal the products will land in whenever it isn't the usual one.
  const { system } = useSystem();
  const otherSystem = system.id !== DEFAULT_SYSTEM.id ? system : null;

  const [createInput, setCreateInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<ProductSearchResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);
  // A creation the backend refused before saving anything: the form reopens
  // with this shown, so the values the user entered are never lost.
  const [createBlock, setCreateBlock] = useState<CreateResult | null>(null);
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<AIAnalysis | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<{ templateId: string; templateName: string; templateGroup: string; templateApplication: string } | null>(null);
  const [finalName, setFinalName] = useState("");
  const [productNumber, setProductNumber] = useState("");
  const [numberChecking, setNumberChecking] = useState(false);
  const [numberCheckResult, setNumberCheckResult] = useState<{ changed: boolean; original: string } | null>(null);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState<{ templateId: string; templateName: string; templateColor?: string } | null>(null);
  const [templateColorName, setTemplateColorName] = useState("");
  // Set when the backend found the exact name already in FreshPortal — the
  // last confirmation before a duplicate is created on purpose.
  const [nameExists, setNameExists] = useState<CreateResult | null>(null);
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
  // Kept so a blocked or failed creation can reopen the form on the same template.
  const lastTemplate = useRef<{ templateId: string; templateName: string; templateGroup: string; templateApplication: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const aiCancelRef = useRef<{ ctrl: AbortController; token: string } | null>(null);

  function cancelAi() {
    if (!aiCancelRef.current) return;
    const { ctrl, token } = aiCancelRef.current;
    ctrl.abort();
    aiCancelRef.current = null;
    setAiLoading(false);
    if (RAILWAY) fetch(`${RAILWAY}/cancel/${token}`, { method: "POST" }).catch(() => {});
  }

  async function callAiAnalyze(body: Record<string, unknown>): Promise<AIAnalysis | null> {
    cancelAi();
    const token = crypto.randomUUID();
    const ctrl = new AbortController();
    aiCancelRef.current = { ctrl, token };
    try {
      const r = await fetch(`${RAILWAY}/product-ai-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, cancel_token: token }),
        signal: ctrl.signal,
      });
      return (await r.json()) as AIAnalysis;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return null;
      throw e;
    } finally {
      if (aiCancelRef.current?.token === token) aiCancelRef.current = null;
    }
  }

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

  // Saving cannot be stopped once it starts — closing the tab would leave the
  // browser session on the server finishing the product without anyone seeing
  // the result, so warn before the page goes away.
  useEffect(() => {
    if (!creating) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [creating]);

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

  function wordJaccard(a: string, b: string): number {
    const wordsA = a.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const wordsB = b.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (wordsA.length === 0 && wordsB.length === 0) return 1;
    const maxWords = Math.max(wordsA.length, wordsB.length);
    if (maxWords === 0) return 1;
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

  // How much of *query*'s words are covered by *candidate* — ignores extra
  // descriptive words in candidate (brand prefixes like "FT", pack-size
  // suffixes like "x20") that would otherwise dilute wordJaccard's symmetric
  // score even when every word the user typed matches perfectly.
  function queryCoverage(query: string, candidate: string): number {
    const wordsQ = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const wordsC = candidate.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (wordsQ.length === 0) return 0;
    const usedC = new Set<number>();
    let total = 0;
    for (const wQ of wordsQ) {
      let bestSim = 0, bestJ = -1;
      for (let j = 0; j < wordsC.length; j++) {
        if (usedC.has(j)) continue;
        const s = fuzzyWordSim(wQ, wordsC[j]);
        if (s > bestSim) { bestSim = s; bestJ = j; }
      }
      if (bestJ >= 0 && bestSim >= 0.80) { total += bestSim; usedC.add(bestJ); }
    }
    return total / wordsQ.length;
  }

  function toTitleCase(s: string): string {
    return s.trim().replace(/\b\w/g, c => c.toUpperCase());
  }

  function validateProductName(name: string): string | null {
    if (/\s{2,}/.test(name)) return t.create.nameErrDoubleSpace;
    if (/[^\p{L}\p{N}\s'-]/u.test(name)) return t.create.nameErrSpecialChars;
    return null;
  }

  // Two characters per word, at most 7 — the same rule the backend applies
  // when it has to find a free variant of this number.
  function genProductNumber(name: string): string {
    const words = name.replace(/[^A-Za-z0-9\s]/g, "").toUpperCase().split(/\s+/).filter(Boolean);
    return words.map(w => w.slice(0, 2)).join("").slice(0, NUMBER_MAX_LEN) || "PROD";
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
      setCreateBlock(null);
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
              callAiAnalyze({ name: createInput.trim(), candidates: results.slice(0, 6) })
                .then((data) => { if (data) setAiAnalysis(data); })
                .catch(() => {})
                .finally(() => setAiLoading(false));
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

  const handleCreateFromTemplate = useCallback((templateId: string, templateName: string, templateVbn = "", templateColor = "", templateGroup = "", templateApplication = "") => {
    const name = toTitleCase(createInput);
    const initialNumber = genProductNumber(name);
    initialFormName.current = name;
    const template = { templateId, templateName, templateGroup, templateApplication };
    lastTemplate.current = template;
    setPendingCreate(template);
    setCreateBlock(null);

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

    // If typed name is ≥70% similar to template name, the template VBN is likely correct.
    // Below 70% the user is creating a different product — let AI determine the right VBN.
    // Symmetric Jaccard alone under-scores cases like typing "Miniroses" against a template
    // named "FT Miniroses x20" — the brand prefix/pack-size suffix dilute the score even
    // though every word the user typed matches perfectly. queryCoverage catches that: full
    // coverage of the typed words is trusted even if the template has extra descriptive words.
    const nameSimilarity = wordJaccard(name, templateName);
    const coverage = queryCoverage(name, templateName);
    const useTemplateVbn = nameSimilarity >= 0.70 || coverage >= 0.99;

    setVbnForCreate(useTemplateVbn ? templateVbn : "");
    setVbnForCreateInfo(null);
    setVbnForCreateChecking(true);
    setAiAnalysis(null);
    setAiLoading(true);

    if (RAILWAY && searchResults && searchResults.length > 0) {
      const aiBody = useTemplateVbn && templateVbn
        ? { name, candidates: searchResults.slice(0, 6), preferred_vbn: templateVbn }
        : { name, candidates: searchResults.slice(0, 6) };

      callAiAnalyze(aiBody)
        .then((data: AIAnalysis | null) => {
          if (!data) { setVbnForCreateChecking(false); return; }
          setAiAnalysis(data);
          // When template VBN is trusted, keep it; otherwise apply AI's recommendation.
          const resolvedVbn = useTemplateVbn ? templateVbn : (data?.vbn?.code ?? "");
          setVbnForCreate(resolvedVbn);
          setVbnForCreateInfo(null);
          if (resolvedVbn && RAILWAY) {
            fetch(`${RAILWAY}/vbn-name/${resolvedVbn}`)
              .then(r => r.json())
              .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
              .catch(() => {})
              .finally(() => setVbnForCreateChecking(false));
          } else {
            setVbnForCreateChecking(false);
          }
        })
        .catch(() => {
          const fallback = useTemplateVbn ? templateVbn : "";
          if (fallback && RAILWAY) {
            fetch(`${RAILWAY}/vbn-name/${fallback}`)
              .then(r => r.json())
              .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
              .catch(() => {})
              .finally(() => setVbnForCreateChecking(false));
          } else {
            setVbnForCreateChecking(false);
          }
        })
        .finally(() => setAiLoading(false));
    } else if (useTemplateVbn && templateVbn && RAILWAY) {
      setAiLoading(false);
      fetch(`${RAILWAY}/vbn-name/${templateVbn}`)
        .then(r => r.json())
        .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
        .catch(() => {})
        .finally(() => setVbnForCreateChecking(false));
    } else {
      setAiLoading(false);
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

  /** A result for cases the backend never got to answer for. */
  function localResult(status: CreateResult["status"], reason: string, name: string, number: string): CreateResult {
    return {
      status, ok: false, name, product_number: number, product: null, product_url: null,
      search_url: null, warnings: [], reason, error_text: null, suggested_number: null, existing: [],
    };
  }

  async function handleConfirmCreate(allowDuplicateName = false) {
    if (!pendingCreate || !RAILWAY) return;
    const template = pendingCreate;
    const nameForLog = finalName.trim();
    const numberForLog = productNumber.trim().toUpperCase();
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setNameExists(null);
    setCreateBlock(null);
    flushSync(() => { setCreating(true); setCreateStatus(t.create.creating); setCreateResult(null); setPendingCreate(null); setColorDropdownOpen(false); });

    // Once the stream starts, the product may get created even if the answer
    // never arrives — so every path below ends in a result the user can see,
    // never in a silent return to the previous screen.
    let result: CreateResult | null = null;
    try {
      const res = await fetch(`${RAILWAY}/product-create/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: template.templateId,
          new_name: nameForLog,
          product_number: numberForLog || null,
          lang,
          vbn_code: vbnForCreate || null,
          color_id: colorForCreate || null,
          color_name: colorList.find(c => c.id === colorForCreate)?.name ?? null,
          allow_duplicate_name: allowDuplicateName,
        }),
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
          else if (event.type === "result") result = event.data as CreateResult;
          else if (event.type === "error") {
            // The backend itself never raises past copy_and_create, so we
            // cannot tell whether it saved — treat it as unconfirmed.
            result = { ...localResult("unconfirmed", "exception", nameForLog, numberForLog), error_text: String(event.message ?? "") };
          }
        }
      }
      // The stream ended without a result: the save may still have gone through.
      if (!result) result = localResult("unconfirmed", "connection_lost", nameForLog, numberForLog);
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === "AbortError";
      result = {
        ...localResult(aborted ? "unconfirmed" : "failed", aborted ? "connection_lost" : "exception", nameForLog, numberForLog),
        error_text: e instanceof Error ? e.message : String(e),
      };
    } finally {
      setCreating(false);
      setCreateStatus(null);
    }

    const outcome: CreateResult = result ?? localResult("unconfirmed", "connection_lost", nameForLog, numberForLog);

    if (outcome.status === "blocked") {
      // Nothing was saved: reopen the form with what the user entered.
      setPendingCreate(template);
      if (outcome.reason === "name_exists") {
        setNameExists(outcome);
      } else {
        if (outcome.reason === "number_taken" && outcome.suggested_number) {
          setProductNumber(outcome.suggested_number);
          setNumberCheckResult({ changed: true, original: outcome.product_number });
        }
        setCreateBlock(outcome);
      }
      return;
    }

    setCreateResult(outcome);
    // Logged whatever the outcome — an unconfirmed or failed attempt is
    // exactly what someone looking at the history later needs to see.
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "product_create",
        vbn_filter: null,
        stats: { ok: outcome.ok ? 1 : 0 },
        details: {
          name: nameForLog,
          product_number: outcome.product?.product_number || numberForLog,
          template_id: template.templateId,
          template_name: template.templateName,
          success: outcome.ok,
          status: outcome.status,
          reason: outcome.reason,
          product_id: outcome.product?.product_id ?? null,
          vbn_code: vbnForCreate || null,
          color: colorList.find(c => c.id === colorForCreate)?.name ?? null,
          warnings: outcome.warnings.map(w => w.code),
        },
      }),
    }).catch(() => {});
  }

  const nameValidationError = createInput ? validateProductName(createInput) : null;
  // The backend refuses the same things, so catch them before a round trip.
  const finalNameError = pendingCreate
    ? (finalName.trim() ? validateProductName(finalName.trim()) : t.create.nameErrEmpty)
    : null;

  /** Human text for a warning the backend reported about the saved product. */
  function warningText(w: CreateWarning): string {
    const expected = w.expected ?? "";
    const actual = w.actual ?? "";
    switch (w.code) {
      case "vbn_mismatch":         return t.create.warnVbnMismatch(expected, actual);
      case "vbn_field_missing":    return t.create.warnVbnFieldMissing(expected);
      case "vbn_not_set":          return t.create.warnVbnNotSet(expected);
      case "color_mismatch":       return t.create.warnColorMismatch(expected, actual);
      case "color_not_set":        return t.create.warnColorNotSet(expected);
      case "color_unverified":     return t.create.warnColorUnverified(expected);
      case "short_name_not_set":   return t.create.warnShortName;
      case "catalogue_copy_not_updated": return t.create.warnCopyNotUpdated;
      default:                     return w.code;
    }
  }

  /** Human text for why a creation was blocked, failed, or stayed unconfirmed. */
  function reasonText(r: CreateResult): string | null {
    switch (r.reason) {
      case "invalid_input":
        switch (r.error_text) {
          case "name_empty":        return t.create.nameErrEmpty;
          case "name_double_space": return t.create.nameErrDoubleSpace;
          case "name_chars":        return t.create.nameErrSpecialChars;
          case "number":            return t.create.errInvalidNumber;
          case "vbn":               return t.create.errInvalidVbn;
          case "template":          return t.create.errInvalidTemplate;
          case "color":             return t.create.errInvalidColor;
          default:                  return r.error_text;
        }
      case "number_taken":
        return r.suggested_number
          ? t.create.numberTakenNow(r.product_number)
          : t.create.numberTakenNoFree(r.product_number);
      case "busy":                 return t.create.blockedBusy;
      case "form_not_loaded":      return t.create.errFormNotLoaded;
      case "name_field_missing":   return t.create.errNameFieldMissing;
      case "number_not_set":       return t.create.errNumberNotSet;
      case "name_not_set":         return t.create.errNameNotSet;
      case "save_button_missing":  return t.create.errSaveButtonMissing;
      case "form_error":           return t.create.errFormError;
      case "exception":            return t.create.errException;
      case "connection_lost":      return t.create.errConnectionLost;
      case "not_found":            return t.create.errNotFound;
      case "name_differs":         return t.create.errNameDiffers;
      default:                     return null;
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
    setCreateBlock(null);
    setNameExists(null);
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
    lastTemplate.current = null;
  }

  /** Back to the filled-in form after a creation that saved nothing. */
  function backToForm() {
    if (!lastTemplate.current) return;
    setCreateResult(null);
    setCreateBlock(null);
    setPendingCreate(lastTemplate.current);
  }

  const highMatches = searchResults ? searchResults.filter(r => r.similarity >= DUPLICATE_SCORE).slice(0, 10) : [];
  const isFallback = highMatches.length === 0 && (searchResults?.length ?? 0) > 0;
  // Nothing close enough to be the same product, so these are templates to
  // copy from: show a handful to choose between, not just the closest one.
  const allDisplayResults = isFallback ? (searchResults ?? []).slice(0, 10) : highMatches;
  const displayResults = showAllResults ? allDisplayResults : allDisplayResults.slice(0, 6);

  const plain = (s: string) => s.replace(/^[✓⚠↑]\s*/, "");
  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";
  const colorMatches = colorList.filter(c => !colorSearch || c.name.toLowerCase().includes(colorSearch.toLowerCase()));
  const created = createResult?.status === "created" || createResult?.status === "created_with_warnings";
  const stepIndex = step === "search" ? 0
    : step === "loading" || step === "results" ? 1
    : step === "confirm" ? 2
    : step === "done" && created ? 4
    : 3;

  // The runner shows while FreshPortal is written; fetch him from the form on.
  preloadMascot();

  /** A result picked as the template; the same name asks first. */
  function pickTemplate(r: ProductSearchResult) {
    if (r.similarity >= 1.0) {
      setShowDuplicateWarning({ templateId: r.product_id, templateName: r.name, templateColor: r.color ?? "" });
    } else {
      handleCreateFromTemplate(r.product_id, r.name, r.vbn_number, r.color ?? "", r.product_group ?? "", r.application ?? "");
    }
  }

  function backToResults() {
    setPendingCreate(null); setVbnForCreate(""); setVbnForCreateInfo(null); setColorForCreate(""); setColorSearch("");
    setColorDropdownOpen(false); setNameFromTemplate(null); setTemplateColorName("");
  }

  // The facts the header carries: which portal, then what this step is about.
  const headerChips = (
    <>
      {otherSystem && (
        <Chip tone="info" tip={`${t.create.onSystem(otherSystem.name)} · ${otherSystem.url}`}>
          <span className={cn("size-2 rounded-full", otherSystem.accent)} />{otherSystem.name}
        </Chip>
      )}
      {step === "search" && syncStatus && (syncStatus.running
        ? <Chip tone="ok" icon={SpinIcon} tip={t.create.syncRunning}>{syncStatus.product_count.toLocaleString(localeStr)}</Chip>
        : syncStatus.product_count > 0 && (
          <Chip tone="mute" icon={Database} tip={t.create.syncProducts(syncStatus.product_count)}>{syncStatus.product_count.toLocaleString(localeStr)}</Chip>
        ))}
      {(step === "loading" || step === "results") && createInput.trim() && (
        <Chip tone="info" icon={Search} tip={t.create.similarTitle}><span className="max-w-[240px] truncate">“{createInput.trim()}”</span></Chip>
      )}
      {step === "results" && highMatches.length > 0 && (
        <Chip tone="warn" icon={TriangleAlert} tip={plain(t.create.warning)}>{highMatches.length} ≥80%</Chip>
      )}
      {step === "results" && isFallback && (
        <Chip tone="mute" icon={Copy} tip={t.create.fallback}>{allDisplayResults.length}</Chip>
      )}
      {step === "confirm" && pendingCreate && (
        <Chip tone="info" icon={Copy}
          tip={[t.create.templateLabel.replace(/:$/, ""), `#${pendingCreate.templateId}`, pendingCreate.templateGroup, pendingCreate.templateApplication].filter(Boolean).join(" · ")}>
          <span className="max-w-[260px] truncate">{pendingCreate.templateName}</span>
        </Chip>
      )}
    </>
  );
  const headerActions = step === "results" ? <IconButton icon={RotateCcw} tip={t.create.backToSearch} onClick={resetToSearch} />
    : step === "confirm" ? <IconButton icon={ArrowLeft} tip={t.create.backToResults} onClick={backToResults} />
    : null;

  return (
    <div>
      {/* A result with the very same name: ask before copying it */}
      {showDuplicateWarning && (
        <ConfirmDialog
          icon={Copy}
          title={t.create.dupWarn1Title}
          text={t.create.dupWarn1Text(showDuplicateWarning.templateName)}
          confirmLabel={t.create.dupWarn1Confirm}
          cancelLabel={t.common.cancel}
          onClose={() => setShowDuplicateWarning(null)}
          onConfirm={() => {
            handleCreateFromTemplate(showDuplicateWarning.templateId, showDuplicateWarning.templateName, "", showDuplicateWarning.templateColor ?? "");
            setShowDuplicateWarning(null);
          }}
        />
      )}

      {/* The name the backend found in FreshPortal: the last question before a duplicate */}
      {nameExists && (
        <ConfirmDialog
          title={t.create.nameExistsTitle}
          text={<>
            <p>{t.create.dupWarn2Text(nameExists.name)}</p>
            {nameExists.existing.length > 0 && (
              <div className="mt-3 space-y-1">
                <p className="text-[11px] font-semibold text-ink-3">{t.create.nameExistsText}</p>
                {nameExists.existing.map(p => (
                  <p key={p.product_id} className="flex min-w-0 items-center gap-1.5 text-xs text-ink">
                    <span className="truncate">{p.name}</span>
                    <Code>{p.product_number}</Code>
                    <span className="font-mono text-ink-3/60">#{p.product_id}</span>
                  </p>
                ))}
              </div>
            )}
          </>}
          confirmLabel={t.create.dupWarn2Confirm}
          cancelLabel={t.create.dupWarn2Cancel}
          onClose={() => setNameExists(null)}
          onConfirm={() => handleConfirmCreate(true)}
        />
      )}

      <ModuleHeader tab="create" t={t} info={t.create.description} chips={headerChips} actions={headerActions} />
      <Section tight>
        <Steps labels={[t.create.stepSearch, t.create.stepTemplate, t.create.stepDetails, t.create.stepDone]} current={stepIndex} />
      </Section>

      {/* "backwards", not "both": a kept transform would frame the module's fixed popups. */}
      <div key={step} className="step-enter">

        {/* ── Search ── */}
        {step === "search" && (
          <Section>
            <div className="mx-auto my-3 w-full max-w-[520px]">
              <label htmlFor="create-name" className={LABEL}>{t.create.nameLabel}</label>
              <div className="flex items-center gap-2.5">
                <FieldBox icon={PackagePlus} tone={nameValidationError ? "bad" : undefined} className="flex-1">
                  <input
                    id="create-name"
                    type="text"
                    value={createInput}
                    onChange={(e) => setCreateInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !nameValidationError && handleProductSearch()}
                    placeholder={t.create.namePlaceholder}
                    className={INPUT}
                    autoFocus
                  />
                </FieldBox>
                <GoButton icon={Search} tip={t.create.searchBtn} disabled={!createInput.trim() || !!nameValidationError} onClick={handleProductSearch} />
              </div>
              {nameValidationError ? <Note>{nameValidationError}</Note> : searchError && <Note>{searchError}</Note>}
            </div>
          </Section>
        )}

        {/* ── Searching ── */}
        {step === "loading" && (
          <Section>
            <ProgressWait status={searchStatus ?? t.create.searching}>
              <Button variant="outline" size="sm" onClick={() => { abortRef.current?.abort(); abortRef.current = null; cancelAi(); }}>
                <X className="size-3.5" />{t.common.cancel}
              </Button>
            </ProgressWait>
          </Section>
        )}

        {/* ── Templates ── */}
        {step === "results" && searchResults !== null && (
          <Section className="flex flex-col gap-3">
            {searchResults.length === 0 ? (
              <div className="flex flex-col items-center">
                <EmptyState icon={SearchX} text={t.create.noResults} hint={t.create.noResultsHint} />
                <Button variant="outline" onClick={resetToSearch}><RotateCcw className="size-4" />{t.create.backToSearch}</Button>
              </div>
            ) : (
              <>
                {/* The whole row picks the template; its copy icon is the
                    keyboard's way to the same click. */}
                <ul className="overflow-hidden rounded-2xl border border-border">
                  {displayResults.map((r) => {
                    const same = r.similarity >= 1.0;
                    const close = r.similarity >= DUPLICATE_SCORE;
                    return (
                      <li key={r.product_id} onClick={() => pickTemplate(r)}
                        className={cn("flex cursor-pointer items-center gap-3 border-b border-muted px-4 py-3 transition-colors last:border-0 hover:bg-ground/50",
                          same ? "shadow-[inset_3px_0_0_var(--color-brick)]" : close && "shadow-[inset_3px_0_0_var(--color-blush)]")}>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-semibold text-ink">{r.name}</p>
                          <p className="mt-0.5 truncate text-[11.5px] text-ink-3">
                            {[r.short_name, r.product_group, r.application].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        <div className="flex flex-none items-center gap-2">
                          {r.vbn_number && <Code tip={t.create.tableVbn}>{r.vbn_number}</Code>}
                          <Chip tone={same ? "bad" : close ? "warn" : "info"} tip={t.create.tableSim}>{Math.round(r.similarity * 100)}%</Chip>
                          <IconButton icon={Copy} tip={t.create.useAsTemplate} danger={same} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {!showAllResults && allDisplayResults.length > 6 && (
                  <Button variant="ghost" size="sm" className="self-center" onClick={() => setShowAllResults(true)}>
                    <ChevronDown className="size-3.5" />{t.create.showMore(allDisplayResults.length - 6)}
                  </Button>
                )}
              </>
            )}
          </Section>
        )}

        {/* ── Details ── */}
        {step === "confirm" && pendingCreate && (
          <Section>
            <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
              <div className="flex min-w-0 flex-col gap-3.5">
                {/* Why the last attempt saved nothing */}
                {createBlock && <Note>{reasonText(createBlock) ?? createBlock.reason}</Note>}

                {/* Name */}
                <div>
                  <label htmlFor="create-final-name" className={LABEL}>{t.create.nameLabel}</label>
                  <FieldBox icon={Tag} tone={finalNameError ? "bad" : nameFromTemplate ? "warn" : undefined}>
                    <input
                      id="create-final-name"
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
                            setAiLoading(true);
                            callAiAnalyze({ name: trimmed, candidates: searchResults.slice(0, 6) })
                              .then((data: AIAnalysis | null) => {
                                if (!data) { setVbnForCreateChecking(false); return; }
                                setAiAnalysis(data);
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
                              .catch(() => setVbnForCreateChecking(false))
                              .finally(() => setAiLoading(false));
                          }
                        }, 500);
                      }}
                      placeholder={t.create.finalNamePlaceholder}
                      className={INPUT}
                      autoFocus
                    />
                  </FieldBox>
                  {finalNameError && <Note>{finalNameError}</Note>}
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
                  <div className="mb-1.5 flex items-center gap-1">
                    <label htmlFor="create-number" className="text-xs font-semibold text-ink-3">{t.create.numberLabel}</label>
                    <InfoTip content={t.create.numberHint} />
                  </div>
                  <FieldBox icon={Hash} tone={numberCheckResult?.changed ? "warn" : undefined}
                    end={numberChecking ? <SpinIcon className="size-4 text-ink-3" />
                      : numberCheckResult && !numberCheckResult.changed ? <Chip tone="ok" icon={Check}>{plain(t.create.numberFree)}</Chip>
                      : null}>
                    <input
                      id="create-number"
                      type="text"
                      value={productNumber}
                      onChange={(e) => { setProductNumber(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, NUMBER_MAX_LEN)); setNumberCheckResult(null); }}
                      placeholder={t.create.numberPlaceholder}
                      className={cn(INPUT, "font-mono uppercase")}
                    />
                  </FieldBox>
                  {numberCheckResult?.changed && <Note tone="warn">{t.create.numberTaken(numberCheckResult.original, productNumber)}</Note>}
                </div>

                {/* VBN and colour */}
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <div>
                    <label htmlFor="create-vbn" className={LABEL}>{t.create.vbnLabel}</label>
                    <FieldBox icon={ListChecks} tone={!vbnForCreateChecking && vbnForCreateInfo && !vbnForCreateInfo.found ? "bad" : undefined}
                      end={vbnForCreateChecking ? <SpinIcon className="size-4 text-ink-3" />
                        : vbnForCreateInfo ? (vbnForCreateInfo.found
                          ? <Check className="size-4 text-emerald" strokeWidth={2.6} />
                          : <CircleAlert className="size-4 text-brick" />)
                        : null}>
                      <input
                        id="create-vbn"
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
                        className={cn(INPUT, "font-mono")}
                      />
                    </FieldBox>
                    {!vbnForCreateChecking && vbnForCreateInfo && (
                      <p className={cn("mt-1 truncate text-[11.5px]", vbnForCreateInfo.found ? "text-ink-3" : "font-semibold text-brick")}>
                        {vbnForCreateInfo.found ? vbnForCreateInfo.name : t.create.vbnNotFound}
                      </p>
                    )}
                  </div>
                  <div ref={colorDropdownRef}>
                    <label htmlFor="create-color" className={LABEL}>{t.create.colorLabel}</label>
                    <div>
                      <FieldBox icon={Palette}
                        end={colorListLoading ? <SpinIcon className="size-4 text-ink-3" />
                          : colorForCreate ? <IconButton size="sm" icon={X} tip={t.create.colorNone}
                              onClick={() => { setColorForCreate(""); setColorSearch(""); setTemplateColorName(""); }} />
                          : <ChevronDown className="size-4 text-ink-3" />}>
                        <input
                          id="create-color"
                          type="text"
                          role="combobox"
                          aria-expanded={colorDropdownOpen}
                          aria-controls="create-color-list"
                          value={colorSearch !== "" ? colorSearch : (colorList.find(c => c.id === colorForCreate)?.name ?? "")}
                          onChange={(e) => { setColorSearch(e.target.value); setColorDropdownOpen(true); }}
                          onFocus={() => { setColorSearch(""); setColorDropdownOpen(true); }}
                          placeholder={colorListLoading ? t.create.colorLoading : colorForCreate ? "" : t.create.colorPlaceholder}
                          disabled={colorListLoading}
                          className={INPUT}
                        />
                      </FieldBox>
                      {/* In the flow, not floating: the module card clips what sticks out of it. */}
                      {colorDropdownOpen && !colorListLoading && (
                        <div id="create-color-list" role="listbox"
                          className="mt-1 max-h-56 overflow-y-auto rounded-xl border border-border bg-surface shadow-[0_6px_18px_rgba(17,26,20,0.08)]">
                          <button type="button"
                            onMouseDown={(e) => { e.preventDefault(); setColorForCreate(""); setColorSearch(""); setColorDropdownOpen(false); setTemplateColorName(""); }}
                            className="w-full border-b border-muted px-3 py-2 text-left text-xs text-ink-3 hover:bg-ground">— {t.create.colorNone}</button>
                          {colorMatches.slice(0, 80).map(c => (
                            <button key={c.id} type="button" role="option" aria-selected={colorForCreate === c.id}
                              onMouseDown={(e) => { e.preventDefault(); setColorForCreate(c.id); setColorSearch(""); setColorDropdownOpen(false); }}
                              className={cn("flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-emerald-light",
                                colorForCreate === c.id ? "bg-emerald-light font-semibold text-emerald-dark" : "text-ink")}>
                              <span>{c.name}</span>
                              <span className="ml-2 font-mono text-[10px] text-ink-3">{c.id}</span>
                            </button>
                          ))}
                          {colorMatches.length === 0 && <p className="px-3 py-2 text-center text-xs text-ink-3">—</p>}
                        </div>
                      )}
                    </div>
                    {colorLoadError && (
                      <div className="mt-1 flex items-center gap-1">
                        <Tip content={colorLoadError}>
                          <p tabIndex={0} className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-brick">{colorLoadError}</p>
                        </Tip>
                        <IconButton size="sm" icon={RotateCcw} tip={t.common.retry} onClick={() => loadColors(false)} />
                        <IconButton size="sm" icon={RefreshCw} tip={t.common.forceRefresh} onClick={() => loadColors(true)} />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* What the AI makes of the name: a duplicate, and the VBN it would give */}
              <Panel title={t.create.aiTitle} icon={Sparkles} className="self-start bg-ground/60">
                {aiLoading ? (
                  <p className="flex items-center gap-2 text-xs"><SpinIcon className="size-3.5 flex-none text-ink-3" /><span className="shimmer-ink">{t.create.aiChecking}</span></p>
                ) : aiAnalysis ? (
                  <div className="space-y-3">
                    {aiAnalysis.duplicate.found && aiAnalysis.duplicate.product_id ? (
                      <div className="space-y-1.5 rounded-xl border border-blush bg-blush/20 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-bold text-brick"><TriangleAlert className="size-3.5" />{plain(t.create.aiDuplicate)}</p>
                        <p className="text-xs text-ink-2">{t.create.aiDuplicateAs} <b>{aiAnalysis.duplicate.product_name}</b></p>
                        {aiAnalysis.duplicate.confidence && <Chip tone="mute" tip={t.create.confidence.replace(/:$/, "")}>{aiAnalysis.duplicate.confidence}</Chip>}
                        {aiAnalysis.duplicate.reason && <p className="text-[11px] text-ink-3">{aiAnalysis.duplicate.reason}</p>}
                        <Button variant="outline" size="sm"
                          onClick={() => handleCreateFromTemplate(aiAnalysis.duplicate.product_id!, aiAnalysis.duplicate.product_name ?? "")}>
                          <Copy className="size-3.5" />{t.create.useAsTemplate}
                        </Button>
                      </div>
                    ) : (
                      <Chip tone="ok" icon={Check} tip={plain(t.create.aiNoDuplicate)}>{plain(t.create.aiNoDuplicate).split("—")[0].trim()}</Chip>
                    )}
                    {aiAnalysis.vbn.code && (
                      <div>
                        <p className="mb-1 text-[11px] font-semibold text-ink-3">{t.create.aiVbnTitle}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Code tone="ok">{aiAnalysis.vbn.code}</Code>
                          {aiAnalysis.vbn.name && <span className="text-[12.5px] text-ink">{aiAnalysis.vbn.name}</span>}
                          {aiAnalysis.vbn.confidence && <Chip tone="mute" tip={t.create.confidence.replace(/:$/, "")}>{aiAnalysis.vbn.confidence}</Chip>}
                        </div>
                        {aiAnalysis.vbn.explanation && <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">{aiAnalysis.vbn.explanation}</p>}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-ink-3/60">—</p>
                )}
              </Panel>
            </div>

            <div className="mt-4 flex justify-end">
              <GoButton icon={Check} tip={numberChecking ? t.create.checkingNumber : t.create.createBtn}
                disabled={creating || numberChecking || !!finalNameError || !productNumber.trim()}
                onClick={() => handleConfirmCreate()} />
            </div>
          </Section>
        )}

        {/* ── Creating ── no cancel: the save cannot be called back once it starts. */}
        {step === "creating" && (
          <Section>
            <RunnerWait title={t.create.creating} status={createStatus !== t.create.creating ? createStatus : null}>
              <Chip tone="info" icon={Tag}>{finalName}</Chip>
              <Chip tone="warn" icon={TriangleAlert} tip={t.create.keepOpen}>{t.create.keepOpenShort}</Chip>
            </RunnerWait>
          </Section>
        )}

        {/* ── Done ── */}
        {step === "done" && createResult && (
          <Section>
            <DoneState
              tone={createResult.status === "created" ? "ok" : createResult.status === "failed" ? "bad" : "warn"}
              icon={createResult.status === "unconfirmed" ? CircleHelp : undefined}
              title={createResult.status === "created" ? t.create.statusCreated
                : createResult.status === "created_with_warnings" ? t.create.statusCreatedWarnings
                : createResult.status === "unconfirmed" ? t.create.statusUnconfirmed
                : t.create.statusFailed}
              sub={<>
                <span className="text-ink">“{createResult.name}”</span>
                {createResult.product_number && <span className="ml-2 font-mono text-xs">{createResult.product_number}</span>}
                {createResult.status !== "created" && reasonText(createResult) && <span className="mt-1 block">{reasonText(createResult)}</span>}
                {createResult.status === "unconfirmed" && <span className="mt-1 block font-semibold text-brick">{t.create.unconfirmedHint}</span>}
                {createResult.status === "failed" && <span className="mt-1 block">{t.create.failedHint}</span>}
                {createResult.error_text && createResult.reason !== "invalid_input" && (
                  <span className="mt-1 block break-all font-mono text-[11px] text-ink-3/60">{createResult.error_text}</span>
                )}
              </>}
            >
              <div className="flex w-full flex-col items-center gap-3">
                {/* What FreshPortal actually holds — read back after saving */}
                {createResult.product && (
                  <Panel title={t.create.inPortal} icon={Store} className="w-full max-w-sm text-left">
                    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-[13px]">
                      <dt className="text-ink-3">{t.create.fieldName}</dt><dd className="min-w-0 truncate text-ink">{createResult.product.name}</dd>
                      <dt className="text-ink-3">{t.create.fieldNumber}</dt><dd><Code>{createResult.product.product_number}</Code></dd>
                      <dt className="text-ink-3">{t.create.vbnLabel}</dt><dd>{createResult.product.vbn_number ? <Code tone="ok">{createResult.product.vbn_number}</Code> : "—"}</dd>
                      <dt className="text-ink-3">{t.create.colorLabel}</dt><dd className="text-ink">{createResult.product.color || "—"}</dd>
                      <dt className="text-ink-3">{t.create.fieldId}</dt><dd className="font-mono text-xs text-ink-2">{createResult.product.product_id}</dd>
                    </dl>
                  </Panel>
                )}

                {createResult.warnings.length > 0 && (
                  <div className="w-full max-w-sm rounded-[14px] border border-blush bg-blush/20 px-4 py-3 text-left">
                    <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-brick"><TriangleAlert className="size-3.5" />{t.create.warnTitle.replace(/:$/, "")}</p>
                    <ul className="space-y-1 text-xs text-ink-2">
                      {createResult.warnings.map((w, i) => <li key={i}>{warningText(w)}</li>)}
                    </ul>
                  </div>
                )}

                <div className="mt-1 flex flex-wrap justify-center gap-2">
                  {createResult.product_url && (
                    <Button asChild variant="outline">
                      <a href={createResult.product_url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" />{t.create.openInPortal}</a>
                    </Button>
                  )}
                  {!createResult.product_url && createResult.search_url && createResult.status === "unconfirmed" && (
                    <Button asChild variant="emphasis">
                      <a href={createResult.search_url} target="_blank" rel="noopener noreferrer"><Search className="size-4" />{t.create.checkInPortal}</a>
                    </Button>
                  )}
                  {createResult.status === "failed" && lastTemplate.current && (
                    <Button variant="outline" onClick={backToForm}><Pencil className="size-4" />{t.create.tryAgain}</Button>
                  )}
                  <Button variant="primary" onClick={resetAll}><Plus className="size-4" />{t.create.createAnother}</Button>
                </div>
              </div>
            </DoneState>
          </Section>
        )}

      </div>
    </div>
  );
}
