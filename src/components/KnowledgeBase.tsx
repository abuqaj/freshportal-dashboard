"use client";

import { useCallback, useEffect, useState } from "react";
import { Lang, translations } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";
const PAGE_SIZE = 20;
const PROPOSAL_KIND = "wiki-proposal";
// Kinds a don't-ask-again rule never covers; the backend refuses them too (NO_RULE_KINDS).
const NO_RULE_KINDS = ["contradiction", "skill-edit", "new-skill"];

type SubTab = "review" | "proposals" | "changelog" | "library" | "runs";
type ReviewView = "pending" | "decided" | "done";
type Decision = "approve" | "approve_always" | "reject" | "answer" | "undo";
type Strings = (typeof translations)[Lang]["knowledgeBase"];

interface ReviewItem {
  id: string;
  run_id: string | null;
  bucket: "auto" | "signoff" | "context";
  kind: string;
  title: string;
  target: string | null;
  body: string | null;
  evidence: string[] | null;
  why: string | null;
  status: string;
  answer: string | null;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  created_at: string | null;
}

interface ChangeLogEntry {
  id: string;
  bucket: ReviewItem["bucket"];
  kind: string;
  title: string;
  target: string | null;
  body: string | null;
  action: string | null;
  verify: string | null;
  evidence: string[] | null;
  why: string | null;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  applied_by_run: string | null;
}

interface Rule {
  id: number;
  kind: string;
  target: string;
  created_by: string | null;
  created_at: string | null;
}

interface DocSummary {
  path: string;
  kind: string;
  title: string | null;
  topic: string | null;
  tags: string[] | null;
  source_date: string | null;
  size_bytes: number | null;
  synced_at: string | null;
  snippet?: string | null;
}

interface Doc extends DocSummary {
  content: string | null;
}

interface Run {
  id: string;
  skill: string;
  started_at: string | null;
  finished_at: string | null;
  status: string | null;
  summary: string | null;
}

interface Overview {
  pending_review: number;
  pending_proposals: number;
  pending_questions: number;
  decided_waiting: number;
  documents: number;
  last_runs: { skill: string; status: string | null; started_at: string | null; finished_at: string | null }[];
}

const BTN = "h-8 px-3 rounded-lg text-xs font-semibold transition-all active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100";

async function api<R>(path: string, init?: RequestInit): Promise<R> {
  const res = await fetch(`${RAILWAY}${path}`, init);
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* an HTML error page */ }
  if (!res.ok) {
    const detail = (parsed as { detail?: unknown } | null)?.detail;
    throw new Error(typeof detail === "string" ? detail : (text.slice(0, 300) || res.statusText));
  }
  return parsed as R;
}

