"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { translations, Lang } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

type MatchMethod =
  | "variety_length" | "variety_nolen"
  | "floricode"
  | "fuzzy_variety" | "fuzzy_variety_nolen" | "fuzzy_nolen"
  | "none";

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
  catalogue_count: number;
  matched_count: number;
  unmatched_count: number;
}

type Stage = "idle" | "parsing" | "preview" | "syncing" | "importing" | "done" | "error";

const MATCH_BADGE: Record<MatchMethod, { label: string; cls: string }> = {
  variety_length:       { label: "exact",       cls: "bg-emerald/15 text-emerald border-emerald/20" },
  variety_nolen:        { label: "exact~len",   cls: "bg-emerald/10 text-emerald border-emerald/15" },
  floricode:            { label: "VBN",         cls: "bg-blue-500/15 text-blue-600 border-blue-500/20" },
  fuzzy_variety:        { label: "fuzzy",       cls: "bg-amber-500/15 text-amber-600 border-amber-500/20" },
  fuzzy_variety_nolen:  { label: "fuzzy~len",   cls: "bg-amber-500/10 text-amber-600 border-amber-500/15" },
  fuzzy_nolen:          { label: "fuzzy~",      cls: "bg-orange-500/15 text-orange-600 border-orange-500/20" },
  none:                 { label: "no match",    cls: "bg-red-500/10 text-red-500 border-red-500/20" },
};

export default function DeliveryImporter({ lang }: { lang: Lang }) {
  const t = translations[lang];
  const td = t.delivery;

  const [stage, setStage] = useState<Stage>("idle");
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
        body: JSON.stringify({ raw_json: body, supplier_id: "27", with_matching: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: ParseResult = await res.json();
      setParseResult(data);
      setCatalogueCount(data.catalogue_count);
      setActiveOrderIdx(0);
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
    setStage("importing");
    setLogs([]);
    setImportResult(null);

    // POST to create-batch: backend resolves supplier via find_supplier_fp_id(tx_company)
    const res = await fetch(`${RAILWAY}/delivery/create-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, supplier_id: "27" }),
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
            setImportResult(ev.data);
            setStage("done");
          }
          if (ev.type === "error") {
            setError(ev.message);
            setStage("error");
          }
        } catch {}
      }
    }
  }

  async function handleAddProducts() {
    if (!importResult?.batch_id || !parseResult) return;
    const order = parseResult.orders[activeOrderIdx];
    if (!order) return;

    setAddStage("running");
    setAddLogs([]);
    setAddResult(null);

    const res = await fetch(`${RAILWAY}/delivery/add-products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch_id: importResult.batch_id, order }),
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
            setAddResult(ev.data);
            setAddStage("done");
          }
          if (ev.type === "error") {
            setAddLogs(prev => [...prev, `Error: ${ev.message}`]);
            setAddStage("error");
          }
        } catch {}
      }
    }
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

          {/* Product lines table */}
          <div className="overflow-x-auto overflow-y-auto max-h-[420px] rounded-2xl border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-muted border-b border-border">
                  {[td.colVariety, td.colBox, td.colLength, td.colStemsBunch, td.colBunches, td.colStemsTotal, td.colPrice, td.colTotal, td.colMatch].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold text-ink-3 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line, i) => {
                  const badge = MATCH_BADGE[line.match_method] ?? MATCH_BADGE.none;
                  return (
                    <tr key={i} className={`border-b border-border/60 transition-colors hover:bg-muted/50
                      ${line.match_method === "none" ? "opacity-60" : ""}`}>
                      <td className="px-3 py-2 font-medium text-ink">
                        {line.nm_variety}
                        {line.catalogue_nm_product && line.catalogue_nm_product !== line.nm_variety && (
                          <div className="text-ink-3 font-normal">{line.catalogue_nm_product}</div>
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
                      <td className="px-3 py-2 text-ink-3">{line.nu_length > 0 ? `${line.nu_length}cm` : "—"}</td>
                      <td className="px-3 py-2 text-ink-3">{line.nu_stems_bunch || "—"}</td>
                      <td className="px-3 py-2 font-semibold text-ink">{line.nu_bunches}</td>
                      <td className="px-3 py-2 text-ink-3">{line.nu_stems_total > 0 ? line.nu_stems_total.toLocaleString() : "—"}</td>
                      <td className="px-3 py-2 text-ink-3">{line.mny_rate_stem > 0 ? `€${line.mny_rate_stem.toFixed(4)}` : "—"}</td>
                      <td className="px-3 py-2 text-ink-3">{line.mny_total > 0 ? `€${line.mny_total.toFixed(2)}` : "—"}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

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
