"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useSession } from "next-auth/react";
import { translations, Lang } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

type MatchMethod =
  | "variety_length" | "variety_nolen" | "variety_anylength"
  | "floricode"
  | "fuzzy_variety" | "fuzzy_variety_nolen" | "fuzzy_nolen" | "fuzzy_anylength"
  | "cached"
  | "none";

interface CatalogueProduct {
  fp_product_id: string;
  nm_product: string;
  nu_length?: number | null;
  nu_stems_bunch?: number | null;
  nu_stems_pack?: number | null;
  nm_packaging?: string;
}

interface DeliveryLine {
  gu_product: string;
  nm_variety: string;
  nm_species: string;
  nu_length: number;
  nu_stems_bunch: number;
  nu_bunches: number;
  nu_stems_total: number;
  mny_rate_stem: number;
  mny_total: number;
  id_floricode: string;
  nm_product: string;
  nm_box: string;
  nu_physical_boxes: number;
  fp_product_id: string;
  match_method: MatchMethod;
  catalogue_nm_product: string;
}

interface DeliveryOrder {
  tx_company: string;
  id_invoice: string;
  id_purchaseorder: string;
  dt_fly: string;
  dt_invoice: string;
  tx_awb: string;
  tx_hawb: string;
  nu_boxes: number;
  nu_stems_total: number;
  mny_total: number;
  lines: DeliveryLine[];
}

interface FPSupplier {
  fp_supplier_id: string;
  nm_supplier: string;
}

interface ParseResult {
  orders: DeliveryOrder[];
  supplier_id: string;
  supplier_nm: string;
  catalogue_count: number;
  catalogue: CatalogueProduct[];
  matched_count: number;
  unmatched_count: number;
}

type Stage = "idle" | "parsing" | "preview" | "syncing" | "importing" | "done" | "error";

const MATCH_BADGE: Record<MatchMethod, { label: string; cls: string }> = {
  variety_length:       { label: "exact",        cls: "bg-emerald/15 text-emerald border-emerald/20" },
  variety_nolen:        { label: "exact~len",    cls: "bg-emerald/10 text-emerald border-emerald/15" },
  variety_anylength:    { label: "exact~len",    cls: "bg-emerald/10 text-emerald border-emerald/15" },
  floricode:            { label: "VBN",          cls: "bg-blue-500/15 text-blue-600 border-blue-500/20" },
  fuzzy_variety:        { label: "fuzzy",        cls: "bg-amber-500/15 text-amber-600 border-amber-500/20" },
  fuzzy_variety_nolen:  { label: "fuzzy~len",    cls: "bg-amber-500/10 text-amber-600 border-amber-500/15" },
  fuzzy_nolen:          { label: "fuzzy~",       cls: "bg-orange-500/15 text-orange-600 border-orange-500/20" },
  fuzzy_anylength:      { label: "fuzzy~len",    cls: "bg-orange-500/10 text-orange-600 border-orange-500/15" },
  cached:               { label: "cached ✓",     cls: "bg-green-500/15 text-green-700 border-green-500/25" },
  none:                 { label: "no match",     cls: "bg-red-500/10 text-red-500 border-red-500/20" },
};

