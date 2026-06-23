"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { translations, Lang } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface Supplier {
  fp_supplier_id: string;
  nm_supplier: string;
  synced: boolean;
  item_count: number;
  synced_at: string | null;
  discovered_at?: string;
}

type SyncState = "idle" | "syncing" | "done" | "error";

interface SupplierSyncState {
  state: SyncState;
  logs: string[];
  error: string;
}

export default function CatalogueSync({ lang }: { lang: Lang }) {
  const t = translations[lang];
  const tc = t.catalogue;

  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<"db" | "scraped" | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [fetchError, setFetchError] = useState("");
  const [syncStates, setSyncStates] = useState<Record<string, SupplierSyncState>>({});
  const logsEndRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [nameFilter, setNameFilter] = useState("");
  const [debugData, setDebugData] = useState<Record<string, unknown> | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);

  const loadSuppliers = useCallback(async (refresh = false) => {
    setLoading(true);
    setFetchError("");
    try {
      const params = new URLSearchParams();
      if (refresh) params.set("refresh", "true");
      const res = await fetch(`${RAILWAY}/catalogue/suppliers?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSuppliers(data.suppliers ?? []);
      setSource(data.source ?? null);
    } catch (e: unknown) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);

  function setSyncField(supplierId: string, patch: Partial<SupplierSyncState>) {
    setSyncStates(prev => ({
      ...prev,
      [supplierId]: {
        ...(prev[supplierId] ?? { state: "idle" as SyncState, logs: [], error: "" }),
        ...patch,
      },
    }));
  }

  function addLog(supplierId: string, msg: string) {
    setSyncStates(prev => {
      const cur = prev[supplierId] ?? { state: "idle" as SyncState, logs: [], error: "" };
      return { ...prev, [supplierId]: { ...cur, logs: [...cur.logs, msg] } };
    });
    setTimeout(() => {
      logsEndRefs.current[supplierId]?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  }

  async function handleDebug() {
    setDebugLoading(true);
    setDebugData(null);
    try {
      const res = await fetch(`${RAILWAY}/catalogue/suppliers?debug=true&refresh=true`);
      const data = await res.json();
      if (data.suppliers) {
        setSuppliers(data.suppliers);
        setSource(data.source ?? null);
      }
      setDebugData(data.debug ?? data);
    } catch (e: unknown) {
      setDebugData({ error: String(e) });
    } finally {
      setDebugLoading(false);
    }
  }

  async function handleSync(supplier: Supplier) {
    const { fp_supplier_id, nm_supplier } = supplier;
    setSyncField(fp_supplier_id, { state: "syncing", logs: [], error: "" });

    const params = new URLSearchParams({ nm_supplier });
    const res = await fetch(
      `${RAILWAY}/catalogue/sync/${fp_supplier_id}/stream?${params}`,
      { method: "POST" }
    );

    if (!res.ok || !res.body) {
      setSyncField(fp_supplier_id, { state: "error", error: await res.text() });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.replace(/^data: /, "").trim();
        if (!line || line.startsWith(":")) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "status") addLog(fp_supplier_id, ev.message);
          if (ev.type === "result") {
            setSyncField(fp_supplier_id, { state: "done" });
            setSuppliers(prev =>
              prev.map(s =>
                s.fp_supplier_id === fp_supplier_id
                  ? { ...s, synced: true, item_count: ev.data.items_saved, synced_at: new Date().toISOString() }
                  : s
              )
            );
          }
          if (ev.type === "error") {
            setSyncField(fp_supplier_id, { state: "error", error: ev.message });
          }
        } catch {}
      }
    }
  }

  function formatDate(iso: string | null | undefined) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString(
      lang === "nl" ? "nl-NL" : lang === "pl" ? "pl-PL" : lang === "es" ? "es-ES" : "en-GB",
      { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }
    );
  }

  const filtered = suppliers.filter(s =>
    !nameFilter || s.nm_supplier.toLowerCase().includes(nameFilter.toLowerCase())
  );

  const syncedCount = suppliers.filter(s => s.synced).length;

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-ink">{tc.title}</h2>
          <p className="text-sm text-ink-3 mt-0.5">{tc.description}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleDebug}
            disabled={debugLoading || loading}
            className="h-8 px-3 rounded-xl text-xs font-medium border border-border text-ink-3 hover:text-ink disabled:opacity-40 transition-colors"
          >
            {debugLoading ? "…" : "Debug"}
          </button>
          <button
            onClick={() => loadSuppliers(true)}
            disabled={loading}
            className="h-8 px-3 rounded-xl text-xs font-medium border border-border text-ink-3 hover:text-ink disabled:opacity-40 transition-colors"
          >
            {loading ? tc.loading : tc.refresh}
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {!loading && suppliers.length > 0 && (
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <span className="px-2.5 py-1 rounded-full bg-muted border border-border text-ink-3 font-medium">
            {suppliers.length} {tc.colSupplier.toLowerCase()}
          </span>
          {syncedCount > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-emerald/10 border border-emerald/20 text-emerald font-medium">
              {syncedCount} {tc.synced}
            </span>
          )}
          {source === "db" && (
            <span className="px-2.5 py-1 rounded-full bg-muted border border-border text-ink-3/60">
              {tc.fromCache}
            </span>
          )}
          {source === "scraped" && (
            <span className="px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-600">
              {tc.justScraped}
            </span>
          )}
        </div>
      )}

      {/* Error */}
      {fetchError && (
        <div className="p-3 rounded-xl bg-red-500/8 border border-red-500/20 text-sm text-red-500 font-mono break-all">
          {fetchError}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !fetchError && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-12 rounded-xl bg-muted animate-pulse" style={{ opacity: 1 - i * 0.15 }}/>
          ))}
        </div>
      )}

      {/* Table */}
      {!loading && suppliers.length > 0 && (
        <div className="rounded-2xl border border-border overflow-hidden flex flex-col">
          {/* Filter bar */}
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-muted/50">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-ink-3 shrink-0">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M10 10l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              value={nameFilter}
              onChange={e => setNameFilter(e.target.value)}
              placeholder={tc.filterPlaceholder}
              className="flex-1 text-sm bg-transparent outline-none text-ink placeholder:text-ink-3/50 min-w-0"
            />
            {nameFilter && (
              <button
                onClick={() => setNameFilter("")}
                className="text-[11px] text-ink-3 hover:text-ink transition-colors shrink-0"
              >
                {tc.clearFilter}
              </button>
            )}
            <span className="text-[11px] text-ink-3 shrink-0 tabular-nums">
              {filtered.length}{nameFilter ? ` / ${suppliers.length}` : ""}
            </span>
          </div>

          {/* Scrollable table body */}
          <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 380px)", minHeight: "200px" }}>
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-muted border-b border-border">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-ink-3 w-10">#</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-ink-3">{tc.colSupplier}</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-ink-3 w-28">{tc.colProducts}</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-ink-3 w-44">{tc.colLastSync}</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-ink-3 w-32">{tc.colAction}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-ink-3">
                      {tc.noMatch}
                    </td>
                  </tr>
                ) : (
                  filtered.map((supplier, idx) => {
                    const ss = syncStates[supplier.fp_supplier_id] ?? { state: "idle" as SyncState, logs: [], error: "" };
                    return (
                      <SupplierRow
                        key={supplier.fp_supplier_id}
                        index={idx + 1}
                        supplier={supplier}
                        syncState={ss}
                        logsEndRef={el => { logsEndRefs.current[supplier.fp_supplier_id] = el; }}
                        onSync={() => handleSync(supplier)}
                        formatDate={formatDate}
                        t={tc}
                      />
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !fetchError && suppliers.length === 0 && (
        <div className="text-center py-12 text-sm text-ink-3">{tc.noSuppliers}</div>
      )}

      {/* Debug panel */}
      {debugData && (
        <details open className="rounded-2xl border border-amber-300/40 bg-amber-50/30 overflow-hidden">
          <summary className="px-4 py-2.5 text-xs font-semibold text-amber-700 cursor-pointer select-none">
            Debug — /supplier/index_v2/index/
          </summary>
          <div className="px-4 pb-4 flex flex-col gap-3 text-xs">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
              <span className="text-ink-3">Final URL</span>
              <span className="text-ink break-all">{String(debugData.final_url ?? "—")}</span>
              <span className="text-ink-3">Page title</span>
              <span className="text-ink">{String(debugData.page_title ?? "—")}</span>
              <span className="text-ink-3">Tables found</span>
              <span className="text-ink">{String(debugData.table_count ?? "—")}</span>
              <span className="text-ink-3">Rows with data-id</span>
              <span className="text-ink">{Array.isArray(debugData.rows_with_dataid) ? (debugData.rows_with_dataid as unknown[]).length : "—"}</span>
              <span className="text-ink-3">Parsed suppliers</span>
              <span className="text-ink font-semibold">{Array.isArray(debugData.parsed_suppliers) ? (debugData.parsed_suppliers as unknown[]).length : "—"}</span>
            </div>
            {Array.isArray(debugData.supplier_links) && (
              <div>
                <p className="text-ink-3 mb-1 font-semibold">Supplier links:</p>
                <div className="bg-muted rounded-lg p-2 max-h-28 overflow-y-auto font-mono text-[10px] text-ink-3 space-y-0.5">
                  {(debugData.supplier_links as string[]).map((l, i) => <div key={i}>{l}</div>)}
                  {(debugData.supplier_links as string[]).length === 0 && <div className="text-amber-600">none</div>}
                </div>
              </div>
            )}
            {Array.isArray(debugData.tr_samples) && (
              <div>
                <p className="text-ink-3 mb-1 font-semibold">First &lt;tr&gt; samples:</p>
                <div className="bg-muted rounded-lg p-2 space-y-1.5 max-h-48 overflow-y-auto font-mono text-[10px] text-ink-3">
                  {(debugData.tr_samples as string[]).map((h, i) => (
                    <div key={i} className="border-b border-border/40 pb-1">
                      <span className="text-emerald font-bold">tr[{i}]: </span>{h}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <details>
              <summary className="text-ink-3 cursor-pointer">HTML snippet (first 3KB)</summary>
              <pre className="mt-1 bg-muted rounded-lg p-2 text-[10px] text-ink-3 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
                {String(debugData.html_snippet ?? "")}
              </pre>
            </details>
          </div>
        </details>
      )}
    </div>
  );
}

function SupplierRow({
  index, supplier, syncState, logsEndRef, onSync, formatDate, t,
}: {
  index: number;
  supplier: Supplier;
  syncState: SupplierSyncState;
  logsEndRef: (el: HTMLDivElement | null) => void;
  onSync: () => void;
  formatDate: (iso: string | null | undefined) => string;
  t: (typeof translations)[Lang]["catalogue"];
}) {
  const { fp_supplier_id, nm_supplier, synced, item_count, synced_at } = supplier;
  const { state, logs, error } = syncState;
  const isSyncing = state === "syncing";
  const isDone = state === "done";
  const isError = state === "error";

  return (
    <>
      <tr className="border-b border-border/60 hover:bg-muted/40 transition-colors">
        <td className="px-4 py-2.5 text-xs text-ink-3 tabular-nums">{index}</td>

        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {synced && state === "idle" ? (
              <span className="relative w-2 h-2 shrink-0">
                <span className="absolute inset-0 rounded-full bg-emerald pulse-ring"/>
                <span className="relative w-2 h-2 rounded-full bg-emerald block"/>
              </span>
            ) : isSyncing ? (
              <svg className="animate-spin w-3 h-3 text-emerald shrink-0" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/>
                <path fill="currentColor" className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : (
              <span className="w-2 h-2 rounded-full bg-ink-3/20 shrink-0"/>
            )}
            <div>
              <span className="font-medium text-ink">{nm_supplier}</span>
              <span className="ml-2 text-[10px] text-ink-3/50 font-mono">#{fp_supplier_id}</span>
            </div>
          </div>
        </td>

        <td className="px-4 py-2.5 text-sm tabular-nums">
          {(synced || isDone) ? (
            <span className="font-semibold text-ink">{item_count.toLocaleString()}</span>
          ) : (
            <span className="text-ink-3/40">—</span>
          )}
        </td>

        <td className="px-4 py-2.5 text-xs text-ink-3">
          {isDone ? (
            <span className="text-emerald font-medium">{t.justSynced}</span>
          ) : isError ? (
            <span className="text-red-500">{t.syncFailed}</span>
          ) : (
            formatDate(synced_at)
          )}
        </td>

        <td className="px-4 py-2.5 text-right">
          <button
            onClick={onSync}
            disabled={isSyncing}
            className={`h-7 px-3 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50
              ${synced && state === "idle"
                ? "border border-border text-ink-3 hover:text-ink hover:border-emerald/40"
                : "bg-emerald text-white hover:bg-emerald/90"
              }`}
          >
            {isSyncing ? t.syncing : synced && state === "idle" ? t.resync : t.syncBtn}
          </button>
        </td>
      </tr>

      {/* Inline log */}
      {(isSyncing || isDone || isError) && logs.length > 0 && (
        <tr className="border-b border-border/60 bg-muted/20">
          <td colSpan={5} className="px-6 pb-3 pt-1">
            <div className="bg-muted rounded-xl p-3 max-h-28 overflow-y-auto font-mono text-[11px] space-y-0.5">
              {logs.map((l, i) => (
                <div key={i} className={
                  l.startsWith("Error") || l.includes("failed") ? "text-red-500" :
                  l.includes("complete") || l.includes("Saving") || l.includes("✓") ? "text-emerald" :
                  "text-ink-3"
                }>{l}</div>
              ))}
              <div ref={logsEndRef}/>
            </div>
            {isError && error && <p className="text-xs text-red-500 mt-1">{error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}
