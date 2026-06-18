"use client";

import { useState, useCallback } from "react";
import { translations, Lang } from "@/lib/i18n";
import { HistoryRow, SyncRun, AutoVbnRun, FixEntry, PhotoUploadItem } from "@/lib/types";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";
const PAGE_SIZE = 10;

interface Props { lang: Lang; }

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 text-emerald" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "ok"
    ? "bg-emerald-light text-emerald"
    : status === "error"
    ? "bg-ember-light text-ember"
    : "bg-amber-50 text-amber-700";
  return <span className={`text-[10px] px-2 py-0.5 rounded-md font-semibold ${cls}`}>{status}</span>;
}

function TypeBadge({ type, t }: { type: string; t: (typeof translations)[Lang] }) {
  const map: Record<string, { label: string; cls: string }> = {
    vbn_check:      { label: t.history.vbnCheck,      cls: "bg-ground text-ink-3 border border-border" },
    vbn_fix:        { label: t.history.vbnFix,        cls: "bg-emerald-light text-emerald" },
    product_create: { label: t.history.productCreate, cls: "bg-ground text-ink border border-border" },
    photo_upload:   { label: t.history.photoUpload,   cls: "bg-amber-50 text-amber-700" },
  };
  const m = map[type] ?? { label: type, cls: "bg-ground text-ink-3 border border-border" };
  return <span className={`text-[10px] px-2 py-0.5 rounded-md font-semibold ${m.cls}`}>{m.label}</span>;
}

