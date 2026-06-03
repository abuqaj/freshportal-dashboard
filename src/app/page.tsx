"use client";

import { useState, useCallback } from "react";
import { flushSync } from "react-dom";

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

type HistoryRow = {
  id: number;
  type: string;
  vbn_filter: string | null;
  stats: Stats;
  created_at: string;
};

export default function Dashboard() {
  const [tab, setTab] = useState<"vbn" | "photos" | "history">("vbn");

  // VBN state
  const [vbnInput, setVbnInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [results, setResults] = useState<VbnResult[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixMessage, setFixMessage] = useState<string | null>(null);

  // History
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [histLoading, setHistLoading] = useState(false);

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
      .map((r) => ({ product_id: r.product_id, new_vbn: r.edited_vbn!.trim() }));

    if (toFix.length === 0) {
      setFixMessage("Brak produktów do poprawy.");
      return;
    }

    setFixing(true);
    setFixMessage(null);
    try {
      const res = await fetch(`${RAILWAY}/vbn-fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixes: toFix }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Railway error");
      setFixMessage(`✓ Poprawiono ${data.fixed} produktów. ${data.failed > 0 ? `${data.failed} nieudanych.` : ""}`);
      // Log to Vercel DB (fire-and-forget)
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
    } catch (e: unknown) {
      setFixMessage(`Błąd: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFixing(false);
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

            {/* Search bar */}
            <div className="bg-white border border-neutral-200 rounded-xl p-5 mb-5">
              <label className="block text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wide">
                Kod VBN do sprawdzenia
              </label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={vbnInput}
                  onChange={(e) => setVbnInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCheck()}
                  placeholder="np. 580"
                  className="border border-neutral-200 rounded-lg px-4 py-2.5 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
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
                          <td className="px-3 py-3">
                            <input
                              type="text"
                              value={r.edited_vbn ?? ""}
                              onChange={(e) => updateVbn(r.product_id, e.target.value)}
                              disabled={r.excluded}
                              placeholder="wpisz VBN"
                              className="border border-neutral-200 rounded px-2 py-1 text-xs w-24 focus:outline-none focus:ring-1 focus:ring-violet-300 disabled:bg-neutral-50"
                            />
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
                          className={`text-xs px-3 py-1.5 rounded-lg ${
                            fixMessage.startsWith("✓")
                              ? "bg-green-50 text-green-700"
                              : "bg-red-50 text-red-600"
                          }`}
                        >
                          {fixMessage}
                        </span>
                      )}
                      <button
                        onClick={handleFix}
                        disabled={fixing}
                        className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
                      >
                        {fixing ? "Poprawiam w FreshPortal…" : "Zatwierdź i popraw w FreshPortal"}
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
                      <th className="text-left px-3 py-3 font-medium">Filtr VBN</th>
                      <th className="text-left px-3 py-3 font-medium">Statystyki</th>
                      <th className="text-left px-3 py-3 font-medium">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row) => (
                      <tr key={row.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                        <td className="px-5 py-3">
                          <span
                            className={`text-xs px-2 py-1 rounded font-medium ${
                              row.type === "vbn_check"
                                ? "bg-violet-50 text-violet-700"
                                : row.type === "vbn_fix"
                                ? "bg-green-50 text-green-700"
                                : "bg-blue-50 text-blue-700"
                            }`}
                          >
                            {row.type === "vbn_check"
                              ? "VBN Sprawdzanie"
                              : row.type === "vbn_fix"
                              ? "VBN Naprawa"
                              : "Photo Upload"}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-neutral-600">{row.vbn_filter ?? "—"}</td>
                        <td className="px-3 py-3 text-neutral-500 text-xs">
                          {row.stats
                            ? Object.entries(row.stats)
                                .map(([k, v]) => `${k}: ${v}`)
                                .join(", ")
                            : "—"}
                        </td>
                        <td className="px-3 py-3 text-neutral-400 text-xs">
                          {new Date(row.created_at).toLocaleString("pl-PL")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
