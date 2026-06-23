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
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [fetchError, setFetchError] = useState("");
  const [syncStates, setSyncStates] = useState<Record<string, SupplierSyncState>>({});
  const logsEndRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [debugData, setDebugData] = useState<Record<string, unknown> | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);

  // Load suppliers on mount
  const loadSuppliers = useCallback(async () => {
    setLoading(true);
    setFetchError("");
    try {
      const res = await fetch(`${RAILWAY}/catalogue/suppliers`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSuppliers(data.suppliers ?? []);
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
      [supplierId]: { ...(prev[supplierId] ?? { state: "idle" as SyncState, logs: [], error: "" }), ...patch },
    }));
  }

  function addLog(supplierId: string, msg: string) {
    setSyncStates(prev => {
      const cur = prev[supplierId] ?? { state: "idle", logs: [], error: "" };
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
      const res = await fetch(`${RAILWAY}/catalogue/suppliers?debug=true`);
      const data = await res.json();
      // Merge suppliers into state and show the debug block
      if (data.suppliers) setSuppliers(data.suppliers);
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
            // Update supplier row in list
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

  function formatDate(iso: string | null) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString(lang === "nl" ? "nl-NL" : lang === "pl" ? "pl-PL" : lang === "es" ? "es-ES" : "en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

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
            disabled={debugLoading}
            className="h-8 px-3 rounded-xl text-xs font-medium border border-border text-ink-3 hover:text-ink disabled:opacity-40 transition-colors"
          >
            {debugLoading ? "…" : "Debug"}
          </button>
          <button
            onClick={loadSuppliers}
            disabled={loading}
            className="h-8 px-3 rounded-xl text-xs font-medium border border-border text-ink-3 hover:text-ink disabled:opacity-40 transition-colors"
          >
            {loading ? tc.loading : tc.refresh}
          </button>
        </div>
      </div>

      {/* Debug panel */}
      {debugData && (
        <details open className="rounded-2xl border border-amber-300/40 bg-amber-50/30 overflow-hidden">
          <summary className="px-4 py-2.5 text-xs font-semibold text-amber-700 cursor-pointer select-none">
            Debug — /supplier/index/index/
          </summary>
          <div className="px-4 pb-4 flex flex-col gap-3 text-xs">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
              <span className="text-ink-3">Final URL</span>
              <span className="text-ink break-all">{String(debugData.final_url ?? "—")}</span>
              <span className="text-ink-3">Page title</span>
              <span className="text-ink">{String(debugData.page_title ?? "—")}</span>
              <span className="text-ink-3">Tables found</span>
              <span className="text-ink">{String(debugData.table_count ?? "—")}</span>
              <span className="text-ink-3">Total &lt;tr&gt; elements</span>
              <span className="text-ink">{Array.isArray(debugData.all_tr_samples) ? `${(debugData.all_tr_samples as unknown[]).length} shown (of all)` : "—"}</span>
              <span className="text-ink-3">Rows with data-id</span>
              <span className="text-ink">{Array.isArray(debugData.rows_with_dataid) ? (debugData.rows_with_dataid as unknown[]).length : "—"}</span>
              <span className="text-ink-3">Parsed suppliers</span>
              <span className="text-ink font-semibold">{Array.isArray(debugData.parsed_suppliers) ? (debugData.parsed_suppliers as unknown[]).length : "—"}</span>
            </div>

            {Array.isArray(debugData.parsed_suppliers) && (debugData.parsed_suppliers as {fp_supplier_id: string; nm_supplier: string}[]).length > 0 && (
              <div>
                <p className="text-ink-3 mb-1 font-semibold">Parsed suppliers:</p>
                <div className="bg-muted rounded-lg p-2 space-y-0.5 max-h-32 overflow-y-auto">
                  {(debugData.parsed_suppliers as {fp_supplier_id: string; nm_supplier: string}[]).map((s, i) => (
                    <div key={i} className="text-ink font-mono">ID {s.fp_supplier_id} — {s.nm_supplier}</div>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(debugData.all_tr_samples) && (
              <div>
                <p className="text-ink-3 mb-1 font-semibold">First &lt;tr&gt; samples (raw HTML):</p>
                <div className="bg-muted rounded-lg p-2 space-y-2 max-h-48 overflow-y-auto font-mono text-[10px] text-ink-3">
                  {(debugData.all_tr_samples as string[]).map((html, i) => (
                    <div key={i} className="border-b border-border/40 pb-1">
                      <span className="text-emerald font-bold">tr[{i}]: </span>{html}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(debugData.all_links) && (
              <div>
                <p className="text-ink-3 mb-1 font-semibold">All links ({(debugData.all_links as string[]).length}):</p>
                <div className="bg-muted rounded-lg p-2 max-h-32 overflow-y-auto font-mono text-[10px] text-ink-3 space-y-0.5">
                  {(debugData.all_links as string[]).filter(l => /supplier/i.test(l)).map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                  {(debugData.all_links as string[]).filter(l => /supplier/i.test(l)).length === 0 && (
                    <div className="text-amber-600">No links containing "supplier" found</div>
                  )}
                </div>
              </div>
            )}

            <details>
              <summary className="text-ink-3 cursor-pointer">HTML snippet (first 4KB)</summary>
              <pre className="mt-1 bg-muted rounded-lg p-2 text-[10px] text-ink-3 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
                {String(debugData.html_snippet ?? "")}
              </pre>
            </details>
          </div>
        </details>
      )}

      {/* Error loading supplier list */}
      {fetchError && (
        <div className="p-3 rounded-xl bg-red-500/8 border border-red-500/20 text-sm text-red-500">
          {fetchError}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !fetchError && (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-14 rounded-2xl bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {/* Supplier table */}
      {!loading && suppliers.length > 0 && (
        <div className="rounded-2xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted border-b border-border">
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-ink-3">{tc.colSupplier}</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-ink-3 w-32">{tc.colProducts}</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-ink-3 w-44">{tc.colLastSync}</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-ink-3 w-36">{tc.colAction}</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map(supplier => {
                const ss = syncStates[supplier.fp_supplier_id] ?? { state: "idle", logs: [], error: "" };
                const isSyncing = ss.state === "syncing";
                return (
                  <SupplierRow
                    key={supplier.fp_supplier_id}
                    supplier={supplier}
                    syncState={ss}
                    logsEndRef={el => { logsEndRefs.current[supplier.fp_supplier_id] = el; }}
                    onSync={() => handleSync(supplier)}
                    formatDate={formatDate}
                    t={tc}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!loading && !fetchError && suppliers.length === 0 && (
        <div className="text-center py-12 text-sm text-ink-3">
          {tc.noSuppliers}
        </div>
      )}
    </div>
  );
}

function SupplierRow({
  supplier, syncState, logsEndRef, onSync, formatDate, t,
}: {
  supplier: Supplier;
  syncState: SupplierSyncState;
  logsEndRef: (el: HTMLDivElement | null) => void;
  onSync: () => void;
  formatDate: (iso: string | null) => string;
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
        {/* Supplier name + sync indicator */}
        <td className="px-4 py-3">
          <div className="flex items-center gap-2.5">
            {synced && state === "idle" ? (
              <span className="relative w-2 h-2 flex-shrink-0">
                <span className="absolute inset-0 rounded-full bg-emerald pulse-ring"/>
                <span className="relative w-2 h-2 rounded-full bg-emerald block"/>
              </span>
            ) : isSyncing ? (
              <svg className="animate-spin w-3.5 h-3.5 text-emerald flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/>
                <path fill="currentColor" className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : (
              <span className="w-2 h-2 rounded-full bg-ink-3/20 flex-shrink-0"/>
            )}
            <div>
              <div className="font-medium text-ink">{nm_supplier}</div>
              <div className="text-[11px] text-ink-3 font-mono">ID: {fp_supplier_id}</div>
            </div>
          </div>
        </td>

        {/* Product count */}
        <td className="px-4 py-3 text-sm">
          {synced || isDone ? (
            <span className="font-semibold text-ink">{item_count.toLocaleString()}</span>
          ) : (
            <span className="text-ink-3/50">—</span>
          )}
        </td>

        {/* Last sync */}
        <td className="px-4 py-3 text-xs text-ink-3">
          {isDone ? (
            <span className="text-emerald font-medium">{t.justSynced}</span>
          ) : isError ? (
            <span className="text-red-500">{t.syncFailed}</span>
          ) : (
            formatDate(synced_at)
          )}
        </td>

        {/* Action */}
        <td className="px-4 py-3 text-right">
          <button
            onClick={onSync}
            disabled={isSyncing}
            className={`h-7 px-3 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50
              ${synced && state === "idle"
                ? "border border-border text-ink-3 hover:text-ink hover:border-emerald/40"
                : "bg-emerald text-white hover:bg-emerald/90"
              }`}
          >
            {isSyncing
              ? t.syncing
              : synced && state === "idle"
                ? t.resync
                : t.syncBtn
            }
          </button>
        </td>
      </tr>

      {/* Expandable log row */}
      {(isSyncing || isDone || isError) && logs.length > 0 && (
        <tr className="border-b border-border/60 bg-muted/30">
          <td colSpan={4} className="px-6 pb-3 pt-1">
            <div className="bg-muted rounded-xl p-3 max-h-32 overflow-y-auto font-mono text-[11px] space-y-0.5">
              {logs.map((l, i) => (
                <div key={i} className={
                  l.startsWith("Error") || l.includes("failed") ? "text-red-500" :
                  l.includes("complete") || l.includes("Saving") ? "text-emerald" :
                  "text-ink-3"
                }>
                  {l}
                </div>
              ))}
              <div ref={logsEndRef}/>
            </div>
            {isError && error && (
              <p className="text-xs text-red-500 mt-1.5">{error}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
