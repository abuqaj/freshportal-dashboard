"use client";

import { useState } from "react";
import {
  Banknote, Building2, Check, CircleAlert, ExternalLink, FileText, Globe, Hash, Info, Pencil, Plus, RotateCcw, TriangleAlert,
} from "lucide-react";
import { Lang, translations } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import {
  Chip, Code, DoneState, DropZone, GoButton, IconButton, ModuleHeader, Panel, ProgressWait, RunnerWait, Section, Steps,
} from "@/components/ui/kit";
import { preloadMascot } from "@/components/MascotRunner";
import { cn } from "@/lib/utils";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

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
  /** Only for a PDF: a .docx is read by label, without the model. */
  usage?: { input_tokens: number; output_tokens: number };
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
  /** Base64 JPEG of the profile right after saving; null when it could not be taken. */
  profile_screenshot: string | null;
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

/** Written with only the first letter capitalised, whoever typed them - the
 *  same rule the API applies (_first_letter_capital), run here when a field
 *  is left so the screen shows what will be created. */
const FIRST_LETTER_ONLY: (keyof Details)[] = ["company_name", "city", "country"];

function firstLetterCapital(value: string): string {
  const text = value.trim().toLowerCase();
  // The first letter, not the first character: "3M KENYA" -> "3M kenya".
  const i = [...text].findIndex(ch => ch.toUpperCase() !== ch.toLowerCase());
  if (i < 0) return text;
  const chars = [...text];
  chars[i] = chars[i].toUpperCase();
  return chars.join("");
}

