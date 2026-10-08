"use client";

import { useState, useCallback, useEffect, type ReactNode } from "react";
import {
  ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, Clock, Database, Download, FileText, History as HistoryIcon, List,
  Loader2, Package, RefreshCw, Scale, TriangleAlert, X, Zap,
} from "lucide-react";
import { translations, Lang } from "@/lib/i18n";
import { saveBlob } from "@/lib/save-blob";
import { HistoryRow, SyncRun, AutoVbnRun, FixEntry, PhotoUploadItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { Chip, Code, EmptyState, IconButton, ModuleHeader, ModuleTabs, SubTabs } from "@/components/ui/kit";
import { ModuleIcon, moduleColors, type Tab } from "@/components/shell/modules";
import { cn } from "@/lib/utils";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";
const PAGE_SIZE = 10;

interface Props { lang: Lang; }

type HistSubTab = "ops" | "sync" | "auto" | "delivery" | "boxweight";

/** NUMERIC columns come back from psycopg2 as strings to preserve precision,
 *  so these accept both and fall back to a dash rather than printing NaN. */
function fmtNum(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value);
}
function fmtKg(value: string | number | null | undefined): string {
  const n = fmtNum(value);
  return n === "—" ? n : `${n} kg`;
}

/** Which module an operation belongs to: its row shows that module's icon in
 *  the module's own colours (user, 2026-10-07). */
const OP_MODULE: Record<string, Tab> = { vbn_check: "vbn", vbn_fix: "vbn", product_create: "create", photo_upload: "photos" };

function OpIcon({ tab }: { tab: Tab }) {
  return (
    <span style={moduleColors(tab)}
      className="grid size-7 flex-none place-items-center rounded-[9px] bg-[linear-gradient(135deg,var(--g1),var(--g2))] text-white [--ic-bg:var(--g1)]">
      <ModuleIcon id={tab} className="size-4" />
    </span>
  );
}

/** A run's outcome as the backend words it, in the palette's tones. */
function StatusChip({ status }: { status: string }) {
  return status === "ok"
    ? <Chip tone="ok" icon={Check}>{status}</Chip>
    : status === "error"
    ? <Chip tone="bad" icon={CircleAlert}>{status}</Chip>
    : <Chip tone="warn" icon={TriangleAlert}>{status}</Chip>;
}

/** A row's facts: beside its name, or on a line of their own on a phone,
 *  under the name (the chevron and the icon are 64 px). */
const DETAILS = "order-last flex w-full min-w-0 flex-wrap items-center gap-1.5 pl-16 sm:order-none sm:w-auto sm:flex-1 sm:pl-0";

/** One line of a list; with `onToggle` it folds its details open. */
function Row({ open, onToggle, children }: { open?: boolean; onToggle?: () => void; children: ReactNode }) {
  const can = !!onToggle;
  return (
    <div
      role={can ? "button" : undefined}
      tabIndex={can ? 0 : undefined}
      aria-expanded={can ? !!open : undefined}
      onClick={onToggle}
      onKeyDown={e => { if (can && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onToggle!(); } }}
      className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-5 py-3 outline-none transition-colors focus-visible:bg-ground",
        can ? "cursor-pointer hover:bg-ground/70" : "hover:bg-ground/40", open && "bg-ground/50")}
    >
      <ChevronRight className={cn("size-4 flex-none text-ink-3/50 transition-transform duration-200", open && "rotate-90", !can && "invisible")} />
      {children}
    </div>
  );
}

/** What a row folds open. */
function Fold({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("step-enter border-t border-muted bg-ground/50 px-5 py-3 sm:pl-12", className)}>{children}</div>;
}

