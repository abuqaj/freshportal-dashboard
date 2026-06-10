"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { flushSync, createPortal } from "react-dom";
import { translations, Lang } from "@/lib/i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

type VbnResult = {
  product_id: string;
  short_name: string;
  name: string;
  current_vbn: string;
  official_name: string;
  status: "OK" | "ERROR" | "WARNING";
  reason: string;
  proposed_vbn: string;
  proposed_vbn_name: string;
  // local editable state
  edited_vbn?: string;
  excluded?: boolean;
};

type Stats = {
  total: number;
  errors: number;
  warnings: number;
  ok: number;
};

type ProductSearchResult = {
  product_id: string;
  name: string;
  short_name: string;
  vbn_number: string;
  similarity: number;
};

type FixEntry = { product_id: string; name: string; old_vbn: string; new_vbn: string };

type AIAnalysis = {
  duplicate: {
    found: boolean;
    product_id?: string | null;
    product_name?: string | null;
    confidence?: string;
    reason?: string;
  };
  vbn: {
    code?: string | null;
    name?: string | null;
    confidence?: string;
    explanation?: string;
  };
};

type HistoryRow = {
  id: number;
  type: string;
  vbn_filter: string | null;
  stats: Record<string, unknown> | null;
  details: { fixes?: FixEntry[]; name?: string; product_number?: string; template_name?: string } | null;
  created_at: string;
};

function ManualTemplateForm({
  newName,
  onCreate,
  disabled,
  placeholder,
  copyLabel,
}: {
  newName: string;
  onCreate: (id: string, name: string) => void;
  disabled: boolean;
  placeholder: string;
  copyLabel: string;
}) {
  const [id, setId] = useState("");
  return (
    <div className="flex gap-3">
      <input
        type="text"
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder={placeholder}
        className="border border-neutral-200 rounded-lg px-3 py-2 text-sm flex-1 focus:outline-none focus:ring-1 focus:ring-violet-300"
      />
      <button
        onClick={() => id.trim() && onCreate(id.trim(), newName)}
        disabled={disabled || !id.trim()}
        className="bg-neutral-700 hover:bg-neutral-800 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors"
      >
        {copyLabel}
      </button>
    </div>
  );
}


