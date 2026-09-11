"use client";

import { useState, useRef } from "react";
import { Lang, translations } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

const CTRL = "h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors";

interface Details {
  company_name: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  vat_number: string | null;
  coc_number: string | null;
  invoice_currency: string | null;
  supplier_code: string | null;
  notes: string | null;
  currency_id: string | null;
  currency_label: string | null;
  currency_needs_change: boolean;
  country_id: string;
}

interface ExtractResult {
  details: Details;
  missing: string[];
  unmapped_currency: boolean;
  usage: { input_tokens: number; output_tokens: number };
}

interface CreateResult {
  supplier_id: string;
  supplier_url: string;
  /** The code that actually went in — not always the one that was asked for. */
  supplier_code: string;
  requested_code: string;
  codes_tried: string[];
  company_name: string;
  filled_fields: string[];
  skipped_fields: string[];
  currency_changed: boolean;
  currency_detail: string;
}

/** Order and labelling of the review form. Keyed so a field that came back
 *  empty can be highlighted against the `missing` list the server returns. */
const FIELDS: { key: keyof Details; labelKey: string; wide?: boolean }[] = [
  { key: "company_name",     labelKey: "fCompany", wide: true },
  { key: "supplier_code",    labelKey: "fCode" },
  { key: "address",          labelKey: "fAddress", wide: true },
  { key: "postal_code",      labelKey: "fPostal" },
  { key: "city",             labelKey: "fCity" },
  { key: "country",          labelKey: "fCountry" },
  { key: "phone",            labelKey: "fPhone" },
  { key: "email",            labelKey: "fEmail", wide: true },
  { key: "vat_number",       labelKey: "fVat" },
  { key: "coc_number",       labelKey: "fCoc" },
  { key: "invoice_currency", labelKey: "fCurrency" },
];