export default function DeliveryImporter({ lang }: { lang: Lang }) {
  const t = translations[lang];
  const td = t.delivery;
  const { data: session } = useSession();
  const username = session?.user?.name ?? undefined;
  const userPerms: string[] = (session?.user as { permissions?: string[] })?.permissions ?? [];
  const isAdmin = userPerms.includes("admin:manage");
  const canSyncCatalogue = isAdmin || userPerms.includes("delivery:import") || userPerms.includes("catalogue:sync");

  const [stage, setStage] = useState<Stage>("idle");
  const [importLogId, setImportLogId] = useState<number | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [activeOrderIdx, setActiveOrderIdx] = useState(0);
  const [catalogueCount, setCatalogueCount] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<{ ok: boolean; batch_id: string; batch_url: string; lines_added: number; message: string } | null>(null);
  const [error, setError] = useState("");

  // ── Add-products step (separate from batch creation) ──
  type AddStage = "idle" | "running" | "done" | "error";
  const [addStage, setAddStage] = useState<AddStage>("idle");
  const [addLogs, setAddLogs] = useState<string[]>([]);
  const [addResult, setAddResult] = useState<{ ok: boolean; lines_added: number; lines_skipped: number; lines_failed: number; message: string; details: { product: string; status: string }[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Match approval & inline edit ──────────────────────────────────────────
  const [approvedKeys, setApprovedKeys] = useState<Set<string>>(new Set());
  const [lineEdits, setLineEdits] = useState<Record<string, { fp_product_id: string; catalogue_nm_product: string }>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editSearch, setEditSearch] = useState("");
  const [savingApproved, setSavingApproved] = useState(false);
  const [showCacheManager, setShowCacheManager] = useState(false);
  const [cachedMatchesList, setCachedMatchesList] = useState<Array<{ delivery_key: string; nm_variety: string; nm_product: string; match_type: string; approved: boolean }>>([]);

  // ── Supplier picker ───────────────────────────────────────────────────────
  const [resolvedSupplier, setResolvedSupplier] = useState<FPSupplier | null>(null);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [supplierList, setSupplierList] = useState<FPSupplier[]>([]);
  const [supplierSearch, setSupplierSearch] = useState("");

  // ── Product match modal ───────────────────────────────────────────────────
  const [editModalOpen, setEditModalOpen] = useState(false);

  // ── Table sort / filter / view ────────────────────────────────────────────
  const [showOnlyUnmatched, setShowOnlyUnmatched] = useState(false);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [duplicateWarning, setDuplicateWarning] = useState<string[]>([]);
  const [multiFileError, setMultiFileError] = useState(false);
  const [fileLoaded, setFileLoaded] = useState(false);

  function deliveryKey(line: DeliveryLine): string {
    return `${(line.nm_variety ?? "").toLowerCase().trim()}|${line.nu_length || ""}`;
  }

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev, msg]);
  }, []);

  // ── File drop / select ──────────────────────────────────────────────────

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = e => {
      setJsonText((e.target?.result as string) || "");
      setFileLoaded(true);
    };
    reader.readAsText(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 1) { setMultiFileError(true); return; }
    setMultiFileError(false);
    const f = files[0];
    if (f && f.name.endsWith(".json")) handleFile(f);
  }

  // ── Clear match cache ──────────────────────────────────────────────────

  const [clearingCache, setClearingCache] = useState(false);

  async function handleClearCache() {
    const supplierId = parseResult?.supplier_id;
    if (!supplierId) { alert(td.clearCacheNoSupplier); return; }
    if (!confirm(td.clearCacheConfirm(supplierId))) return;
    setClearingCache(true);
    try {
      const res = await fetch(`${RAILWAY}/catalogue/${supplierId}/matches`, { method: "DELETE" });
      const data = await res.json();
      alert(td.clearCacheSuccess(data.deleted));
    } catch { alert(td.clearCacheError); }
    finally { setClearingCache(false); }
  }

  // ── Duplicate detection ────────────────────────────────────────────────

  async function checkDuplicate(text: string): Promise<string[]> {
    try {
      const body = JSON.parse(text);
      const rawInvoices: { id_invoice?: string }[] = body.invoices ?? (Array.isArray(body) ? body : [body]);
      const ids = rawInvoices.map(i => i.id_invoice).filter(Boolean) as string[];
      if (!ids.length) return [];
      const res = await fetch(`${RAILWAY}/delivery/import-log?limit=500`);
      if (!res.ok) return [];
      const data = await res.json();
      const entries: { id_invoice?: string }[] = data.history ?? data.logs ?? (Array.isArray(data) ? data : []);
      const existing = new Set<string>(entries.map(l => l.id_invoice).filter(Boolean) as string[]);
      return ids.filter(id => existing.has(id));
    } catch { return []; }
  }

  async function handleParseClick() {
    if (!jsonText.trim()) return;
    const dupes = await checkDuplicate(jsonText);
    if (dupes.length > 0) {
      setDuplicateWarning(dupes);
      return;
    }
    await handleParse();
  }

  // ── Parse & match ──────────────────────────────────────────────────────

  async function handleParse(supplierIdOverride?: string) {
    if (!jsonText.trim()) return;
    setStage("parsing");
    setDuplicateWarning([]);
    setError("");
    try {
      const body = JSON.parse(jsonText);
      const res = await fetch(`${RAILWAY}/delivery/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_json: body,
          with_matching: true,
          ...(supplierIdOverride ? { supplier_id: supplierIdOverride } : {}),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: ParseResult = await res.json();
      setParseResult(data);
      setCatalogueCount(data.catalogue_count);
      setActiveOrderIdx(0);
      setLineEdits({});
      setEditingKey(null);
      setShowOnlyUnmatched(false);
      setSortCol(null);
      setColFilters({});
      if (data.supplier_id) {
        setResolvedSupplier({ fp_supplier_id: data.supplier_id, nm_supplier: data.supplier_nm || data.supplier_id });
      } else {
        setResolvedSupplier(null);
      }
      const preApproved = new Set<string>();
      for (const order of data.orders) {
        for (const line of order.lines) {
          if (line.match_method === "cached") preApproved.add(deliveryKey(line));
        }
      }
      setApprovedKeys(preApproved);
      setStage("preview");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  // ── Supplier picker ──────────────────────────────────────────────────────

  async function openSupplierPicker() {
    if (supplierList.length === 0) {
      try {
        const res = await fetch(`${RAILWAY}/catalogue/suppliers`);
        if (res.ok) {
          const data = await res.json();
          setSupplierList(data.suppliers ?? []);
        }
      } catch {}
    }
    setSupplierSearch("");
    setSupplierPickerOpen(true);
  }

  async function handleSelectSupplier(supplier: FPSupplier) {
    setSupplierPickerOpen(false);
    setResolvedSupplier(supplier);

    const txCompany = parseResult?.orders[activeOrderIdx]?.tx_company ?? "";
    try {
      await fetch(`${RAILWAY}/catalogue/supplier-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tx_company: txCompany, fp_supplier_id: supplier.fp_supplier_id }),
      });
    } catch {}

    let needsSync = false;
    try {
      const statusRes = await fetch(`${RAILWAY}/catalogue/${supplier.fp_supplier_id}/status`);
      if (statusRes.ok) {
        const status = await statusRes.json();
        needsSync = !status.synced || (status.item_count ?? 0) === 0;
      } else {
        needsSync = true;
      }
    } catch {
      needsSync = true;
    }

    if (needsSync) {
      await syncCatalogueForSupplier(supplier.fp_supplier_id, supplier.nm_supplier);
    } else {
      await handleParse(supplier.fp_supplier_id);
    }
  }

  // ── Sync catalogue ──────────────────────────────────────────────────────

  async function syncCatalogueForSupplier(supplierId: string, supplierName: string) {
    setStage("syncing");
    setLogs([]);
    addLog(`Syncing catalogue for ${supplierName} (#${supplierId})…`);

    const params = new URLSearchParams({ nm_supplier: supplierName });
    const res = await fetch(
      `${RAILWAY}/catalogue/sync/${supplierId}/stream?${params}`,
      { method: "POST" }
    );

    if (!res.ok || !res.body) {
      addLog(await res.text());
      setStage("preview");
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
        const evLine = part.replace(/^data: /, "").trim();
        if (!evLine || evLine.startsWith(":")) continue;
        try {
          const ev = JSON.parse(evLine);
          if (ev.type === "status") addLog(ev.message);
          if (ev.type === "result") {
            addLog(`Catalogue synced — ${ev.data.items_saved} products. Re-matching…`);
            setCatalogueCount(ev.data.items_saved);
            await handleParse(supplierId);
          }
          if (ev.type === "error") {
            addLog(`Error: ${ev.message}`);
            setStage("preview");
          }
        } catch {}
      }
    }
  }

  async function handleSyncCatalogue() {
    if (resolvedSupplier) {
      await syncCatalogueForSupplier(resolvedSupplier.fp_supplier_id, resolvedSupplier.nm_supplier);
      return;
    }
    await openSupplierPicker();
  }

  // ── Import to FreshPortal ───────────────────────────────────────────────

  async function handleImport() {
    if (!parseResult) return;
    const order = parseResult.orders[activeOrderIdx];
    if (!order) return;

    const keysToCache = new Set(
      order.lines
        .filter(l => !!(lineEdits[deliveryKey(l)]?.fp_product_id ?? l.fp_product_id))
        .map(l => deliveryKey(l))
    );
    await handleApproveMatches(keysToCache);

    setStage("importing");
    setLogs([]);
    setImportResult(null);

    const res = await fetch(`${RAILWAY}/delivery/create-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });

    if (!res.ok || !res.body) {
      setError(await res.text());
      setStage("error");
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
          if (ev.type === "status") addLog(ev.message);
          if (ev.type === "result") {
            const result = ev.data;
            setImportResult(result);
            setStage("done");
            if (result.ok && result.batch_id) {
              try {
                const logRes = await fetch(`${RAILWAY}/delivery/import-log`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    fp_supplier_id: parseResult!.supplier_id,
                    tx_company: order.tx_company,
                    id_invoice: order.id_invoice,
                    dt_fly: order.dt_fly,
                    tx_awb: order.tx_awb,
                    nu_boxes: order.nu_boxes,
                    nu_stems_total: order.nu_stems_total,
                    mny_total: order.mny_total,
                    nu_lines_total: order.lines.length,
                    nu_lines_matched: order.lines.filter((l: DeliveryLine) => l.fp_product_id).length,
                    batch_id: result.batch_id,
                    batch_url: result.batch_url,
                    batch_status: "ok",
                    nm_user: username ?? null,
                    details: { lines: order.lines.map((l: DeliveryLine) => ({
                      nm_variety: l.nm_variety, nu_length: l.nu_length,
                      nu_bunches: l.nu_bunches, match_method: l.match_method,
                      catalogue_nm_product: l.catalogue_nm_product,
                    })) },
                  }),
                });
                if (logRes.ok) {
                  const logData = await logRes.json();
                  setImportLogId(logData.id);
                }
              } catch {}
            }
          }
          if (ev.type === "error") {
            setError(ev.message);
            setStage("error");
          }
        } catch {}
      }
    }
  }

  async function handleApproveMatches(keys?: Set<string>) {
    if (!parseResult) return;
    const supplierId = parseResult.supplier_id;
    if (!supplierId) return;
    const order = parseResult.orders[activeOrderIdx];
    if (!order) return;
    const keysToSave = keys ?? approvedKeys;
    const seenKeys = new Set<string>();
    const matches = order.lines
      .map(line => {
        const dk = deliveryKey(line);
        const edit = lineEdits[dk];
        const effectiveFpId = edit?.fp_product_id ?? line.fp_product_id;
        if (!effectiveFpId) return null;
        if (!keysToSave.has(dk)) return null;
        if (seenKeys.has(dk)) return null;
        seenKeys.add(dk);
        return {
          delivery_key: dk,
          nm_variety:   line.nm_variety,
          nu_length:    line.nu_length,
          id_floricode: line.id_floricode,
          fp_product_id: effectiveFpId,
          nm_product:   edit?.catalogue_nm_product ?? line.catalogue_nm_product,
          match_type:   line.match_method === "cached" ? "cached" : "approved",
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    if (!matches.length) return;
    setSavingApproved(true);
    try {
      const res = await fetch(`${RAILWAY}/catalogue/${supplierId}/matches/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matches }),
      });
      if (!res.ok) {
        console.error("[cache] approve failed", res.status, await res.text().catch(() => ""));
      }
    } catch (err) {
      console.error("[cache] approve error", err);
    } finally {
      setSavingApproved(false);
    }
  }

  async function handleAddProducts() {
    if (!importResult?.batch_id || !parseResult) return;
    const order = parseResult.orders[activeOrderIdx];
    if (!order) return;

    setAddStage("running");
    setAddLogs([]);
    setAddResult(null);

    const orderWithEdits = {
      ...order,
      lines: order.lines.map(line => {
        const dk = deliveryKey(line);
        const edit = lineEdits[dk];
        if (!edit) return line;
        return { ...line, fp_product_id: edit.fp_product_id, catalogue_nm_product: edit.catalogue_nm_product };
      }),
    };

    const res = await fetch(`${RAILWAY}/delivery/add-products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch_id: importResult.batch_id, order: orderWithEdits }),
    });

    if (!res.ok || !res.body) {
      setAddLogs([await res.text()]);
      setAddStage("error");
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
          if (ev.type === "status") setAddLogs(prev => [...prev, ev.message]);
          if (ev.type === "result") {
            const addData = ev.data;
            setAddResult(addData);
            setAddStage("done");
            const allMatchedKeys = new Set(
              orderWithEdits.lines
                .filter(l => l.fp_product_id)
                .map(l => deliveryKey(l))
            );
            await handleApproveMatches(allMatchedKeys);
            if (importLogId) {
              try {
                await fetch(`${RAILWAY}/delivery/import-log/${importLogId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    nu_products_added: addData.lines_added ?? 0,
                    nu_products_failed: addData.lines_failed ?? 0,
                    nu_products_skipped: addData.lines_skipped ?? 0,
                    products_status: addData.ok ? "ok" : "partial",
                  }),
                });
              } catch {}
            }
          }
          if (ev.type === "error") {
            setAddLogs(prev => [...prev, `Error: ${ev.message}`]);
            setAddStage("error");
            if (importLogId) {
              try {
                await fetch(`${RAILWAY}/delivery/import-log/${importLogId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ products_status: "error", nu_products_added: 0, nu_products_failed: 0, nu_products_skipped: 0 }),
                });
              } catch {}
            }
          }
        } catch {}
      }
    }
  }

  async function loadCacheManager() {
    const supplierId = parseResult?.supplier_id;
    if (!supplierId) return;
    try {
      const res = await fetch(`${RAILWAY}/catalogue/${supplierId}/matches`);
      if (res.ok) {
        const data = await res.json();
        setCachedMatchesList(data.matches ?? []);
        setShowCacheManager(true);
      }
    } catch {}
  }

  async function deleteCachedMatch(dk: string) {
    const supplierId = parseResult?.supplier_id;
    if (!supplierId) return;
    await fetch(`${RAILWAY}/catalogue/${supplierId}/matches/${encodeURIComponent(dk)}`, { method: "DELETE" });
    setCachedMatchesList(prev => prev.filter(m => m.delivery_key !== dk));
  }

  function reset() {
    setStage("idle");
    setJsonText("");
    setParseResult(null);
    setLogs([]);
    setError("");
    setImportResult(null);
    setAddStage("idle");
    setAddLogs([]);
    setAddResult(null);
    setApprovedKeys(new Set());
    setLineEdits({});
    setEditingKey(null);
    setEditModalOpen(false);
    setShowCacheManager(false);
    setCachedMatchesList([]);
    setResolvedSupplier(null);
    setSupplierPickerOpen(false);
    setSupplierSearch("");
    setShowOnlyUnmatched(false);
    setSortCol(null);
    setSortDir("asc");
    setColFilters({});
    setDuplicateWarning([]);
    setMultiFileError(false);
    setFileLoaded(false);
  }

  function handleSortCol(col: string) {
    if (sortCol === col) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const order = parseResult?.orders[activeOrderIdx];

  const displayLines = useMemo(() => {
    const o = parseResult?.orders[activeOrderIdx];
    if (!o) return [];
    let lines = [...o.lines];

    if (showOnlyUnmatched) {
      lines = lines.filter(l => {
        const dk = `${(l.nm_variety ?? "").toLowerCase().trim()}|${l.nu_length || ""}`;
        return !(lineEdits[dk]?.fp_product_id ?? l.fp_product_id);
      });
    }

    if (colFilters.variety) {
      const f = colFilters.variety.toLowerCase();
      lines = lines.filter(l => l.nm_variety.toLowerCase().includes(f));
    }
    if (colFilters.box) {
      const f = colFilters.box.toLowerCase();
      lines = lines.filter(l => (l.nm_box || "").toLowerCase().includes(f));
    }

    if (sortCol) {
      const dir = sortDir === "asc" ? 1 : -1;
      lines.sort((a, b) => {
        let av: string | number = 0, bv: string | number = 0;
        if (sortCol === "variety")    { av = a.nm_variety;       bv = b.nm_variety; }
        else if (sortCol === "box")   { av = a.nm_box || "";     bv = b.nm_box || ""; }
        else if (sortCol === "length") { av = a.nu_length;       bv = b.nu_length; }
        else if (sortCol === "stemsBunch") { av = a.nu_stems_bunch; bv = b.nu_stems_bunch; }
        else if (sortCol === "bunches") { av = a.nu_bunches;     bv = b.nu_bunches; }
        else if (sortCol === "stemsTotal") { av = a.nu_stems_total; bv = b.nu_stems_total; }
        else if (sortCol === "price") { av = a.mny_rate_stem;    bv = b.mny_rate_stem; }
        else if (sortCol === "total") { av = a.mny_total;        bv = b.mny_total; }
        else if (sortCol === "match") { av = a.match_method;     bv = b.match_method; }
        if (av < bv) return -dir;
        if (av > bv) return dir;
        return 0;
      });
    }
    return lines;
  }, [parseResult, activeOrderIdx, showOnlyUnmatched, colFilters, sortCol, sortDir, lineEdits]);

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-5 sm:gap-6">
      <div>
        <h2 className="text-lg font-bold text-ink">{td.title}</h2>
        <p className="text-sm text-ink-3 mt-0.5">
          {stage === "preview" || stage === "syncing" ? td.descReview
           : stage === "importing" ? td.descImport
           : stage === "done" ? td.descProducts
           : td.descUpload}
        </p>
      </div>

      {/* ── PROGRESS STEPPER ── */}
      <DeliveryStepBar
        stage={stage}
        allDone={stage === "done" && addStage === "done" && (addResult?.ok ?? false)}
        steps={[td.stepUpload, td.stepReview, td.stepImport, td.stepProducts]}
      />

      {/* ── IDLE / INPUT ── */}
      {(stage === "idle" || stage === "parsing") && (
        <div className="flex flex-col gap-4">
          {/* Multi-file error */}
          {multiFileError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600">
              <span>⚠ {td.onlyOneFile}</span>
              <button onClick={() => setMultiFileError(false)} className="ml-auto text-amber-400 hover:text-amber-600 transition-colors">✕</button>
            </div>
          )}

          {/* Duplicate warning */}
          {duplicateWarning.length > 0 && (
            <div className="flex flex-col gap-2 px-3 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs">
              <p className="font-semibold text-amber-700">{td.duplicateWarningTitle}</p>
              <p className="text-amber-600">{td.duplicateWarningMsg(duplicateWarning.join(", "))}</p>
              <div className="flex gap-2 mt-1">
                <button
                  onClick={() => { setDuplicateWarning([]); handleParse(); }}
                  className="h-7 px-3 rounded-lg text-xs font-semibold bg-amber-500/25 text-amber-800 hover:bg-amber-500/35 transition-colors"
                >
                  {td.parseBtn}
                </button>
                <button
                  onClick={() => setDuplicateWarning([])}
                  className="h-7 px-3 rounded-lg text-xs font-medium border border-amber-500/30 text-amber-600 hover:bg-amber-500/10 transition-colors"
                >
                  {t.common.cancel}
                </button>
              </div>
            </div>
          )}

          <div
            className={`border-2 border-dashed rounded-2xl p-4 transition-colors
              ${fileLoaded ? "border-border/40 bg-muted/30" : "border-border hover:border-emerald/40"}`}
            onDragOver={e => e.preventDefault()}
            onDrop={onDrop}
          >
            <textarea
              className={`w-full h-40 bg-transparent text-sm font-mono outline-none resize-none placeholder:text-ink-3/40 transition-colors
                ${fileLoaded ? "text-ink-3/60 cursor-not-allowed select-none" : "text-ink"}`}
              placeholder={td.pastePlaceholder}
              value={jsonText}
              readOnly={fileLoaded}
              onChange={e => { if (!fileLoaded) setJsonText(e.target.value); }}
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px] text-ink-3">{td.dropHint}</span>
              <div className="flex items-center gap-3">
                {jsonText && (
                  <button
                    onClick={() => { setJsonText(""); setDuplicateWarning([]); setMultiFileError(false); setFileLoaded(false); }}
                    className="text-[11px] text-red-400 hover:text-red-600 transition-colors"
                  >
                    {td.clearJson}
                  </button>
                )}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="text-[11px] text-ink-3 hover:text-ink underline"
                >
                  Browse
                </button>
              </div>
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />

          <div className="flex items-center justify-end gap-3">
            {stage === "parsing" && (
              <div className="flex items-center gap-2">
                <svg className="animate-spin w-4 h-4 text-emerald" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/>
                  <path fill="currentColor" className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                <span className="text-sm text-ink-3">{td.parsing}</span>
              </div>
            )}
            <button
              onClick={handleParseClick}
              disabled={!jsonText.trim() || stage === "parsing"}
              className="h-9 px-5 rounded-xl text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity"
            >
              {td.parseBtn}
            </button>
          </div>
        </div>
      )}

      {/* ── PREVIEW ── */}
      {stage === "preview" && order && (
        <div className="flex flex-col gap-5">
          {/* Order tabs if multiple invoices */}
          {parseResult!.orders.length > 1 && (
            <div className="flex gap-2 flex-wrap">
              {parseResult!.orders.map((o, i) => (
                <button
                  key={i}
                  onClick={() => setActiveOrderIdx(i)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors
                    ${i === activeOrderIdx ? "bg-emerald text-white border-transparent" : "border-border text-ink-3 hover:text-ink"}`}
                >
                  {o.id_invoice}
                </button>
              ))}
            </div>
          )}

          {/* Order header */}
          <div className="bg-muted rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Row label={td.supplier} value={order.tx_company} />
            <Row label={td.invoiceNr} value={order.id_invoice} />
            <Row label={td.deliveryDate} value={order.dt_fly} />
            <Row label={td.awb} value={order.tx_awb} />
            <Row label={td.boxes} value={String(order.nu_boxes)} />
            <Row label={td.stemsTotal} value={order.nu_stems_total.toLocaleString()} />
            <Row label={td.valueTotal} value={`$${order.mny_total.toFixed(2)}`} />
          </div>

          {/* FreshPortal supplier resolution row */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-3 shrink-0">{td.fpSupplierLabel}</span>
            {resolvedSupplier ? (
              <>
                <span className="font-medium text-ink">{resolvedSupplier.nm_supplier}</span>
                <span className="text-ink-3/50 text-xs">#{resolvedSupplier.fp_supplier_id}</span>
                <button
                  onClick={openSupplierPicker}
                  title={td.changeSupplierBtn}
                  className="ml-1 text-ink-3 hover:text-ink opacity-60 hover:opacity-100 transition-opacity"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
              </>
            ) : (
              <>
                <span className="text-amber-600 text-xs">{td.supplierNoMatch}</span>
                <button
                  onClick={openSupplierPicker}
                  className="h-6 px-2.5 rounded-lg text-xs font-medium border border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-colors"
                >
                  {td.selectSupplierBtn}
                </button>
              </>
            )}
          </div>

          {/* Catalogue status */}
          <div className="flex items-center gap-3 text-sm flex-wrap">
            <span className={`px-2.5 py-1 rounded-full border text-xs font-medium
              ${(catalogueCount ?? 0) > 0 ? "bg-emerald/10 text-emerald border-emerald/20" : "bg-amber-500/10 text-amber-600 border-amber-500/20"}`}>
              {(catalogueCount ?? 0) > 0
                ? td.catalogueCount(catalogueCount!)
                : td.catalogueEmpty}
            </span>
            <span className="px-2.5 py-1 rounded-full border text-xs text-emerald bg-emerald/10 border-emerald/20">
              {parseResult!.matched_count} {td.matched}
            </span>
            {parseResult!.unmatched_count > 0 && (
              <span className="px-2.5 py-1 rounded-full border text-xs text-red-500 bg-red-500/10 border-red-500/20">
                {parseResult!.unmatched_count} {td.unmatched}
              </span>
            )}
            <div className="ml-auto flex gap-2">
              {canSyncCatalogue && (
                <button
                  onClick={handleSyncCatalogue}
                  className="h-7 px-3 rounded-lg text-xs font-medium border border-border text-ink-3 hover:text-ink hover:border-emerald/40 transition-colors"
                >
                  {td.syncCatalogueBtn}
                </button>
              )}
              {canSyncCatalogue && (
                <button
                  onClick={handleClearCache}
                  disabled={clearingCache}
                  title={td.clearCacheTitle}
                  className="h-7 px-3 rounded-lg text-xs font-medium border border-red-400/40 text-red-500 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                >
                  {clearingCache ? td.clearingCache : td.clearCache}
                </button>
              )}
            </div>
          </div>

          {parseResult!.unmatched_count > 0 && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              ⚠ {td.unmatchedWarning(parseResult!.unmatched_count)}
            </p>
          )}

          {/* Approve toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShowOnlyUnmatched(p => !p)}
              title={showOnlyUnmatched ? td.showAll : td.showOnlyUnmatched}
              className={`h-7 px-3 rounded-lg text-xs font-semibold border transition-colors
                ${showOnlyUnmatched
                  ? "bg-amber-500/15 border-amber-500/30 text-amber-700"
                  : "bg-emerald/8 border-emerald/30 text-emerald hover:bg-emerald/15"}`}
            >
              {td.approved(approvedKeys.size, order.lines.filter(l => l.fp_product_id).length)}
              {showOnlyUnmatched ? " ✕" : ""}
            </button>
            <button
              onClick={() => {
                const all = new Set(order.lines.filter(l => l.fp_product_id).map(l => deliveryKey(l)));
                setApprovedKeys(all);
              }}
              className="h-6 px-2 rounded-md text-[11px] border border-emerald/40 text-emerald hover:bg-emerald/8 transition-colors"
            >
              {td.approveAll}
            </button>
            <button
              onClick={() => setApprovedKeys(new Set())}
              className="h-6 px-2 rounded-md text-[11px] border border-border text-ink-3 hover:text-ink transition-colors"
            >
              {td.deselectAll}
            </button>
            {(Object.values(colFilters).some(Boolean) || sortCol) && (
              <button
                onClick={() => { setColFilters({}); setSortCol(null); setSortDir("asc"); }}
                className="h-6 px-2 rounded-md text-[11px] border border-border text-ink-3 hover:text-ink transition-colors"
              >
                ✕ Reset
              </button>
            )}
            <button
              onClick={loadCacheManager}
              className="h-6 px-2 rounded-md text-[11px] border border-border text-ink-3 hover:text-ink ml-auto transition-colors"
            >
              {td.cacheManager}
            </button>
          </div>

          {/* Action buttons — above the table */}
          <div className="flex items-center justify-end gap-3">
            <button onClick={reset} className="h-9 px-4 rounded-xl text-sm border border-border text-ink-3 hover:text-ink transition-colors bg-surface">
              {td.startOver}
            </button>
            <button
              onClick={handleImport}
              disabled={parseResult!.matched_count === 0}
              className="h-9 px-5 rounded-xl text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity"
            >
              {td.importBtn}
            </button>
          </div>

          {/* Product lines table */}
          <div className="overflow-x-auto overflow-y-auto max-h-[440px] rounded-2xl border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-muted border-b border-border">
                  <th className="px-2 py-2 text-center font-semibold text-ink-3 w-8">✓</th>
                  <SortTh col="variety"    label={td.colVariety}    sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  <SortTh col="box"        label={td.colBox}        sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  <SortTh col="boxQty"     label={td.colBoxQty}     sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  <th className="px-3 py-2 text-left font-semibold text-ink-3 whitespace-nowrap">{td.colContent}</th>
                  <SortTh col="length"     label={td.colLength}     sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  <SortTh col="stemsBunch" label={td.colStemsBunch} sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  <SortTh col="bunches"    label={td.colBunches}    sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  <SortTh col="stemsTotal" label={td.colStemsTotal} sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  <SortTh col="price"      label={td.colPrice}      sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  <SortTh col="total"      label={td.colTotal}      sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  <SortTh col="match"      label={td.colMatch}      sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                </tr>
                {/* Filter row */}
                <tr className="bg-muted/60 border-b border-border/60">
                  <td />
                  <td className="px-2 py-1">
                    <input
                      value={colFilters.variety ?? ""}
                      onChange={e => setColFilters(p => ({ ...p, variety: e.target.value }))}
                      placeholder="…"
                      className="w-full text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface outline-none focus:border-emerald/50 min-w-[60px]"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={colFilters.box ?? ""}
                      onChange={e => setColFilters(p => ({ ...p, box: e.target.value }))}
                      placeholder="…"
                      className="w-full text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface outline-none focus:border-emerald/50 min-w-[40px]"
                    />
                  </td>
                  <td colSpan={9} />
                </tr>
              </thead>
              <tbody>
                {displayLines.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-6 text-center text-xs text-ink-3">
                      {showOnlyUnmatched ? td.showAll : "—"}
                    </td>
                  </tr>
                ) : displayLines.map((line, i) => {
                  const dk = deliveryKey(line);
                  const edit = lineEdits[dk];
                  const displayCatName = edit?.catalogue_nm_product ?? line.catalogue_nm_product;
                  const isApproved = approvedKeys.has(dk);
                  const hasMatch = !!(edit?.fp_product_id ?? line.fp_product_id);
                  const badge = MATCH_BADGE[edit ? "cached" : line.match_method] ?? MATCH_BADGE.none;

                  return (
                    <tr key={i} className={`border-b border-border/60 transition-colors hover:bg-muted/50
                      ${line.match_method === "none" && !edit ? "opacity-60" : ""}
                      ${isApproved ? "bg-green-500/5" : ""}`}>
                      {/* Approve checkbox */}
                      <td className="px-2 py-2 text-center">
                        {hasMatch && (
                          <input
                            type="checkbox"
                            checked={isApproved}
                            onChange={e => {
                              setApprovedKeys(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(dk); else next.delete(dk);
                                return next;
                              });
                            }}
                            className="w-3.5 h-3.5 accent-emerald cursor-pointer"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2 font-medium text-ink">
                        {line.nm_variety}
                        {displayCatName && displayCatName !== line.nm_variety && (
                          <div className="text-ink-3 font-normal">{displayCatName}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {line.nm_box ? (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-medium
                            ${line.nm_box.startsWith("MB")
                              ? "bg-purple-500/10 text-purple-600 border-purple-500/20"
                              : "bg-muted text-ink-3 border-border"}`}>
                            {line.nm_box}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {(line.nu_physical_boxes ?? 1) > 1 ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-semibold bg-blue-500/10 text-blue-600 border-blue-500/20">
                            ×{line.nu_physical_boxes}
                          </span>
                        ) : (
                          <span className="text-ink-3">{line.nu_physical_boxes ?? 1}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-ink-3 text-center">
                        {Math.floor(line.nu_bunches / Math.max(1, line.nu_physical_boxes ?? 1)) * line.nu_stems_bunch}
                      </td>
                      <td className="px-3 py-2 text-ink-3">{line.nu_length > 0 ? `${line.nu_length}cm` : "—"}</td>
                      <td className="px-3 py-2 text-ink-3">{line.nu_stems_bunch || "—"}</td>
                      <td className="px-3 py-2 font-semibold text-ink">{line.nu_bunches}</td>
                      <td className="px-3 py-2 text-ink-3">{line.nu_stems_total > 0 ? line.nu_stems_total.toLocaleString() : "—"}</td>
                      <td className="px-3 py-2 text-ink-3">{line.mny_rate_stem > 0 ? `$${line.mny_rate_stem.toFixed(4)}` : "—"}</td>
                      <td className="px-3 py-2 text-ink-3">{line.mny_total > 0 ? `$${line.mny_total.toFixed(2)}` : "—"}</td>
                      {/* Match badge + edit button */}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${badge.cls}`}>
                            {badge.label}
                          </span>
                          <button
                            onClick={() => { setEditingKey(dk); setEditSearch(""); setEditModalOpen(true); }}
                            title={hasMatch ? td.changeMatch : td.assignFromCatalogue}
                            className={`transition-opacity ${hasMatch ? "text-ink-3 hover:text-ink opacity-50 hover:opacity-100" : "text-red-400 hover:text-red-600 opacity-70 hover:opacity-100"}`}
                          >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Product match modal */}
          {editModalOpen && editingKey && (() => {
            const dk = editingKey;
            const editLine = order.lines.find(l => deliveryKey(l) === dk);
            const currentEdit = lineEdits[dk];
            const currentMatchName = currentEdit?.catalogue_nm_product ?? editLine?.catalogue_nm_product ?? "";
            const catalogue = parseResult?.catalogue ?? [];
            const matchResults = editSearch.length >= 2
              ? catalogue.filter(p => p.nm_product.toLowerCase().includes(editSearch.toLowerCase())).slice(0, 30)
              : catalogue.slice(0, 30);
            return (
              <>
                <div className="fixed inset-0 bg-black/60 z-[200]" onClick={() => { setEditModalOpen(false); setEditingKey(null); setEditSearch(""); }} />
                <div className="fixed inset-x-4 top-12 bottom-4 z-[201] max-w-lg mx-auto rounded-2xl border border-border bg-surface shadow-2xl flex flex-col overflow-hidden">
                  <div className="px-4 py-3 border-b border-border shrink-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-ink">
                          {editLine ? td.editMatchTitle : td.editNoMatchTitle}
                        </p>
                        {editLine && (
                          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-3">
                            <span className="font-medium text-ink">{editLine.nm_variety}</span>
                            {editLine.nm_species && <span>{editLine.nm_species}</span>}
                            {editLine.nu_length > 0 && <span>{editLine.nu_length} cm</span>}
                            {editLine.nu_stems_bunch > 0 && <span>{editLine.nu_stems_bunch} st/bos</span>}
                            {editLine.nu_bunches > 0 && <span>{editLine.nu_bunches} bossen</span>}
                          </div>
                        )}
                        {currentMatchName && (
                          <p className="mt-1 text-[11px] text-ink-3">
                            {td.currentMatch}: <span className="text-emerald font-medium">{currentMatchName}</span>
                          </p>
                        )}
                      </div>
                      <button onClick={() => { setEditModalOpen(false); setEditingKey(null); setEditSearch(""); }} className="text-ink-3 hover:text-ink shrink-0 mt-0.5">✕</button>
                    </div>
                  </div>
                  <div className="px-3 py-2 border-b border-border shrink-0">
                    <input
                      autoFocus
                      value={editSearch}
                      onChange={e => setEditSearch(e.target.value)}
                      onKeyDown={e => { if (e.key === "Escape") { setEditModalOpen(false); setEditingKey(null); setEditSearch(""); } }}
                      placeholder={td.editSearchPlaceholder}
                      className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-surface outline-none focus:border-emerald/50"
                    />
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {matchResults.length === 0 ? (
                      <p className="text-xs text-ink-3 px-4 py-3">{td.noProductsFound}</p>
                    ) : matchResults.map(p => {
                      const isCurrentMatch = (currentEdit?.fp_product_id ?? editLine?.fp_product_id) === p.fp_product_id;
                      return (
                        <button
                          key={p.fp_product_id}
                          onClick={() => {
                            setLineEdits(prev => ({ ...prev, [dk]: { fp_product_id: p.fp_product_id, catalogue_nm_product: p.nm_product } }));
                            setApprovedKeys(prev => { const n = new Set(prev); n.add(dk); return n; });
                            setEditModalOpen(false);
                            setEditingKey(null);
                            setEditSearch("");
                          }}
                          className={`w-full text-left px-4 py-2.5 border-b border-border/60 last:border-0 transition-colors
                            ${isCurrentMatch ? "bg-emerald/8" : "bg-surface hover:bg-muted"}`}
                        >
                          <div className={`text-sm font-medium leading-snug ${isCurrentMatch ? "text-emerald" : "text-ink"}`}>{p.nm_product}</div>
                          <div className="flex items-center gap-2.5 mt-1 flex-wrap">
                            <span className="text-[10px] text-ink-3">#{p.fp_product_id}</span>
                            {p.nu_length != null && p.nu_length > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 font-medium">{p.nu_length} cm</span>
                            )}
                            {p.nu_stems_bunch != null && p.nu_stems_bunch > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 font-medium">{p.nu_stems_bunch} st/bos</span>
                            )}
                            {p.nu_stems_pack != null && p.nu_stems_pack > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-ink-3 font-medium">pack {p.nu_stems_pack}</span>
                            )}
                            {p.nm_packaging && (
                              <span className="text-[10px] text-ink-3">{p.nm_packaging}</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            );
          })()}

          {/* Supplier picker modal */}
          {supplierPickerOpen && (
            <>
              <div
                className="fixed inset-0 bg-black/60 z-[200]"
                onClick={() => setSupplierPickerOpen(false)}
              />
              <div className="fixed inset-x-4 top-16 bottom-16 z-[201] max-w-md mx-auto rounded-2xl border border-border bg-surface shadow-2xl flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                  <div>
                    <span className="text-sm font-semibold text-ink">{td.selectSupplierTitle}</span>
                    <p className="text-xs text-ink-3 mt-0.5">{td.supplierForLabel} {parseResult?.orders[activeOrderIdx]?.tx_company}</p>
                  </div>
                  <button onClick={() => setSupplierPickerOpen(false)} className="text-xs text-ink-3 hover:text-ink">✕</button>
                </div>
                <div className="px-3 py-2 border-b border-border shrink-0">
                  <input
                    autoFocus
                    value={supplierSearch}
                    onChange={e => setSupplierSearch(e.target.value)}
                    placeholder={td.searchSupplierPlaceholder}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-surface outline-none focus:border-emerald/50"
                  />
                </div>
                <div className="overflow-y-auto flex-1 bg-surface">
                  {supplierList.length === 0 ? (
                    <p className="text-xs text-ink-3 px-4 py-3">{td.loadingSuppliers}</p>
                  ) : (
                    supplierList
                      .filter(s => s.nm_supplier.toLowerCase().includes(supplierSearch.toLowerCase()))
                      .map(s => (
                        <button
                          key={s.fp_supplier_id}
                          onClick={() => handleSelectSupplier(s)}
                          className={`w-full text-left px-4 py-2.5 text-sm border-b border-border/60 last:border-0 transition-colors
                            ${resolvedSupplier?.fp_supplier_id === s.fp_supplier_id
                              ? "bg-emerald/10 text-emerald font-medium"
                              : "bg-surface text-ink hover:bg-muted"}`}
                        >
                          {s.nm_supplier}
                          <span className="ml-2 text-xs text-ink-3">#{s.fp_supplier_id}</span>
                        </button>
                      ))
                  )}
                </div>
              </div>
            </>
          )}

          {/* Cache manager — modal dialog */}
          {showCacheManager && (
            <>
              <div
                className="fixed inset-0 bg-black/60 z-[200]"
                onClick={() => setShowCacheManager(false)}
              />
              <div className="fixed inset-x-4 top-12 bottom-4 z-[201] max-w-3xl mx-auto rounded-2xl border border-border bg-surface shadow-2xl flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                  <span className="text-sm font-semibold text-ink">{td.cacheManager} ({td.cacheEntries(cachedMatchesList.length)})</span>
                  <button onClick={() => setShowCacheManager(false)} className="text-xs text-ink-3 hover:text-ink">{td.closeBtn} ✕</button>
                </div>
                {cachedMatchesList.length === 0 ? (
                  <p className="text-xs text-ink-3 px-4 py-3">{td.noSavedMatches}</p>
                ) : (
                  <div className="overflow-y-auto flex-1">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted z-10">
                        <tr className="border-b border-border">
                          <th className="px-3 py-2 text-left text-ink-3 font-semibold">{td.cacheColVariety}</th>
                          <th className="px-3 py-2 text-left text-ink-3 font-semibold">{td.cacheColFpProduct}</th>
                          <th className="px-3 py-2 text-left text-ink-3 font-semibold">{td.cacheColType}</th>
                          <th className="px-3 py-2 text-center text-ink-3 font-semibold">{td.cacheColApproved}</th>
                          <th className="px-2 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {cachedMatchesList.map(m => (
                          <tr key={m.delivery_key} className="border-b border-border/60 hover:bg-muted/50">
                            <td className="px-3 py-1.5 font-mono text-ink-3">{m.nm_variety || m.delivery_key}</td>
                            <td className="px-3 py-1.5 text-ink">{m.nm_product || "—"}</td>
                            <td className="px-3 py-1.5 text-ink-3">{m.match_type}</td>
                            <td className="px-3 py-1.5 text-center">{m.approved ? "✓" : "—"}</td>
                            <td className="px-2 py-1.5">
                              <button
                                onClick={() => deleteCachedMatch(m.delivery_key)}
                                title={td.deleteFromCache}
                                className="text-red-400 hover:text-red-600 transition-colors"
                              >
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                                </svg>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

        </div>
      )}

      {/* ── SYNCING ── */}
      {stage === "syncing" && (
        <ProgressLog title={td.syncing} logs={logs} />
      )}

      {/* ── IMPORTING ── */}
      {stage === "importing" && (
        <ProgressLog title={td.importing} logs={logs} />
      )}

      {/* ── DONE ── */}
      {stage === "done" && importResult && (
        <div className="flex flex-col gap-4">

          {/* Batch creation result — always visible */}
          <div className={`p-4 rounded-2xl border ${importResult.ok ? "bg-emerald/8 border-emerald/20" : "bg-red-500/8 border-red-500/20"}`}>
            <p className={`font-semibold text-sm ${importResult.ok ? "text-emerald" : "text-red-500"}`}>
              {importResult.ok ? td.batchCreated : td.importFailed}
            </p>
            <p className="text-xs text-ink-3 mt-1">{importResult.message}</p>
            {importResult.batch_id && (
              <p className="text-xs text-ink-3 mt-0.5">{td.batchId}: <span className="font-mono font-semibold">{importResult.batch_id}</span></p>
            )}
            {importResult.batch_url && (
              <a href={importResult.batch_url} target="_blank" rel="noopener noreferrer"
                className="text-xs text-emerald underline mt-1 inline-block">
                {td.viewBatch} →
              </a>
            )}
          </div>

          {addStage === "done" && addResult?.ok ? (
            <>
              <div className="p-4 rounded-2xl border bg-emerald/8 border-emerald/20">
                <p className="font-semibold text-sm text-emerald">
                  {td.productsAdded(addResult.lines_added)}
                  {addResult.lines_failed > 0 && `, ${addResult.lines_failed} failed`}
                  {addResult.lines_skipped > 0 && `, ${addResult.lines_skipped} bez dopasowania`}
                </p>
                <p className="text-xs text-ink-3 mt-1">{addResult.message}</p>
                {addResult.details.length > 0 && (
                  <div className="mt-2 max-h-52 overflow-y-auto space-y-0.5 pr-1">
                    {addResult.details.map((d, i) => (
                      <div key={i} className={`text-xs font-mono ${d.status === "added" ? "text-emerald" : "text-red-400"}`}>
                        {d.status === "added" ? "✓" : "✗"} {d.product}
                      </div>
                    ))}
                  </div>
                )}
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-ink-3 hover:text-ink">{td.fullLog(addLogs.length)}</summary>
                  <div className="mt-1 bg-muted rounded-xl p-2 max-h-64 overflow-y-auto font-mono space-y-0.5">
                    {addLogs.map((l, i) => (
                      <div key={i} className={l.startsWith("  ✓") ? "text-emerald" : l.startsWith("  ✗") ? "text-red-400" : "text-ink-3"}>{l}</div>
                    ))}
                  </div>
                </details>
              </div>

              <details className="text-xs">
                <summary className="cursor-pointer text-ink-3 hover:text-ink">{td.batchLog(logs.length)}</summary>
                <div className="mt-2 bg-muted rounded-xl p-3 max-h-48 overflow-y-auto font-mono space-y-0.5">
                  {logs.map((l, i) => <div key={i} className="text-ink-3">{l}</div>)}
                </div>
              </details>

              <button onClick={reset} className="self-end h-10 px-6 rounded-xl text-sm font-semibold bg-emerald text-white hover:bg-emerald/90 active:scale-[0.98] transition-all">
                {td.startOver}
              </button>
            </>
          ) : (
            <>
              {importResult.ok && importResult.batch_id && (
                <div className="flex flex-col gap-3">
                  {addStage === "idle" && (
                    <button
                      onClick={handleAddProducts}
                      className="h-10 px-6 rounded-xl text-sm font-semibold bg-emerald text-white hover:bg-emerald/90 transition-colors"
                    >
                      {td.addProductsBtn(importResult.batch_id)}
                    </button>
                  )}

                  {addStage === "running" && (
                    <ProgressLog title={td.addingProducts} logs={addLogs} />
                  )}

                  {addStage === "done" && addResult && !addResult.ok && (
                    <div className={`p-4 rounded-2xl border bg-amber-500/8 border-amber-500/20`}>
                      <p className="font-semibold text-sm text-amber-600">
                        {td.productsAdded(addResult.lines_added)}
                        {addResult.lines_failed > 0 && `, ${addResult.lines_failed} failed`}
                      </p>
                      <p className="text-xs text-ink-3 mt-1">{addResult.message}</p>
                    </div>
                  )}

                  {addStage === "error" && (
                    <div className="p-3 rounded-xl bg-red-500/8 border border-red-500/20">
                      <p className="text-sm font-semibold text-red-500">{td.addProductsFailed}</p>
                      <div className="mt-1 font-mono text-xs text-red-400 space-y-0.5">
                        {addLogs.map((l, i) => <div key={i}>{l}</div>)}
                      </div>
                      <button onClick={() => setAddStage("idle")} className="mt-2 text-xs text-ink-3 underline">
                        {td.retryBtn}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <details className="text-xs">
                <summary className="cursor-pointer text-ink-3 hover:text-ink">{td.batchLog(logs.length)}</summary>
                <div className="mt-2 bg-muted rounded-xl p-3 max-h-48 overflow-y-auto font-mono space-y-0.5">
                  {logs.map((l, i) => <div key={i} className="text-ink-3">{l}</div>)}
                </div>
              </details>

              <button onClick={reset} className="self-end h-9 px-5 rounded-xl text-sm border border-border text-ink-3 hover:text-ink transition-colors">
                {td.startOver}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── ERROR ── */}
      {stage === "error" && (
        <div className="flex flex-col gap-3">
          <div className="p-4 rounded-2xl bg-red-500/8 border border-red-500/20">
            <p className="text-sm font-semibold text-red-500">{t.common.error}</p>
            <p className="text-xs text-red-400 mt-1 font-mono">{error}</p>
          </div>
          <button onClick={reset} className="self-end h-9 px-5 rounded-xl text-sm border border-border text-ink-3 hover:text-ink transition-colors">
            {t.common.retry}
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-ink-3 shrink-0 w-28">{label}</span>
      <span className="font-medium text-ink">{value || "—"}</span>
    </div>
  );
}

function SortTh({
  col, label, sortCol, sortDir, onSort,
}: {
  col: string; label: string; sortCol: string | null; sortDir: "asc" | "desc"; onSort: (col: string) => void;
}) {
  const active = sortCol === col;
  return (
    <th
      className="px-3 py-2 text-left font-semibold text-ink-3 whitespace-nowrap cursor-pointer select-none hover:text-ink transition-colors"
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[9px] ${active ? "text-emerald" : "opacity-30"}`}>
          {active ? (sortDir === "asc" ? "▲" : "▼") : "▲▼"}
        </span>
      </span>
    </th>
  );
}

function DeliveryStepBar({
  stage, steps, allDone,
}: {
  stage: Stage; steps: string[]; allDone: boolean;
}) {
  const current = allDone ? steps.length
    : stage === "idle" || stage === "parsing" || stage === "error" ? 0
    : stage === "preview" || stage === "syncing" ? 1
    : stage === "importing" ? 2
    : 3;

  return (
    <div className="flex items-start w-full">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={i} className="flex items-start flex-1 min-w-0">
            <div className="flex flex-col items-center gap-2 flex-shrink-0">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold ring-2 transition-all
                ${done    ? "bg-emerald ring-emerald text-white"
                : active  ? "bg-surface ring-emerald text-emerald"
                :           "bg-surface ring-border text-ink-3"}`}>
                {done ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : i + 1}
              </div>
              <span className={`text-[11px] font-medium text-center whitespace-nowrap
                ${active ? "text-emerald" : done ? "text-ink-3" : "text-ink-3/50"}`}>
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-0.5 mt-[18px] mx-1.5 rounded-full transition-colors
                ${done ? "bg-emerald" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProgressLog({ title, logs }: { title: string; logs: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <svg className="animate-spin w-4 h-4 text-emerald" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/>
          <path fill="currentColor" className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
        <span className="text-sm font-semibold text-ink">{title}</span>
      </div>
      <div ref={containerRef} className="bg-muted rounded-2xl p-4 h-72 overflow-y-auto font-mono text-xs space-y-0.5">
        {logs.map((l, i) => (
          <div key={i} className={`${l.startsWith("  ⚠") || l.startsWith("Error") ? "text-amber-500" : l.startsWith("  ✓") ? "text-emerald" : "text-ink-3"}`}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}
