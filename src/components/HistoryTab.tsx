"use client";

import { useState, useCallback } from "react";
import { translations, Lang } from "@/lib/i18n";
import { HistoryRow, SyncRun, AutoVbnRun, FixEntry, PhotoUploadItem } from "@/lib/types";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";
const PAGE_SIZE = 10;

interface Props {
  lang: Lang;
}

export default function HistoryTab({ lang }: Props) {
  const t = translations[lang];
  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";

  const [historySubTab, setHistorySubTab] = useState<"ops" | "sync" | "auto">("ops");

  // Ops history
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(null);
  const [histOpsOffset, setHistOpsOffset] = useState(0);
  const [histOpsHasMore, setHistOpsHasMore] = useState(false);

  // Sync history
  const [syncHistory, setSyncHistory] = useState<SyncRun[] | null>(null);
  const [syncHistLoading, setSyncHistLoading] = useState(false);
  const [expandedSyncId, setExpandedSyncId] = useState<number | null>(null);
  const [histSyncOffset, setHistSyncOffset] = useState(0);
  const [histSyncHasMore, setHistSyncHasMore] = useState(false);

  // Auto VBN history
  const [autoVbnHistory, setAutoVbnHistory] = useState<AutoVbnRun[] | null>(null);
  const [autoVbnHistLoading, setAutoVbnHistLoading] = useState(false);
  const [histAutoOffset, setHistAutoOffset] = useState(0);
  const [histAutoHasMore, setHistAutoHasMore] = useState(false);
  const [expandedAutoId, setExpandedAutoId] = useState<number | null>(null);

  const loadHistory = useCallback(async (append = false) => {
    setHistLoading(true);
    const offset = append ? histOpsOffset : 0;
    try {
      const res = await fetch(`/api/history?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      const rows: HistoryRow[] = data.history ?? [];
      const hasMore: boolean = data.hasMore ?? false;
      if (append) {
        setHistory((prev: HistoryRow[] | null) => [...(prev ?? []), ...rows]);
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
        setSyncHistory((prev: SyncRun[] | null) => [...(prev ?? []), ...rows]);
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
        setAutoVbnHistory((prev: AutoVbnRun[] | null) => [...(prev ?? []), ...rows]);
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
    if (tab === "ops" && history === null) loadHistory();
    if (tab === "sync" && syncHistory === null) loadSyncHistory();
    if (tab === "auto" && autoVbnHistory === null) loadAutoVbnHistory();
  }

  // Load ops on first mount
  useState(() => { loadHistory(); loadSyncHistory(); loadAutoVbnHistory(); });

  function handleRefresh() {
    if (historySubTab === "ops") loadHistory();
    else if (historySubTab === "sync") loadSyncHistory();
    else loadAutoVbnHistory();
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6 flex justify-between items-start">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">{t.history.title}</h1>
          <p className="text-sm text-neutral-500 mt-1">{t.history.description}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-0.5 bg-neutral-100 rounded-lg p-1">
            {(["ops", "sync", "auto"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => handleTabSwitch(tab)}
                className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                  historySubTab === tab
                    ? "bg-white text-neutral-800 shadow-sm"
                    : "text-neutral-500 hover:text-neutral-700"
                }`}
              >
                {tab === "ops" ? t.history.subTabOps : tab === "sync" ? t.history.subTabSync : t.history.subTabAutoVbn}
              </button>
            ))}
          </div>
          <button
            onClick={handleRefresh}
            className="text-sm text-violet-600 hover:text-violet-700 border border-violet-200 rounded-lg px-3 py-1.5"
          >
            {t.history.refresh}
          </button>
        </div>
      </div>

      {/* Sync sub-tab */}
      {historySubTab === "sync" && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          {syncHistLoading && syncHistory === null ? (
            <div className="p-8 text-center text-sm text-neutral-400">{t.history.syncLoading}</div>
          ) : !syncHistory || syncHistory.length === 0 ? (
            <div className="p-6 text-center text-xs text-neutral-400">{t.history.noSyncRuns}</div>
          ) : (
            <>
              <div className="divide-y divide-neutral-50">
                {syncHistory.map((run) => {
                  const isExp = expandedSyncId === run.id;
                  const dur = run.finished_at
                    ? Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)
                    : null;
                  return (
                    <>
                      <div
                        key={run.id}
                        onClick={() => setExpandedSyncId(isExp ? null : run.id)}
                        className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-neutral-50 transition-colors"
                      >
                        <span className="text-neutral-300 text-xs w-3">{isExp ? "▼" : "▶"}</span>
                        <span className={`text-xs px-2 py-0.5 rounded font-medium flex-shrink-0 ${
                          run.status === "ok" ? "bg-green-50 text-green-700"
                          : run.status === "error" ? "bg-red-50 text-red-600"
                          : "bg-amber-50 text-amber-700"
                        }`}>{run.status}</span>
                        <span className="text-xs text-neutral-500 flex-shrink-0">
                          {new Date(run.started_at).toLocaleString(localeStr)}
                        </span>
                        {dur !== null && (
                          <span className="text-xs text-neutral-400 flex-shrink-0">{dur < 60 ? `${dur}s` : `${Math.round(dur/60)}min`}</span>
                        )}
                        {run.product_count != null && (
                          <span className="text-xs text-neutral-600 font-medium flex-shrink-0">{run.product_count.toLocaleString()} {t.history.products}</span>
                        )}
                        {run.error && (
                          <span className="text-xs text-red-500 truncate flex-1" title={run.error}>{run.error}</span>
                        )}
                        <span className="text-xs text-neutral-300 flex-shrink-0">{(run.messages ?? []).length} {t.history.msgs}</span>
                      </div>
                      {isExp && (
                        <div key={`${run.id}-msgs`} className="bg-neutral-50 border-t border-neutral-100 px-8 py-3 font-mono text-xs text-neutral-600 space-y-0.5 max-h-80 overflow-y-auto">
                          {(run.messages ?? []).length === 0
                            ? <p className="text-neutral-400 italic">{t.history.noMessages}</p>
                            : (run.messages ?? []).map((msg: string, i: number) => (
                              <div key={i} className={`leading-5 ${
                                msg.startsWith("STOP") ? "text-red-600 font-semibold"
                                : msg.startsWith("Empty") ? "text-amber-600"
                                : msg.startsWith("will retry") || msg.includes("retry") ? "text-amber-500"
                                : msg.includes("complete") || msg.includes("Complete") ? "text-green-600 font-medium"
                                : ""
                              }`}>{msg}</div>
                            ))
                          }
                        </div>
                      )}
                    </>
                  );
                })}
              </div>
              {histSyncHasMore && (
                <div className="px-5 py-3 border-t border-neutral-100 text-center">
                  <button
                    onClick={() => loadSyncHistory(true)}
                    disabled={syncHistLoading}
                    className="text-xs text-violet-600 hover:text-violet-700 disabled:opacity-40 font-medium"
                  >
                    {syncHistLoading ? t.history.syncLoading : t.history.loadMore}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Operations sub-tab */}
      {historySubTab === "ops" && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          {histLoading && history === null ? (
            <div className="p-8 text-center text-sm text-neutral-400">{t.history.loading}</div>
          ) : !history || history.length === 0 ? (
            <div className="p-8 text-center text-sm text-neutral-400">
              {t.history.empty}
              <p className="text-xs mt-1 text-neutral-300">{t.history.emptyHint}</p>
            </div>
          ) : (
            <>
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
                          className={`border-b border-neutral-50 transition-colors ${canExpand ? "cursor-pointer hover:bg-neutral-50" : "hover:bg-neutral-50"}`}
                        >
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              {canExpand && <span className="text-neutral-300 text-xs">{isExpanded ? "▼" : "▶"}</span>}
                              <span className={`text-xs px-2 py-1 rounded font-medium ${
                                row.type === "vbn_check" ? "bg-violet-50 text-violet-700"
                                : row.type === "vbn_fix" ? "bg-green-50 text-green-700"
                                : row.type === "product_create" ? "bg-blue-50 text-blue-700"
                                : row.type === "photo_upload" ? "bg-amber-50 text-amber-700"
                                : "bg-neutral-100 text-neutral-600"
                              }`}>
                                {row.type === "vbn_check" ? t.history.vbnCheck
                                  : row.type === "vbn_fix" ? t.history.vbnFix
                                  : row.type === "product_create" ? t.history.productCreate
                                  : row.type === "photo_upload" ? t.history.photoUpload
                                  : row.type}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-neutral-600 font-mono text-xs">
                            {row.type === "product_create"
                              ? (row.details?.product_number ?? "—")
                              : row.type === "photo_upload"
                              ? (row.stats?.total != null ? `${row.stats.total} upload${Number(row.stats.total) !== 1 ? "s" : ""}` : "—")
                              : (row.vbn_filter ?? "—")}
                          </td>
                          <td className="px-3 py-3 text-neutral-500 text-xs">
                            {row.type === "product_create" ? (
                              <span>
                                <span className="font-medium text-neutral-700">{row.details?.name ?? "—"}</span>
                                {row.details?.template_name && (
                                  <span className="text-neutral-400 ml-1">({t.create.templateLabel} {row.details.template_name})</span>
                                )}
                              </span>
                            ) : row.type === "photo_upload" ? (
                              <span className="flex items-center gap-2">
                                {row.stats?.ok != null && Number(row.stats.ok) > 0 && (
                                  <span className="text-green-600 font-medium">{String(row.stats.ok)} ok</span>
                                )}
                                {row.stats?.error != null && Number(row.stats.error) > 0 && (
                                  <span className="text-red-500 font-medium">{String(row.stats.error)} error</span>
                                )}
                              </span>
                            ) : row.stats && Object.keys(row.stats).length > 0
                            ? Object.entries(row.stats).map(([k, v]) => `${k}: ${v}`).join(", ")
                            : "—"}
                          </td>
                          <td className="px-3 py-3 text-neutral-400 text-xs">
                            {new Date(row.created_at).toLocaleString(localeStr)}
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
                                      <td className="py-1.5 pr-2"><span className="bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-mono">{f.old_vbn}</span></td>
                                      <td className="py-1.5 px-2 text-neutral-300">→</td>
                                      <td className="py-1.5"><span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-mono">{f.new_vbn}</span></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                        {isExpanded && row.type === "photo_upload" && photoItems.length > 0 && (
                          <tr key={`${row.id}-photos`} className="border-b border-neutral-100 bg-amber-50/30">
                            <td colSpan={4} className="px-8 py-3">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-neutral-400 uppercase tracking-wide">
                                    <th className="text-left pb-1 font-medium">{t.history.fileCol}</th>
                                    <th className="text-left pb-1 font-medium">{t.history.expandProduct}</th>
                                    <th className="text-left pb-1 font-medium">{t.history.statusCol}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {photoItems.map((item: PhotoUploadItem, i: number) => (
                                    <tr key={i} className="border-t border-amber-100">
                                      <td className="py-1.5 pr-4 text-neutral-500 font-mono truncate max-w-48" title={item.filename}>{item.filename}</td>
                                      <td className="py-1.5 pr-4 text-neutral-700">{item.product_name}</td>
                                      <td className="py-1.5">
                                        {item.status === "ok"
                                          ? <span className="bg-green-50 text-green-700 px-1.5 py-0.5 rounded">ok</span>
                                          : <span className="bg-red-50 text-red-600 px-1.5 py-0.5 rounded" title={item.message}>{item.message || "error"}</span>
                                        }
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
              {histOpsHasMore && (
                <div className="px-5 py-3 border-t border-neutral-100 text-center">
                  <button
                    onClick={() => loadHistory(true)}
                    disabled={histLoading}
                    className="text-xs text-violet-600 hover:text-violet-700 disabled:opacity-40 font-medium"
                  >
                    {histLoading ? t.history.loading : t.history.loadMore}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Auto VBN sub-tab */}
      {historySubTab === "auto" && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          {autoVbnHistLoading && autoVbnHistory === null ? (
            <div className="p-8 text-center text-sm text-neutral-400">{t.history.loading}</div>
          ) : !autoVbnHistory || autoVbnHistory.length === 0 ? (
            <div className="p-6 text-center text-xs text-neutral-400">{t.history.autoVbnNoData}</div>
          ) : (
            <>
              <div className="divide-y divide-neutral-50">
                {autoVbnHistory.map((run) => {
                  const isExp = expandedAutoId === run.id;
                  const dur = run.finished_at
                    ? Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)
                    : null;
                  return (
                    <>
                      <div
                        key={run.id}
                        onClick={() => setExpandedAutoId(isExp ? null : run.id)}
                        className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-neutral-50 transition-colors"
                      >
                        <span className="text-neutral-300 text-xs w-3">{isExp ? "▼" : "▶"}</span>
                        <span className={`text-xs px-2 py-0.5 rounded font-medium flex-shrink-0 ${
                          run.status === "ok" ? "bg-green-50 text-green-700"
                          : run.status === "error" ? "bg-red-50 text-red-600"
                          : "bg-amber-50 text-amber-700"
                        }`}>{run.status}</span>
                        <span className="text-xs text-neutral-500 flex-shrink-0">
                          {new Date(run.started_at).toLocaleString(localeStr)}
                        </span>
                        {dur !== null && (
                          <span className="text-xs text-neutral-400 flex-shrink-0">{dur < 60 ? `${dur}s` : `${Math.round(dur/60)}min`}</span>
                        )}
                        {run.checked_count != null && (
                          <span className="text-xs text-neutral-600 flex-shrink-0">{run.checked_count} {t.history.autoVbnChecked}</span>
                        )}
                        {run.fixed_count != null && run.fixed_count > 0 && (
                          <span className="text-xs text-green-600 font-medium flex-shrink-0">{run.fixed_count} {t.history.autoVbnFixed}</span>
                        )}
                        {run.error && (
                          <span className="text-xs text-red-500 truncate flex-1" title={run.error}>{run.error}</span>
                        )}
                      </div>
                      {isExp && (run.fixes ?? []).length > 0 && (
                        <div key={`${run.id}-fixes`} className="bg-neutral-50 border-t border-neutral-100 px-8 py-3">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-neutral-400 uppercase tracking-wide">
                                <th className="text-left pb-1 font-medium">{t.history.expandProduct}</th>
                                <th className="text-left pb-1 font-medium">{t.history.expandOldVbn}</th>
                                <th className="text-left pb-1 font-medium"></th>
                                <th className="text-left pb-1 font-medium">{t.history.expandNewVbn}</th>
                                <th className="text-left pb-1 font-medium">{t.history.statusCol}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(run.fixes ?? []).map((f, i) => (
                                <tr key={i} className="border-t border-neutral-100">
                                  <td className="py-1.5 pr-4 text-neutral-700">{f.name || f.product_id}</td>
                                  <td className="py-1.5 pr-2"><span className="bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-mono">{f.old_vbn}</span></td>
                                  <td className="py-1.5 px-2 text-neutral-300">→</td>
                                  <td className="py-1.5 pr-4"><span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-mono">{f.new_vbn}</span></td>
                                  <td className="py-1.5">
                                    {f.ok
                                      ? <span className="bg-green-50 text-green-700 px-1.5 py-0.5 rounded">ok</span>
                                      : <span className="bg-red-50 text-red-600 px-1.5 py-0.5 rounded">failed</span>
                                    }
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  );
                })}
              </div>
              {histAutoHasMore && (
                <div className="px-5 py-3 border-t border-neutral-100 text-center">
                  <button
                    onClick={() => loadAutoVbnHistory(true)}
                    disabled={autoVbnHistLoading}
                    className="text-xs text-violet-600 hover:text-violet-700 disabled:opacity-40 font-medium"
                  >
                    {autoVbnHistLoading ? t.history.loading : t.history.loadMore}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
