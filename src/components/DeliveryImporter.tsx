"use client";

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useSession } from "next-auth/react";
import { translations, Lang } from "@/lib/i18n";
import DeliveryTour, { TourStep } from "./DeliveryTour";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

const POMAROSA_GROWER_NAMES: Record<string, string> = {
  "tessa-e1":  "Ecuanros",
  "tessa-e2":  "Ecuanros",
  "tessa-s":   "Solera",
  "tessa-p":   "Positano",
  "tessa-ps2": "Positano",
  "tessa-1":   "Tessa",
  "tessa-3":   "Tessa",
  "tessa-d":   "Growerfarms S.A",
  "tessa-f":   "Arcoflor Floress Arcoiris",
  "tessa-r1":  "Inversiones Pontetresa",
  "tessa-r2":  "Inversiones Pontetresa",
  "tessa-r3":  "Inversiones Pontetresa",
};

function resolvePomarosaGrower(nmLocation: string): string {
  const key = nmLocation.replace(/\s+/g, "").toLowerCase();
  return POMAROSA_GROWER_NAMES[key] ?? nmLocation;
}

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
  nm_location: string;
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
  supplier_confirmed: boolean;
  matched_count: number;
  unmatched_count: number;
}

type Stage = "idle" | "parsing" | "shipment" | "preview" | "importing" | "done" | "error";

interface DfgLineError {
  product_number: string;
  length: number;
  message: string;
}

interface DfgCreateResult {
  batch_id: number | null;
  number: string;
  created: boolean;
  stock_entries_ok: unknown[];
  errors: DfgLineError[];
  skipped_unmatched: string[];
}

// ── Demo data for guided tour ─────────────────────────────────────────────

const DEMO_JSON = `{
  "invoices": [{
    "id_invoice": "INV-2024-DEMO",
    "tx_company": "Demo Grower B.V.",
    "dt_fly": "2024-06-15",
    "tx_awb": "176-12345678",
    "nu_boxes": 8,
    "lines": [
      { "nm_variety": "ROSES RED NAOMI", "nu_length": 60, "nu_bunches": 10 },
      { "nm_variety": "CHRYSANTH ANASTASIA WHITE", "nu_length": 70, "nu_bunches": 20 },
      { "nm_variety": "ALSTROEM PINK FLOYD", "nu_length": 60, "nu_bunches": 15 },
      { "nm_variety": "GERBERA MINI PINK", "nu_length": 45, "nu_bunches": 20 },
      { "nm_variety": "TULIP RED DYNASTY", "nu_length": 40, "nu_bunches": 25 }
    ]
  }]
}`;

const DEMO_PARSE_RESULT: ParseResult = {
  orders: [{
    tx_company: "Demo Grower B.V.", id_invoice: "INV-2024-DEMO", id_purchaseorder: "PO-88001",
    dt_fly: "2024-06-15", dt_invoice: "2024-06-12", tx_awb: "176-12345678", tx_hawb: "HAW-001",
    nu_boxes: 8, nu_stems_total: 1575, mny_total: 441.00,
    lines: [
      { gu_product: "d1", nm_variety: "ROSES RED NAOMI", nm_species: "Rosa", nu_length: 60, nu_stems_bunch: 25, nu_bunches: 10, nu_stems_total: 250, mny_rate_stem: 0.38, mny_total: 95.00, id_floricode: "VB401010", nm_product: "Roses Red Naomi 60cm", nm_box: "FB", nu_physical_boxes: 2, fp_product_id: "10001", match_method: "variety_length", catalogue_nm_product: "Roses Red Naomi 60cm", nm_location: "" },
      { gu_product: "d2", nm_variety: "CHRYSANTH ANASTASIA WHITE", nm_species: "Chrysanthemum", nu_length: 70, nu_stems_bunch: 10, nu_bunches: 20, nu_stems_total: 200, mny_rate_stem: 0.22, mny_total: 44.00, id_floricode: "VB120020", nm_product: "Chrysanth Anastasia White 70cm", nm_box: "HB", nu_physical_boxes: 2, fp_product_id: "10002", match_method: "fuzzy_variety", catalogue_nm_product: "Chrysanthemum Anastasia White 70", nm_location: "" },
      { gu_product: "d3", nm_variety: "ALSTROEM PINK FLOYD", nm_species: "Alstroemeria", nu_length: 60, nu_stems_bunch: 5, nu_bunches: 30, nu_stems_total: 150, mny_rate_stem: 0.14, mny_total: 21.00, id_floricode: "VB110030", nm_product: "Alstroem Pink Floyd 60cm", nm_box: "MB", nu_physical_boxes: 1, fp_product_id: "10003", match_method: "cached", catalogue_nm_product: "Alstroemeria Pink Floyd 60", nm_location: "" },
      { gu_product: "d4", nm_variety: "GERBERA MINI PINK", nm_species: "Gerbera", nu_length: 45, nu_stems_bunch: 10, nu_bunches: 20, nu_stems_total: 200, mny_rate_stem: 0.18, mny_total: 36.00, id_floricode: "VB210040", nm_product: "", nm_box: "MB", nu_physical_boxes: 2, fp_product_id: "", match_method: "none", catalogue_nm_product: "", nm_location: "" },
      { gu_product: "d5", nm_variety: "TULIP RED DYNASTY", nm_species: "Tulipa", nu_length: 40, nu_stems_bunch: 10, nu_bunches: 25, nu_stems_total: 250, mny_rate_stem: 0.16, mny_total: 40.00, id_floricode: "VB300050", nm_product: "Tulip Red Dynasty 40cm", nm_box: "HB", nu_physical_boxes: 1, fp_product_id: "10005", match_method: "variety_nolen", catalogue_nm_product: "Tulip Red Dynasty", nm_location: "" },
    ],
  }],
  supplier_id: "210", supplier_nm: "Demo Grower B.V.", supplier_confirmed: true, matched_count: 4, unmatched_count: 1,
};

const DEMO_IMPORT_RESULT: DfgCreateResult = {
  batch_id: 999001, number: "DEMO-2024-001", created: true,
  stock_entries_ok: [1, 2, 3, 4],
  errors: [],
  skipped_unmatched: ["Gerbera Mini Pink 45cm"],
};