export default function HistoryTab({ lang }: Props) {
  const t = translations[lang];
  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";

  const [historySubTab, setHistorySubTab] = useState<"ops" | "sync" | "auto">("ops");

  const [history, setHistory]               = useState<HistoryRow[] | null>(null);
  const [histLoading, setHistLoading]       = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(null);
  const [histOpsOffset, setHistOpsOffset]   = useState(0);
  const [histOpsHasMore, setHistOpsHasMore] = useState(false);

  const [syncHistory, setSyncHistory]           = useState<SyncRun[] | null>(null);
  const [syncHistLoading, setSyncHistLoading]   = useState(false);
  const [expandedSyncId, setExpandedSyncId]     = useState<number | null>(null);
  const [histSyncOffset, setHistSyncOffset]     = useState(0);
  const [histSyncHasMore, setHistSyncHasMore]   = useState(false);

  const [autoVbnHistory, setAutoVbnHistory]         = useState<AutoVbnRun[] | null>(null);
  const [autoVbnHistLoading, setAutoVbnHistLoading] = useState(false);
  const [histAutoOffset, setHistAutoOffset]         = useState(0);
  const [histAutoHasMore, setHistAutoHasMore]       = useState(false);
  const [expandedAutoId, setExpandedAutoId]         = useState<number | null>(null);

  const loadHistory = useCallback(async (append = false) => {
    setHistLoading(true);
    const offset = append ? histOpsOffset : 0;
    try {
      const res = await fetch(`/api/history?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      const rows: HistoryRow[] = data.history ?? [];
      const hasMore: boolean = data.hasMore ?? false;
      if (append) {
        setHistory((prev) => [...(prev ?? []), ...rows]);
        setHistOpsOffset(offset + rows.length);
      } else {
        setHistory(rows);
        setHistOpsOffset(rows.length);
      }
      setHistOpsHasMore(hasMore);
    } catch { /* ignore */ }
    setHistLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histOpsOffset]);

  const loadSyncHistory = useCallback(async (append = false) => {
    if (!RAILWAY) return;
    setSyncHistLoading(true);
    const offset = append ? histSyncOffset : 0;
    try {
      const res = await fetch(`${RAILWAY}/sync/history?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      const rows: SyncRun[] = data.history ?? [];
      const hasMore: boolean = data.hasMore ?? false;
      if (append) {
        setSyncHistory((prev) => [...(prev ?? []), ...rows]);
        setHistSyncOffset(offset + rows.length);
      } else {
        setSyncHistory(rows);
        setHistSyncOffset(rows.length);
      }
      setHistSyncHasMore(hasMore);
    } catch { /* ignore */ }
    setSyncHistLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histSyncOffset]);

  const loadAutoVbnHistory = useCallback(async (append = false) => {
    if (!RAILWAY) return;
    setAutoVbnHistLoading(true);
    const offset = append ? histAutoOffset : 0;
    try {
      const res = await fetch(`${RAILWAY}/vbn-auto/history?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      const rows: AutoVbnRun[] = data.history ?? [];
      const hasMore: boolean = data.hasMore ?? false;
      if (append) {
        setAutoVbnHistory((prev) => [...(prev ?? []), ...rows]);
        setHistAutoOffset(offset + rows.length);
      } else {
        setAutoVbnHistory(rows);
        setHistAutoOffset(rows.length);
      }
      setHistAutoHasMore(hasMore);
    } catch { /* ignore */ }
    setAutoVbnHistLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histAutoOffset]);

  function handleTabSwitch(tab: "ops" | "sync" | "auto") {
    setHistorySubTab(tab);
    if (tab === "ops"  && history === null)        loadHistory();
    if (tab === "sync" && syncHistory === null)     loadSyncHistory();
    if (tab === "auto" && autoVbnHistory === null)  loadAutoVbnHistory();
  }

  useState(() => { loadHistory(); loadSyncHistory(); loadAutoVbnHistory(); });

  function handleRefresh() {
    if (historySubTab === "ops")   loadHistory();
    else if (historySubTab === "sync") loadSyncHistory();
    else loadAutoVbnHistory();
  }

  const isLoading = historySubTab === "ops" ? histLoading
    : historySubTab === "sync" ? syncHistLoading
    : autoVbnHistLoading;

  return (
    <div>
      {/* ── Header ── */}
      <div className="px-6 py-5 border-b border-border flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink">{t.history.title}</h2>
          <p className="text-xs text-ink-3 mt-0.5">{t.history.description}</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="flex-shrink-0 flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink border border-border rounded-lg px-3 py-1.5 bg-surface hover:bg-muted transition-colors disabled:opacity-40"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={isLoading ? "animate-spin" : ""}>
            <path d="M10.5 6A4.5 4.5 0 1 1 6 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            <path d="M6 1.5h3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t.history.refresh}
        </button>
      </div>

      {/* ── Sub-tabs ── */}
      <div className="px-5 py-3 border-b border-border">
        <div className="flex gap-1 bg-ground border border-border rounded-xl p-1 w-fit">
          {(["ops", "sync", "auto"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => handleTabSwitch(tab)}
              className={`text-xs px-4 py-1.5 rounded-lg font-medium transition-colors ${
                historySubTab === tab
                  ? "bg-surface text-ink shadow-sm border border-border"
                  : "text-ink-3 hover:text-ink"
              }`}
            >
              {tab === "ops" ? t.history.subTabOps : tab === "sync" ? t.history.subTabSync : t.history.subTabAutoVbn}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="overflow-y-auto max-h-[calc(100vh-360px)]">

        {/* OPERATIONS */}
        {historySubTab === "ops" && (
          histLoading && history === null ? (
            <div className="flex items-center justify-center gap-2 py-12 text-ink-3 text-sm">
              <Spinner /><span>{t.history.loading}</span>
            </div>
          ) : !history || history.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium text-ink-3">{t.history.empty}</p>
              <p className="text-xs text-ink-3/50 mt-1">{t.history.emptyHint}</p>
            </div>
          ) : (
            <>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-5 py-3 text-[11px] font-medium text-ink-3">{t.history.colType}</th>
                    <th className="text-left px-3 py-3 text-[11px] font-medium text-ink-3">{t.history.colFilter}</th>
                    <th className="text-left px-3 py-3 text-[11px] font-medium text-ink-3">{t.history.colDetails}</th>
                    <th className="text-left px-3 py-3 text-[11px] font-medium text-ink-3">{t.history.colUser}</th>
                    <th className="text-left px-3 py-3 text-[11px] font-medium text-ink-3">{t.history.colDate}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row, rowIdx) => {
                    const fixes: FixEntry[] = row.details?.fixes ?? [];
                    const photoItems: PhotoUploadItem[] = row.details?.items ?? [];
                    const isExpanded = expandedHistoryId === row.id;
                    const canExpand = (row.type === "vbn_fix" && fixes.length > 0) ||
                                      (row.type === "photo_upload" && photoItems.length > 0);
                    return (
                      <>
                        <tr
                          key={row.id}
                          onClick={() => canExpand && setExpandedHistoryId(isExpanded ? null : row.id)}
                          className={`border-b border-border transition-colors card-enter ${canExpand ? "cursor-pointer hover:bg-ground" : "hover:bg-ground/50"}`}
                          style={{ animationDelay: `${Math.min(rowIdx * 20, 300)}ms` }}
                        >
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              {canExpand && (
                                <span className="text-ink-3/40">
                                  {isExpanded ? <ChevronDown /> : <ChevronRight />}
                                </span>
                              )}
                              <TypeBadge type={row.type} t={t} />
                            </div>
                          </td>
                          <td className="px-3 py-3 text-xs font-mono text-ink-3">
                            {row.type === "product_create"
                              ? (row.details?.product_number ?? "—")
                              : row.type === "photo_upload"
                              ? (row.stats?.total != null ? `${row.stats.total}×` : "—")
                              : (row.vbn_filter ?? "—")}
                          </td>
                          <td className="px-3 py-3 text-xs text-ink-3">
                            {row.type === "product_create" ? (
                              <span className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium text-ink">{row.details?.name ?? "—"}</span>
                                {row.details?.template_name && (
                                  <span className="text-ink-3/60 text-[10px]">{t.create.templateLabel} {row.details.template_name}</span>
                                )}
                                {row.details?.success === false && (
                                  <span className="bg-ember-light text-ember text-[10px] px-1.5 py-0.5 rounded-md font-medium">failed</span>
                                )}
                              </span>
                            ) : row.type === "photo_upload" ? (
                              <span className="flex items-center gap-2">
                                {row.stats?.ok != null && Number(row.stats.ok) > 0 && (
                                  <span className="text-emerald font-medium">{String(row.stats.ok)} ok</span>
                                )}
                                {row.stats?.error != null && Number(row.stats.error) > 0 && (
                                  <span className="text-ember font-medium">{String(row.stats.error)} err</span>
                                )}
                              </span>
                            ) : row.stats && Object.keys(row.stats).length > 0
                              ? Object.entries(row.stats).map(([k, v]) => `${k}: ${v}`).join(", ")
                              : "—"}
                          </td>
                          <td className="px-3 py-3 text-[11px] text-ink-3/60 whitespace-nowrap">
                            {row.username ?? <span className="text-ink-3/30">—</span>}
                          </td>
                          <td className="px-3 py-3 text-[11px] text-ink-3/60 whitespace-nowrap">
                            {new Date(row.created_at).toLocaleString(localeStr)}
                          </td>
                        </tr>

                        {/* Expanded: VBN fixes */}
                        {isExpanded && fixes.length > 0 && (
                          <tr key={`${row.id}-fixes`} className="border-b border-border">
                            <td colSpan={5} className="px-8 py-4 bg-emerald-light/20">
                              <div className="divide-y divide-emerald/10">
                                {fixes.map((f, i) => (
                                  <div key={i} className="flex items-center gap-3 py-1.5">
                                    <span className="flex-1 text-xs text-ink min-w-0 truncate">{f.name || f.product_id}</span>
                                    <span className="text-[10px] font-mono bg-ember-light text-ember px-1.5 py-0.5 rounded">{f.old_vbn}</span>
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-ink-3/40 flex-shrink-0">
                                      <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                    <span className="text-[10px] font-mono bg-emerald-light text-emerald px-1.5 py-0.5 rounded">{f.new_vbn}</span>
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}

                        {/* Expanded: Photo upload items */}
                        {isExpanded && row.type === "photo_upload" && photoItems.length > 0 && (
                          <tr key={`${row.id}-photos`} className="border-b border-border">
                            <td colSpan={5} className="px-8 py-4 bg-amber-50/40">
                              <div className="divide-y divide-amber-100">
                                {photoItems.map((item: PhotoUploadItem, i: number) => (
                                  <div key={i} className="flex items-center gap-3 py-1.5">
                                    <span className="text-[10px] font-mono text-ink-3 truncate max-w-40" title={item.filename}>{item.filename}</span>
                                    <span className="flex-1 text-xs text-ink truncate">{item.product_name}</span>
                                    {item.status === "ok"
                                      ? <span className="text-[10px] bg-emerald-light text-emerald px-1.5 py-0.5 rounded-md font-medium">ok</span>
                                      : <span className="text-[10px] bg-ember-light text-ember px-1.5 py-0.5 rounded-md font-medium" title={item.message}>{item.message || "error"}</span>
                                    }
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>

              {/* Load more — sticky inside scroll container */}
              {histOpsHasMore && (
                <div className="sticky bottom-0 border-t border-border bg-surface px-5 py-3 flex justify-center">
                  <button
                    onClick={() => loadHistory(true)}
                    disabled={histLoading}
                    className="flex items-center gap-2 text-xs text-ink-3 hover:text-ink border border-border rounded-lg px-4 py-2 bg-ground hover:bg-muted transition-colors disabled:opacity-40"
                  >
                    {histLoading ? <><Spinner /><span>{t.history.loading}</span></> : t.history.loadMore}
                  </button>
                </div>
              )}
            </>
          )
        )}

        {/* SYNC */}
        {historySubTab === "sync" && (
          syncHistLoading && syncHistory === null ? (
            <div className="flex items-center justify-center gap-2 py-12 text-ink-3 text-sm">
              <Spinner /><span>{t.history.syncLoading}</span>
            </div>
          ) : !syncHistory || syncHistory.length === 0 ? (
            <div className="py-12 text-center text-sm text-ink-3">{t.history.noSyncRuns}</div>
          ) : (
            <>
              <div className="divide-y divide-border">
                {syncHistory.map((run, runIdx) => {
                  const isExp = expandedSyncId === run.id;
                  const dur = run.finished_at
                    ? Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)
                    : null;
                  return (
                    <div key={run.id} className="card-enter" style={{ animationDelay: `${Math.min(runIdx * 20, 300)}ms` }}>
                      <div
                        onClick={() => setExpandedSyncId(isExp ? null : run.id)}
                        className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-ground transition-colors"
                      >
                        <span className="text-ink-3/40 flex-shrink-0">
                          {isExp ? <ChevronDown /> : <ChevronRight />}
                        </span>
                        <StatusBadge status={run.status} />
                        <span className="text-xs text-ink-3 flex-shrink-0">
                          {new Date(run.started_at).toLocaleString(localeStr)}
                        </span>
                        {dur !== null && (
                          <span className="text-[11px] text-ink-3/60 flex-shrink-0">
                            {dur < 60 ? `${dur}s` : `${Math.round(dur / 60)}min`}
                          </span>
                        )}
                        {run.product_count != null && (
                          <span className="text-xs text-ink font-medium flex-shrink-0">
                            {run.product_count.toLocaleString()} {t.history.products}
                          </span>
                        )}
                        {run.error && (
                          <span className="text-xs text-ember truncate flex-1" title={run.error}>{run.error}</span>
                        )}
                        <span className="text-[11px] text-ink-3/40 flex-shrink-0 ml-auto">
                          {(run.messages ?? []).length} {t.history.msgs}
                        </span>
                      </div>
                      {isExp && (
                        <div className="border-t border-border bg-ground/60 px-8 py-3 font-mono text-xs text-ink-3 space-y-0.5 max-h-60 overflow-y-auto">
                          {(run.messages ?? []).length === 0
                            ? <p className="text-ink-3/50 italic">{t.history.noMessages}</p>
                            : (run.messages ?? []).map((msg: string, i: number) => (
                              <div key={i} className={`leading-5 ${
                                msg.startsWith("STOP")                           ? "text-ember font-semibold"
                                : msg.startsWith("Empty")                        ? "text-amber-600"
                                : msg.includes("retry")                          ? "text-amber-500"
                                : msg.includes("complete") || msg.includes("Complete") ? "text-emerald font-medium"
                                : "text-ink-3"
                              }`}>{msg}</div>
                            ))
                          }
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {histSyncHasMore && (
                <div className="sticky bottom-0 border-t border-border bg-surface px-5 py-3 flex justify-center">
                  <button
                    onClick={() => loadSyncHistory(true)}
                    disabled={syncHistLoading}
                    className="flex items-center gap-2 text-xs text-ink-3 hover:text-ink border border-border rounded-lg px-4 py-2 bg-ground hover:bg-muted transition-colors disabled:opacity-40"
                  >
                    {syncHistLoading ? <><Spinner /><span>{t.history.loading}</span></> : t.history.loadMore}
                  </button>
                </div>
              )}
            </>
          )
        )}

        {/* AUTO VBN */}
        {historySubTab === "auto" && (
          autoVbnHistLoading && autoVbnHistory === null ? (
            <div className="flex items-center justify-center gap-2 py-12 text-ink-3 text-sm">
              <Spinner /><span>{t.history.loading}</span>
            </div>
          ) : !autoVbnHistory || autoVbnHistory.length === 0 ? (
            <div className="py-12 text-center text-sm text-ink-3">{t.history.autoVbnNoData}</div>
          ) : (
            <>
              <div className="divide-y divide-border">
                {autoVbnHistory.map((run, runIdx) => {
                  const isExp = expandedAutoId === run.id;
                  const dur = run.finished_at
                    ? Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)
                    : null;
                  const msgCount = (run.messages ?? []).length;
                  const fixCount = (run.fixes ?? []).length;
                  return (
                    <div key={run.id} className="card-enter" style={{ animationDelay: `${Math.min(runIdx * 20, 300)}ms` }}>
                      <div
                        onClick={() => setExpandedAutoId(isExp ? null : run.id)}
                        className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-ground transition-colors"
                      >
                        <span className="text-ink-3/40 flex-shrink-0">
                          {isExp ? <ChevronDown /> : <ChevronRight />}
                        </span>
                        <StatusBadge status={run.status} />
                        <span className="text-xs text-ink-3 flex-shrink-0">
                          {new Date(run.started_at).toLocaleString(localeStr)}
                        </span>
                        {dur !== null && (
                          <span className="text-[11px] text-ink-3/60 flex-shrink-0">
                            {dur < 60 ? `${dur}s` : `${Math.round(dur / 60)}min`}
                          </span>
                        )}
                        {run.checked_count != null && (
                          <span className="text-xs text-ink-3 flex-shrink-0">
                            {run.checked_count} {t.history.autoVbnChecked}
                          </span>
                        )}
                        {run.fixed_count != null && run.fixed_count > 0 && (
                          <span className="text-xs text-emerald font-medium flex-shrink-0">
                            {run.fixed_count} {t.history.autoVbnFixed}
                          </span>
                        )}
                        {run.error && (
                          <span className="text-xs text-ember truncate flex-1" title={run.error}>{run.error}</span>
                        )}
                        <span className="text-[11px] text-ink-3/40 ml-auto flex-shrink-0">
                          {msgCount} {t.history.msgs}
                        </span>
                      </div>

                      {isExp && (
                        <div className="border-t border-border">
                          {msgCount > 0 && (
                            <div className="bg-ground/60 px-8 py-3 font-mono text-xs text-ink-3 space-y-0.5 max-h-60 overflow-y-auto">
                              {(run.messages ?? []).map((msg, i) => (
                                <div key={i} className={`leading-5 ${
                                  msg.startsWith("Fix FAILED") || msg.startsWith("ERROR") ? "text-ember font-semibold"
                                  : msg.startsWith("Fix fixed")                           ? "text-emerald font-medium"
                                  : msg.startsWith("ERROR —") || msg.startsWith("WARNING —") ? "text-amber-600"
                                  : msg.startsWith("OK —")                                ? "text-ink-3/50"
                                  : msg.startsWith("Done:")                               ? "text-emerald font-medium"
                                  : "text-ink-3"
                                }`}>{msg}</div>
                              ))}
                            </div>
                          )}
                          {fixCount > 0 && (
                            <div className="bg-emerald-light/20 px-8 py-4">
                              <div className="divide-y divide-emerald/10">
                                {(run.fixes ?? []).map((f, i) => (
                                  <div key={i} className="flex items-center gap-3 py-1.5">
                                    <span className="flex-1 text-xs text-ink min-w-0 truncate">{f.name || f.product_id}</span>
                                    <span className="text-[10px] font-mono bg-ember-light text-ember px-1.5 py-0.5 rounded">{f.old_vbn}</span>
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-ink-3/40 flex-shrink-0">
                                      <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                    <span className="text-[10px] font-mono bg-emerald-light text-emerald px-1.5 py-0.5 rounded">{f.new_vbn}</span>
                                    {f.ok
                                      ? <span className="text-[10px] bg-emerald-light text-emerald px-1.5 py-0.5 rounded-md">ok</span>
                                      : <span className="text-[10px] bg-ember-light text-ember px-1.5 py-0.5 rounded-md">failed</span>
                                    }
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {msgCount === 0 && fixCount === 0 && (
                            <div className="bg-ground/60 px-8 py-3 text-xs text-ink-3/50 italic">{t.history.noMessages}</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {histAutoHasMore && (
                <div className="sticky bottom-0 border-t border-border bg-surface px-5 py-3 flex justify-center">
                  <button
                    onClick={() => loadAutoVbnHistory(true)}
                    disabled={autoVbnHistLoading}
                    className="flex items-center gap-2 text-xs text-ink-3 hover:text-ink border border-border rounded-lg px-4 py-2 bg-ground hover:bg-muted transition-colors disabled:opacity-40"
                  >
                    {autoVbnHistLoading ? <><Spinner /><span>{t.history.loading}</span></> : t.history.loadMore}
                  </button>
                </div>
              )}
            </>
          )
        )}

      </div>
    </div>
  );
}