/** Who did it, as initials; the name in the tooltip. */
function Who({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return (
    <Tip content={name}>
      <span tabIndex={0} className="grid size-6 flex-none place-items-center rounded-full bg-sage/60 text-[10px] font-bold uppercase text-emerald-dark outline-none">
        {name.slice(0, 2)}
      </span>
    </Tip>
  );
}

/** A VBN change: old code, arrow, new code. */
function FixLine({ f, ok }: { f: FixEntry; ok?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs text-ink">{f.name || f.product_id}</span>
      <Code tone="bad">{f.old_vbn}</Code>
      <ArrowRight className="size-3.5 flex-none text-ink-3/50" />
      <Code tone="ok">{f.new_vbn}</Code>
      {ok !== undefined && (ok ? <Check className="size-4 text-emerald" strokeWidth={2.6} /> : <X className="size-4 text-brick" strokeWidth={2.6} />)}
    </div>
  );
}

/** A run's log, its lines tinted by what they say. */
function LogLines({ lines, tone }: { lines: string[]; tone: (line: string) => string }) {
  return (
    <div className="max-h-60 space-y-0.5 overflow-y-auto font-mono text-xs">
      {lines.map((msg, i) => <div key={i} className={cn("leading-5", tone(msg))}>{msg}</div>)}
    </div>
  );
}

export default function HistoryTab({ lang }: Props) {
  const t = translations[lang];
  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";

  const [historySubTab, setHistorySubTab] = useState<HistSubTab>("ops");

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

  // Delivery import history
  interface DeliveryImportRun {
    id: number;
    fp_supplier_id: string | null;
    tx_company: string | null;
    id_invoice: string | null;
    dt_fly: string | null;
    tx_awb: string | null;
    nu_boxes: number | null;
    nu_stems_total: number | null;
    mny_total: number | null;
    nu_lines_total: number;
    nu_lines_matched: number;
    batch_id: string | null;
    batch_url: string | null;
    batch_status: string;
    invoice_id: string | null;
    invoice_url: string | null;
    nu_products_added: number | null;
    nu_products_failed: number | null;
    nu_products_skipped: number | null;
    products_status: string;
    nm_user: string | null;
    created_at: string;
    details: {
      productLines?: {
        nm_variety: string; nu_length: number; nu_bunches: number;
        match_method: string; catalogue_nm_product: string;
        status: "added" | "failed" | "skipped" | "notApproved" | "inPortal"; message: string;
      }[];
      requestLogs?: string[];
    } | null;
  }
  const [deliveryHistory, setDeliveryHistory]       = useState<DeliveryImportRun[] | null>(null);
  const [deliveryHistLoading, setDeliveryHistLoading] = useState(false);
  const [histDeliveryOffset, setHistDeliveryOffset] = useState(0);
  const [histDeliveryHasMore, setHistDeliveryHasMore] = useState(false);
  const [expandedDeliveryId, setExpandedDeliveryId] = useState<number | null>(null);

  // Every delivery file parsed, with its kind, beside the imports
  // (python/delivery_parse_log.py; user, 2026-10-01). The file itself can be
  // downloaded while it is kept.
  interface ParsedFile {
    id: number;
    created_at: string;
    nm_user: string | null;
    file_kind: "pdf" | "json" | "txt";
    file_name: string | null;
    file_bytes: number | null;
    outcome: "read" | "unknown_format" | "error";
    tx_company: string | null;
    id_invoice: string | null;
    nu_lines: number | null;
    error: string | null;
    file_kept: boolean;
  }
  interface FilesKept { retention_days: number; files_bytes: number; max_files_mb: number }
  const [deliveryView, setDeliveryView]         = useState<"imports" | "files">("imports");
  const [parsedFiles, setParsedFiles]           = useState<ParsedFile[] | null>(null);
  const [parsedLoading, setParsedLoading]       = useState(false);
  const [parsedOffset, setParsedOffset]         = useState(0);
  const [parsedHasMore, setParsedHasMore]       = useState(false);
  const [filesKept, setFilesKept]               = useState<FilesKept | null>(null);
  const [parsedMessage, setParsedMessage]       = useState("");

  /** One row per invoice, not per run: kenya_box_weight_log is keyed by
   *  invoice_id and overwritten each time, so this shows the current state
   *  of every invoice the module has touched and when it was established. */
  interface BoxWeightRun {
    invoice_id: string;
    sequence: string | null;
    invoice_url?: string;
    total_weight: string | number | null;
    box_count: string | number | null;
    weight_per_box: string | number | null;
    lines_written: number | null;
    status: string | null;
    detail: string | null;
    checked_at: string | null;
  }
  const [boxWeightHistory, setBoxWeightHistory]         = useState<BoxWeightRun[] | null>(null);
  const [boxWeightHistLoading, setBoxWeightHistLoading] = useState(false);
  const [histBoxWeightOffset, setHistBoxWeightOffset]   = useState(0);
  const [histBoxWeightHasMore, setHistBoxWeightHasMore] = useState(false);

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

  const loadDeliveryHistory = useCallback(async (append = false) => {
    if (!RAILWAY) return;
    setDeliveryHistLoading(true);
    const offset = append ? histDeliveryOffset : 0;
    try {
      const res = await fetch(`${RAILWAY}/delivery/import-log?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      const rows = data.history ?? [];
      const hasMore: boolean = data.hasMore ?? false;
      if (append) {
        setDeliveryHistory(prev => [...(prev ?? []), ...rows]);
        setHistDeliveryOffset(offset + rows.length);
      } else {
        setDeliveryHistory(rows);
        setHistDeliveryOffset(rows.length);
      }
      setHistDeliveryHasMore(hasMore);
    } catch {}
    setDeliveryHistLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histDeliveryOffset]);

  const loadParsedFiles = useCallback(async (append = false) => {
    if (!RAILWAY) return;
    setParsedLoading(true);
    const offset = append ? parsedOffset : 0;
    try {
      const res = await fetch(`${RAILWAY}/delivery/parse-log?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      const rows: ParsedFile[] = data.parses ?? [];
      if (append) {
        setParsedFiles(prev => [...(prev ?? []), ...rows]);
        setParsedOffset(offset + rows.length);
      } else {
        setParsedFiles(rows);
        setParsedOffset(rows.length);
      }
      setParsedHasMore(data.hasMore ?? false);
      setFilesKept(data);
    } catch {}
    setParsedLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedOffset]);

  function showDeliveryView(view: "imports" | "files") {
    setDeliveryView(view);
    if (view === "files" && parsedFiles === null) loadParsedFiles();
  }

  async function downloadParsedFile(row: ParsedFile) {
    setParsedMessage("");
    const res = await fetch(`${RAILWAY}/delivery/parse-log/${row.id}/file`);
    if (!res.ok) { setParsedMessage(t.history.parseGone); return; }
    saveBlob(await res.blob(), row.file_name || `delivery-${row.id}.${row.file_kind}`);
  }

  const loadBoxWeightHistory = useCallback(async (append = false) => {
    if (!RAILWAY) return;
    setBoxWeightHistLoading(true);
    const offset = append ? histBoxWeightOffset : 0;
    try {
      const res = await fetch(`${RAILWAY}/kenya/box-weight/log?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      const rows: BoxWeightRun[] = data.log ?? [];
      const hasMore: boolean = data.hasMore ?? false;
      if (append) {
        setBoxWeightHistory(prev => [...(prev ?? []), ...rows]);
        setHistBoxWeightOffset(offset + rows.length);
      } else {
        setBoxWeightHistory(rows);
        setHistBoxWeightOffset(rows.length);
      }
      setHistBoxWeightHasMore(hasMore);
    } catch {}
    setBoxWeightHistLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histBoxWeightOffset]);

  function handleTabSwitch(tab: HistSubTab) {
    setHistorySubTab(tab);
    if (tab === "ops"       && history === null)          loadHistory();
    if (tab === "sync"      && syncHistory === null)       loadSyncHistory();
    if (tab === "auto"      && autoVbnHistory === null)    loadAutoVbnHistory();
    if (tab === "delivery"  && deliveryHistory === null)   loadDeliveryHistory();
    if (tab === "boxweight" && boxWeightHistory === null)  loadBoxWeightHistory();
  }

  useEffect(() => {
    loadHistory(); loadSyncHistory(); loadAutoVbnHistory();
    loadDeliveryHistory(); loadBoxWeightHistory();
  }, []);

  function handleRefresh() {
    if (historySubTab === "ops")           loadHistory();
    else if (historySubTab === "sync")      loadSyncHistory();
    else if (historySubTab === "delivery" && deliveryView === "files") loadParsedFiles();
    else if (historySubTab === "delivery")  loadDeliveryHistory();
    else if (historySubTab === "boxweight") loadBoxWeightHistory();
    else                                    loadAutoVbnHistory();
  }

  const isLoading = historySubTab === "ops" ? histLoading
    : historySubTab === "sync"      ? syncHistLoading
    : historySubTab === "delivery"  ? (deliveryView === "files" ? parsedLoading : deliveryHistLoading)
    : historySubTab === "boxweight" ? boxWeightHistLoading
    : autoVbnHistLoading;

  /** A date short in the row, in full in its tooltip. */
  const when = (iso: string | null | undefined) => {
    if (!iso) return <span className="text-[11.5px] text-ink-3/50">—</span>;
    const d = new Date(iso);
    return (
      <Tip content={d.toLocaleString(localeStr)}>
        <span tabIndex={0} className="whitespace-nowrap text-[11.5px] tabular-nums text-ink-3 outline-none">
          {d.toLocaleString(localeStr, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
        </span>
      </Tip>
    );
  };
  const duration = (start: string, end: string | null) => {
    if (!end) return null;
    const s = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
    return <Chip tone="mute" icon={Clock}>{s < 60 ? `${s}s` : `${Math.round(s / 60)}min`}</Chip>;
  };
  const loadingLine = (text: string) => (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-3"><Loader2 className="size-4 animate-spin text-emerald" />{text}</div>
  );
  const moreButton = (busy: boolean, onMore: () => void) => (
    <div className="sticky bottom-0 flex justify-center border-t border-border bg-surface/95 px-5 py-2.5 backdrop-blur-sm">
      <Button variant="ghost" size="sm" disabled={busy} onClick={onMore}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronDown className="size-3.5" />}{busy ? t.history.loading : t.history.loadMore}
      </Button>
    </div>
  );
  const opLabel: Record<string, string> = {
    vbn_check: t.history.vbnCheck, vbn_fix: t.history.vbnFix, product_create: t.history.productCreate, photo_upload: t.history.photoUpload,
  };

  return (
    <div>
      <ModuleHeader tab="history" t={t} info={t.history.description}
        actions={<IconButton icon={RefreshCw} tip={t.history.refresh} spin={isLoading} disabled={isLoading} onClick={handleRefresh} />} />
      <div className="px-5 pb-3">
        <ModuleTabs<HistSubTab>
          value={historySubTab}
          onChange={handleTabSwitch}
          items={[
            { id: "ops", icon: List, label: t.history.subTabOps },
            { id: "sync", icon: Database, label: t.history.subTabSync },
            { id: "auto", icon: Zap, label: t.history.subTabAutoVbn },
            { id: "delivery", icon: Package, label: t.history.subTabDelivery },
            { id: "boxweight", icon: Scale, label: t.history.subTabBoxWeight },
          ]}
        />
      </div>

      {/* The delivery tab holds two lists: the imports, or every file parsed */}
      {historySubTab === "delivery" && (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-muted px-5 py-2.5">
          <SubTabs<"imports" | "files">
            value={deliveryView}
            onChange={showDeliveryView}
            items={[{ id: "imports", label: t.history.delivImports, icon: Package }, { id: "files", label: t.history.delivFiles, icon: FileText }]}
          />
          {deliveryView === "files" && filesKept && (
            <Chip tone="mute" icon={HistoryIcon} tip={t.history.parseKept(filesKept.retention_days, (filesKept.files_bytes / 1024 / 1024).toFixed(1), filesKept.max_files_mb)}>
              {filesKept.retention_days} d · {(filesKept.files_bytes / 1024 / 1024).toFixed(1)} MB
            </Chip>
          )}
          {deliveryView === "files" && parsedMessage && <span className="text-[12px] font-semibold text-brick">{parsedMessage}</span>}
        </div>
      )}

      <div key={historySubTab + deliveryView} className="step-enter max-h-[calc(100vh-330px)] overflow-y-auto border-t border-muted">

        {/* ── Operations ── */}
        {historySubTab === "ops" && (
          histLoading && history === null ? loadingLine(t.history.loading)
          : !history || history.length === 0 ? <EmptyState icon={List} text={t.history.empty} hint={t.history.emptyHint} />
          : (
            <>
              <div className="divide-y divide-muted">
                {history.map((row) => {
                  const fixes: FixEntry[] = row.details?.fixes ?? [];
                  const photoItems: PhotoUploadItem[] = row.details?.items ?? [];
                  const isExpanded = expandedHistoryId === row.id;
                  const canExpand = (row.type === "vbn_fix" && fixes.length > 0) || (row.type === "photo_upload" && photoItems.length > 0);
                  const stat = (k: string) => (row.stats?.[k] != null ? Number(row.stats[k]) : null);
                  return (
                    <div key={row.id}>
                      <Row open={isExpanded} onToggle={canExpand ? () => setExpandedHistoryId(isExpanded ? null : row.id) : undefined}>
                        {OP_MODULE[row.type] ? <OpIcon tab={OP_MODULE[row.type]} /> : <span className="size-7 flex-none" />}
                        <span className="text-[13px] font-semibold text-ink">{opLabel[row.type] ?? row.type}</span>

                        <span className={DETAILS}>
                          {row.type === "product_create" ? (
                            <>
                              <span className="truncate text-[13px] text-ink">{row.details?.name ?? "—"}</span>
                              {row.details?.product_number && <Code>{row.details.product_number}</Code>}
                              {row.details?.template_name && <Chip tone="mute" tip={t.create.templateLabel.replace(/:$/, "")}><span className="max-w-[200px] truncate">{row.details.template_name}</span></Chip>}
                              {row.details?.status === "unconfirmed" ? <Chip tone="warn" icon={TriangleAlert}>{t.create.badgeUnconfirmed}</Chip>
                                : row.details?.success === false ? <Chip tone="bad" icon={X} tip={t.create.statusFailed} />
                                : row.details?.warnings && row.details.warnings.length > 0 ? <Chip tone="warn" icon={TriangleAlert}>{t.create.badgeWarnings}</Chip>
                                : null}
                            </>
                          ) : row.type === "photo_upload" ? (
                            <>
                              {stat("total") != null && <Chip tone="info" tip={t.photo.photosCount(stat("total")!)}>{stat("total")}×</Chip>}
                              {(stat("ok") ?? 0) > 0 && <Chip tone="ok" icon={Check}>{stat("ok")}</Chip>}
                              {(stat("error") ?? 0) > 0 && <Chip tone="bad" icon={X}>{stat("error")}</Chip>}
                            </>
                          ) : row.type === "vbn_check" ? (
                            <>
                              {row.vbn_filter && <Code>{row.vbn_filter}</Code>}
                              {(stat("errors") ?? 0) > 0 && <Chip tone="bad" icon={CircleAlert} tip={t.vbn.statErrors}>{stat("errors")}</Chip>}
                              {(stat("warnings") ?? 0) > 0 && <Chip tone="warn" icon={TriangleAlert} tip={t.vbn.statWarnings}>{stat("warnings")}</Chip>}
                              {stat("ok") != null && <Chip tone="ok" icon={Check} tip={t.vbn.statOk}>{stat("ok")}</Chip>}
                            </>
                          ) : row.type === "vbn_fix" ? (
                            <>
                              {row.vbn_filter && <Code>{row.vbn_filter}</Code>}
                              {stat("fixed") != null && <Chip tone="ok" icon={Check}>{stat("fixed")}</Chip>}
                              {(stat("failed") ?? 0) > 0 && <Chip tone="bad" icon={X}>{stat("failed")}</Chip>}
                            </>
                          ) : (
                            <span className="text-xs text-ink-3">
                              {row.stats && Object.keys(row.stats).length > 0 ? Object.entries(row.stats).map(([k, v]) => `${k}: ${v}`).join(", ") : "—"}
                            </span>
                          )}
                        </span>

                        <span className="ml-auto flex items-center gap-2.5">
                          <Who name={row.username} />
                          {when(row.created_at)}
                        </span>
                      </Row>

                      {isExpanded && fixes.length > 0 && (
                        <Fold className="divide-y divide-muted">
                          {fixes.map((f, i) => <FixLine key={i} f={f} />)}
                        </Fold>
                      )}
                      {isExpanded && row.type === "photo_upload" && photoItems.length > 0 && (
                        <Fold className="divide-y divide-muted">
                          {photoItems.map((item, i) => (
                            <div key={i} className="flex items-center gap-2.5 py-1.5">
                              {item.status === "ok" ? <Check className="size-4 flex-none text-emerald" strokeWidth={2.6} /> : <X className="size-4 flex-none text-brick" strokeWidth={2.6} />}
                              <span className="min-w-0 flex-1 truncate text-xs text-ink">{item.product_name}</span>
                              <span className="max-w-40 truncate font-mono text-[11px] text-ink-3">{item.filename}</span>
                              {item.status !== "ok" && <span className="max-w-40 truncate text-[11px] font-semibold text-brick">{item.message || "error"}</span>}
                            </div>
                          ))}
                        </Fold>
                      )}
                    </div>
                  );
                })}
              </div>
              {histOpsHasMore && moreButton(histLoading, () => loadHistory(true))}
            </>
          )
        )}

        {/* ── Sync ── */}
        {historySubTab === "sync" && (
          syncHistLoading && syncHistory === null ? loadingLine(t.history.syncLoading)
          : !syncHistory || syncHistory.length === 0 ? <EmptyState icon={Database} text={t.history.noSyncRuns} />
          : (
            <>
              <div className="divide-y divide-muted">
                {syncHistory.map((run) => {
                  const isExp = expandedSyncId === run.id;
                  const msgs = run.messages ?? [];
                  return (
                    <div key={run.id}>
                      <Row open={isExp} onToggle={() => setExpandedSyncId(isExp ? null : run.id)}>
                        <StatusChip status={run.status} />
                        {when(run.started_at)}
                        {duration(run.started_at, run.finished_at)}
                        {run.product_count != null && <Chip tone="info" icon={Database} tip={t.history.products}>{run.product_count.toLocaleString(localeStr)}</Chip>}
                        {run.error && (
                          <Tip content={run.error}><span tabIndex={0} className="min-w-0 flex-1 truncate text-xs font-semibold text-brick outline-none">{run.error}</span></Tip>
                        )}
                        <span className="ml-auto text-[11.5px] text-ink-3/60">{msgs.length} {t.history.msgs}</span>
                      </Row>
                      {isExp && (
                        <Fold>
                          {msgs.length === 0 ? <p className="text-xs text-ink-3/60">{t.history.noMessages}</p> : (
                            <LogLines lines={msgs} tone={(msg) =>
                              msg.startsWith("STOP") ? "font-semibold text-brick"
                              : msg.startsWith("Empty") || msg.includes("retry") ? "text-brick/80"
                              : msg.includes("complete") || msg.includes("Complete") ? "font-medium text-emerald-dark"
                              : "text-ink-3"} />
                          )}
                        </Fold>
                      )}
                    </div>
                  );
                })}
              </div>
              {histSyncHasMore && moreButton(syncHistLoading, () => loadSyncHistory(true))}
            </>
          )
        )}

        {/* ── Auto VBN ── */}
        {historySubTab === "auto" && (
          autoVbnHistLoading && autoVbnHistory === null ? loadingLine(t.history.loading)
          : !autoVbnHistory || autoVbnHistory.length === 0 ? <EmptyState icon={Zap} text={t.history.autoVbnNoData} />
          : (
            <>
              <div className="divide-y divide-muted">
                {autoVbnHistory.map((run) => {
                  const isExp = expandedAutoId === run.id;
                  const msgs = run.messages ?? [];
                  const fixes = run.fixes ?? [];
                  return (
                    <div key={run.id}>
                      <Row open={isExp} onToggle={() => setExpandedAutoId(isExp ? null : run.id)}>
                        <StatusChip status={run.status} />
                        {when(run.started_at)}
                        {duration(run.started_at, run.finished_at)}
                        {run.checked_count != null && <Chip tone="mute" icon={List} tip={t.history.autoVbnChecked}>{run.checked_count}</Chip>}
                        {run.fixed_count != null && run.fixed_count > 0 && <Chip tone="ok" icon={Check} tip={t.history.autoVbnFixed}>{run.fixed_count}</Chip>}
                        {run.error && (
                          <Tip content={run.error}><span tabIndex={0} className="min-w-0 flex-1 truncate text-xs font-semibold text-brick outline-none">{run.error}</span></Tip>
                        )}
                        <span className="ml-auto text-[11.5px] text-ink-3/60">{msgs.length} {t.history.msgs}</span>
                      </Row>
                      {isExp && (
                        <Fold className="space-y-3">
                          {msgs.length > 0 && (
                            <LogLines lines={msgs} tone={(msg) =>
                              msg.startsWith("Fix FAILED") || msg.startsWith("ERROR") ? "font-semibold text-brick"
                              : msg.startsWith("Fix fixed") || msg.startsWith("Done:") ? "font-medium text-emerald-dark"
                              : msg.startsWith("WARNING —") ? "text-brick/80"
                              : msg.startsWith("OK —") ? "text-ink-3/50"
                              : "text-ink-3"} />
                          )}
                          {fixes.length > 0 && (
                            <div className="divide-y divide-muted rounded-xl border border-border bg-surface px-3">
                              {fixes.map((f, i) => <FixLine key={i} f={f} ok={f.ok} />)}
                            </div>
                          )}
                          {msgs.length === 0 && fixes.length === 0 && <p className="text-xs text-ink-3/60">{t.history.noMessages}</p>}
                        </Fold>
                      )}
                    </div>
                  );
                })}
              </div>
              {histAutoHasMore && moreButton(autoVbnHistLoading, () => loadAutoVbnHistory(true))}
            </>
          )
        )}

        {/* ── Delivery import: files parsed ── */}
        {historySubTab === "delivery" && deliveryView === "files" && (
          parsedLoading && parsedFiles === null ? loadingLine(t.history.loading)
          : !parsedFiles || parsedFiles.length === 0 ? <EmptyState icon={FileText} text={t.history.parseEmpty} />
          : (
            <>
              <div className="divide-y divide-muted">
                {parsedFiles.map((row) => {
                  const outcome = {
                    read:           { label: t.history.parseRead,    tone: "ok" as const },
                    unknown_format: { label: t.history.parseUnknown, tone: "warn" as const },
                    error:          { label: t.history.parseError,   tone: "bad" as const },
                  }[row.outcome] ?? { label: row.outcome, tone: "mute" as const };
                  return (
                    <Row key={row.id}>
                      <Code>{row.file_kind.toUpperCase()}</Code>
                      <Chip tone={outcome.tone} tip={row.error || undefined}>{outcome.label}</Chip>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                        <span className="font-semibold">{row.tx_company ?? row.file_name ?? "—"}</span>
                        {row.id_invoice && <span className="ml-1 text-ink-3">#{row.id_invoice}</span>}
                        {row.tx_company && row.file_name && <span className="ml-2 text-[11.5px] text-ink-3/60">{row.file_name}</span>}
                      </span>
                      <span className="ml-auto flex items-center gap-2.5">
                        <Who name={row.nm_user} />
                        {when(row.created_at)}
                        {row.file_kept
                          ? <IconButton size="sm" icon={Download} tip={t.history.parseDownload} onClick={() => downloadParsedFile(row)} />
                          : <span className="w-7" />}
                      </span>
                    </Row>
                  );
                })}
              </div>
              {parsedHasMore && moreButton(parsedLoading, () => loadParsedFiles(true))}
            </>
          )
        )}

        {/* ── Delivery import: imports ── */}
        {historySubTab === "delivery" && deliveryView === "imports" && (
          deliveryHistLoading && deliveryHistory === null ? loadingLine(t.history.loading)
          : !deliveryHistory || deliveryHistory.length === 0 ? <EmptyState icon={Package} text={t.delivery.histDeliveryEmpty} hint={t.delivery.histDeliveryEmptyHint} />
          : (
            <>
              <div className="divide-y divide-muted">
                {deliveryHistory.map((run) => {
                  const isExp = expandedDeliveryId === run.id;
                  const batchOk = run.batch_status === "ok";
                  const prodPending = run.products_status === "pending";
                  const prodOk = run.products_status === "ok";
                  return (
                    <div key={run.id}>
                      <Row open={isExp} onToggle={() => setExpandedDeliveryId(isExp ? null : run.id)}>
                        <OpIcon tab="delivery" />
                        <span className="truncate text-[13px] font-semibold text-ink">{run.tx_company ?? run.fp_supplier_id ?? "—"}</span>
                        <span className={DETAILS}>
                          {run.id_invoice && <Code>#{run.id_invoice}</Code>}
                          <Chip tone={batchOk ? "ok" : "bad"} icon={batchOk ? Check : CircleAlert} tip={t.delivery.batchId}>batch</Chip>
                          {!prodPending && (
                            <Chip tone={prodOk ? "ok" : "warn"} icon={Package} tip={t.history.products}>{run.nu_products_added ?? 0}/{run.nu_lines_matched}</Chip>
                          )}
                        </span>
                        <span className="ml-auto flex items-center gap-2.5">
                          <Who name={run.nm_user} />
                          {when(run.created_at)}
                        </span>
                      </Row>

                      {isExp && (
                        <Fold className="space-y-3">
                          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
                            {([
                              [t.delivery.histDeliverySupplier, run.tx_company],
                              [t.delivery.histDeliveryInvoice,  run.id_invoice],
                              [t.delivery.histDeliveryFlight,   run.dt_fly],
                              [t.delivery.histDeliveryAwb,      run.tx_awb],
                              [t.delivery.histDeliveryBoxes,    run.nu_boxes],
                              [t.delivery.histDeliveryStems,    run.nu_stems_total?.toLocaleString(localeStr)],
                              [t.delivery.histDeliveryValue,    run.mny_total != null ? `€${Number(run.mny_total).toFixed(2)}` : null],
                              [t.delivery.colMatch, t.delivery.histDeliveryMatches(run.nu_lines_matched, run.nu_lines_total)],
                              [t.delivery.histDeliveryUser,     run.nm_user],
                            ] as [string, ReactNode][]).map(([label, val]) => (
                              <div key={label} className="contents">
                                <dt className="text-ink-3">{label}</dt>
                                <dd className="font-mono font-medium text-ink">{val ?? "—"}</dd>
                              </div>
                            ))}
                            <dt className="text-ink-3">{t.delivery.batchId}</dt>
                            <dd className="font-mono">
                              {run.batch_url
                                ? <a href={run.batch_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-emerald underline">{run.batch_id}</a>
                                : <span className="text-ink">{run.batch_id ?? "—"}</span>}
                            </dd>
                            {run.invoice_id && <>
                              <dt className="text-ink-3">{t.delivery.invoiceIdLabel}</dt>
                              <dd className="font-mono">
                                {run.invoice_url
                                  ? <a href={run.invoice_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-emerald underline">{run.invoice_id}</a>
                                  : <span className="text-ink">{run.invoice_id}</span>}
                              </dd>
                            </>}
                            {!prodPending && <>
                              <dt className="text-ink-3">{t.history.products}</dt>
                              <dd className="flex flex-wrap gap-1.5">
                                <Chip tone="ok" icon={Check}>{t.delivery.histDeliveryAdded(run.nu_products_added ?? 0)}</Chip>
                                {(run.nu_products_failed ?? 0) > 0 && <Chip tone="bad" icon={X}>{t.delivery.histDeliveryFailed(run.nu_products_failed!)}</Chip>}
                                {(run.nu_products_skipped ?? 0) > 0 && <Chip tone="mute">{t.delivery.histDeliverySkipped(run.nu_products_skipped!)}</Chip>}
                              </dd>
                            </>}
                          </dl>

                          {!!run.details?.productLines?.length && (
                            <details className="text-xs">
                              <summary className="cursor-pointer select-none font-semibold text-ink-3 hover:text-ink">{t.delivery.productLinesLog(run.details.productLines.length)}</summary>
                              <div className="mt-2 max-h-64 divide-y divide-muted overflow-y-auto rounded-xl border border-border bg-surface px-3">
                                {run.details.productLines.map((pl, i) => {
                                  const badge = {
                                    added:       { label: t.delivery.lineStatusAdded,       tone: "ok" as const },
                                    failed:      { label: t.delivery.lineStatusFailed,      tone: "bad" as const },
                                    skipped:     { label: t.delivery.lineStatusSkipped,     tone: "warn" as const },
                                    notApproved: { label: t.delivery.lineStatusNotApproved, tone: "mute" as const },
                                    inPortal:    { label: t.delivery.lineStatusInPortal,    tone: "info" as const },
                                  }[pl.status];
                                  return (
                                    <div key={i} className="flex items-start justify-between gap-2 py-1.5">
                                      <div className="min-w-0">
                                        <p className="truncate font-medium text-ink">
                                          {pl.nm_variety}
                                          {pl.nu_length > 0 && <span className="font-normal text-ink-3"> · {pl.nu_length}cm</span>}
                                        </p>
                                        {pl.message && <p className="truncate font-mono text-[11px] text-brick">{pl.message}</p>}
                                      </div>
                                      <Chip tone={badge.tone}>{badge.label}</Chip>
                                    </div>
                                  );
                                })}
                              </div>
                            </details>
                          )}

                          {!!run.details?.requestLogs?.length && (
                            <details className="text-xs">
                              <summary className="cursor-pointer select-none font-semibold text-ink-3 hover:text-ink">{t.delivery.batchLog(run.details.requestLogs.length)}</summary>
                              <div className="mt-2 max-h-64 overflow-y-auto rounded-xl bg-surface p-2 font-mono">
                                {run.details.requestLogs.map((l, i) => (
                                  <div key={i} className={cn("whitespace-pre-wrap break-all border-b border-muted py-1.5 last:border-0",
                                    l.startsWith("  ⚠") ? "text-brick" : l.startsWith("  ✓") ? "text-emerald-dark" : "text-ink-3")}>
                                    {l}
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </Fold>
                      )}
                    </div>
                  );
                })}
              </div>
              {histDeliveryHasMore && moreButton(deliveryHistLoading, () => loadDeliveryHistory(true))}
            </>
          )
        )}

        {/* ── Box weight (Kenya) ── */}
        {historySubTab === "boxweight" && (
          boxWeightHistLoading && boxWeightHistory === null ? loadingLine(t.history.loading)
          : !boxWeightHistory || boxWeightHistory.length === 0 ? <EmptyState icon={Scale} text={t.history.empty} />
          : (
            <>
              <div className="divide-y divide-muted">
                {boxWeightHistory.map((r) => (
                  <div key={r.invoice_id}>
                    <Row>
                      <OpIcon tab="boxweight" />
                      {r.invoice_url ? (
                        <a href={r.invoice_url} target="_blank" rel="noopener noreferrer"
                          className="font-mono text-[13px] font-semibold text-ink transition-colors hover:text-emerald">#{r.sequence || r.invoice_id}</a>
                      ) : (
                        <span className="font-mono text-[13px] font-semibold text-ink">#{r.sequence || r.invoice_id}</span>
                      )}
                      <StatusChip status={r.status ?? "—"} />
                      <span className="text-xs tabular-nums text-ink-3">
                        {fmtKg(r.total_weight)} / {fmtNum(r.box_count)} {t.history.bwBoxes} = <b className="font-semibold text-ink">{fmtKg(r.weight_per_box)}</b>
                      </span>
                      <Chip tone="mute">{t.history.bwLinesWritten(String(r.lines_written ?? 0))}</Chip>
                      <span className="ml-auto">{when(r.checked_at)}</span>
                    </Row>
                    {r.detail && <p className="-mt-1.5 break-words px-5 pb-3 text-xs text-ink-3 sm:pl-12">{r.detail}</p>}
                  </div>
                ))}
              </div>
              {histBoxWeightHasMore && moreButton(boxWeightHistLoading, () => loadBoxWeightHistory(true))}
            </>
          )
        )}

      </div>
    </div>
  );
}
