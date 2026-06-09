"use client";

import { useState, useCallback, useRef } from "react";
import { flushSync, createPortal } from "react-dom";

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
}: {
  newName: string;
  onCreate: (id: string, name: string) => void;
  disabled: boolean;
}) {
  const [id, setId] = useState("");
  return (
    <div className="flex gap-3">
      <input
        type="text"
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder="ID produktu (np. 65945)"
        className="border border-neutral-200 rounded-lg px-3 py-2 text-sm flex-1 focus:outline-none focus:ring-1 focus:ring-violet-300"
      />
      <button
        onClick={() => id.trim() && onCreate(id.trim(), newName)}
        disabled={disabled || !id.trim()}
        className="bg-neutral-700 hover:bg-neutral-800 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors"
      >
        Kopiuj ten produkt
      </button>
    </div>
  );
}


export default function Dashboard() {
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

  // History
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(null);

  // Photo
  const [xlsxFile, setXlsxFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

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
      setStatusMessage("Łączenie z Railway…");
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
            [trimmed]: data.found ? (data.name ?? "") : "⚠ Nieznany kod VBN",
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
      setFixMessage("Brak produktów do poprawy.");
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
            const msg = `✓ Poprawiono ${data.fixed} produktów.${data.failed > 0 ? ` ${data.failed} nieudanych.` : ""}`;
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
      setSearchStatus("Łączenie z Railway…");
      setAiAnalysis(null);
      setAiLoading(false);
      setSelectedTemplateWas100Pct(false);
      setShowAllResults(false);
    });
    try {
      const res = await fetch(`${RAILWAY}/product-search/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createInput.trim() }),
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
    const setA = new Set(a.toLowerCase().trim().split(/\s+/).filter(Boolean));
    const setB = new Set(b.toLowerCase().trim().split(/\s+/).filter(Boolean));
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    setA.forEach(w => { if (setB.has(w)) intersection++; });
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 1;
  }

  function genProductNumber(name: string): string {
    const words = name.replace(/[^A-Za-z0-9\s]/g, "").toUpperCase().split(/\s+/).filter(Boolean);
    return words.map(w => w.slice(0, 2)).join("").slice(0, 8) || "PROD";
  }

  function handleCreateFromTemplate(templateId: string, templateName: string) {
    const name = createInput.trim();
    const initialNumber = genProductNumber(name);
    initialFormName.current = name;
    setPendingCreate({ templateId, templateName });
    setFinalName(name);
    setProductNumber(initialNumber);
    setCreateResult(null);
    setNumberChecking(true);
    setNumberCheckResult(null);

    fetch(`${RAILWAY}/product-number-suggest?number=${encodeURIComponent(initialNumber)}`)
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
    flushSync(() => { setCreating(true); setCreateStatus("Inicjalizacja…"); setCreateResult(null); setPendingCreate(null); });
    try {
      const res = await fetch(`${RAILWAY}/product-create/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: templateId, new_name: nameForLog, product_number: numberForLog || null }),
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
          <p className="text-sm font-semibold text-neutral-800 tracking-tight">FreshPortal Tools</p>
          <p className="text-xs text-neutral-400 mt-0.5">fp042100.freshportal.nl</p>
        </div>
        <nav className="flex-1 py-3">
          {[
            { id: "vbn", label: "VBN Checker", icon: "🏷️" },
            { id: "create", label: "Nowe produkty", icon: "➕" },
            { id: "photos", label: "Photo Uploader", icon: "🖼️" },
            { id: "history", label: "Historia", icon: "📋" },
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
          <p className="text-xs text-neutral-400">FreshPortal Dashboard v1.0</p>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        {/* VBN Checker */}
        {tab === "vbn" && (
          <div className="p-8 max-w-5xl">
            <div className="mb-6">
              <h1 className="text-xl font-semibold text-neutral-900">VBN Checker</h1>
              <p className="text-sm text-neutral-500 mt-1">
                Sprawdź poprawność kodów VBN produktów w FreshPortal na podstawie danych Floricode
              </p>
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
                Kody VBN do sprawdzenia
              </label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={vbnInput}
                  onChange={(e) => setVbnInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCheck()}
                  placeholder="np. 580, 595, 580"
                  className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
                />
                <button
                  onClick={handleCheck}
                  disabled={loading || !vbnInput.trim()}
                  className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                >
                  {loading ? "Sprawdzam…" : "Sprawdź produkty"}
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
                  { label: "Wszystkich", value: stats.total, color: "text-neutral-800" },
                  { label: "Błędy", value: stats.errors, color: "text-red-600" },
                  { label: "Ostrzeżenia", value: stats.warnings, color: "text-amber-600" },
                  { label: "Poprawne", value: stats.ok, color: "text-green-600" },
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
                    Produkty z błędami / ostrzeżeniami
                    <span className="ml-2 text-xs text-neutral-400">({errorResults.length} do poprawy)</span>
                  </p>
                </div>

                {errorResults.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-green-600">
                    ✓ Wszystkie produkty mają poprawne kody VBN
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-neutral-100 text-xs text-neutral-400 uppercase tracking-wide">
                        <th className="text-left px-5 py-3 font-medium">Nazwa produktu</th>
                        <th className="text-left px-3 py-3 font-medium">Aktualny VBN</th>
                        <th className="text-left px-3 py-3 font-medium">Powód</th>
                        <th className="text-left px-3 py-3 font-medium">Proponowany VBN</th>
                        <th className="px-3 py-3 font-medium">Akcja</th>
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
                              {r.excluded ? "Przywróć" : "Pomiń"}
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
                      {errorResults.filter((r) => !r.excluded && r.edited_vbn?.trim()).length} produktów zostanie
                      zaktualizowanych w FreshPortal
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
                        {fixing ? "Poprawiam…" : "Zatwierdź i popraw w FreshPortal"}
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
                  ✓ {stats.ok} produktów z poprawnym VBN (kliknij aby rozwinąć)
                </summary>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-neutral-100 text-neutral-400">
                      <th className="text-left px-5 py-2">Nazwa</th>
                      <th className="text-left px-3 py-2">VBN</th>
                      <th className="text-left px-3 py-2">Oficjalna nazwa VBN</th>
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
            <div className="mb-6">
              <h1 className="text-xl font-semibold text-neutral-900">Nowe produkty</h1>
              <p className="text-sm text-neutral-500 mt-1">
                Wpisz nazwę produktu — system znajdzie podobne lub stworzy kopię najbliższego
              </p>
            </div>

            {/* Search bar */}
            <div className="bg-white border border-neutral-200 rounded-xl p-5 mb-5">
              <label className="block text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">
                Nazwa nowego produktu
              </label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={createInput}
                  onChange={(e) => setCreateInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleProductSearch()}
                  placeholder="np. Rosa Ec Toxic"
                  className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
                />
                <button
                  onClick={handleProductSearch}
                  disabled={searching || !createInput.trim()}
                  className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                >
                  {searching ? "Szukam…" : "Szukaj podobnych"}
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
                    Podobne produkty
                    {highMatches.length > 0 && (
                      <span className="ml-2 text-xs text-neutral-400">({highMatches.length} wyników ≥80%)</span>
                    )}
                  </p>
                </div>

                {searchResults.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-neutral-500 text-center">
                    Nie znaleziono podobnych produktów w FreshPortal.
                    <br />
                    <span className="text-xs text-neutral-400 mt-1 block">
                      Wyszukaj ręcznie produkt do skopiowania wpisując jego ID poniżej.
                    </span>
                  </div>
                ) : (
                  <>
                    {highMatches.length > 0 && (
                      <div className="px-5 py-3 bg-amber-50 border-b border-amber-100 text-xs text-amber-700">
                        ⚠ Podobny produkt już może istnieć (podobieństwo ≥80%). Sprawdź listę przed tworzeniem.
                      </div>
                    )}
                    {isFallback && (
                      <div className="px-5 py-3 bg-neutral-50 border-b border-neutral-100 text-xs text-neutral-500">
                        Brak produktów z podobieństwem ≥80%. Najbliższy znaleziony wynik:
                      </div>
                    )}
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-neutral-100 text-xs text-neutral-400 uppercase tracking-wide">
                          <th className="text-left px-5 py-3 font-medium">Nazwa produktu</th>
                          <th className="text-left px-3 py-3 font-medium">VBN</th>
                          <th className="text-left px-3 py-3 font-medium">Podobieństwo</th>
                          <th className="px-3 py-3 font-medium">Akcja</th>
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
                                    handleCreateFromTemplate(r.product_id, r.name);
                                  }
                                }}
                                disabled={creating}
                                className="text-xs px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg transition-colors"
                              >
                                Kopiuj jako szablon
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
                          Pokaż więcej ({allDisplayResults.length - 5} kolejnych)
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
                <p className="text-sm font-semibold text-neutral-800 mb-1">Potwierdź nazwę nowego produktu</p>
                <p className="text-xs text-neutral-500 mb-3">
                  Szablon: <span className="font-medium text-neutral-700">{pendingCreate.templateName}</span>
                  <span className="ml-2 text-neutral-400">(ID: {pendingCreate.templateId})</span>
                </p>
                <div className="flex flex-col gap-3">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="block text-xs text-neutral-400 mb-1">Nazwa produktu</label>
                      <input
                        type="text"
                        value={finalName}
                        onChange={(e) => {
                          const newName = e.target.value;
                          setFinalName(newName);
                          setNumberCheckResult(null);
                          if (nameChangeDebounce.current) clearTimeout(nameChangeDebounce.current);
                          nameChangeDebounce.current = setTimeout(() => {
                            const sim = wordJaccard(initialFormName.current, newName.trim());
                            if (sim < 0.60) {
                              // Name changed >40% — regenerate number and re-check availability
                              const newBase = genProductNumber(newName.trim());
                              setProductNumber(newBase);
                              setNumberChecking(true);
                              fetch(`${RAILWAY}/product-number-suggest?number=${encodeURIComponent(newBase)}`)
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
                            // else: name changed <40% — keep existing validated number
                          }, 1000);
                        }}
                        placeholder="Nazwa nowego produktu…"
                        className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
                        autoFocus
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-neutral-400 mb-1 flex items-center gap-1.5">
                        Nr produktu (maks. 8 znaków)
                        {numberChecking && (
                          <svg className="animate-spin h-3 w-3 text-violet-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        )}
                        {!numberChecking && numberCheckResult && !numberCheckResult.changed && (
                          <span className="text-green-600 text-xs">✓ wolny</span>
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
                      <span>Nr <span className="font-mono font-medium">{numberCheckResult.original}</span> jest zajęty — zmieniono na <span className="font-mono font-medium">{productNumber}</span></span>
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleConfirmCreate()}
                      disabled={creating || numberChecking || !finalName.trim() || !productNumber.trim()}
                      className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                    >
                      {creating ? "Tworzę…" : numberChecking ? "Sprawdzam numer…" : "Utwórz produkt"}
                    </button>
                    <button
                      onClick={() => setPendingCreate(null)}
                      className="border border-neutral-200 text-neutral-500 hover:bg-neutral-50 text-sm px-4 py-2.5 rounded-lg transition-colors"
                    >
                      Anuluj
                    </button>
                  </div>
                  <p className="text-xs text-neutral-400">Format: tylko wielkie litery, bez spacji, unikalny w systemie</p>
                </div>
              </div>
            )}

            {/* AI Analysis */}
            {searchResults !== null && (aiLoading || aiAnalysis) && (
              <div className="mt-4 bg-white border border-neutral-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-neutral-100 flex items-center gap-2">
                  <span className="text-xs font-medium text-neutral-500 uppercase tracking-wide">Analiza AI</span>
                  {aiLoading && (
                    <svg className="animate-spin h-3 w-3 text-violet-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                </div>
                {aiLoading ? (
                  <p className="px-5 py-4 text-sm text-neutral-400">Sprawdzam duplikaty i sugeruję VBN…</p>
                ) : aiAnalysis && (
                  <div className="p-5 flex flex-col gap-3">
                    {/* Duplicate result */}
                    {aiAnalysis.duplicate.found && aiAnalysis.duplicate.product_id ? (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                        <p className="text-sm font-semibold text-amber-800">⚠ Prawdopodobny duplikat</p>
                        <p className="text-sm text-amber-700 mt-0.5">
                          Ten produkt może już istnieć jako{" "}
                          <strong>{aiAnalysis.duplicate.product_name}</strong>
                          {aiAnalysis.duplicate.confidence && (
                            <span className="ml-2 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100">
                              pewność: {aiAnalysis.duplicate.confidence}
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
                          Użyj jako szablon
                        </button>
                      </div>
                    ) : (
                      <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                        <p className="text-sm text-green-700">✓ AI nie znalazła duplikatu — produkt prawdopodobnie nie istnieje w systemie.</p>
                      </div>
                    )}

                    {/* VBN suggestion */}
                    {aiAnalysis.vbn.code && (
                      <div className="bg-violet-50 border border-violet-200 rounded-lg px-4 py-3">
                        <p className="text-xs font-medium text-violet-500 uppercase tracking-wide mb-1">Sugerowany VBN dla nowego produktu</p>
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
                  Lub podaj ID produktu-szablonu ręcznie
                </p>
                <ManualTemplateForm
                  newName={createInput}
                  onCreate={handleCreateFromTemplate}
                  disabled={creating}
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
              <p className="text-sm text-neutral-500 mt-1">
                Dodaj zdjęcia do produktów FreshPortal na podstawie pliku Excel
              </p>
            </div>

            <div className="bg-white border border-neutral-200 rounded-xl p-6">
              <p className="text-sm font-medium text-neutral-700 mb-3">Format pliku Excel</p>
              <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 mb-5 text-xs text-neutral-500 font-mono">
                <p className="font-medium text-neutral-600 mb-1">Wymagane kolumny:</p>
                <p>• <strong>product_id</strong> — ID produktu w FreshPortal</p>
                <p>• <strong>photo_name</strong> — nazwa pliku zdjęcia (np. rosa_red.jpg)</p>
              </div>

              <label className="block text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">
                Plik Excel (.xlsx)
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
                    {xlsxFile ? xlsxFile.name : "Kliknij aby wybrać plik .xlsx"}
                  </p>
                  {!xlsxFile && (
                    <p className="text-xs text-neutral-400 mt-1">lub przeciągnij i upuść</p>
                  )}
                </label>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  onClick={handleUpload}
                  disabled={!xlsxFile || uploading}
                  className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                >
                  {uploading ? "Uploaduję…" : "Uruchom Photo Uploader"}
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
                <h1 className="text-xl font-semibold text-neutral-900">Historia operacji</h1>
                <p className="text-sm text-neutral-500 mt-1">Logi wszystkich operacji VBN i photo upload</p>
              </div>
              <button
                onClick={loadHistory}
                className="text-sm text-violet-600 hover:text-violet-700 border border-violet-200 rounded-lg px-3 py-1.5"
              >
                Odśwież
              </button>
            </div>

            <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
              {histLoading ? (
                <div className="p-8 text-center text-sm text-neutral-400">Ładuję historię…</div>
              ) : !history || history.length === 0 ? (
                <div className="p-8 text-center text-sm text-neutral-400">
                  Brak historii operacji. Uruchom najpierw VBN Checker lub Photo Uploader.
                  <p className="text-xs mt-1 text-neutral-300">
                    (Wymaga skonfigurowanej bazy danych Vercel Postgres)
                  </p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100 text-xs text-neutral-400 uppercase tracking-wide">
                      <th className="text-left px-5 py-3 font-medium">Typ</th>
                      <th className="text-left px-3 py-3 font-medium">Filtr / Nr</th>
                      <th className="text-left px-3 py-3 font-medium">Szczegóły</th>
                      <th className="text-left px-3 py-3 font-medium">Data</th>
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
                                    ? "VBN Sprawdzanie"
                                    : row.type === "vbn_fix"
                                    ? "VBN Naprawa"
                                    : row.type === "product_create"
                                    ? "Nowy produkt"
                                    : "Photo Upload"}
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
                                      <span className="text-neutral-400 ml-1">(szablon: {row.details.template_name})</span>
                                    )}
                                  </span>
                                )
                                : row.stats && Object.keys(row.stats).length > 0
                                ? Object.entries(row.stats).map(([k, v]) => `${k}: ${v}`).join(", ")
                                : "—"}
                            </td>
                            <td className="px-3 py-3 text-neutral-400 text-xs">
                              {new Date(row.created_at).toLocaleString("pl-PL")}
                            </td>
                          </tr>
                          {isExpanded && fixes.length > 0 && (
                            <tr key={`${row.id}-detail`} className="border-b border-neutral-100 bg-green-50/40">
                              <td colSpan={4} className="px-8 py-3">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-neutral-400 uppercase tracking-wide">
                                      <th className="text-left pb-1 font-medium">Produkt</th>
                                      <th className="text-left pb-1 font-medium">Stary VBN</th>
                                      <th className="text-left pb-1 font-medium"></th>
                                      <th className="text-left pb-1 font-medium">Nowy VBN</th>
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
                <p className="text-lg font-semibold text-neutral-900">Produkt już istnieje!</p>
                <p className="text-sm text-neutral-600 mt-1">
                  Znaleziono produkt{" "}
                  <strong className="text-neutral-800">{showDuplicateWarning.templateName}</strong>{" "}
                  z identyczną nazwą (podobieństwo 100%). Czy na pewno chcesz stworzyć duplikat?
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDuplicateWarning(null)}
                className="px-4 py-2 text-sm border border-neutral-200 rounded-lg text-neutral-600 hover:bg-neutral-50 transition-colors"
              >
                Anuluj
              </button>
              <button
                onClick={() => {
                  handleCreateFromTemplate(showDuplicateWarning.templateId, showDuplicateWarning.templateName);
                  setSelectedTemplateWas100Pct(true);
                  setShowDuplicateWarning(null);
                }}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                Tak, utwórz duplikat
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
                <p className="text-lg font-semibold text-neutral-900">Ostatnie ostrzeżenie!</p>
                <p className="text-sm text-neutral-600 mt-1">
                  Nazwa produktu{" "}
                  <strong className="text-neutral-800">{finalName}</strong>{" "}
                  jest identyczna z istniejącym produktem w FreshPortal. Duplikat zostanie utworzony w systemie.
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowSecondDuplicateWarning(false)}
                className="px-4 py-2 text-sm border border-neutral-200 rounded-lg text-neutral-600 hover:bg-neutral-50 transition-colors"
              >
                Zmień nazwę
              </button>
              <button
                onClick={() => handleConfirmCreate(true)}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                Tak, utwórz mimo to
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
            <p className="px-3 py-2 text-xs text-neutral-400">Brak wyników w Floricode</p>
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
