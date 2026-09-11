"use client";

import React, { useState, useRef } from "react";
import { Lang, translations } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

const CTRL = "h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50 transition-colors";

/** Wizard position. `reading` and `creating` are the two waits: each belongs
 *  to the step before it, so the bar does not jump ahead of work that has not
 *  finished. */
type Stage = "idle" | "reading" | "review" | "creating" | "done";

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

/** Same shape as the delivery importer's stepper, kept local rather than
 *  extracted: that component is in production and works, and lifting it out
 *  to share forty lines is a change to working code for no behavioural gain. */
function SupplierStepBar({ stage, steps }: { stage: Stage; steps: string[] }) {
  const current = stage === "idle" || stage === "reading" ? 0
    : stage === "review" ? 1
    : stage === "creating" ? 2
    : steps.length;

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
                  <svg className="w-4 h-4 step-dot-pop" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
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

function Spinner({ label }: { label: string }) {
  return (
    <div className="step-enter flex flex-col items-center gap-5 py-10">
      <div className="relative flex items-center justify-center">
        <svg className="animate-spin w-14 h-14 text-emerald/20" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5"/>
        </svg>
        <svg className="animate-spin absolute w-14 h-14 text-emerald" viewBox="0 0 24 24" fill="none" style={{ animationDuration: "0.9s" }}>
          <path stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
      </div>
      <p className="text-sm font-semibold text-ink">{label}</p>
    </div>
  );
}

export default function KenyaSupplier({ lang }: { lang: Lang }) {
  const t = translations[lang].kenyaSupplier;

  const [stage, setStage] = useState<Stage>("idle");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [edited, setEdited] = useState<Partial<Record<keyof Details, string>>>({});
  const [created, setCreated] = useState<CreateResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStage("idle");
    setError("");
    setFileName("");
    setResult(null);
    setEdited({});
    setCreated(null);
  }

  async function upload(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError(t.errNotPdf);
      return;
    }
    setStage("reading");
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
        setError((parsed as { detail?: string } | null)?.detail ?? (text.slice(0, 300) || res.statusText));
        setStage("idle");
        return;
      }
      setResult(parsed as ExtractResult);
      setStage("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("idle");
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
  const canCreate = !!value("company_name").trim() && codeValid;

  async function create() {
    if (!d) return;
    setStage("creating");
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
        // Back to review, with the values intact so they can be corrected.
        setStage("review");
        return;
      }
      setCreated(parsed as CreateResult);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("review");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SupplierStepBar stage={stage} steps={[t.stepUpload, t.stepReview, t.stepCreate]} />

      {!!error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
          <p className="text-xs text-red-600 break-words">{error}</p>
        </div>
      )}

      {/* ── 1. Upload ─────────────────────────────────────────────────── */}
      {stage === "idle" && (
        <div className="step-enter flex flex-col gap-4">
          <div>
            <p className="text-sm font-semibold text-ink">{t.title}</p>
            <p className="text-xs text-ink-3 max-w-3xl mt-0.5">{t.intro}</p>
          </div>
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            className={`rounded-2xl border-2 border-dashed p-12 flex flex-col items-center gap-3 cursor-pointer transition-colors
                        ${dragging ? "border-emerald bg-emerald/5" : "border-border hover:border-emerald/50"}`}
          >
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="text-ink-3">
              <path d="M12 16V4m0 0L7 9m5-5l5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
            </svg>
            <p className="text-sm font-medium text-ink">{t.dropHere}</p>
            <p className="text-xs text-ink-3">{fileName || t.pdfOnly}</p>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }}
            />
          </div>
        </div>
      )}

      {stage === "reading" && <Spinner label={t.reading} />}
      {stage === "creating" && <Spinner label={t.creating} />}

      {/* ── 2. Review ─────────────────────────────────────────────────── */}
      {stage === "review" && result && d && (
        <div className="step-enter flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-ink">{t.reviewTitle}</p>
              <p className="text-xs text-ink-3">{t.reviewHint}</p>
            </div>
            <span className="text-xs text-ink-3">{fileName}</span>
          </div>

          {result.missing.length > 0 && (
            <p className="text-xs text-amber-600">{t.missingNote(String(result.missing.length))}</p>
          )}
          {d.notes && <p className="text-xs text-amber-600">{t.modelNote}: {d.notes}</p>}

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

          <div className="flex items-center gap-3 flex-wrap border-t border-border pt-4">
            <button onClick={reset} className={CTRL}>{t.btnBack}</button>
            <button
              onClick={create}
              disabled={!canCreate}
              className="h-10 px-5 rounded-lg text-sm font-semibold bg-emerald text-white
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t.btnCreate}
            </button>
            {!codeValid && <span className="text-xs text-amber-600">{t.codeInvalid}</span>}
            <span className="text-xs text-ink-3">{t.createWarning}</span>
          </div>
        </div>
      )}

      {/* ── 3. Done ───────────────────────────────────────────────────── */}
      {stage === "done" && created && (
        <div className="step-enter rounded-2xl border border-emerald/40 bg-emerald/5 p-5 flex flex-col gap-3">
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
          <div className="flex items-center gap-3 flex-wrap pt-1">
            <a
              href={created.supplier_url}
              target="_blank"
              rel="noopener noreferrer"
              className="h-10 px-5 rounded-lg text-sm font-semibold bg-emerald text-white
                         inline-flex items-center gap-2 transition-colors hover:opacity-90"
            >
              {t.openProfile}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M14 4h6v6M20 4l-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </a>
            <button onClick={reset} className={CTRL}>{t.btnAnother}</button>
          </div>
        </div>
      )}
    </div>
  );
}