// Fixed customer list for the invoice target — DFG API only ever invoices to
// one of these 4 FreshPortal customers for this integration (2026-08-24).
const DFG_CUSTOMERS: { id: number; code: string; name: string }[] = [
  { id: 2,  code: "OZE",   name: "OZ-Hami - Actual weight" },
  { id: 12, code: "OZEDS", name: "OZ-Hami - Direct Sales" },
  { id: 14, code: "OZEG",  name: "OZ-Hami - Gypso" },
  { id: 16, code: "COLSUM", name: "Coloriginz - Summerflowers" },
];

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

  const [stage, setStage] = useState<Stage>("idle");
  const [importLogId, setImportLogId] = useState<number | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [activeOrderIdx, setActiveOrderIdx] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<DfgCreateResult | null>(null);
  const [error, setError] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [orderDateOverride, setOrderDateOverride] = useState("");
  const [shipmentEditOpen, setShipmentEditOpen] = useState(false);
  // Set when /delivery/api/check finds the shipment already exists — blocks
  // create until the user explicitly chooses to add the missing lines instead.
  const [existingBatch, setExistingBatch] = useState<{ id: number; number: string } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoParseRef = useRef(false);

  // ── Tour refs ─────────────────────────────────────────────────────────────
  const refDropZone        = useRef<HTMLDivElement>(null);
  const refParseBtn        = useRef<HTMLButtonElement>(null);
  const refSupplierRow     = useRef<HTMLDivElement>(null);
  const refCatalogueStatus = useRef<HTMLDivElement>(null);
  const refApproveToolbar  = useRef<HTMLDivElement>(null);
  const refTable           = useRef<HTMLDivElement>(null);
  const refActionBtns      = useRef<HTMLDivElement>(null);
  const refImportResult    = useRef<HTMLDivElement>(null);

  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [isTourMode, setIsTourMode] = useState(false);

  // ── Match approval & inline edit ──────────────────────────────────────────
  const [approvedKeys, setApprovedKeys] = useState<Set<string>>(new Set());
  const [lineEdits, setLineEdits] = useState<Record<string, { fp_product_id: string; catalogue_nm_product: string }>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editSearch, setEditSearch] = useState("");
  const [editSearchResults, setEditSearchResults] = useState<CatalogueProduct[]>([]);
  const [savingApproved, setSavingApproved] = useState(false);

  // ── Supplier picker ───────────────────────────────────────────────────────
  const [resolvedSupplier, setResolvedSupplier] = useState<FPSupplier | null>(null);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [supplierList, setSupplierList] = useState<FPSupplier[]>([]);
  const [supplierSearch, setSupplierSearch] = useState("");

  // ── Product match modal ───────────────────────────────────────────────────
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [partialApproveOpen, setPartialApproveOpen] = useState(false);
  const [supplierConfirmOpen, setSupplierConfirmOpen] = useState(false);

  // ── Table sort / filter / view ────────────────────────────────────────────
  const [showOnlyUnmatched, setShowOnlyUnmatched] = useState(false);
  const [showOnlyUnapproved, setShowOnlyUnapproved] = useState(false);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [tableSearch, setTableSearch] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState<string[]>([]);
  const [multiFileError, setMultiFileError] = useState(false);
  const [fileLoaded, setFileLoaded] = useState(false);

  // Keyed by variety name only (length excluded) — a confirmed product match is a
  // variety-identity decision, so it applies to every line sharing the name in this
  // order (any length) and is cached across future deliveries for the same supplier.
  function deliveryKey(line: DeliveryLine): string {
    return (line.nm_variety ?? "").toLowerCase().trim();
  }

  // order.dt_fly is always normalised to "DD-MM-YYYY" by the parser; <input type="date">
  // needs "YYYY-MM-DD" — convert only at the UI boundary, never change the stored format.
  function ddmmyyyyToIso(s: string): string {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
  }
  function isoToDdmmyyyy(s: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
  }

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev, msg]);
  }, []);

  // POST helper that logs the outgoing request body and the raw response
  // (status + body) into the shipment-creation log, so failures can be
  // diagnosed from the exact bytes exchanged with the DFG API instead of
  // just a one-line summary.
  const loggedRequest = useCallback(async (url: string, body: unknown, label: string): Promise<any> => {
    addLog(`${label}\n→ POST ${url.replace(RAILWAY, "")}\n${JSON.stringify(body, null, 2)}`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    const pretty = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    addLog(`${res.ok ? "  ✓" : "  ⚠"} ${res.status} ${res.ok ? "OK" : "ERROR"}\n${pretty}`);
    if (!res.ok) throw new Error(pretty);
    return data;
  }, [addLog]);

  // ── Tour ──────────────────────────────────────────────────────────────────

  // Auto-show for new users (delay for module-enter animation to complete)
  useEffect(() => {
    if (!username) return;
    fetch(`${RAILWAY}/user/flag/delivery_tour_dismissed`)
      .then(r => r.ok ? r.json() : { value: true })
      .then(d => {
        if (!d.value) {
          setTimeout(() => {
            setJsonText(DEMO_JSON);
            setFileLoaded(true);
            setIsTourMode(true);
            setTourStep(0);
            setTourOpen(true);
          }, 700);
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  useEffect(() => {
    if (!autoParseRef.current) return;
    if (!jsonText.trim() || stage !== "idle") return;
    autoParseRef.current = false;
    handleParseClick();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsonText]);

  // Live product search for the manual match-correction modal — the products
  // table is ~44k rows, too large to preload client-side like the old
  // supplier-catalogue list, so this queries the DB per keystroke (debounced).
  useEffect(() => {
    if (!editModalOpen || editSearch.trim().length < 2) {
      setEditSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${RAILWAY}/delivery/product-search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: editSearch.trim(), limit: 30 }),
        });
        if (!cancelled && res.ok) {
          const data = await res.json();
          setEditSearchResults(data.results ?? []);
        }
      } catch {}
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [editSearch, editModalOpen]);

  function openTour() {
    reset();
    setJsonText(DEMO_JSON);
    setFileLoaded(true);
    setIsTourMode(true);
    setTourStep(0);
    setTourOpen(true);
  }

  async function dismissTour() {
    setTourOpen(false);
    const wasInTourMode = isTourMode;
    setIsTourMode(false);
    if (wasInTourMode) reset();
    try {
      await fetch(`${RAILWAY}/user/flag/delivery_tour_dismissed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: true }),
      });
    } catch {}
  }

  // ── File drop / select ──────────────────────────────────────────────────

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = e => {
      setJsonText((e.target?.result as string) || "");
      setFileLoaded(true);
      autoParseRef.current = true;
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
    const supplierId = resolvedSupplier?.fp_supplier_id || parseResult?.supplier_id;
    if (!supplierId) { alert(td.clearCacheNoSupplier); return; }
    const supplierName = resolvedSupplier?.nm_supplier || supplierId;
    if (!confirm(td.clearCacheConfirm(supplierName, supplierId))) return;
    setClearingCache(true);
    try {
      // Wipe every cached match for this supplier only — other suppliers' caches
      // are untouched, since matches are now name-only and apply to any future
      // delivery for this supplier regardless of length.
      const res = await fetch(`${RAILWAY}/catalogue/${supplierId}/matches`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      // Re-parse the currently loaded JSON so the table reflects fresh matching.
      await handleParse(supplierId, true);
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

  async function handleParse(supplierIdOverride?: string, keepStage = false) {
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
      setActiveOrderIdx(0);
      setLineEdits({});
      setEditingKey(null);
      setShowOnlyUnmatched(false);
      setShowOnlyUnapproved(false);
      setSortCol(null);
      setColFilters({});
      if (data.supplier_id) {
        setResolvedSupplier({ fp_supplier_id: data.supplier_id, nm_supplier: data.supplier_nm || data.supplier_id });
        if (!data.supplier_confirmed) setSupplierConfirmOpen(true);
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
      if (!keepStage) setStage("shipment");
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
    setExistingBatch(null);

    // Changing supplier only changes which fp_supplier_id is sent when the
    // shipment is created — product matches are not supplier-scoped, so there
    // is no need to re-parse the JSON or re-run matching here.
    const txCompany = parseResult?.orders[activeOrderIdx]?.tx_company ?? "";
    try {
      await fetch(`${RAILWAY}/catalogue/supplier-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tx_company: txCompany, fp_supplier_id: supplier.fp_supplier_id }),
      });
    } catch {}
  }

  // ── Import to FreshPortal ───────────────────────────────────────────────

  async function logImportResult(order: DeliveryOrder, result: DfgCreateResult) {
    if (!result.batch_id) return;
    try {
      const logRes = await fetch(`${RAILWAY}/delivery/import-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fp_supplier_id: resolvedSupplier?.fp_supplier_id || parseResult!.supplier_id,
          tx_company: order.tx_company,
          id_invoice: order.id_invoice,
          dt_fly: order.dt_fly,
          tx_awb: order.tx_awb,
          nu_boxes: order.nu_boxes,
          nu_stems_total: order.nu_stems_total,
          mny_total: order.mny_total,
          nu_lines_total: order.lines.length,
          nu_lines_matched: order.lines.filter((l: DeliveryLine) => l.fp_product_id).length,
          batch_id: String(result.batch_id),
          batch_url: "",
          batch_status: result.errors.length > 0 ? "partial" : "ok",
          nm_user: username ?? null,
          details: { lines: order.lines.map((l: DeliveryLine) => ({
            nm_variety: l.nm_variety, nu_length: l.nu_length,
            nu_bunches: l.nu_bunches, match_method: l.match_method,
            catalogue_nm_product: l.catalogue_nm_product,
          })) },
        }),
      });
      if (!logRes.ok) return;
      const logData = await logRes.json();
      setImportLogId(logData.id);
      await fetch(`${RAILWAY}/delivery/import-log/${logData.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nu_products_added: result.stock_entries_ok.length,
          nu_products_failed: result.errors.length,
          nu_products_skipped: result.skipped_unmatched.length,
          products_status: result.errors.length > 0 ? "partial" : "ok",
        }),
      });
    } catch {}
  }

  async function handleImport(skipPartialCheck = false) {
    if (!parseResult) return;
    const order = parseResult.orders[activeOrderIdx];
    if (!order) return;
    const supplierFpId = resolvedSupplier?.fp_supplier_id || parseResult.supplier_id;
    if (!supplierFpId) {
      setError(td.noSupplierResolved);
      setStage("error");
      return;
    }
    if (!customerId) {
      // Shouldn't be reachable via the UI — the shipment step gates on this —
      // but guard defensively since this function can also run on retry paths.
      setStage("shipment");
      return;
    }

    // Check if all matched lines are approved — show modal if not
    if (!skipPartialCheck) {
      const totalMatched = order.lines.filter(l => !!(lineEdits[deliveryKey(l)]?.fp_product_id ?? l.fp_product_id)).length;
      const totalApproved = order.lines.filter(l => {
        const dk = deliveryKey(l);
        return !!(lineEdits[dk]?.fp_product_id ?? l.fp_product_id) && approvedKeys.has(dk);
      }).length;
      if (totalApproved < totalMatched) {
        setPartialApproveOpen(true);
        return;
      }
    }

    // Save approved matches to cache (only the approved ones)
    await handleApproveMatches(approvedKeys);

    setStage("importing");
    setLogs([]);
    setImportResult(null);
    setError("");

    const orderWithEdits: DeliveryOrder = {
      ...order,
      dt_fly: orderDateOverride || order.dt_fly,
      lines: order.lines
        .filter(line => approvedKeys.has(deliveryKey(line)))
        .map(line => {
          const dk = deliveryKey(line);
          const edit = lineEdits[dk];
          return edit ? { ...line, fp_product_id: edit.fp_product_id, catalogue_nm_product: edit.catalogue_nm_product } : line;
        }),
    };
    const skippedUnmatched = order.lines.filter(l => !l.fp_product_id).map(l => l.nm_product);

    try {
      const checkData = await loggedRequest(
        `${RAILWAY}/delivery/api/check`,
        { supplier_fp_id: supplierFpId, batch_number: order.id_invoice },
        td.checkingExisting,
      );

      if (checkData.exists) {
        const batch = checkData.batch;
        setExistingBatch({ id: batch.id, number: batch.number });
        const existingKeys = new Set(
          (batch.stock_entries ?? []).map((se: { product_number: string; characteristics?: { length?: number } }) =>
            `${se.product_number}|${se.characteristics?.length ?? 0}`)
        );
        const missingLines = orderWithEdits.lines.filter(l => !existingKeys.has(`${l.fp_product_id}|${l.nu_length}`));

        if (missingLines.length === 0) {
          setError(td.batchAlreadyExistsComplete(batch.number));
          setStage("error");
          return;
        }

        const retryData = await loggedRequest(
          `${RAILWAY}/delivery/api/retry`,
          { batch_id: batch.id, supplier_fp_id: supplierFpId, order: { ...orderWithEdits, lines: missingLines } },
          td.addingMissingToExisting(batch.number, missingLines.length),
        );
        const result: DfgCreateResult = {
          batch_id: retryData.batch_id, number: retryData.number, created: false,
          stock_entries_ok: retryData.stock_entries_ok, errors: retryData.errors,
          skipped_unmatched: skippedUnmatched,
        };
        setImportResult(result);
        await logImportResult(orderWithEdits, result);
        setStage("done");
        return;
      }

      const created = await loggedRequest(
        `${RAILWAY}/delivery/api/create`,
        { order: orderWithEdits, supplier_fp_id: supplierFpId, customer_id: Number(customerId) },
        td.creatingShipment,
      );
      const result: DfgCreateResult = created as DfgCreateResult;
      result.skipped_unmatched = skippedUnmatched;
      setImportResult(result);
      await logImportResult(orderWithEdits, result);
      setStage("done");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  async function handleRetryFailed() {
    if (!parseResult || !importResult?.batch_id || importResult.errors.length === 0) return;
    const order = parseResult.orders[activeOrderIdx];
    if (!order) return;
    const supplierFpId = resolvedSupplier?.fp_supplier_id || parseResult.supplier_id;
    const failedSet = new Set(importResult.errors.map(e => `${e.product_number}|${e.length}`));

    const retryLines = order.lines
      .filter(l => approvedKeys.has(deliveryKey(l)))
      .map(line => {
        const dk = deliveryKey(line);
        const edit = lineEdits[dk];
        return edit ? { ...line, fp_product_id: edit.fp_product_id, catalogue_nm_product: edit.catalogue_nm_product } : line;
      })
      .filter(l => failedSet.has(`${l.fp_product_id}|${l.nu_length}`));
    if (!retryLines.length) return;

    setRetrying(true);
    try {
      const retryData = await loggedRequest(
        `${RAILWAY}/delivery/api/retry`,
        { batch_id: importResult.batch_id, supplier_fp_id: supplierFpId, order: { ...order, lines: retryLines } },
        td.retryingBtn,
      );
      setImportResult(prev => prev ? {
        ...prev,
        stock_entries_ok: [...prev.stock_entries_ok, ...retryData.stock_entries_ok],
        errors: retryData.errors,
      } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }

  async function handleApproveMatches(keys?: Set<string>) {
    if (!parseResult) return;
    const supplierId = resolvedSupplier?.fp_supplier_id || parseResult.supplier_id;
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

  async function handleConfirmSupplier() {
    setSupplierConfirmOpen(false);
    const supplierId = resolvedSupplier?.fp_supplier_id;
    const txCompany = parseResult?.orders[activeOrderIdx]?.tx_company ?? "";
    if (!supplierId) return;
    try {
      await fetch(`${RAILWAY}/catalogue/supplier-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tx_company: txCompany, fp_supplier_id: supplierId }),
      });
    } catch {}
  }

  function handleChangeSupplier() {
    setSupplierConfirmOpen(false);
    openSupplierPicker();
  }

  function reset() {
    setStage("idle");
    setJsonText("");
    setParseResult(null);
    setLogs([]);
    setError("");
    setImportResult(null);
    setExistingBatch(null);
    setCustomerId("");
    setOrderDateOverride("");
    setShipmentEditOpen(false);
    setApprovedKeys(new Set());
    setLineEdits({});
    setEditingKey(null);
    setEditModalOpen(false);
    setPartialApproveOpen(false);
    setResolvedSupplier(null);
    setSupplierPickerOpen(false);
    setSupplierSearch("");
    setShowOnlyUnmatched(false);
    setShowOnlyUnapproved(false);
    setSortCol(null);
    setSortDir("asc");
    setColFilters({});
    setTableSearch("");
    setDuplicateWarning([]);
    setMultiFileError(false);
    setFileLoaded(false);
  }

  function handleStartOver() {
    if (!confirm(td.startOverConfirm)) return;
    reset();
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
  const isPomarosa = !!(
    order?.tx_company?.toLowerCase().includes("pomarosa") ||
    resolvedSupplier?.nm_supplier?.toLowerCase().includes("pomarosa")
  );

  const displayLines = useMemo(() => {
    const o = parseResult?.orders[activeOrderIdx];
    if (!o) return [];
    let lines = [...o.lines];

    if (showOnlyUnmatched) {
      lines = lines.filter(l => {
        const dk = deliveryKey(l);
        return !(lineEdits[dk]?.fp_product_id ?? l.fp_product_id);
      });
    }

    if (showOnlyUnapproved) {
      lines = lines.filter(l => {
        const dk = deliveryKey(l);
        return !!(lineEdits[dk]?.fp_product_id ?? l.fp_product_id) && !approvedKeys.has(dk);
      });
    }

    if (tableSearch) {
      const q = tableSearch.toLowerCase();
      lines = lines.filter(l => {
        const dk = deliveryKey(l);
        const catName = lineEdits[dk]?.catalogue_nm_product ?? l.catalogue_nm_product ?? "";
        return (
          l.nm_variety.toLowerCase().includes(q) ||
          (l.nm_species ?? "").toLowerCase().includes(q) ||
          (l.nm_box ?? "").toLowerCase().includes(q) ||
          catName.toLowerCase().includes(q) ||
          l.match_method.toLowerCase().includes(q) ||
          (l.id_floricode ?? "").toLowerCase().includes(q) ||
          String(l.nu_length).includes(q)
        );
      });
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
  }, [parseResult, activeOrderIdx, showOnlyUnmatched, showOnlyUnapproved, approvedKeys, tableSearch, sortCol, sortDir, lineEdits]);

  // Per-line outcome for the "done" screen's expandable product list — derived
  // from the same approval/match state used to build the request, cross-
  // referenced against the result's errors/skipped_unmatched (stock_entries_ok's
  // shape isn't reliably typed, so success is inferred by elimination instead).
  type DoneLineStatus = "added" | "failed" | "skipped" | "notApproved";
  const doneLineStatuses = useMemo((): { line: DeliveryLine; status: DoneLineStatus; message: string }[] => {
    const o = parseResult?.orders[activeOrderIdx];
    if (!o || !importResult) return [];
    const failedMsg = new Map(importResult.errors.map(e => [`${e.product_number}|${e.length}`, e.message]));
    return o.lines.map(line => {
      const dk = deliveryKey(line);
      const edit = lineEdits[dk];
      const fpId = edit?.fp_product_id ?? line.fp_product_id;
      if (!fpId) return { line, status: "skipped" as const, message: "" };
      if (!approvedKeys.has(dk)) return { line, status: "notApproved" as const, message: "" };
      const key = `${fpId}|${line.nu_length}`;
      if (failedMsg.has(key)) return { line, status: "failed" as const, message: failedMsg.get(key) ?? "" };
      return { line, status: "added" as const, message: "" };
    });
  }, [parseResult, activeOrderIdx, importResult, lineEdits, approvedKeys]);

  type AllTourStep = TourStep & { tourStage: "idle" | "shipment" | "preview" | "done" };

  const allTourSteps = useMemo((): AllTourStep[] => [
    { tourStage: "idle",     targetRef: refDropZone        as React.RefObject<HTMLElement|null>, title: td.tourStep1Title, body: td.tourStep1Body },
    { tourStage: "idle",     targetRef: refParseBtn        as React.RefObject<HTMLElement|null>, title: td.tourStep2Title, body: td.tourStep2Body },
    { tourStage: "shipment", targetRef: refSupplierRow     as React.RefObject<HTMLElement|null>, title: td.tourStep3Title, body: td.tourStep3Body },
    { tourStage: "preview",  targetRef: refCatalogueStatus as React.RefObject<HTMLElement|null>, title: td.tourStep4Title, body: td.tourStep4Body },
    { tourStage: "preview",  targetRef: refApproveToolbar  as React.RefObject<HTMLElement|null>, title: td.tourStep5Title, body: td.tourStep5Body },
    { tourStage: "preview",  targetRef: refTable           as React.RefObject<HTMLElement|null>, title: td.tourStep6Title, body: td.tourStep6Body },
    { tourStage: "preview",  targetRef: refActionBtns      as React.RefObject<HTMLElement|null>, title: td.tourStep7Title, body: td.tourStep7Body },
    { tourStage: "done",     targetRef: refImportResult    as React.RefObject<HTMLElement|null>, title: td.tourStep8Title, body: td.tourStep8Body },
  ], [td]);

  function handleTourNext() {
    const nextIdx = tourStep + 1;
    if (nextIdx >= allTourSteps.length) { dismissTour(); return; }
    const nextStage = allTourSteps[nextIdx].tourStage;
    const currStage = allTourSteps[tourStep].tourStage;
    if (nextStage !== currStage) {
      if (nextStage === "shipment") {
        const preApproved = new Set<string>();
        DEMO_PARSE_RESULT.orders[0].lines.forEach(l => { if (l.fp_product_id) preApproved.add(deliveryKey(l)); });
        setParseResult(DEMO_PARSE_RESULT);
        setResolvedSupplier({ fp_supplier_id: "210", nm_supplier: "Demo Grower B.V." });
        setActiveOrderIdx(0);
        setLineEdits({});
        setShowOnlyUnmatched(false);
        setShowOnlyUnapproved(false);
        setSortCol(null);
        setColFilters({});
        setApprovedKeys(preApproved);
        setCustomerId(String(DFG_CUSTOMERS[0].id));
        setStage("shipment");
      } else if (nextStage === "preview") {
        setStage("preview");
      } else if (nextStage === "done") {
        setImportResult(DEMO_IMPORT_RESULT);
        setStage("done");
      }
    }
    setTourStep(nextIdx);
  }

  return (
    <div data-di className="p-4 sm:p-6 flex flex-col gap-5 sm:gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">{td.title}</h2>
          <p className="text-sm text-ink-3 mt-0.5">
            {stage === "shipment" ? td.descShipment
             : stage === "preview" ? td.descReview
             : stage === "importing" ? td.descImport
             : stage === "done" ? td.descProducts
             : td.descUpload}
          </p>
        </div>
        {stage !== "importing" && (
          <button
            onClick={openTour}
            title={td.tourOpenBtn}
            className="flex-shrink-0 w-7 h-7 rounded-full border border-border text-ink-3 hover:text-emerald hover:border-emerald/50 text-xs font-bold transition-colors flex items-center justify-center"
          >
            ?
          </button>
        )}
      </div>

      {tourOpen && (
        <DeliveryTour
          steps={allTourSteps}
          stepIndex={Math.min(tourStep, allTourSteps.length - 1)}
          onNext={handleTourNext}
          onSkip={dismissTour}
          t={{ tourNext: td.tourNext, tourSkip: td.tourSkip, tourFinish: td.tourFinish }}
        />
      )}

      {isTourMode && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600">
          <span>🎯</span>
          <span>{td.tourDemoMode}</span>
        </div>
      )}

      {/* ── PROGRESS STEPPER ── */}
      <DeliveryStepBar
        stage={stage}
        allDone={stage === "done" && (importResult?.errors.length ?? 0) === 0}
        steps={[td.stepUpload, td.stepReviewShipment, td.stepReviewProducts, td.stepImport]}
      />

      {/* ── PARSING ── */}
      {stage === "parsing" && (
        <div className="flex flex-col items-center gap-5 py-8">
          <div className="relative flex items-center justify-center">
            <svg className="animate-spin w-14 h-14 text-emerald/20" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5"/>
            </svg>
            <svg className="animate-spin absolute w-14 h-14 text-emerald" viewBox="0 0 24 24" fill="none" style={{ animationDuration: "0.9s" }}>
              <path stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10"/>
            </svg>
          </div>
          <p className="text-sm font-semibold text-ink">{td.parsing}</p>
        </div>
      )}

      {/* ── IDLE / INPUT ── */}
      {stage === "idle" && (
        <div key="idle" className="step-enter flex flex-col gap-4">
          {/* Multi-file error */}
          {multiFileError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600">
              <span>⚠ {td.onlyOneFile}</span>
              <button onClick={() => setMultiFileError(false)} className="ml-auto text-amber-400 hover:text-amber-600 transition-colors">✕</button>
            </div>
          )}

          {/* Duplicate warning — centered modal */}
          {duplicateWarning.length > 0 && (
            <>
              <div className="fixed inset-0 bg-black/60 z-[300]" onClick={() => setDuplicateWarning([])} />
              <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-[301] max-w-md mx-auto rounded-2xl border-2 border-amber-500/40 bg-surface shadow-2xl p-6 flex flex-col gap-4">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-xl">
                    ⚠
                  </div>
                  <div>
                    <p className="text-sm font-bold text-amber-700">{td.duplicateWarningTitle}</p>
                    <p className="text-xs text-ink-3 mt-1 leading-relaxed">{td.duplicateWarningMsg(duplicateWarning.join(", "))}</p>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setDuplicateWarning([])}
                    className="h-9 px-4 rounded-xl text-sm font-medium border border-border text-ink-3 hover:text-ink transition-colors"
                  >
                    {t.common.cancel}
                  </button>
                  <button
                    onClick={() => { setDuplicateWarning([]); handleParse(); }}
                    className="h-9 px-5 rounded-xl text-sm font-semibold bg-amber-500 text-white hover:bg-amber-500/90 transition-colors"
                  >
                    {td.parseBtn}
                  </button>
                </div>
              </div>
            </>
          )}

          <div
            ref={refDropZone}
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
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs text-ink-3">{td.dropHint}</span>
              <div className="flex items-center gap-2">
                {jsonText && (
                  <button
                    onClick={() => { setJsonText(""); setDuplicateWarning([]); setMultiFileError(false); setFileLoaded(false); }}
                    className="h-7 px-3 rounded-lg text-xs font-medium text-red-500 border border-red-400/30 hover:bg-red-500/10 transition-colors"
                  >
                    {td.clearJson}
                  </button>
                )}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="h-7 px-3 rounded-lg text-xs font-medium text-ink-3 border border-border hover:text-ink hover:border-emerald/40 transition-colors"
                >
                  {td.browseBtn}
                </button>
              </div>
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />

          <div className="flex items-center justify-end gap-3">
            <button
              ref={refParseBtn}
              onClick={handleParseClick}
              disabled={!jsonText.trim() || duplicateWarning.length > 0}
              className="h-9 px-5 rounded-xl text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity"
            >
              {td.parseBtn}
            </button>
          </div>
        </div>
      )}

      {/* ── PREVIEW ── */}
      {stage === "shipment" && order && (
        <div key="shipment" className="step-enter flex flex-col gap-5">

          {/* Supplier confirmation popup */}
          {supplierConfirmOpen && resolvedSupplier && (
            <>
              <div className="fixed inset-0 bg-black/60 z-[300]" />
              <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-[301] max-w-sm mx-auto rounded-2xl border-2 border-border bg-surface shadow-2xl p-6 flex flex-col gap-5">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-xl">🏭</div>
                  <div>
                    <p className="text-sm font-bold text-ink">{td.supplierConfirmTitle}</p>
                    <p className="text-xs text-ink-3 mt-1 leading-relaxed">{td.supplierConfirmBody(order.tx_company)}</p>
                    <p className="mt-2 text-sm font-semibold text-ink">{resolvedSupplier.nm_supplier}</p>
                    <p className="text-[11px] text-ink-3">#{resolvedSupplier.fp_supplier_id}</p>
                    <p className="mt-2 text-xs text-ink-3">{td.supplierConfirmQuestion}</p>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={handleChangeSupplier}
                    className="h-9 px-4 rounded-xl text-sm font-medium border border-border text-ink-3 hover:text-ink transition-colors"
                  >
                    {td.supplierConfirmChange}
                  </button>
                  <button
                    autoFocus
                    onClick={handleConfirmSupplier}
                    className="h-9 px-5 rounded-xl text-sm font-semibold bg-emerald text-white hover:bg-emerald/90 transition-colors"
                  >
                    {td.supplierConfirmYes}
                  </button>
                </div>
              </div>
            </>
          )}

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

          {/* Shipment details pill */}
          <div className="card-enter rounded-2xl border border-border bg-muted p-4 relative">
            <div className="flex items-start justify-between gap-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm flex-1">
                <Row label={td.supplier} value={order.tx_company} />
                <Row label={td.invoiceNr} value={order.id_invoice} />
                {shipmentEditOpen ? (
                  <div className="flex gap-2 items-center">
                    <span className="text-ink-3 shrink-0 w-28">{td.deliveryDate}</span>
                    <input
                      type="date"
                      value={ddmmyyyyToIso(orderDateOverride || order.dt_fly)}
                      onChange={e => setOrderDateOverride(isoToDdmmyyyy(e.target.value))}
                      className="h-8 px-2 rounded-lg text-sm border border-emerald/40 bg-surface outline-none focus:border-emerald transition-colors"
                    />
                  </div>
                ) : (
                  <Row label={td.deliveryDate} value={orderDateOverride || order.dt_fly} />
                )}
                <Row label={td.awb} value={order.tx_awb} />
                <Row label={td.boxes} value={String(order.nu_boxes)} />
                <Row label={td.stemsTotal} value={order.nu_stems_total.toLocaleString()} />
                <Row label={td.valueTotal} value={`$${order.mny_total.toFixed(2)}`} />
              </div>
              <button
                onClick={() => setShipmentEditOpen(v => !v)}
                title={td.editShipmentBtn}
                className={`shrink-0 w-7 h-7 rounded-full border flex items-center justify-center transition-colors
                  ${shipmentEditOpen ? "border-emerald bg-emerald/10 text-emerald" : "border-border text-ink-3 hover:text-ink hover:border-emerald/40"}`}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            </div>

            {/* FreshPortal supplier resolution row */}
            <div ref={refSupplierRow} className="flex items-center gap-2 text-sm mt-3 pt-3 border-t border-border/60">
              <span className="text-ink-3 shrink-0">{td.fpSupplierLabel}</span>
              {resolvedSupplier ? (
                <>
                  <span className="font-medium text-ink">{resolvedSupplier.nm_supplier}</span>
                  <span className="text-ink-3/50 text-xs">#{resolvedSupplier.fp_supplier_id}</span>
                  {shipmentEditOpen && (
                    <button
                      onClick={openSupplierPicker}
                      className="ml-1 h-6 px-2.5 rounded-lg text-xs font-medium border border-emerald/40 text-emerald hover:bg-emerald/8 transition-colors"
                    >
                      {td.changeSupplierBtn}
                    </button>
                  )}
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
          </div>

          {/* Assign to customer — required before continuing */}
          <div className="card-enter rounded-2xl border-2 border-emerald/25 bg-emerald-light p-4 flex flex-col gap-2">
            <label className="text-sm font-semibold text-emerald-dark flex items-center gap-1.5">
              {td.customerIdLabel}
              <span
                title={td.customerIdTooltip}
                className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-emerald/40 text-emerald text-[10px] leading-none cursor-help shrink-0"
              >
                i
              </span>
            </label>
            <select
              value={customerId}
              onChange={e => setCustomerId(e.target.value)}
              className="h-10 px-3 rounded-xl text-sm font-medium border-2 border-emerald/30 bg-surface outline-none focus:border-emerald transition-colors"
            >
              <option value="" disabled>{td.customerIdPlaceholder}</option>
              {DFG_CUSTOMERS.map(c => (
                <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
              ))}
            </select>
          </div>

          {/* Continue to products */}
          <div className="flex items-center justify-between gap-3">
            <button onClick={handleStartOver} className="text-xs text-ink-3 hover:text-ink transition-colors">
              {td.startOver}
            </button>
            <div className="flex flex-col items-end gap-1">
              {!customerId && (
                <span className="text-[11px] text-ember">{td.customerRequiredHint}</span>
              )}
              <button
                onClick={() => setStage("preview")}
                disabled={!resolvedSupplier || !customerId}
                className="h-10 px-6 rounded-xl text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity whitespace-nowrap"
              >
                {td.continueToProductsBtn} →
              </button>
            </div>
          </div>

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

        </div>
      )}

      {stage === "preview" && order && (
        <div key="preview" className="step-enter flex flex-col gap-5">

          {/* Back to shipment */}
          <button
            onClick={() => setStage("shipment")}
            className="self-start flex items-center gap-1 text-xs text-ink-3 hover:text-ink transition-colors"
          >
            ← {td.backToShipmentBtn}
          </button>

          {/* Partial approve confirmation modal */}
          {partialApproveOpen && (() => {
            const totalMatched = order.lines.filter((l: DeliveryLine) => !!(lineEdits[deliveryKey(l)]?.fp_product_id ?? l.fp_product_id)).length;
            const totalApproved = order.lines.filter((l: DeliveryLine) => { const dk = deliveryKey(l); return !!(lineEdits[dk]?.fp_product_id ?? l.fp_product_id) && approvedKeys.has(dk); }).length;
            return (
              <>
                <div className="fixed inset-0 bg-black/60 z-[300]" onClick={() => setPartialApproveOpen(false)} />
                <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-[301] max-w-md mx-auto rounded-2xl border-2 border-amber-500/40 bg-surface shadow-2xl p-6 flex flex-col gap-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-xl">⚠</div>
                    <div>
                      <p className="text-sm font-bold text-amber-700">{td.partialApproveTitle}</p>
                      <p className="text-xs text-ink-3 mt-1 leading-relaxed">{td.partialApproveBody(totalApproved, totalMatched)}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button
                      autoFocus
                      onClick={() => setPartialApproveOpen(false)}
                      className="h-9 px-5 rounded-xl text-sm font-semibold border-2 border-emerald text-emerald bg-emerald/8 hover:bg-emerald/15 transition-colors"
                    >
                      {td.partialApproveCancel}
                    </button>
                    <button
                      onClick={() => { setPartialApproveOpen(false); handleImport(true); }}
                      className="h-9 px-4 rounded-xl text-sm font-medium border border-border text-ink-3 hover:text-ink transition-colors"
                    >
                      {td.partialApproveConfirm}
                    </button>
                  </div>
                </div>
              </>
            );
          })()}

          {/* Match status */}
          <div ref={refCatalogueStatus} className="flex items-center gap-3 text-sm flex-wrap">
            <span className="px-2.5 py-1 rounded-full border text-xs text-emerald bg-emerald/10 border-emerald/20">
              {parseResult!.matched_count} {td.matched}
            </span>
            {parseResult!.unmatched_count > 0 && (
              <button
                onClick={() => setShowOnlyUnmatched(p => !p)}
                className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors
                  ${showOnlyUnmatched
                    ? "bg-red-500/20 text-red-600 border-red-500/40 ring-1 ring-red-500/30"
                    : "bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20"}`}
              >
                {parseResult!.unmatched_count} {td.unmatched}
                {showOnlyUnmatched ? " ✕" : ""}
              </button>
            )}
            <div className="ml-auto flex gap-2">
              <button
                onClick={handleClearCache}
                disabled={clearingCache}
                title={td.clearCacheTitle}
                className="h-7 px-3 rounded-lg text-xs font-medium border border-red-400/40 text-red-500 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
              >
                {clearingCache ? td.clearingCache : td.clearCache}
              </button>
            </div>
          </div>

          {parseResult!.unmatched_count > 0 && (
            <button
              onClick={() => setShowOnlyUnmatched(p => !p)}
              className={`w-full text-left text-xs rounded-xl px-3 py-2 border transition-colors
                ${showOnlyUnmatched
                  ? "text-amber-700 bg-amber-100 border-amber-300"
                  : "text-amber-600 bg-amber-50 border-amber-200 hover:bg-amber-100"}`}
            >
              ⚠ {td.unmatchedWarning(parseResult!.unmatched_count)}
              <span className="ml-2 underline">{showOnlyUnmatched ? td.showAll : td.showOnlyUnmatched}</span>
            </button>
          )}

          {/* Approve toolbar */}
          <div ref={refApproveToolbar} className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShowOnlyUnapproved(p => !p)}
              title={showOnlyUnapproved ? td.showAll : td.showOnlyUnmatched}
              className={`h-7 px-3 rounded-lg text-xs font-semibold border transition-colors
                ${showOnlyUnapproved
                  ? "bg-amber-500/15 border-amber-500/30 text-amber-700"
                  : "bg-emerald/8 border-emerald/30 text-emerald hover:bg-emerald/15"}`}
            >
              {td.approved(
                order.lines.filter(l => { const dk = deliveryKey(l); return !!(lineEdits[dk]?.fp_product_id ?? l.fp_product_id) && approvedKeys.has(dk); }).length,
                order.lines.filter(l => !!(lineEdits[deliveryKey(l)]?.fp_product_id ?? l.fp_product_id)).length
              )}
              {showOnlyUnapproved ? " ✕" : ""}
            </button>
            <button
              onClick={() => {
                const all = new Set(order.lines.filter(l => !!(lineEdits[deliveryKey(l)]?.fp_product_id ?? l.fp_product_id)).map(l => deliveryKey(l)));
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
            {(tableSearch || sortCol) && (
              <button
                onClick={() => { setTableSearch(""); setSortCol(null); setSortDir("asc"); }}
                className="h-6 px-2 rounded-md text-[11px] border border-border text-ink-3 hover:text-ink ml-auto transition-colors"
              >
                ✕ {td.resetFilter}
              </button>
            )}
          </div>

          {/* Action buttons + search bar — above the table */}
          <div ref={refActionBtns} className="flex items-center gap-3">
            <input
              value={tableSearch}
              onChange={e => setTableSearch(e.target.value)}
              placeholder={td.tableSearchPlaceholder}
              className="flex-1 h-9 px-3 rounded-xl text-sm border border-border bg-surface outline-none focus:border-emerald/50 placeholder:text-ink-3/50 transition-colors"
            />
            <button onClick={handleStartOver} className="h-9 px-4 rounded-xl text-sm border border-border text-ink-3 hover:text-ink transition-colors bg-surface whitespace-nowrap">
              {td.startOver}
            </button>
            <button
              onClick={() => handleImport()}
              disabled={approvedKeys.size === 0}
              className="h-9 px-5 rounded-xl text-sm font-semibold text-white bg-emerald disabled:opacity-40 transition-opacity whitespace-nowrap"
            >
              {td.importBtn}
            </button>
          </div>

          {/* Product lines table */}
          {(() => {
            return (
          <div ref={refTable} className="overflow-x-auto overflow-y-auto max-h-[440px] rounded-2xl border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-muted border-b border-border">
                  <th className="px-2 py-2 text-center font-semibold text-ink-3 w-8" title={td.colApproveTooltip}>✓</th>
                  <SortTh col="variety"    label={td.colVariety}    sortCol={sortCol} sortDir={sortDir} onSort={handleSortCol} />
                  {isPomarosa && <th className="px-3 py-2 text-left font-semibold text-ink-3 whitespace-nowrap">{td.colGrower}</th>}
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
              </thead>
              <tbody>
                {displayLines.length === 0 ? (
                  <tr>
                    <td colSpan={isPomarosa ? 13 : 12} className="px-4 py-6 text-center text-xs text-ink-3">
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
                      {isPomarosa && (
                        <td className="px-3 py-2 text-ink-3 whitespace-nowrap">
                          {line.nm_location ? resolvePomarosaGrower(line.nm_location) : "—"}
                        </td>
                      )}
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
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-semibold bg-blue-500/10 text-blue-600 border-blue-500/20">
                          ×{line.nu_physical_boxes ?? 1}
                        </span>
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
          );})()}

          {/* Product match modal */}
          {editModalOpen && editingKey && (() => {
            const dk = editingKey;
            const editLine = order.lines.find(l => deliveryKey(l) === dk);
            const currentEdit = lineEdits[dk];
            const currentMatchName = currentEdit?.catalogue_nm_product ?? editLine?.catalogue_nm_product ?? "";
            const matchResults = editSearchResults;
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
                          <div className="mt-1.5 text-xs text-ink-3">
                            <span className="font-medium text-ink">{editLine.nm_variety}</span>
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
                      <p className="text-xs text-ink-3 px-4 py-3">
                        {editSearch.trim().length < 2 ? td.editSearchTypeToSearch : td.noProductsFound}
                      </p>
                    ) : matchResults.map(p => {
                      const isCurrentMatch = (currentEdit?.fp_product_id ?? editLine?.fp_product_id) === p.fp_product_id;
                      return (
                        <button
                          key={p.nm_product}
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
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            );
          })()}

        </div>
      )}

      {/* ── IMPORTING ── */}
      {stage === "importing" && (
        <div key="importing" className="step-enter flex flex-col items-center gap-5 py-8">
          <div className="relative flex items-center justify-center">
            <svg className="animate-spin w-14 h-14 text-emerald/20" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5"/>
            </svg>
            <svg className="animate-spin absolute w-14 h-14 text-emerald" viewBox="0 0 24 24" fill="none" style={{ animationDuration: "0.9s" }}>
              <path stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10"/>
            </svg>
          </div>
          <div className="text-center space-y-1 max-w-xs">
            <p className="text-sm font-semibold text-ink">{td.creatingShipment}</p>
          </div>
          {isAdmin && logs.length > 0 && <ProgressLog title={td.importing} logs={logs} />}
        </div>
      )}

      {/* ── DONE ── */}
      {stage === "done" && importResult && (
        <div key="done" ref={refImportResult} className="step-enter flex justify-center py-4">
          <div className="card-enter w-full max-w-lg bg-surface rounded-3xl border border-border shadow-lg overflow-hidden">

            {/* Hero band */}
            <div className={`px-6 pt-8 pb-6 flex flex-col items-center text-center ${importResult.errors.length === 0 ? "bg-emerald/6" : "bg-amber-500/6"}`}>
              {/* Animated icon */}
              <div className={`done-icon w-16 h-16 rounded-full flex items-center justify-center text-3xl mb-4 ${importResult.errors.length === 0 ? "bg-emerald text-white shadow-[0_0_24px_rgba(26,125,69,0.4)]" : "bg-amber-500 text-white shadow-[0_0_24px_rgba(245,158,11,0.4)]"}`}>
                {importResult.errors.length === 0 ? "✓" : "!"}
              </div>
              <h2 className={`text-lg font-bold mb-1 ${importResult.errors.length === 0 ? "text-emerald" : "text-amber-600"}`}>
                {importResult.errors.length === 0 ? td.batchCreated : td.importPartial}
              </h2>
              {importResult.batch_id && (
                <p className="text-xs text-ink-3 font-mono">{td.batchId}: <span className="font-semibold text-ink-2">{importResult.number || importResult.batch_id}</span></p>
              )}
              {existingBatch && (
                <p className="text-xs text-blue-500 mt-1">{td.addedToExistingBatch(existingBatch.number)}</p>
              )}

              {/* Stat chips */}
              <div className="flex gap-2 mt-4 flex-wrap justify-center">
                <StatChip
                  value={importResult.stock_entries_ok.length}
                  label={td.statAddedN(importResult.stock_entries_ok.length)}
                  color="emerald"
                  delay="0ms"
                />
                {importResult.errors.length > 0 && (
                  <StatChip
                    value={importResult.errors.length}
                    label={td.statFailedN(importResult.errors.length)}
                    color="red"
                    delay="60ms"
                  />
                )}
                {importResult.skipped_unmatched.length > 0 && (
                  <StatChip
                    value={importResult.skipped_unmatched.length}
                    label={td.statSkippedN(importResult.skipped_unmatched.length)}
                    color="amber"
                    delay="120ms"
                  />
                )}
              </div>
            </div>

            {/* Failed lines + retry */}
            {importResult.errors.length > 0 && (
              <div className="px-6 py-4 border-t border-border">
                <p className="text-xs font-semibold text-red-500 uppercase tracking-wide mb-2">{td.statFailedN(importResult.errors.length)}</p>
                <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                  {importResult.errors.map((e, i) => (
                    <div key={i} className="text-xs font-mono text-red-500">
                      <span className="font-semibold">{e.product_number}</span>
                      {e.length ? <span className="text-ink-3"> ({e.length}cm)</span> : null}
                      <span className="block text-red-400">{e.message}</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={handleRetryFailed}
                  disabled={retrying}
                  className="mt-2 text-xs text-emerald underline disabled:opacity-40"
                >
                  {retrying ? td.retryingBtn : td.retryBtn}
                </button>
              </div>
            )}

            {/* Skipped (unmatched) lines */}
            {importResult.skipped_unmatched.length > 0 && (
              <div className="px-6 py-4 border-t border-border">
                <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-2">{td.statSkippedN(importResult.skipped_unmatched.length)}</p>
                <div className="max-h-32 overflow-y-auto space-y-0.5 pr-1">
                  {importResult.skipped_unmatched.map((p, i) => (
                    <div key={i} className="text-xs font-mono text-amber-600 truncate">{p}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Product lines — full added/failed/skipped/excluded breakdown */}
            <div className="px-6 pt-4 pb-2 border-t border-border">
              <details className="text-xs">
                <summary className="cursor-pointer text-ink-3 hover:text-ink select-none">{td.productLinesLog(doneLineStatuses.length)}</summary>
                <div className="mt-2 max-h-64 overflow-y-auto space-y-1 pr-1">
                  {doneLineStatuses.map(({ line, status, message }, i) => {
                    const badge = {
                      added:        { label: td.lineStatusAdded,        cls: "bg-emerald/10 text-emerald border-emerald/20" },
                      failed:       { label: td.lineStatusFailed,       cls: "bg-red-500/10 text-red-500 border-red-500/20" },
                      skipped:      { label: td.lineStatusSkipped,      cls: "bg-amber-500/10 text-amber-600 border-amber-500/20" },
                      notApproved:  { label: td.lineStatusNotApproved,  cls: "bg-muted text-ink-3 border-border" },
                    }[status];
                    return (
                      <div key={i} className="flex items-start justify-between gap-2 py-1 border-b border-border/40 last:border-0">
                        <div className="min-w-0">
                          <p className="font-medium text-ink truncate">
                            {line.nm_variety}
                            {line.nu_length > 0 && <span className="text-ink-3 font-normal"> · {line.nu_length}cm</span>}
                          </p>
                          {message && <p className="text-red-400 font-mono text-[11px] truncate">{message}</p>}
                        </div>
                        <span className={`shrink-0 px-2 py-0.5 rounded-full border text-[11px] font-medium whitespace-nowrap ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </details>
            </div>

            {/* Collapsible logs */}
            <div className="px-6 pb-5 pt-2 space-y-2">
              <details className="text-xs">
                <summary className="cursor-pointer text-ink-3 hover:text-ink select-none">{td.batchLog(logs.length)}</summary>
                <div className="mt-1 bg-ground rounded-xl p-2 max-h-64 overflow-y-auto font-mono">
                  {logs.map((l, i) => (
                    <div
                      key={i}
                      className={`whitespace-pre-wrap break-all py-1.5 border-b border-border/40 last:border-0
                        ${l.startsWith("  ⚠") ? "text-amber-500" : l.startsWith("  ✓") ? "text-emerald" : "text-ink-3"}`}
                    >
                      {l}
                    </div>
                  ))}
                </div>
              </details>

              <div className="flex justify-end pt-1">
                <button
                  onClick={handleStartOver}
                  className="h-9 px-5 rounded-xl text-sm font-semibold border border-border text-ink-2 hover:bg-muted hover:text-ink transition-colors"
                >
                  {td.startOver}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── ERROR ── */}
      {stage === "error" && (
        <div key="error" className="step-enter flex flex-col gap-3">
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

function StatChip({ value, label, color, delay }: { value: number; label: string; color: "emerald" | "red" | "amber"; delay: string }) {
  const colours = {
    emerald: "bg-emerald/10 text-emerald border-emerald/20",
    red:     "bg-red-500/10 text-red-500 border-red-500/20",
    amber:   "bg-amber-500/10 text-amber-600 border-amber-500/20",
  };
  return (
    <div
      className={`stat-chip inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-semibold ${colours[color]}`}
      style={{ animationDelay: delay }}
    >
      <span className="text-base font-bold">{value}</span>
      <span className="text-xs font-normal opacity-80">{label.replace(/^\d+\s*/, "")}</span>
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
    : stage === "shipment" ? 1
    : stage === "preview" ? 2
    : 3;

  return (
    <div className="flex items-start w-full">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={i}>
            <div className="flex flex-col items-center gap-2 flex-shrink-0">
              <div className={`relative w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold ring-2 transition-all duration-300
                ${done    ? "bg-emerald ring-emerald text-white"
                : active  ? "bg-surface ring-emerald text-emerald scale-110"
                :           "bg-surface ring-border text-ink-3"}`}>
                {active && <span className="absolute inset-0 rounded-full ring-2 ring-emerald/40 animate-ping" />}
                {done ? (
                  <svg key={`done-${i}`} className="w-4 h-4 step-dot-pop" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : i + 1}
              </div>
              <span className={`text-[11px] font-medium text-center whitespace-nowrap transition-colors duration-300
                ${active ? "text-emerald" : done ? "text-ink-3" : "text-ink-3/50"}`}>
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className="flex-1 mt-[18px] mx-2 rounded-full bg-border overflow-hidden">
                <div className={`h-0.5 bg-emerald rounded-full transition-transform duration-500 ease-out origin-left
                  ${done ? "scale-x-100" : "scale-x-0"}`} />
              </div>
            )}
          </React.Fragment>
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
      <div ref={containerRef} className="bg-muted rounded-2xl p-4 h-72 overflow-y-auto font-mono text-xs">
        {logs.map((l, i) => (
          <div
            key={i}
            className={`whitespace-pre-wrap break-all py-1.5 border-b border-border/40 last:border-0
              ${l.startsWith("  ⚠") || l.startsWith("Error") ? "text-amber-500" : l.startsWith("  ✓") ? "text-emerald" : "text-ink-3"}`}
          >
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}