function postJson<R>(path: string, body: unknown): Promise<R> {
  return api<R>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function formatWhen(value: string | null, lang: Lang): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function statusLabel(status: string, t: Strings): string {
  switch (status) {
    case "pending":         return t.statusPending;
    case "approved":        return t.statusApproved;
    case "approved_always": return t.statusApprovedAlways;
    case "rejected":        return t.statusRejected;
    case "answered":        return t.statusAnswered;
    case "applied":         return t.statusApplied;
    default:                return t.statusClosed;
  }
}

function kindLabel(kind: string, t: Strings): string {
  return kind === "thread_summary" ? t.kindThread
    : kind === "curated" ? t.kindCurated
    : kind === "inbox" ? t.kindInbox
    : kind === "wiki" ? t.kindWiki
    : t.kindOther;
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-3">
      <svg className="animate-spin h-4 w-4 text-emerald" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
      </svg>
      <span>{label}</span>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return <p className="rounded-lg border border-ember/30 bg-ember/5 px-3 py-2 text-xs text-ember">{message}</p>;
}

function Empty({ label }: { label: string }) {
  return <p className="py-10 text-center text-sm text-ink-3">{label}</p>;
}

function BucketBadge({ bucket, t }: { bucket: ReviewItem["bucket"]; t: Strings }) {
  const style = bucket === "signoff" ? "bg-amber-50 text-amber-700 border-amber-200"
    : bucket === "context" ? "bg-sky-50 text-sky-700 border-sky-200"
    : "bg-emerald/10 text-emerald border-emerald/20";
  const label = bucket === "signoff" ? t.bucketSignoff : bucket === "context" ? t.bucketContext : t.bucketAuto;
  return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border ${style}`}>{label}</span>;
}

function EvidenceList({ evidence, t }: { evidence: string[] | null; t: Strings }) {
  if (!evidence || evidence.length === 0) return null;
  return (
    <div className="text-xs text-ink-3">
      <span className="font-semibold">{t.evidence}:</span>
      <ul className="mt-1 flex flex-col gap-0.5">
        {evidence.map(path => <li key={path}><code className="text-ink break-all">{path}</code></li>)}
      </ul>
    </div>
  );
}

/* ─── Review ─────────────────────────────────────────────────────────────── */

function ReviewCard({ item, t, lang, onDecided }: {
  item: ReviewItem; t: Strings; lang: Lang; onDecided: (item: ReviewItem) => void;
}) {
  const [answer, setAnswer] = useState(item.answer ?? "");
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState("");

  async function decide(decision: Decision) {
    setBusy(decision);
    setError("");
    try {
      const res = await postJson<{ item: ReviewItem }>(
        `/kb/review-items/${encodeURIComponent(item.id)}/decision`,
        { decision, answer: decision === "answer" ? answer : null });
      onDecided(res.item);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(null);
  }

  const pending = item.status === "pending";
  const changeable = ["approved", "approved_always", "rejected", "answered"].includes(item.status);

  return (
    <div className="step-enter rounded-xl border border-border bg-surface p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <BucketBadge bucket={item.bucket} t={t} />
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-ground text-ink-3 border border-border">{item.kind}</span>
        <span className="text-[10px] text-ink-3 ml-auto">{formatWhen(item.created_at, lang)}</span>
      </div>
      <h3 className="text-sm font-semibold text-ink">{item.title}</h3>

      {item.target && (
        <p className="text-xs text-ink-3">
          <span className="font-semibold">{t.target}:</span> <code className="text-ink">{item.target}</code>
        </p>
      )}
      {item.body && (
        <div>
          <p className="text-[11px] font-semibold text-ink-3 mb-1">{item.bucket === "context" ? t.question : t.proposedChange}</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-ground px-3 py-2 text-xs text-ink font-mono">{item.body}</pre>
        </div>
      )}
      {item.why && <p className="text-xs text-ink"><span className="font-semibold text-ink-3">{t.why}:</span> {item.why}</p>}
      <EvidenceList evidence={item.evidence} t={t} />

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <span className={`text-xs font-medium ${pending ? "text-amber-700" : "text-ink-3"}`}>{statusLabel(item.status, t)}</span>
        {item.decided_by && <span className="text-[11px] text-ink-3">· {t.decidedBy(item.decided_by, formatWhen(item.decided_at, lang))}</span>}
      </div>
      {item.status === "answered" && item.answer && (
        <p className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-xs text-sky-900 whitespace-pre-wrap">{item.answer}</p>
      )}

      {pending && item.bucket === "signoff" && (
        <div className="flex flex-wrap gap-2">
          <button className={`${BTN} bg-emerald text-white hover:bg-emerald/90`} disabled={busy !== null} onClick={() => decide("approve")}>{t.approve}</button>
          {item.target && !NO_RULE_KINDS.includes(item.kind) && (
            <button className={`${BTN} border border-emerald/40 text-emerald hover:bg-emerald/5`} disabled={busy !== null} onClick={() => decide("approve_always")}>{t.approveAlways}</button>
          )}
          <button className={`${BTN} border border-border text-ink-3 hover:text-ember hover:border-ember/40`} disabled={busy !== null} onClick={() => decide("reject")}>{t.reject}</button>
        </div>
      )}
      {pending && item.bucket === "context" && (
        <div className="flex flex-col gap-2">
          <textarea
            value={answer}
            onChange={e => setAnswer(e.target.value)}
            placeholder={t.answerPlaceholder}
            rows={3}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-emerald/50"
          />
          <button className={`${BTN} self-start bg-emerald text-white hover:bg-emerald/90`} disabled={busy !== null || !answer.trim()} onClick={() => decide("answer")}>{t.sendAnswer}</button>
        </div>
      )}
      {changeable && (
        <button className={`${BTN} self-start border border-border text-ink-3 hover:text-ink`} disabled={busy !== null} onClick={() => decide("undo")}>{t.undo}</button>
      )}
      {error && <ErrorBox message={error} />}
    </div>
  );
}

function ReviewList({ t, lang, kind, excludeKind, hint, onChanged }: {
  t: Strings; lang: Lang; kind?: string; excludeKind?: string; hint?: string; onChanged: () => void;
}) {
  const [view, setView] = useState<ReviewView>("pending");
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ view, limit: String(PAGE_SIZE), offset: String(offset) });
    if (kind) params.set("kind", kind);
    if (excludeKind) params.set("exclude_kind", excludeKind);
    try {
      const res = await api<{ items: ReviewItem[]; has_more: boolean }>(`/kb/review-items?${params.toString()}`);
      setItems(prev => (offset === 0 || !prev ? res.items : [...prev, ...res.items]));
      setHasMore(res.has_more);
    } catch (e) {
      setError(errorText(e));
      if (offset === 0) setItems([]);
    }
    setLoading(false);
  }, [view, kind, excludeKind]);

  useEffect(() => {
    setItems(null);
    load(0);
  }, [load]);

  function handleDecided(updated: ReviewItem) {
    // Keep the card where it is, so the new status is visible where it was clicked.
    setItems(prev => (prev ?? []).map(item => (item.id === updated.id ? updated : item)));
    onChanged();
  }

  const views: { id: ReviewView; label: string }[] = [
    { id: "pending", label: t.viewPending },
    { id: "decided", label: t.viewDecided },
    { id: "done", label: t.viewDone },
  ];
  const groups: { bucket: ReviewItem["bucket"] | null; items: ReviewItem[] }[] = !items ? []
    : view === "pending"
      ? [{ bucket: "signoff" as const, items: items.filter(i => i.bucket === "signoff") },
         { bucket: "context" as const, items: items.filter(i => i.bucket === "context") }].filter(g => g.items.length > 0)
      : [{ bucket: null, items }];

  return (
    <div className="flex flex-col gap-4">
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
      <div className="flex gap-1 bg-ground border border-border rounded-xl p-1 w-fit">
        {views.map(v => (
          <button key={v.id} onClick={() => setView(v.id)}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${view === v.id ? "bg-surface text-ink shadow-sm border border-border" : "text-ink-3 hover:text-ink"}`}>
            {v.label}
          </button>
        ))}
      </div>
      {error && <ErrorBox message={`${t.loadError} ${error}`} />}
      {items === null ? <Spinner label={t.loading} />
        : items.length === 0 ? <Empty label={t.empty} />
        : groups.map(group => (
          <div key={group.bucket ?? "all"} className="flex flex-col gap-3">
            {group.bucket && <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">{group.bucket === "signoff" ? t.bucketSignoff : t.bucketContext}</h3>}
            {group.items.map(item => <ReviewCard key={`${item.id}-${item.status}`} item={item} t={t} lang={lang} onDecided={handleDecided} />)}
          </div>
        ))}
      {hasMore && (
        <button className={`${BTN} self-center border border-border text-ink-3 hover:text-ink`} disabled={loading} onClick={() => load(items?.length ?? 0)}>{t.loadMore}</button>
      )}
    </div>
  );
}

