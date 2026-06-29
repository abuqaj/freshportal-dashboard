"use client";

import { useState, useRef, useCallback, useEffect } from "react";
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

interface ParseResult {
  orders: DeliveryOrder[];
  supplier_id: string;
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

  const [stage, setStage] = useState<Stage>("idle");
  const [importLogId, setImportLogId] = useState<number | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [activeOrderIdx, setActiveOrderIdx] = useState(0);
  const [catalogueCount, setCatalogueCount] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<{ ok: boolean; batch_id: string; batch_url: string; lines_added: number; message: string } | null>(null);
  const [error, setError] = useState("");

  // ── Fust (packaging) sync ─────────────────────────────
  const [fustSyncing, setFustSyncing] = useState(false);
  const [fustCount, setFustCount] = useState<number | null>(null);
  const [fustLogs, setFustLogs] = useState<string[]>([]);

  async function handleSyncFust() {
    setFustSyncing(true);
    setFustLogs([]);
    try {
      const res = await fetch(`${RAILWAY}/fust/sync`, { method: "POST" });
      if (!res.ok || !res.body) { setFustLogs([await res.text()]); return; }
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
            if (ev.type === "status") setFustLogs(prev => [...prev, ev.message]);
            if (ev.type === "result") setFustCount(ev.data.entries_saved);
            if (ev.type === "error") setFustLogs(prev => [...prev, `Błąd: ${ev.message}`]);
          } catch {}
        }
      }
    } finally {
      setFustSyncing(false);
    }
  }

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

  function deliveryKey(line: DeliveryLine): string {
    return `${(line.nm_variety ?? "").toLowerCase().trim()}|${line.nu_length || ""}`;
  }

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev, msg]);
  }, []);

  // ── File drop / select ──────────────────────────────────────────────────

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = e => setJsonText((e.target?.result as string) || "");
    reader.readAsText(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith(".json")) handleFile(f);
  }

  // ── Clear match cache ──────────────────────────────────────────────────

  const [clearingCache, setClearingCache] = useState(false);

  async function handleClearCache() {
    const supplierId = parseResult?.supplier_id;
    if (!supplierId) { alert("Najpierw sparsuj JSON żeby poznać dostawcę."); return; }
    if (!confirm(`Wyczyścić wszystkie cache'd matche dla supplier ${supplierId}?`)) return;
    setClearingCache(true);
    try {
      const res = await fetch(`${RAILWAY}/catalogue/${supplierId}/matches`, { method: "DELETE" });
      const data = await res.json();
      alert(`Usunięto ${data.deleted} wpisów z cache. Parsuj ponownie.`);
    } catch { alert("Błąd podczas czyszczenia cache."); }
    finally { setClearingCache(false); }
  }

  // ── Parse & match ──────────────────────────────────────────────────────

  async function handleParse() {
    if (!jsonText.trim()) return;
    setStage("parsing");
    setError("");
    try {
      const body = JSON.parse(jsonText);
      const res = await fetch(`${RAILWAY}/delivery/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_json: body, with_matching: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: ParseResult = await res.json();
      setParseResult(data);
      setCatalogueCount(data.catalogue_count);
      setActiveOrderIdx(0);
      setLineEdits({});
      setEditingKey(null);
      // Pre-approve lines that are already cached from DB
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

  // ── Sync catalogue ──────────────────────────────────────────────────────

  async function handleSyncCatalogue() {
    const order = parseResult?.orders[activeOrderIdx];
    setStage("syncing");
    setLogs([]);

    // Resolve fp_supplier_id from the company name in the parsed order
    let supplierId = "";
    let supplierName = order?.tx_company ?? "";
    try {
      const suppRes = await fetch(`${RAILWAY}/catalogue/suppliers`);
      if (suppRes.ok) {
        const suppData = await suppRes.json();
        const list: Array<{ fp_supplier_id: string; nm_supplier: string }> =
          suppData.suppliers ?? [];
        const needle = supplierName.toLowerCase();
        const match =
          list.find(s => s.nm_supplier.toLowerCase().includes(needle)) ||
          list.find(s => {
            const firstWord = needle.split(" ")[0];
            return firstWord && s.nm_supplier.toLowerCase().includes(firstWord);
          });
        if (match) {
          supplierId = match.fp_supplier_id;
          supplierName = match.nm_supplier;
        }
      }
    } catch {}

    if (!supplierId) {
      addLog(`Supplier '${supplierName}' not found — cannot sync`);
      setStage("preview");
      return;
    }

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
        const line = part.replace(/^data: /, "").trim();
        if (!line || line.startsWith(":")) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "status") addLog(ev.message);
          if (ev.type === "result") {
            setCatalogueCount(ev.data.items_saved);
            setStage("preview");
            handleParse();
          }
          if (ev.type === "error") {
            addLog(`Error: ${ev.message}`);
            setStage("preview");
          }
        } catch {}
      }
    }
  }

  // ── Import to FreshPortal ───────────────────────────────────────────────

  async function handleImport() {
    if (!parseResult) return;
    const order = parseResult.orders[activeOrderIdx];
    if (!order) return;

    // Cache all matched lines immediately — leaving the matching screen means user agreed
    const keysToCache = new Set(
      order.lines
        .filter(l => !!(lineEdits[deliveryKey(l)]?.fp_product_id ?? l.fp_product_id))
        .map(l => deliveryKey(l))
    );
    await handleApproveMatches(keysToCache);

    setStage("importing");
    setLogs([]);
    setImportResult(null);

    // POST to create-batch: backend resolves supplier via find_supplier_fp_id(tx_company)
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
            // Log import to history
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
    const matches = order.lines
      .map(line => {
        const dk = deliveryKey(line);
        const edit = lineEdits[dk];
        const effectiveFpId = edit?.fp_product_id ?? line.fp_product_id;
        if (!effectiveFpId) return null;
        if (!keysToSave.has(dk)) return null;
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

    // Build order with any inline edits applied
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
            // Auto-approve all matched lines after successful import
            const allMatchedKeys = new Set(
              orderWithEdits.lines
                .filter(l => l.fp_product_id)
                .map(l => deliveryKey(l))
            );
            await handleApproveMatches(allMatchedKeys);
            // Update history log with add-products result
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
            // Log failure
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
    setShowCacheManager(false);
    setCachedMatchesList([]);
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const order = parseResult?.orders[activeOrderIdx];

  return (
    <div className="p-6 flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-bold text-ink">{td.title}</h2>
        <p className="text-sm text-ink-3 mt-0.5">{td.description}</p>
      </div>

      {/* ── IDLE / INPUT ── */}
      {(stage === "idle" || stage === "parsing") && (
        <div className="flex flex-col gap-4">
          <div
            className="border-2 border-dashed border-border rounded-2xl p-4 transition-colors hover:border-emerald/40"
            onDragOver={e => e.preventDefault()}
            onDrop={onDrop}
          >
            <textarea
              className="w-full h-40 bg-transparent text-sm font-mono text-ink outline-none resize-none placeholder:text-ink-3/40"
              placeholder={td.pastePlaceholder}
              value={jsonText}
              onChange={e => setJsonText(e.target.value)}
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px] text-ink-3">{td.dropHint}</span>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-[11px] text-ink-3 hover:text-ink underline"
              >
                Browse
              </button>
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />

          <button
            onClick={handleParse}
            disabled={!jsonText.trim() || stage === "parsing"}
            className="self-end h-9 px-5 rounded-xl text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity"
          >
            {stage === "parsing" ? td.parsing : td.parseBtn}
          </button>
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
          <div className="bg-muted rounded-2xl p-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Row label={td.supplier} value={order.tx_company} />
            <Row label={td.invoiceNr} value={order.id_invoice} />
            <Row label={td.deliveryDate} value={order.dt_fly} />
            <Row label={td.awb} value={order.tx_awb} />
            <Row label={td.boxes} value={String(order.nu_boxes)} />
            <Row label={td.stemsTotal} value={order.nu_stems_total.toLocaleString()} />
            <Row label={td.valueTotal} value={`€${order.mny_total.toFixed(2)}`} />
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
              {/* Fust (packaging) sync — one-time setup per FP system */}
              <button
                onClick={handleSyncFust}
                disabled={fustSyncing}
                title={fustCount !== null ? `Ostatnia synchronizacja: ${fustCount} typów opakowań` : "Synchronizuj typy opakowań (jednorazowo)"}
                className={`h-7 px-3 rounded-lg text-xs font-medium border transition-colors
                  ${fustCount !== null
                    ? "border-emerald/30 text-emerald bg-emerald/8 hover:bg-emerald/15"
                    : "border-border text-ink-3 hover:text-ink hover:border-border-hover"}
                  disabled:opacity-40`}
              >
                {fustSyncing ? "Syncing…" : fustCount !== null ? `Opakowania ✓ ${fustCount}` : "Sync opakowania"}
              </button>
              <button
                onClick={handleSyncCatalogue}
                className="h-7 px-3 rounded-lg text-xs font-medium border border-border text-ink-3 hover:text-ink hover:border-emerald/40 transition-colors"
              >
                {td.syncCatalogueBtn}
              </button>
              <button
                onClick={handleClearCache}
                disabled={clearingCache}
                title="Usuń zcachowane matche — następny parse użyje świeżego algorytmu"
                className="h-7 px-3 rounded-lg text-xs font-medium border border-red-400/40 text-red-500 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
              >
                {clearingCache ? "Czyszczę…" : "Wyczyść cache"}
              </button>
            </div>
          </div>

          {/* Fust sync progress log (collapses when done) */}
          {fustLogs.length > 0 && (
            <details open={fustSyncing}>
              <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink">
                Log sync opakowań ({fustLogs.length} linii)
              </summary>
              <div className="mt-1 bg-muted rounded-xl p-2 max-h-40 overflow-y-auto font-mono text-xs space-y-0.5">
                {fustLogs.map((l, i) => <div key={i} className="text-ink-3">{l}</div>)}
              </div>
            </details>
          )}

          {parseResult!.unmatched_count > 0 && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              ⚠ {td.unmatchedWarning(parseResult!.unmatched_count)}
            </p>
          )}

          {/* Approve toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-ink-3">
              {approvedKeys.size} / {order.lines.filter(l => l.fp_product_id).length} zatwierdzone
            </span>
            <button
              onClick={() => {
                const all = new Set(order.lines.filter(l => l.fp_product_id).map(l => deliveryKey(l)));
                setApprovedKeys(all);
              }}
              className="h-6 px-2 rounded-md text-[11px] border border-emerald/40 text-emerald hover:bg-emerald/8 transition-colors"
            >
              Zatwierdź wszystkie
            </button>
            <button
              onClick={() => setApprovedKeys(new Set())}
              className="h-6 px-2 rounded-md text-[11px] border border-border text-ink-3 hover:text-ink transition-colors"
            >
              Odznacz wszystkie
            </button>
            <button
              onClick={() => handleApproveMatches()}
              disabled={approvedKeys.size === 0 || savingApproved}
              className="h-6 px-3 rounded-md text-[11px] font-semibold border border-green-500/40 text-green-700 bg-green-500/8 hover:bg-green-500/15 disabled:opacity-40 transition-colors"
            >
              {savingApproved ? "Zapisuję…" : `Zapisz zatwierdzone (${approvedKeys.size})`}
            </button>
            <button
              onClick={loadCacheManager}
              className="h-6 px-2 rounded-md text-[11px] border border-border text-ink-3 hover:text-ink ml-auto transition-colors"
            >
              Pamięć systemu
            </button>
          </div>

          {/* Product lines table */}
          <div className="overflow-x-auto overflow-y-auto max-h-[420px] rounded-2xl border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-muted border-b border-border">
                  <th className="px-2 py-2 text-center font-semibold text-ink-3 w-8">✓</th>
                  {[td.colVariety, td.colBox, td.colBoxQty, td.colContent, td.colLength, td.colStemsBunch, td.colBunches, td.colStemsTotal, td.colPrice, td.colTotal, td.colMatch].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold text-ink-3 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line, i) => {
                  const dk = deliveryKey(line);
                  const edit = lineEdits[dk];
                  const displayCatName = edit?.catalogue_nm_product ?? line.catalogue_nm_product;
                  const isApproved = approvedKeys.has(dk);
                  const isEditing = editingKey === dk;
                  const hasMatch = !!line.fp_product_id;
                  const badge = MATCH_BADGE[line.match_method] ?? MATCH_BADGE.none;
                  const catalogueForSearch = parseResult?.catalogue ?? [];
                  const searchResults = isEditing && editSearch.length >= 2
                    ? catalogueForSearch.filter(p =>
                        p.nm_product.toLowerCase().includes(editSearch.toLowerCase())
                      ).slice(0, 8)
                    : [];

                  return (
                    <tr key={i} className={`border-b border-border/60 transition-colors hover:bg-muted/50
                      ${line.match_method === "none" ? "opacity-60" : ""}
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
                      <td className="px-3 py-2 text-ink-3">{line.mny_rate_stem > 0 ? `€${line.mny_rate_stem.toFixed(4)}` : "—"}</td>
                      <td className="px-3 py-2 text-ink-3">{line.mny_total > 0 ? `€${line.mny_total.toFixed(2)}` : "—"}</td>
                      {/* Match badge + inline edit */}
                      <td className="px-3 py-2">
                        {isEditing ? (
                          <div className="relative">
                            <input
                              autoFocus
                              value={editSearch}
                              onChange={e => setEditSearch(e.target.value)}
                              onKeyDown={e => { if (e.key === "Escape") { setEditingKey(null); setEditSearch(""); } }}
                              placeholder="Szukaj produktu…"
                              className="w-48 px-2 py-1 text-[11px] border border-emerald/50 rounded-md bg-background outline-none"
                            />
                            {searchResults.length > 0 && (
                              <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-background border border-border rounded-xl shadow-lg overflow-hidden">
                                {searchResults.map(p => (
                                  <button
                                    key={p.fp_product_id}
                                    onClick={() => {
                                      setLineEdits(prev => ({ ...prev, [dk]: { fp_product_id: p.fp_product_id, catalogue_nm_product: p.nm_product } }));
                                      setApprovedKeys(prev => { const n = new Set(prev); n.add(dk); return n; });
                                      setEditingKey(null);
                                      setEditSearch("");
                                    }}
                                    className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-muted border-b border-border/50 last:border-0 truncate"
                                  >
                                    {p.nm_product}
                                  </button>
                                ))}
                              </div>
                            )}
                            <button onClick={() => { setEditingKey(null); setEditSearch(""); }} className="ml-1 text-ink-3 hover:text-ink text-[11px]">✕</button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${badge.cls}`}>
                              {badge.label}
                            </span>
                            {hasMatch && (
                              <button
                                onClick={() => { setEditingKey(dk); setEditSearch(""); }}
                                title="Zmień dopasowanie"
                                className="text-ink-3 hover:text-ink opacity-50 hover:opacity-100 transition-opacity"
                              >
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                </svg>
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Cache manager panel */}
          {showCacheManager && (
            <div className="rounded-2xl border border-border bg-muted/40 p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-ink">Pamięć systemu ({cachedMatchesList.length} wpisów)</span>
                <button onClick={() => setShowCacheManager(false)} className="text-xs text-ink-3 hover:text-ink">Zamknij ✕</button>
              </div>
              {cachedMatchesList.length === 0 ? (
                <p className="text-xs text-ink-3">Brak zapisanych dopasowań.</p>
              ) : (
                <div className="overflow-y-auto max-h-64 rounded-xl border border-border bg-background">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr className="border-b border-border">
                        <th className="px-3 py-1.5 text-left text-ink-3 font-semibold">Odmiana</th>
                        <th className="px-3 py-1.5 text-left text-ink-3 font-semibold">Produkt FP</th>
                        <th className="px-3 py-1.5 text-left text-ink-3 font-semibold">Typ</th>
                        <th className="px-3 py-1.5 text-center text-ink-3 font-semibold">Zatw.</th>
                        <th className="px-1 py-1.5"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {cachedMatchesList.map(m => (
                        <tr key={m.delivery_key} className="border-b border-border/60 hover:bg-muted/50">
                          <td className="px-3 py-1.5 font-mono text-ink-3">{m.nm_variety || m.delivery_key}</td>
                          <td className="px-3 py-1.5 text-ink">{m.nm_product || "—"}</td>
                          <td className="px-3 py-1.5 text-ink-3">{m.match_type}</td>
                          <td className="px-3 py-1.5 text-center">{m.approved ? "✓" : "—"}</td>
                          <td className="px-1 py-1.5">
                            <button
                              onClick={() => deleteCachedMatch(m.delivery_key)}
                              title="Usuń z pamięci"
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
          )}

          {/* Actions */}
          <div className="flex gap-3 justify-end">
            <button onClick={reset} className="h-9 px-4 rounded-xl text-sm border border-border text-ink-3 hover:text-ink transition-colors">
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

          {/* Batch creation result */}
          <div className={`p-4 rounded-2xl border ${importResult.ok ? "bg-emerald/8 border-emerald/20" : "bg-red-500/8 border-red-500/20"}`}>
            <p className={`font-semibold text-sm ${importResult.ok ? "text-emerald" : "text-red-500"}`}>
              {importResult.ok ? "Przesyłka stworzona" : td.importFailed}
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

          {/* Add Products step — only when batch was created */}
          {importResult.ok && importResult.batch_id && (
            <div className="flex flex-col gap-3">
              {addStage === "idle" && (
                <button
                  onClick={handleAddProducts}
                  className="h-10 px-6 rounded-xl text-sm font-semibold bg-emerald text-white hover:bg-emerald/90 transition-colors"
                >
                  Dodaj produkty do przesyłki #{importResult.batch_id}
                </button>
              )}

              {addStage === "running" && (
                <ProgressLog title="Dodawanie produktów…" logs={addLogs} />
              )}

              {addStage === "done" && addResult && (
                <div className={`p-4 rounded-2xl border ${addResult.ok ? "bg-emerald/8 border-emerald/20" : "bg-amber-500/8 border-amber-500/20"}`}>
                  <p className={`font-semibold text-sm ${addResult.ok ? "text-emerald" : "text-amber-600"}`}>
                    {addResult.lines_added} produktów dodanych
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
                    <summary className="cursor-pointer text-ink-3 hover:text-ink">Pełny log ({addLogs.length} linii)</summary>
                    <div className="mt-1 bg-muted rounded-xl p-2 max-h-64 overflow-y-auto font-mono space-y-0.5">
                      {addLogs.map((l, i) => (
                        <div key={i} className={l.startsWith("  ✓") ? "text-emerald" : l.startsWith("  ✗") ? "text-red-400" : "text-ink-3"}>{l}</div>
                      ))}
                    </div>
                  </details>
                </div>
              )}

              {addStage === "error" && (
                <div className="p-3 rounded-xl bg-red-500/8 border border-red-500/20">
                  <p className="text-sm font-semibold text-red-500">Błąd dodawania produktów</p>
                  <div className="mt-1 font-mono text-xs text-red-400 space-y-0.5">
                    {addLogs.map((l, i) => <div key={i}>{l}</div>)}
                  </div>
                  <button onClick={() => setAddStage("idle")} className="mt-2 text-xs text-ink-3 underline">
                    Spróbuj ponownie
                  </button>
                </div>
              )}
            </div>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-ink-3 hover:text-ink">Log tworzenia przesyłki ({logs.length})</summary>
            <div className="mt-2 bg-muted rounded-xl p-3 max-h-48 overflow-y-auto font-mono space-y-0.5">
              {logs.map((l, i) => <div key={i} className="text-ink-3">{l}</div>)}
            </div>
          </details>

          <button onClick={reset} className="self-end h-9 px-5 rounded-xl text-sm border border-border text-ink-3 hover:text-ink transition-colors">
            {td.startOver}
          </button>
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