export default function KenyaSupplier({ lang }: { lang: Lang }) {
  const t = translations[lang].kenyaSupplier;

  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [edited, setEdited] = useState<Partial<Record<keyof Details, string>>>({});
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError(t.errNotPdf);
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    setEdited({});
    setCreated(null);
    setFileName(file.name);
    try {
      const body = new FormData();
      body.append("pdf", file);
      const res = await fetch(`${RAILWAY}/kenya/supplier/extract`, { method: "POST", body });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* HTML error page */ }
      if (!res.ok) {
        const detail = (parsed as { detail?: string } | null)?.detail;
        setError(detail ?? (text.slice(0, 300) || res.statusText));
        return;
      }
      setResult(parsed as ExtractResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  }

  const d = result?.details;
  const value = (k: keyof Details) =>
    edited[k] ?? ((d?.[k] as string | null) ?? "");

  const code = value("supplier_code").trim();
  const codeValid = /^[A-Z]{4,7}$/.test(code);
  const canCreate = !!value("company_name").trim() && codeValid && !creating && !created;

  async function create() {
    if (!d) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch(`${RAILWAY}/kenya/supplier/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: value("company_name"),
          supplier_code: code,
          address: value("address"),
          postal_code: value("postal_code"),
          city: value("city"),
          phone: value("phone"),
          email: value("email"),
          vat_number: value("vat_number"),
          coc_number: value("coc_number"),
          // The id resolved at extraction time; the operator edits the
          // human-readable currency, not this.
          currency_id: d.currency_id,
        }),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* HTML error page */ }
      if (!res.ok) {
        setError((parsed as { detail?: string } | null)?.detail ?? (text.slice(0, 400) || res.statusText));
        return;
      }
      setCreated(parsed as CreateResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border p-4 flex flex-col gap-2">
        <p className="text-sm font-semibold text-ink">{t.title}</p>
        <p className="text-xs text-ink-3 max-w-3xl">{t.intro}</p>
        <p className="text-xs text-ink-3 max-w-3xl">{t.stageNote}</p>
      </div>

      {/* ── Drop zone ─────────────────────────────────────────────────── */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`rounded-2xl border-2 border-dashed p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors
                    ${dragging ? "border-emerald bg-emerald/5" : "border-border hover:border-emerald/50"}`}
      >
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="text-ink-3">
          <path d="M12 16V4m0 0L7 9m5-5l5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
        </svg>
        <p className="text-sm font-medium text-ink">{busy ? t.reading : t.dropHere}</p>
        <p className="text-xs text-ink-3">{fileName || t.pdfOnly}</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }}
        />
      </div>

      {!!error && (
        <p className="text-xs text-red-600 break-words px-1">{error}</p>
      )}

      {/* ── Review ────────────────────────────────────────────────────── */}
      {result && d && (
        <div className="rounded-2xl border border-border p-4 flex flex-col gap-4">
          <div>
            <p className="text-sm font-semibold text-ink">{t.reviewTitle}</p>
            <p className="text-xs text-ink-3">{t.reviewHint}</p>
          </div>

          {result.missing.length > 0 && (
            <p className="text-xs text-amber-600">
              {t.missingNote(String(result.missing.length))}
            </p>
          )}
          {d.notes && (
            <p className="text-xs text-amber-600">{t.modelNote}: {d.notes}</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {FIELDS.map(f => {
              const isMissing = result.missing.includes(f.key as string);
              return (
                <div key={f.key} className={f.wide ? "sm:col-span-2" : ""}>
                  <label className="block text-[11px] text-ink-3 mb-1">
                    {(t as unknown as Record<string, string>)[f.labelKey]}
                    {isMissing && <span className="text-amber-600 ml-1.5">{t.notFound}</span>}
                  </label>
                  <input
                    value={value(f.key)}
                    onChange={e => setEdited(prev => ({ ...prev, [f.key]: e.target.value }))}
                    className={`${CTRL} w-full ${isMissing && !edited[f.key] ? "border-amber-500/50" : ""}`}
                  />
                </div>
              );
            })}
          </div>

          {/* What the portal will be set to, as opposed to what was read */}
          <div className="rounded-xl border border-border p-3 flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-ink">{t.mappingTitle}</p>
            <p className="text-xs text-ink-3">
              {t.mapCountry}: <span className="text-ink">Kenya</span>
              <span className="text-ink-3"> (id {d.country_id})</span>
            </p>
            <p className="text-xs text-ink-3">
              {t.mapCurrency}:{" "}
              {d.currency_label ? (
                <>
                  <span className="text-ink">{d.currency_label}</span>
                  <span className="text-ink-3"> (id {d.currency_id})</span>
                  <span className="text-ink-3">
                    {" — "}{d.currency_needs_change ? t.currencyWillChange : t.currencyAlreadyDefault}
                  </span>
                </>
              ) : (
                <span className="text-amber-600">
                  {result.unmapped_currency ? t.currencyUnmapped(d.invoice_currency ?? "") : t.currencyNone}
                </span>
              )}
            </p>
          </div>

          <p className="text-[11px] text-ink-3">
            {t.tokens(String(result.usage.input_tokens), String(result.usage.output_tokens))}
          </p>

          {!created && (
            <div className="flex items-center gap-3 flex-wrap border-t border-border pt-4">
              <button
                onClick={create}
                disabled={!canCreate}
                className="h-10 px-5 rounded-lg text-sm font-semibold bg-emerald text-white
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? t.creating : t.btnCreate}
              </button>
              {!codeValid && (
                <span className="text-xs text-amber-600">{t.codeInvalid}</span>
              )}
              <span className="text-xs text-ink-3">{t.createWarning}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Created ───────────────────────────────────────────────────── */}
      {created && (
        <div className="rounded-2xl border border-emerald/40 bg-emerald/5 p-4 flex flex-col gap-3">
          <p className="text-sm font-semibold text-emerald">
            {t.createdTitle(created.company_name, created.supplier_code)}
          </p>
          <p className="text-xs text-ink-3">
            {t.createdId}: <span className="font-mono text-ink">#{created.supplier_id}</span>
            {" · "}{t.mapCurrency}: {created.currency_detail}
          </p>
          {created.supplier_code !== created.requested_code && (
            <p className="text-xs text-amber-600">
              {t.codeTaken(created.requested_code, created.supplier_code)}
            </p>
          )}
          {created.skipped_fields.length > 0 && (
            <p className="text-xs text-amber-600">
              {t.createdSkipped(created.skipped_fields.join(", "))}
            </p>
          )}
          <a
            href={created.supplier_url}
            target="_blank"
            rel="noopener noreferrer"
            className="h-10 px-5 rounded-lg text-sm font-semibold bg-emerald text-white
                       inline-flex items-center gap-2 self-start transition-colors hover:opacity-90"
          >
            {t.openProfile}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M14 4h6v6M20 4l-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </a>
        </div>
      )}
    </div>
  );
}