export default function KenyaSupplier({ lang }: { lang: Lang }) {
  const all = translations[lang];
  const t = all.kenyaSupplier;

  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [edited, setEdited] = useState<Partial<Record<keyof Details, string>>>({});
  // Fields open read-only: what was read is checked first, and changed only
  // on purpose.
  const [editing, setEditing] = useState(false);
  const [created, setCreated] = useState<CreateResult | null>(null);

  function reset() {
    setStage("idle");
    setError("");
    setFileName("");
    setResult(null);
    setEdited({});
    setEditing(false);
    setCreated(null);
  }

  async function upload(file: File) {
    if (!/\.(pdf|docx)$/i.test(file.name)) {
      setError(t.errFileType);
      return;
    }
    setStage("reading");
    setError("");
    setResult(null);
    setEdited({});
    setEditing(false);
    setCreated(null);
    setFileName(file.name);
    try {
      const body = new FormData();
      // The API's field is still called "pdf"; it takes a .docx as well.
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
          // Also on the way out: a field still focused when Create is clicked
          // has not been tidied yet. The API applies the rule once more.
          company_name: firstLetterCapital(value("company_name")),
          supplier_code: code,
          address: value("address"),
          postal_code: value("postal_code"),
          city: firstLetterCapital(value("city")),
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

  const stepIndex = stage === "idle" || stage === "reading" ? 0 : stage === "review" ? 1 : stage === "creating" ? 2 : 3;

  // The runner shows while FreshPortal is written; fetch him from the review on.
  preloadMascot();

  return (
    <div>
      <ModuleHeader
        tab="supplier"
        t={all}
        info={stage === "review" ? t.reviewHint : t.intro}
        chips={stage === "review" && result ? <>
          {fileName && <Chip tone="info" icon={FileText}><span className="max-w-[220px] truncate">{fileName}</span></Chip>}
          {result.missing.length > 0 && <Chip tone="warn" icon={TriangleAlert} tip={t.missingNote(String(result.missing.length))}>{result.missing.length}</Chip>}
        </> : null}
        actions={stage === "review" ? <>
          <IconButton icon={editing ? Check : Pencil} active={editing} tip={editing ? t.btnDoneEditing : t.btnEditFields} onClick={() => setEditing(on => !on)} />
          <IconButton icon={RotateCcw} tip={t.btnBack} onClick={reset} />
        </> : null}
      />
      <Section tight>
        <Steps labels={[t.stepUpload, t.stepReview, t.stepCreate]} current={stepIndex} />
      </Section>

      {!!error && (
        <Section tight>
          <p role="alert" className="flex items-start gap-1.5 text-[12.5px] font-semibold text-brick">
            <CircleAlert className="mt-px size-[15px] flex-none" /><span className="break-words">{error}</span>
          </p>
        </Section>
      )}

      {/* "backwards", not "both": a kept transform would frame fixed popups. */}
      <div key={stage} className="step-enter">

        {/* ── 1. Upload ── */}
        {stage === "idle" && (
          <Section>
            <DropZone title={t.dropHere} exts={[".pdf", ".docx"]}
              accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
              onFiles={files => upload(files[0])} />
          </Section>
        )}

        {stage === "reading" && (
          <Section><ProgressWait status={t.reading} /></Section>
        )}

        {/* ── 2. Review ── */}
        {stage === "review" && result && d && (
          <Section className="flex flex-col gap-4">
            {d.notes && (
              <p className="flex items-start gap-1.5 text-[12.5px] text-ink-2">
                <Info className="mt-px size-[15px] flex-none text-ink-3" /><span><b className="font-semibold">{t.modelNote}:</b> {d.notes}</span>
              </p>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {FIELDS.map(f => {
                const isMissing = result.missing.includes(f.key as string) && !edited[f.key];
                return (
                  <label key={f.key} className={cn("block", f.wide && "sm:col-span-2")}>
                    <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink-3">
                      {(t as unknown as Record<string, string>)[f.labelKey]}
                      {isMissing && <Chip tone="warn" icon={TriangleAlert}>{t.notFound}</Chip>}
                    </span>
                    <input
                      value={value(f.key)}
                      readOnly={!editing}
                      onChange={e => setEdited(prev => ({ ...prev, [f.key]: e.target.value }))}
                      onBlur={() => {
                        if (!FIRST_LETTER_ONLY.includes(f.key)) return;
                        setEdited(prev => prev[f.key] === undefined
                          ? prev
                          : { ...prev, [f.key]: firstLetterCapital(prev[f.key] as string) });
                      }}
                      placeholder={editing ? "" : "—"}
                      className={cn("h-10 w-full rounded-xl border px-3 text-sm outline-none transition-colors",
                        f.key === "supplier_code" && "font-mono",
                        editing
                          ? "border-border bg-surface text-ink focus:border-emerald/55 focus:ring-4 focus:ring-emerald/12"
                          : "cursor-default border-transparent bg-ground text-ink placeholder:text-ink-3/50",
                        isMissing && "border-blush bg-blush/15")}
                    />
                  </label>
                );
              })}
            </div>

            {/* What the portal will be set to, as opposed to what was read */}
            <Panel title={t.mappingTitle} icon={Building2} className="bg-ground/50">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="info" icon={Globe} tip={`${t.mapCountry} · id ${d.country_id}`}>Kenya</Chip>
                {d.currency_label
                  ? <Chip tone="ok" icon={Banknote}
                      tip={`${t.mapCurrency}: ${d.currency_label} (id ${d.currency_id}) — ${d.currency_needs_change ? t.currencyWillChange : t.currencyAlreadyDefault}`}>
                      {d.currency_label}
                    </Chip>
                  : <Chip tone="warn" icon={Banknote}
                      tip={result.unmapped_currency ? t.currencyUnmapped(d.invoice_currency ?? "") : t.currencyNone}>
                      {d.invoice_currency || "—"}
                    </Chip>}
                {result.usage && (
                  <span className="ml-auto text-[11px] text-ink-3">{t.tokens(String(result.usage.input_tokens), String(result.usage.output_tokens))}</span>
                )}
              </div>
            </Panel>

            <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-muted pt-4">
              {!codeValid && (
                <p className="mr-auto flex items-center gap-1.5 text-[12.5px] font-semibold text-brick">
                  <TriangleAlert className="size-[15px] flex-none" />{t.codeInvalid}
                </p>
              )}
              <Chip tone="bad" icon={CircleAlert} tip={t.createWarning}>{t.irreversible}</Chip>
              <GoButton icon={Check} tip={canCreate ? t.btnCreate : `${t.btnCreate} · ${t.codeInvalid}`} disabled={!canCreate} onClick={create} />
            </div>
          </Section>
        )}

        {/* ── Creating: written to FreshPortal ── */}
        {stage === "creating" && (
          <Section>
            <RunnerWait title={t.creating}>
              {value("company_name") && <Chip tone="info" icon={Building2}>{value("company_name")}</Chip>}
              {code && <Code>{code}</Code>}
            </RunnerWait>
          </Section>
        )}

        {/* ── 3. Done ── */}
        {stage === "done" && created && (
          <Section>
            <DoneState
              title={t.createdTitle(created.company_name, created.supplier_code)}
              chips={<>
                <Chip tone="info" icon={Hash} tip={t.createdId}>{created.supplier_id}</Chip>
                <Chip tone="ok" icon={Banknote} tip={`${t.mapCurrency}: ${created.currency_detail}`}>{t.mapCurrency}</Chip>
              </>}
            >
              <div className="flex w-full flex-col items-center gap-3">
                {created.supplier_code !== created.requested_code && (
                  <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-brick">
                    <TriangleAlert className="size-[15px] flex-none" />{t.codeTaken(created.requested_code, created.supplier_code)}
                  </p>
                )}
                {created.skipped_fields.length > 0 && (
                  <p className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                    <Info className="size-[15px] flex-none text-ink-3" />{t.createdSkipped(created.skipped_fields.join(", "))}
                  </p>
                )}
                {created.profile_screenshot && (
                  <Tip content={t.profileShotHint}>
                    <a
                      href={created.supplier_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative block w-full max-w-xl overflow-hidden rounded-[18px] border border-border bg-surface outline-none focus-visible:ring-2 focus-visible:ring-emerald"
                    >
                      <img
                        src={`data:image/jpeg;base64,${created.profile_screenshot}`}
                        alt={t.profileShotAlt(created.company_name)}
                        className="block max-h-[420px] w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.01]"
                      />
                      {/* Always visible, so the picture reads as a link on touch screens too */}
                      <span className="absolute right-2 top-2 grid size-8 place-items-center rounded-lg bg-white/90 text-ink shadow">
                        <ExternalLink className="size-4" />
                      </span>
                    </a>
                  </Tip>
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  <Button asChild variant="outline">
                    <a href={created.supplier_url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" />{t.openProfile}</a>
                  </Button>
                  <Button variant="primary" onClick={reset}><Plus className="size-4" />{t.btnAnother}</Button>
                </div>
              </div>
            </DoneState>
          </Section>
        )}

      </div>
    </div>
  );
}