function RulesPanel({ t, lang }: { t: Strings; lang: Lang }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setRules((await api<{ rules: Rule[] }>("/kb/rules")).rules);
    } catch (e) {
      setError(errorText(e));
      setRules([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(id: number) {
    try {
      await api(`/kb/rules/${id}`, { method: "DELETE" });
      setRules(prev => (prev ?? []).filter(rule => rule.id !== id));
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="rounded-xl border border-border bg-ground/40 p-4 flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink">{t.rulesTitle}</h3>
      <p className="text-xs text-ink-3">{t.rulesHint}</p>
      {error && <ErrorBox message={error} />}
      {rules === null ? <Spinner label={t.loading} />
        : rules.length === 0 ? <p className="text-xs text-ink-3">{t.rulesEmpty}</p>
        : (
          <ul className="flex flex-col gap-1.5">
            {rules.map(rule => (
              <li key={rule.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
                <span className="font-medium text-ink">{rule.kind}</span>
                <code className="text-ink-3 break-all">{rule.target}</code>
                <span className="text-ink-3 ml-auto">{rule.created_by ?? "—"} · {formatWhen(rule.created_at, lang)}</span>
                <button className={`${BTN} h-7 border border-border text-ink-3 hover:text-ember`} onClick={() => remove(rule.id)}>{t.removeRule}</button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

/* ─── Change log ─────────────────────────────────────────────────────────── */

function ChangeLogTab({ t, lang }: { t: Strings; lang: Lang }) {
  const [entries, setEntries] = useState<ChangeLogEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const res = await api<{ items: ChangeLogEntry[]; has_more: boolean }>(`/kb/change-log?limit=${PAGE_SIZE}&offset=${offset}`);
      setEntries(prev => (offset === 0 || !prev ? res.items : [...prev, ...res.items]));
      setHasMore(res.has_more);
    } catch (e) {
      setError(errorText(e));
      if (offset === 0) setEntries([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(0); }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-3">{t.changeLogHint}</p>
      {error && <ErrorBox message={`${t.loadError} ${error}`} />}
      {entries === null ? <Spinner label={t.loading} />
        : entries.length === 0 ? <Empty label={t.empty} />
        : (
          <ul className="flex flex-col gap-2">
            {entries.map(entry => (
              <li key={entry.id} className="rounded-xl border border-border bg-surface">
                <button className="w-full flex flex-col gap-1 px-4 py-3 text-left" aria-expanded={expanded === entry.id}
                  onClick={() => setExpanded(expanded === entry.id ? "" : entry.id)}>
                  <span className="flex flex-wrap items-center gap-2">
                    {entry.bucket === "auto"
                      ? <BucketBadge bucket="auto" t={t} />
                      : <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md border bg-ground text-ink-3 border-border">{t.approvedBy(entry.decided_by ?? "—")}</span>}
                    <span className="text-[10px] text-ink-3 ml-auto">{formatWhen(entry.applied_at, lang)}</span>
                  </span>
                  <span className="text-sm font-semibold text-ink">{entry.title}</span>
                  <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-3">
                    {entry.target && <span><span className="font-semibold">{t.target}:</span> <code className="text-ink break-all">{entry.target}</code></span>}
                    <span><span className="font-semibold">{t.run}:</span> <code className="text-ink">{entry.applied_by_run ?? "—"}</code></span>
                  </span>
                </button>
                {expanded === entry.id && (
                  <div className="step-enter flex flex-col gap-3 border-t border-border mx-4 py-3">
                    {entry.body && (
                      <div>
                        <p className="text-[11px] font-semibold text-ink-3 mb-1">{t.changeMade}</p>
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-ground px-3 py-2 text-xs text-ink font-mono">{entry.body}</pre>
                      </div>
                    )}
                    {entry.action && <p className="text-xs text-ink"><span className="font-semibold text-ink-3">{t.actionDone}:</span> {entry.action}</p>}
                    {entry.verify && <p className="text-xs text-ink"><span className="font-semibold text-ink-3">{t.howToVerify}:</span> {entry.verify}</p>}
                    {entry.why && <p className="text-xs text-ink"><span className="font-semibold text-ink-3">{t.why}:</span> {entry.why}</p>}
                    <EvidenceList evidence={entry.evidence} t={t} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      {hasMore && (
        <button className={`${BTN} self-center border border-border text-ink-3 hover:text-ink`} disabled={loading} onClick={() => load(entries?.length ?? 0)}>{t.loadMore}</button>
      )}
    </div>
  );
}

/* ─── Library ────────────────────────────────────────────────────────────── */

function LibraryTab({ t, lang }: { t: Strings; lang: Lang }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Doc | null>(null);
  const [opening, setOpening] = useState("");

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (query.trim()) params.set("q", query.trim());
    if (kind) params.set("kind", kind);
    try {
      const res = await api<{ documents: DocSummary[]; has_more: boolean }>(`/kb/documents?${params.toString()}`);
      setDocs(prev => (offset === 0 || !prev ? res.documents : [...prev, ...res.documents]));
      setHasMore(res.has_more);
    } catch (e) {
      setError(errorText(e));
      if (offset === 0) setDocs([]);
    }
    setLoading(false);
  }, [query, kind]);

  useEffect(() => {
    const timer = setTimeout(() => load(0), 400);
    return () => clearTimeout(timer);
  }, [load]);

  async function openDoc(path: string) {
    setOpening(path);
    setError("");
    try {
      setOpen(await api<Doc>(`/kb/documents/item?path=${encodeURIComponent(path)}`));
    } catch (e) {
      setError(errorText(e));
    }
    setOpening("");
  }

  if (open) {
    return (
      <div className="step-enter flex flex-col gap-3">
        <button className={`${BTN} self-start border border-border text-ink-3 hover:text-ink`} onClick={() => setOpen(null)}>← {t.backToList}</button>
        <h3 className="text-base font-semibold text-ink">{open.title ?? open.path}</h3>
        <p className="text-xs text-ink-3">
          {kindLabel(open.kind, t)}{open.topic ? ` · ${open.topic}` : ""}{open.source_date ? ` · ${open.source_date}` : ""} · <code>{open.path}</code>
        </p>
        {open.content
          ? <pre className="whitespace-pre-wrap rounded-lg border border-border bg-ground px-4 py-3 text-xs text-ink font-mono">{open.content}</pre>
          : <Empty label={t.noContent} />}
      </div>
    );
  }

  const kinds = [
    { id: "", label: t.kindAll },
    { id: "thread_summary", label: t.kindThread },
    { id: "curated", label: t.kindCurated },
    { id: "inbox", label: t.kindInbox },
    { id: "wiki", label: t.kindWiki },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t.searchPlaceholder}
          className="h-9 flex-1 min-w-[200px] px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50"
        />
        <select value={kind} onChange={e => setKind(e.target.value)}
          className="h-9 px-3 rounded-lg text-sm border border-border bg-surface outline-none focus:border-emerald/50">
          {kinds.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
      </div>
      {error && <ErrorBox message={`${t.loadError} ${error}`} />}
      {docs === null ? <Spinner label={t.loading} />
        : docs.length === 0 ? <Empty label={t.empty} />
        : (
          <ul className="flex flex-col gap-2">
            {docs.map(doc => (
              <li key={doc.path}>
                <button onClick={() => openDoc(doc.path)} disabled={opening !== ""}
                  className="w-full text-left rounded-xl border border-border bg-surface px-4 py-3 transition-all hover:border-emerald/40 active:scale-[0.995] disabled:opacity-60">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-ground border border-border text-ink-3">{kindLabel(doc.kind, t)}</span>
                    {doc.topic && <span className="text-[10px] text-ink-3">{doc.topic}</span>}
                    <span className="text-[10px] text-ink-3 ml-auto">{doc.source_date ?? formatWhen(doc.synced_at, lang)}</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-ink">{opening === doc.path ? t.loading : (doc.title ?? doc.path)}</p>
                  {doc.snippet && <p className="mt-0.5 text-xs text-ink-3 line-clamp-2">{doc.snippet}</p>}
                </button>
              </li>
            ))}
          </ul>
        )}
      {hasMore && (
        <button className={`${BTN} self-center border border-border text-ink-3 hover:text-ink`} disabled={loading} onClick={() => load(docs?.length ?? 0)}>{t.loadMore}</button>
      )}
    </div>
  );
}

/* ─── Runs ───────────────────────────────────────────────────────────────── */

function RunsTab({ t, lang }: { t: Strings; lang: Lang }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState("");
  const [error, setError] = useState("");

  const loadRuns = useCallback(async (offset: number) => {
    try {
      const res = await api<{ runs: Run[]; has_more: boolean }>(`/kb/runs?limit=${PAGE_SIZE}&offset=${offset}`);
      setRuns(prev => (offset === 0 || !prev ? res.runs : [...prev, ...res.runs]));
      setHasMore(res.has_more);
    } catch (e) {
      setError(errorText(e));
      if (offset === 0) setRuns([]);
    }
  }, []);

  useEffect(() => { loadRuns(0); }, [loadRuns]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-3">{t.runsHint}</p>
      {error && <ErrorBox message={`${t.loadError} ${error}`} />}

      <section className="flex flex-col gap-2">
        {runs === null ? <Spinner label={t.loading} />
          : runs.length === 0 ? <p className="text-xs text-ink-3">{t.empty}</p>
          : (
            <ul className="flex flex-col gap-2">
              {runs.map(run => (
                <li key={run.id} className="rounded-xl border border-border bg-surface">
                  <button className="w-full flex flex-wrap items-center gap-2 px-4 py-3 text-left" onClick={() => setExpanded(expanded === run.id ? "" : run.id)}>
                    <span className="text-sm font-semibold text-ink">{run.skill}</span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${run.status === "ok" ? "bg-emerald/10 text-emerald" : "bg-amber-50 text-amber-700"}`}>{run.status ?? "—"}</span>
                    <span className="text-xs text-ink-3 ml-auto">{formatWhen(run.started_at, lang)}</span>
                  </button>
                  {expanded === run.id && run.summary && (
                    <pre className="step-enter mx-4 mb-3 whitespace-pre-wrap rounded-lg border border-border bg-ground px-3 py-2 text-xs text-ink font-mono">{run.summary}</pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        {hasMore && (
          <button className={`${BTN} self-center border border-border text-ink-3 hover:text-ink`} onClick={() => loadRuns(runs?.length ?? 0)}>{t.loadMore}</button>
        )}
      </section>
    </div>
  );
}

/* ─── Module ─────────────────────────────────────────────────────────────── */

export default function KnowledgeBase({ lang }: { lang: Lang }) {
  const t = translations[lang].knowledgeBase;
  const [tab, setTab] = useState<SubTab>("review");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api<Overview>("/kb/overview"));
    } catch {
      setOverview(null);  // the counters are a convenience; each tab reports its own errors
    }
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview, refreshKey]);

  const tabs: { id: SubTab; label: string; count: number }[] = [
    { id: "review", label: t.tabReview, count: (overview?.pending_review ?? 0) + (overview?.pending_questions ?? 0) },
    { id: "proposals", label: t.tabProposals, count: overview?.pending_proposals ?? 0 },
    { id: "changelog", label: t.tabChangeLog, count: 0 },
    { id: "library", label: t.tabLibrary, count: 0 },
    { id: "runs", label: t.tabRuns, count: 0 },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-ink">{t.title}</h2>
          <p className="text-xs text-ink-3 mt-0.5">{t.intro}</p>
        </div>
        <button onClick={() => setRefreshKey(k => k + 1)}
          className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink border border-border rounded-lg px-3 py-1.5 bg-surface hover:bg-muted transition-all active:scale-[0.97]">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M10.5 6A4.5 4.5 0 1 1 6 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            <path d="M6 1.5h3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t.refresh}
        </button>
      </div>

      <div className="overflow-x-auto">
        <div className="flex gap-1 bg-ground border border-border rounded-xl p-1 w-fit min-w-max">
          {tabs.map(item => (
            <button key={item.id} onClick={() => setTab(item.id)}
              className={`flex items-center gap-1.5 text-xs px-3 sm:px-4 py-1.5 rounded-lg font-medium transition-colors ${tab === item.id ? "bg-surface text-ink shadow-sm border border-border" : "text-ink-3 hover:text-ink"}`}>
              {item.label}
              {item.count > 0 && (
                <span title={t.pendingCount(String(item.count))} className="min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">{item.count}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div key={`${tab}-${refreshKey}`} className="step-enter overflow-y-auto max-h-[calc(100vh-300px)] pr-1">
        {tab === "review" && (
          <div className="flex flex-col gap-5">
            <ReviewList t={t} lang={lang} excludeKind={PROPOSAL_KIND} onChanged={loadOverview} />
            <RulesPanel t={t} lang={lang} />
          </div>
        )}
        {tab === "proposals" && <ReviewList t={t} lang={lang} kind={PROPOSAL_KIND} hint={t.proposalsHint} onChanged={loadOverview} />}
        {tab === "changelog" && <ChangeLogTab t={t} lang={lang} />}
        {tab === "library" && <LibraryTab t={t} lang={lang} />}
        {tab === "runs" && <RunsTab t={t} lang={lang} />}
      </div>
    </div>
  );
}