export default function Dashboard() {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    const saved = localStorage.getItem("fp_lang") as Lang | null;
    if (saved && ["en", "nl", "pl", "es"].includes(saved)) setLangState(saved);
  }, []);

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

  function setLang(l: Lang) { setLangState(l); localStorage.setItem("fp_lang", l); }
  const t = translations[lang];

  const [tab, setTab] = useState<"vbn" | "photos" | "history" | "create">("vbn");

  // VBN state
  const [vbnInput, setVbnInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [results, setResults] = useState<VbnResult[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixMessage, setFixMessage] = useState<string | null>(null);
  const [fixSuccess, setFixSuccess] = useState<string | null>(null);
  // VBN code → official name cache (populated on load + live lookup)
  const [vbnNameCache, setVbnNameCache] = useState<Record<string, string>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const nameChangeDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFormName = useRef<string>("");
  // Autocomplete suggestions for current active input
  const [suggestions, setSuggestions] = useState<{ product_id: string; items: { id: string; name: string }[] } | null>(null);
  // Fixed-position anchor for portal dropdown (avoids table overflow-hidden clipping)
  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number } | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});;

  // Product creation
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
  const [showDuplicateWarning, setShowDuplicateWarning] = useState<{ templateId: string; templateName: string } | null>(null);
  const [selectedTemplateWas100Pct, setSelectedTemplateWas100Pct] = useState(false);
  const [showSecondDuplicateWarning, setShowSecondDuplicateWarning] = useState(false);
  const [showAllResults, setShowAllResults] = useState(false);

  // Create form — VBN
  const [vbnForCreate, setVbnForCreate] = useState("");
  const [vbnForCreateInfo, setVbnForCreateInfo] = useState<{ found: boolean; name: string } | null>(null);
  const [vbnForCreateChecking, setVbnForCreateChecking] = useState(false);
  const vbnForCreateDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Create form — Color
  const [colorList, setColorList] = useState<{ id: string; name: string }[]>([]);
  const [colorListLoading, setColorListLoading] = useState(false);
  const [colorLoadError, setColorLoadError] = useState<string | null>(null);
  const [colorForCreate, setColorForCreate] = useState("");
  const [colorSearch, setColorSearch] = useState("");
  const [colorDropdownOpen, setColorDropdownOpen] = useState(false);
  const colorDropdownRef = useRef<HTMLDivElement>(null);

  // Sync status
  type SyncStatus = { running: boolean; product_count: number; last_sync: { started_at: string; finished_at: string | null; product_count: number | null; status: string } | null };
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncTriggering, setSyncTriggering] = useState(false);

  // History
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(null);

  // Photo
  const [xlsxFile, setXlsxFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  // Pre-load color list + fetch sync status when entering Create tab
  useEffect(() => {
    if (tab === "create") {
      if (colorList.length === 0 && !colorListLoading) loadColors();
      if (RAILWAY) {
        fetch(`${RAILWAY}/sync/status`)
          .then(r => r.json())
          .then((d: SyncStatus) => setSyncStatus(d))
          .catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Auto-fill VBN from AI analysis when it arrives and the create form is already open
  useEffect(() => {
    if (pendingCreate && !vbnForCreate && aiAnalysis?.vbn?.code && RAILWAY) {
      const code = aiAnalysis.vbn.code;
      setVbnForCreate(code);
      setVbnForCreateChecking(true);
      setVbnForCreateInfo(null);
      fetch(`${RAILWAY}/vbn-name/${code}`)
        .then(r => r.json())
        .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
        .catch(() => {})
        .finally(() => setVbnForCreateChecking(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiAnalysis]);

  const errorResults = results?.filter((r) => !r.excluded && r.status !== "OK") ?? [];

  async function handleCheck() {
    if (!vbnInput.trim()) return;
    if (!RAILWAY) {
      setCheckError("NEXT_PUBLIC_RAILWAY_API_URL not configured — redeploy Vercel after adding the env var.");
      return;
    }
    // flushSync forces React to render the spinner BEFORE the async fetch starts
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
        body: JSON.stringify({ vbn: vbnInput.trim() }),
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
        // Handle both \n and \r\n line endings
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          // Skip SSE comments (keepalive) and empty lines
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (event.type === "status") {
            // Each status update triggers its own render
            flushSync(() => setStatusMessage(event.message as string));
          } else if (event.type === "result") {
            const data = event.data as { results: VbnResult[]; stats: Stats };
            const withEdits = data.results.map((r) => ({
              ...r,
              edited_vbn: r.proposed_vbn,
              excluded: false,
            }));
            setResults(withEdits);
            setStats(data.stats);
            // Seed cache with proposed VBN names that came from the API
            const seedCache: Record<string, string> = {};
            data.results.forEach((r) => {
              if (r.proposed_vbn && r.proposed_vbn_name)
                seedCache[r.proposed_vbn] = r.proposed_vbn_name;
              if (r.current_vbn && r.official_name)
                seedCache[r.current_vbn] = r.official_name;
            });
            setVbnNameCache(seedCache);
            // Log to Vercel DB (fire-and-forget)
            fetch("/api/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "vbn_check",
                vbn_filter: vbnInput.trim(),
                stats: data.stats,
                details: { result_count: data.results.length },
              }),
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
    setResults((prev) =>
      prev ? prev.map((r) => (r.product_id === product_id ? { ...r, edited_vbn: val } : r)) : prev
    );

    const trimmed = val.trim();
    if (!trimmed || !RAILWAY) { setSuggestions(null); return; }

    if (debounceTimers.current[product_id]) clearTimeout(debounceTimers.current[product_id]);

    if (/^\d+$/.test(trimmed)) {
      // Numeric → look up official name
      setSuggestions(null);
      setVbnNameCache((prev) => ({ ...prev, [trimmed]: prev[trimmed] && prev[trimmed] !== "…" ? prev[trimmed] : "…" }));
      debounceTimers.current[product_id] = setTimeout(async () => {
        try {
          const res = await fetch(`${RAILWAY}/vbn-name/${trimmed}`);
          const data = await res.json();
          setVbnNameCache((prev) => ({
            ...prev,
            [trimmed]: data.found ? (data.name ?? "") : t.vbn.unknownCode,
          }));
        } catch {
          setVbnNameCache((prev) => ({ ...prev, [trimmed]: "" }));
        }
      }, 600);
    } else {
      // Text → search by name, show autocomplete dropdown
      debounceTimers.current[product_id] = setTimeout(async () => {
        // Calculate input position for portal dropdown
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
    setResults((prev) =>
      prev ? prev.map((r) => (r.product_id === product_id ? { ...r, edited_vbn: id } : r)) : prev
    );
    setVbnNameCache((prev) => ({ ...prev, [id]: name }));
    setSuggestions(null);
  }

  function toggleExclude(product_id: string) {
    setResults((prev) =>
      prev ? prev.map((r) => (r.product_id === product_id ? { ...r, excluded: !r.excluded } : r)) : prev
    );
  }

  async function handleFix() {
    if (!results) return;
    const toFix = results
      .filter((r) => !r.excluded && r.status !== "OK" && r.edited_vbn?.trim())
      .map((r) => ({
        product_id: r.product_id,
        new_vbn: r.edited_vbn!.trim(),
        old_vbn: r.current_vbn,
        name: r.name,
      }));

    if (toFix.length === 0) {
      setFixMessage(t.vbn.nothingToFix);
      return;
    }

    flushSync(() => {
      setFixing(true);
      setFixMessage(null);
    });

    try {
      // Railway only needs product_id + new_vbn
      const fixPayload = toFix.map(({ product_id, new_vbn }) => ({ product_id, new_vbn }));
      const res = await fetch(`${RAILWAY}/vbn-fix/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixes: fixPayload }),
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
            // Reset search, show banner
            setResults(null);
            setStats(null);
            setVbnInput("");
            setVbnNameCache({});
            setFixSuccess(msg);
            setTimeout(() => setFixSuccess(null), 6000);
            fetch("/api/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "vbn_fix",
                vbn_filter: null,
                stats: { fixed: data.fixed, failed: data.failed },
                details: { fixes: toFix },
              }),
            }).catch(() => {});
          } else if (event.type === "error") {
            throw new Error(event.message as string);
          }
        }
      }
    } catch (e: unknown) {
      setFixMessage(`Błąd: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFixing(false);
    }
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
            // Fire AI analysis in background — don't await, show results immediately
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

  function wordJaccard(a: string, b: string): number {
    const wordsA = a.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const wordsB = b.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (wordsA.length === 0 && wordsB.length === 0) return 1;
    const maxWords = Math.max(wordsA.length, wordsB.length);
    if (maxWords === 0) return 1;
    // Fuzzy per-word similarity: greedy sequential char match
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
      if (bestJ >= 0 && bestSim >= 0.80) {
        totalSim += bestSim;
        usedB.add(bestJ);
      }
    }
    return totalSim / maxWords;
  }

  function genProductNumber(name: string): string {
    const words = name.replace(/[^A-Za-z0-9\s]/g, "").toUpperCase().split(/\s+/).filter(Boolean);
    return words.map(w => w.slice(0, 2)).join("").slice(0, 8) || "PROD";
  }

  function loadColors() {
    if (colorListLoading || !RAILWAY) return;
    setColorListLoading(true);
    setColorLoadError(null);
    fetch(`${RAILWAY}/floricode/colors`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: { colors: { id: string; name: string }[] }) => setColorList(d.colors ?? []))
      .catch((e: unknown) => setColorLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setColorListLoading(false));
  }

  async function triggerSync() {
    if (!RAILWAY || syncTriggering) return;
    setSyncTriggering(true);
    try {
      await fetch(`${RAILWAY}/sync/run`, { method: "POST" });
      // Poll status every 5 s while running
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

  function handleCreateFromTemplate(templateId: string, templateName: string, templateVbn = "") {
    const name = createInput.trim();
    const initialNumber = genProductNumber(name);
    initialFormName.current = name;
    setPendingCreate({ templateId, templateName });
    setFinalName(name);
    setProductNumber(initialNumber);
    setCreateResult(null);
    setNumberChecking(true);
    setNumberCheckResult(null);

    // Pre-fill VBN: AI suggestion if available, else fall back to template's own VBN
    const initialVbn = aiAnalysis?.vbn?.code ?? templateVbn;
    setVbnForCreate(initialVbn);
    setVbnForCreateInfo(null);
    if (initialVbn && RAILWAY) {
      setVbnForCreateChecking(true);
      fetch(`${RAILWAY}/vbn-name/${initialVbn}`)
        .then(r => r.json())
        .then((d: { found: boolean; name?: string }) => setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
        .catch(() => {})
        .finally(() => setVbnForCreateChecking(false));
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
  }

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

  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    const res = await fetch("/api/history");
    const data = await res.json();
    setHistory(data.history ?? []);
    setHistLoading(false);
  }, []);

  async function handleUpload() {
    if (!xlsxFile) return;
    setUploading(true);
    setUploadMsg(null);
    const fd = new FormData();
    fd.append("xlsx", xlsxFile);
    try {
      const res = await fetch(`${RAILWAY}/photo-upload`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Railway error");
      setUploadMsg(data.message ?? "Upload zakończony pomyślnie.");
    } catch (e: unknown) {
      setUploadMsg(`Błąd: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  }

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
            { id: "vbn",     label: "VBN Checker",        icon: "🏷️" },
            { id: "create",  label: t.nav.newProducts,    icon: "➕" },
            { id: "photos",  label: "Photo Uploader",     icon: "🖼️" },
            { id: "history", label: t.nav.history,        icon: "📋" },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setTab(item.id as typeof tab);
                if (item.id === "history") loadHistory();
              }}
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

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        {/* VBN Checker */}
        {tab === "vbn" && (
          <div className="p-8 max-w-5xl">
            <div className="mb-6">
              <h1 className="text-xl font-semibold text-neutral-900">VBN Checker</h1>
              <p className="text-sm text-neutral-500 mt-1">{t.vbn.description}</p>
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
              <label className="block text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">
                {t.vbn.codesLabel}
              </label>
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
                <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  ⚠️ {checkError}
                </p>
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
                  <div className="px-5 py-8 text-center text-sm text-green-600">
                    {t.vbn.allOk}
                  </div>
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
                        <tr
                          key={r.product_id}
                          className={`border-b border-neutral-50 hover:bg-neutral-50 transition-colors ${
                            r.excluded ? "opacity-40" : ""
                          }`}
                        >
                          <td className="px-5 py-3">
                            <p className="font-medium text-neutral-800">{r.name}</p>
                            <p className="text-xs text-neutral-400">{r.short_name}</p>
                          </td>
                          <td className="px-3 py-3">
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                                r.status === "ERROR"
                                  ? "bg-red-50 text-red-700"
                                  : "bg-amber-50 text-amber-700"
                              }`}
                            >
                              {r.current_vbn}
                            </span>
                            {r.official_name && (
                              <p className="text-xs text-neutral-400 mt-0.5 max-w-32 truncate">{r.official_name}</p>
                            )}
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
                              placeholder="VBN lub nazwa…"
                              className="border border-neutral-200 rounded px-2 py-1 text-xs w-36 focus:outline-none focus:ring-1 focus:ring-violet-300 disabled:bg-neutral-50"
                            />
                            {/* Name label for numeric codes */}
                            {r.edited_vbn?.trim() && /^\d+$/.test(r.edited_vbn.trim()) && (
                              <p className={`text-xs mt-0.5 break-words leading-snug ${
                                vbnNameCache[r.edited_vbn.trim()]?.startsWith("⚠")
                                  ? "text-red-400"
                                  : vbnNameCache[r.edited_vbn.trim()] === "…"
                                  ? "text-neutral-300 italic"
                                  : "text-neutral-400"
                              }`}>
                                {vbnNameCache[r.edited_vbn.trim()] ?? ""}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-3 text-center">
                            <button
                              onClick={() => toggleExclude(r.product_id)}
                              className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                                r.excluded
                                  ? "border-green-200 text-green-600 hover:bg-green-50"
                                  : "border-neutral-200 text-neutral-400 hover:border-red-200 hover:text-red-500"
                              }`}
                            >
                              {r.excluded ? t.vbn.restore : t.vbn.skip}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* Confirm bar */}
                {errorResults.length > 0 && (
                  <div className="px-5 py-4 bg-neutral-50 border-t border-neutral-100 flex items-center justify-between">
                    <p className="text-xs text-neutral-500">
                      {errorResults.filter((r) => !r.excluded && r.edited_vbn?.trim()).length} {t.vbn.willBeUpdated}
                    </p>
                    <div className="flex gap-2 items-center">
                      {fixMessage && (
                        <span
                          className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg ${
                            fixMessage.startsWith("✓")
                              ? "bg-green-50 text-green-700"
                              : fixMessage.startsWith("Błąd")
                              ? "bg-red-50 text-red-600"
                              : "bg-violet-50 text-violet-700"
                          }`}
                        >
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

            {/* Show all OK products collapsed */}
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
                    {results
                      .filter((r) => r.status === "OK")
                      .map((r) => (
                        <tr key={r.product_id} className="border-b border-neutral-50">
                          <td className="px-5 py-2 text-neutral-700">{r.name}</td>
                          <td className="px-3 py-2">
                            <span className="bg-green-50 text-green-700 px-2 py-0.5 rounded text-xs">
                              {r.current_vbn}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-neutral-400">{r.official_name}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>
        )}

        {/* Product Creation */}
        {tab === "create" && (
          <div className="p-8 max-w-3xl">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold text-neutral-900">{t.nav.newProducts}</h1>
                <p className="text-sm text-neutral-500 mt-1">{t.create.description}</p>
              </div>
              {/* Sync status badge */}
              <div className="flex-shrink-0 text-right">
                {syncStatus ? (
                  <div className="flex flex-col items-end gap-1">
                    <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium ${
                      syncStatus.running ? "bg-violet-50 text-violet-700" :
                      syncStatus.product_count > 0 ? "bg-green-50 text-green-700" : "bg-neutral-100 text-neutral-500"
                    }`}>
                      {syncStatus.running && (
                        <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                        </svg>
                      )}
                      {syncStatus.running ? "Syncing…" :
                       syncStatus.product_count > 0 ? `${syncStatus.product_count.toLocaleString()} products in DB` :
                       "DB empty"}
                    </div>
                    {syncStatus.last_sync?.finished_at && !syncStatus.running && (
                      <p className="text-xs text-neutral-400">
                        Last sync: {new Date(syncStatus.last_sync.finished_at).toLocaleString()}
                      </p>
                    )}
                    <button
                      onClick={triggerSync}
                      disabled={syncTriggering || syncStatus.running}
                      className="text-xs text-violet-600 hover:text-violet-700 disabled:opacity-40 underline"
                    >
                      {syncTriggering || syncStatus.running ? "Syncing…" : "Sync now"}
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-neutral-300">Loading DB status…</div>
                )}
              </div>
            </div>

            {/* Search bar */}
            <div className="bg-white border border-neutral-200 rounded-xl p-5 mb-5">
              <label className="block text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">
                {t.create.nameLabel}
              </label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={createInput}
                  onChange={(e) => setCreateInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleProductSearch()}
                  placeholder={t.create.namePlaceholder}
                  className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
                />
                <button
                  onClick={handleProductSearch}
                  disabled={searching || !createInput.trim()}
                  className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
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
                <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  ⚠️ {searchError}
                </p>
              )}
            </div>

            {/* Create result */}
            {createResult && (
              <div className={`mb-5 rounded-xl px-5 py-4 border text-sm ${
                createResult.ok
                  ? "bg-green-50 border-green-200 text-green-700"
                  : "bg-red-50 border-red-200 text-red-600"
              }`}>
                <p className="font-medium">{createResult.ok ? "✓ " : "⚠ "}{createResult.message}</p>
                {createResult.ok && createResult.url && (
                  <p className="text-xs mt-1 opacity-70">URL: {createResult.url}</p>
                )}
              </div>
            )}

            {/* Creating spinner */}
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
                    {highMatches.length > 0 && (
                      <span className="ml-2 text-xs text-neutral-400">{t.create.resultsCount(highMatches.length)}</span>
                    )}
                  </p>
                </div>

                {searchResults.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-neutral-500 text-center">
                    {t.create.noResults}
                    <br />
                    <span className="text-xs text-neutral-400 mt-1 block">
                      {t.create.noResultsHint}
                    </span>
                  </div>
                ) : (
                  <>
                    {highMatches.length > 0 && (
                      <div className="px-5 py-3 bg-amber-50 border-b border-amber-100 text-xs text-amber-700">
                        {t.create.warning}
                      </div>
                    )}
                    {isFallback && (
                      <div className="px-5 py-3 bg-neutral-50 border-b border-neutral-100 text-xs text-neutral-500">
                        {t.create.fallback}
                      </div>
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
                                r.similarity >= 1.0
                                  ? "bg-green-50 text-green-700"
                                  : r.similarity >= 0.80
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-neutral-100 text-neutral-500"
                              }`}>
                                {Math.round(r.similarity * 100)}%
                              </span>
                            </td>
                            <td className="px-3 py-3 text-center">
                              <button
                                onClick={() => {
                                  if (r.similarity >= 1.0) {
                                    setShowDuplicateWarning({ templateId: r.product_id, templateName: r.name });
                                  } else {
                                    handleCreateFromTemplate(r.product_id, r.name, r.vbn_number);
                                  }
                                }}
                                disabled={creating}
                                className="text-xs px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg transition-colors"
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
                        <button
                          onClick={() => setShowAllResults(true)}
                          className="text-xs text-violet-600 hover:text-violet-700 font-medium"
                        >
                          {t.create.showMore(allDisplayResults.length - 5)}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
              );
            })()}

            {/* Confirmation step before creating */}
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
                              // Name changed >40% — regenerate number and re-check availability
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
                            // VBN re-check: run AI analysis with new name to apply all
                            // validation rules (Floricode + color conflict + genus-other fallback)
                            if (trimmed && RAILWAY && searchResults && searchResults.length > 0) {
                              setVbnForCreateChecking(true);
                              setVbnForCreateInfo(null);
                              fetch(`${RAILWAY}/product-ai-analyze`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ name: trimmed, candidates: searchResults.slice(0, 6) }),
                              })
                                .then(r => r.json())
                                .then((data: AIAnalysis) => {
                                  const code = data?.vbn?.code ?? null;
                                  if (code) {
                                    setVbnForCreate(code);
                                    setVbnForCreateInfo(null);
                                    fetch(`${RAILWAY}/vbn-name/${code}`)
                                      .then(r => r.json())
                                      .then((d: { found: boolean; name?: string }) =>
                                        setVbnForCreateInfo({ found: d.found, name: d.name ?? "" }))
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
                        placeholder="Nazwa nowego produktu…"
                        className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
                        autoFocus
                      />
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
                        placeholder="np. ROECAT"
                        className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm w-36 font-mono uppercase focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
                      />
                    </div>
                  </div>
                  {numberCheckResult?.changed && (
                    <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <span>⚠</span>
                      <span>{t.create.numberTaken(numberCheckResult.original, productNumber)}</span>
                    </div>
                  )}

                  {/* VBN + Color row */}
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
                        className="border border-neutral-200 rounded-lg px-3 py-2.5 text-sm w-full font-mono focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
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
                          <button onClick={() => { setColorForCreate(""); setColorSearch(""); }} className="text-neutral-300 hover:text-neutral-500 text-xs">✕</button>
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
                          className="border border-neutral-200 rounded-lg px-3 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400 disabled:bg-neutral-50"
                        />
                        {colorLoadError && (
                          <div className="flex items-center gap-2 mt-0.5">
                            <p className="text-xs text-red-500 flex-1 truncate">{colorLoadError}</p>
                            <button onClick={loadColors} className="text-xs text-violet-600 hover:underline shrink-0">Retry</button>
                          </div>
                        )}
                        {!colorListLoading && !colorLoadError && colorList.length === 0 && (
                          <button onClick={loadColors} className="text-xs text-violet-500 hover:underline mt-0.5">Load colors</button>
                        )}
                        {colorDropdownOpen && !colorListLoading && (
                          <div className="absolute z-30 left-0 right-0 mt-1 max-h-52 overflow-y-auto bg-white border border-neutral-200 rounded-xl shadow-xl">
                            <button
                              onMouseDown={(e) => { e.preventDefault(); setColorForCreate(""); setColorSearch(""); setColorDropdownOpen(false); }}
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
                                  className={`w-full text-left px-3 py-2 text-xs hover:bg-violet-50 flex justify-between items-center ${
                                    colorForCreate === c.id ? "bg-violet-50 text-violet-700 font-medium" : "text-neutral-700"
                                  }`}
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
                      className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                    >
                      {creating ? t.create.creating : numberChecking ? t.create.checkingNumber : t.create.createBtn}
                    </button>
                    <button
                      onClick={() => { setPendingCreate(null); setVbnForCreate(""); setVbnForCreateInfo(null); setColorForCreate(""); setColorSearch(""); setColorDropdownOpen(false); }}
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
                    {/* Duplicate result */}
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
                        {aiAnalysis.duplicate.reason && (
                          <p className="text-xs text-amber-600 mt-1">{aiAnalysis.duplicate.reason}</p>
                        )}
                        <button
                          onClick={() => handleCreateFromTemplate(
                            aiAnalysis.duplicate.product_id!,
                            aiAnalysis.duplicate.product_name ?? ""
                          )}
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

                    {/* VBN suggestion */}
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
                        {aiAnalysis.vbn.explanation && (
                          <p className="text-xs text-violet-600 mt-1">{aiAnalysis.vbn.explanation}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Manual template ID */}
            {searchResults !== null && (
              <div className="mt-4 bg-white border border-neutral-200 rounded-xl p-5">
                <p className="text-xs font-medium text-neutral-500 mb-3 uppercase tracking-wide">
                  {t.create.manualTitle}
                </p>
                <ManualTemplateForm
                  newName={createInput}
                  onCreate={handleCreateFromTemplate}
                  disabled={creating}
                  placeholder={t.create.manualPlaceholder}
                  copyLabel={t.create.manualCopy}
                />
              </div>
            )}
          </div>
        )}

        {/* Photo Uploader */}
        {tab === "photos" && (
          <div className="p-8 max-w-2xl">
            <div className="mb-6">
              <h1 className="text-xl font-semibold text-neutral-900">Photo Uploader</h1>
              <p className="text-sm text-neutral-500 mt-1">{t.photo.description}</p>
            </div>

            <div className="bg-white border border-neutral-200 rounded-xl p-6">
              <p className="text-sm font-medium text-neutral-700 mb-3">{t.photo.formatTitle}</p>
              <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 mb-5 text-xs text-neutral-500 font-mono">
                <p className="font-medium text-neutral-600 mb-1">{t.photo.requiredCols}</p>
                <p>• <strong>product_id</strong> — {t.photo.col1.replace("product_id — ", "")}</p>
                <p>• <strong>photo_name</strong> — {t.photo.col2.replace("photo_name — ", "")}</p>
              </div>

              <label className="block text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">
                {t.photo.fileLabel}
              </label>
              <div className="border-2 border-dashed border-neutral-200 rounded-xl p-8 text-center hover:border-violet-300 transition-colors">
                <input
                  type="file"
                  accept=".xlsx"
                  onChange={(e) => setXlsxFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                  id="xlsx-input"
                />
                <label htmlFor="xlsx-input" className="cursor-pointer">
                  <p className="text-3xl mb-2">📊</p>
                  <p className="text-sm text-neutral-600">
                    {xlsxFile ? xlsxFile.name : t.photo.filePrompt}
                  </p>
                  {!xlsxFile && (
                    <p className="text-xs text-neutral-400 mt-1">{t.photo.fileDrag}</p>
                  )}
                </label>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  onClick={handleUpload}
                  disabled={!xlsxFile || uploading}
                  className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                >
                  {uploading ? t.photo.uploading : t.photo.uploadBtn}
                </button>
              </div>

              {uploadMsg && (
                <p
                  className={`mt-4 text-sm px-4 py-3 rounded-lg ${
                    uploadMsg.startsWith("Błąd") ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"
                  }`}
                >
                  {uploadMsg}
                </p>
              )}
            </div>
          </div>
        )}

        {/* History */}
        {tab === "history" && (
          <div className="p-8 max-w-4xl">
            <div className="mb-6 flex justify-between items-start">
              <div>
                <h1 className="text-xl font-semibold text-neutral-900">{t.history.title}</h1>
                <p className="text-sm text-neutral-500 mt-1">{t.history.description}</p>
              </div>
              <button
                onClick={loadHistory}
                className="text-sm text-violet-600 hover:text-violet-700 border border-violet-200 rounded-lg px-3 py-1.5"
              >
                {t.history.refresh}
              </button>
            </div>

            <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
              {histLoading ? (
                <div className="p-8 text-center text-sm text-neutral-400">{t.history.loading}</div>
              ) : !history || history.length === 0 ? (
                <div className="p-8 text-center text-sm text-neutral-400">
                  {t.history.empty}
                  <p className="text-xs mt-1 text-neutral-300">{t.history.emptyHint}</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100 text-xs text-neutral-400 uppercase tracking-wide">
                      <th className="text-left px-5 py-3 font-medium">{t.history.colType}</th>
                      <th className="text-left px-3 py-3 font-medium">{t.history.colFilter}</th>
                      <th className="text-left px-3 py-3 font-medium">{t.history.colDetails}</th>
                      <th className="text-left px-3 py-3 font-medium">{t.history.colDate}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row) => {
                      const fixes = row.details?.fixes ?? [];
                      const isExpanded = expandedHistoryId === row.id;
                      const canExpand = row.type === "vbn_fix" && fixes.length > 0;
                      return (
                        <>
                          <tr
                            key={row.id}
                            onClick={() => canExpand && setExpandedHistoryId(isExpanded ? null : row.id)}
                            className={`border-b border-neutral-50 transition-colors ${
                              canExpand ? "cursor-pointer hover:bg-neutral-50" : "hover:bg-neutral-50"
                            }`}
                          >
                            <td className="px-5 py-3">
                              <div className="flex items-center gap-2">
                                {canExpand && (
                                  <span className="text-neutral-300 text-xs">{isExpanded ? "▼" : "▶"}</span>
                                )}
                                <span
                                  className={`text-xs px-2 py-1 rounded font-medium ${
                                    row.type === "vbn_check"
                                      ? "bg-violet-50 text-violet-700"
                                      : row.type === "vbn_fix"
                                      ? "bg-green-50 text-green-700"
                                      : row.type === "product_create"
                                      ? "bg-blue-50 text-blue-700"
                                      : "bg-neutral-100 text-neutral-600"
                                  }`}
                                >
                                  {row.type === "vbn_check"
                                    ? t.history.vbnCheck
                                    : row.type === "vbn_fix"
                                    ? t.history.vbnFix
                                    : row.type === "product_create"
                                    ? t.history.productCreate
                                    : t.history.photoUpload}
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-3 text-neutral-600 font-mono text-xs">
                              {row.type === "product_create"
                                ? (row.details?.product_number ?? "—")
                                : (row.vbn_filter ?? "—")}
                            </td>
                            <td className="px-3 py-3 text-neutral-500 text-xs">
                              {row.type === "product_create"
                                ? (
                                  <span>
                                    <span className="font-medium text-neutral-700">{row.details?.name ?? "—"}</span>
                                    {row.details?.template_name && (
                                      <span className="text-neutral-400 ml-1">({t.create.templateLabel} {row.details.template_name})</span>
                                    )}
                                  </span>
                                )
                                : row.stats && Object.keys(row.stats).length > 0
                                ? Object.entries(row.stats).map(([k, v]) => `${k}: ${v}`).join(", ")
                                : "—"}
                            </td>
                            <td className="px-3 py-3 text-neutral-400 text-xs">
                              {new Date(row.created_at).toLocaleString(lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL")}
                            </td>
                          </tr>
                          {isExpanded && fixes.length > 0 && (
                            <tr key={`${row.id}-detail`} className="border-b border-neutral-100 bg-green-50/40">
                              <td colSpan={4} className="px-8 py-3">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-neutral-400 uppercase tracking-wide">
                                      <th className="text-left pb-1 font-medium">{t.history.expandProduct}</th>
                                      <th className="text-left pb-1 font-medium">{t.history.expandOldVbn}</th>
                                      <th className="text-left pb-1 font-medium"></th>
                                      <th className="text-left pb-1 font-medium">{t.history.expandNewVbn}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {fixes.map((f, i) => (
                                      <tr key={i} className="border-t border-green-100">
                                        <td className="py-1.5 pr-4 text-neutral-700">{f.name || f.product_id}</td>
                                        <td className="py-1.5 pr-2">
                                          <span className="bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-mono">{f.old_vbn}</span>
                                        </td>
                                        <td className="py-1.5 px-2 text-neutral-300">→</td>
                                        <td className="py-1.5">
                                          <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-mono">{f.new_vbn}</span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Duplicate warning modal — step 1: before opening form */}
      {showDuplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0 text-2xl">
                ⚠️
              </div>
              <div>
                <p className="text-lg font-semibold text-neutral-900">{t.create.dupWarn1Title}</p>
                <p className="text-sm text-neutral-600 mt-1">
                  {t.create.dupWarn1Text(showDuplicateWarning.templateName)}
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDuplicateWarning(null)}
                className="px-4 py-2 text-sm border border-neutral-200 rounded-lg text-neutral-600 hover:bg-neutral-50 transition-colors"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={() => {
                  handleCreateFromTemplate(showDuplicateWarning.templateId, showDuplicateWarning.templateName);
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

      {/* Duplicate warning modal — step 2: before submitting form */}
      {showSecondDuplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0 text-2xl">
                ⚠️
              </div>
              <div>
                <p className="text-lg font-semibold text-neutral-900">{t.create.dupWarn2Title}</p>
                <p className="text-sm text-neutral-600 mt-1">
                  {t.create.dupWarn2Text(finalName)}
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowSecondDuplicateWarning(false)}
                className="px-4 py-2 text-sm border border-neutral-200 rounded-lg text-neutral-600 hover:bg-neutral-50 transition-colors"
              >
                {t.create.dupWarn2Cancel}
              </button>
              <button
                onClick={() => handleConfirmCreate(true)}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                {t.create.dupWarn2Confirm}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Portal dropdown — rendered in document.body to escape table overflow:hidden */}
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
