"use client";

import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  Activity, ArrowLeft, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, Clock, FileText, GitCommitHorizontal, History,
  Inbox, Library, Loader2, MessageCircleQuestion, PackagePlus, RefreshCw, Search, Send, ShieldCheck, Trash2, TriangleAlert, Undo2,
  Wand2, X,
} from "lucide-react";
import { Lang, translations } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { Chip, Code, EmptyState, GoButton, IconButton, InfoTip, ModuleHeader, ModuleTabs, Panel, SubTabs, type ChipTone } from "@/components/ui/kit";
import { cn } from "@/lib/utils";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";
const PAGE_SIZE = 20;
const PROPOSAL_KIND = "wiki-proposal";
// Kinds a don't-ask-again rule never covers; the backend refuses them too (NO_RULE_KINDS).
const NO_RULE_KINDS = ["contradiction", "skill-edit", "new-skill"];
// .claude/skills/ exists only on test_1, so installing a skill is always a
// commit there. Mirrors INSTALL_KINDS, SKILL_BRANCH and HEARTBEAT_FRESH in
// knowledge_base.py: new-skill is Install, skill-edit is Update.
const INSTALL_KINDS = ["new-skill", "skill-edit"];
const SKILL_BRANCH = "test_1";
const HEARTBEAT_FRESH_MS = 90 * 60 * 1000;
// How the laptop words refusing a file edited after the update was written.
const STALE_UPDATE = "has changed since";

type SubTab = "review" | "proposals" | "changelog" | "library" | "runs";
type ReviewView = "pending" | "decided" | "done";
// The statuses each view lists: DECIDED and DONE in knowledge_base.py.
const VIEW_STATUSES: Record<ReviewView, readonly string[]> = {
  pending: ["pending"],
  decided: ["approved", "approved_always", "rejected", "answered"],
  done: ["applied", "closed"],
};
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
  install_state: "available" | "requested" | "installed" | "blocked" | "failed" | null;
  install_target_repo: string | null;
  install_target_path: string | null;
  install_commit: string | null;
  install_message: string | null;
}

// What the laptop's thirty-minute heartbeat last reported for one repository.
interface AgentState {
  repo: string;
  present: boolean;
  branch: string | null;
  clean: boolean;
  seen_at: string | null;
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
  // An installed skill was applied by its commit, not by a run.
  install_commit: string | null;
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

type InstallBlock = "offline" | "absent" | "branch" | "dirty";

/** The four conditions install_block_reason() checks in knowledge_base.py.
 *  The backend refuses a blocked request as well; this only decides whether
 *  the button is pressable and what it says when it is not. */
function installBlockReason(state: AgentState | null): InstallBlock | null {
  const seenAt = state?.seen_at ? new Date(state.seen_at).getTime() : NaN;
  if (!state || Number.isNaN(seenAt) || Date.now() - seenAt > HEARTBEAT_FRESH_MS) return "offline";
  if (!state.present) return "absent";
  if (state.branch !== SKILL_BRANCH) return "branch";
  if (!state.clean) return "dirty";
  return null;
}

function blockText(reason: InstallBlock, state: AgentState | null, t: Strings): string {
  switch (reason) {
    case "absent": return t.installNotFound;
    case "branch": return t.installWrongBranch(state?.branch ?? "—");
    case "dirty":  return t.installDirty;
    default:       return t.installOffline;
  }
}

function kindLabel(kind: string, t: Strings): string {
  return kind === "thread_summary" ? t.kindThread
    : kind === "curated" ? t.kindCurated
    : kind === "inbox" ? t.kindInbox
    : kind === "wiki" ? t.kindWiki
    : t.kindOther;
}

/* ─── Small pieces ───────────────────────────────────────────────────────── */

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-3">
      <Loader2 className="size-4 animate-spin text-emerald" />{label}
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[12.5px] font-semibold text-brick">
      <CircleAlert className="mt-px size-[15px] flex-none" /><span className="break-words">{message}</span>
    </p>
  );
}

/** A status sentence as a chip: the words before " · " on it, all of it in the tooltip. */
function SentenceChip({ tone, icon, text }: { tone: ChipTone; icon?: ComponentType<{ className?: string }>; text: string }) {
  const short = text.split(" · ")[0];
  return <Chip tone={tone} icon={icon} tip={short !== text ? text : undefined}>{short}</Chip>;
}

const BUCKET: Record<ReviewItem["bucket"], { tone: ChipTone; icon: ComponentType<{ className?: string }> }> = {
  signoff: { tone: "warn", icon: TriangleAlert },
  context: { tone: "info", icon: MessageCircleQuestion },
  auto: { tone: "ok", icon: Wand2 },
};

function BucketChip({ bucket, t }: { bucket: ReviewItem["bucket"]; t: Strings }) {
  const label = bucket === "signoff" ? t.bucketSignoff : bucket === "context" ? t.bucketContext : t.bucketAuto;
  return <Chip tone={BUCKET[bucket].tone} icon={BUCKET[bucket].icon}>{label}</Chip>;
}

/** Why it was proposed and what it rests on, behind an ⓘ. */
function WhyTip({ why, evidence, t }: { why: string | null; evidence: string[] | null; t: Strings }) {
  if (!why && !evidence?.length) return null;
  return (
    <InfoTip content={
      <div className="max-w-sm space-y-1.5 text-left">
        {why && <p><b>{t.why}:</b> {why}</p>}
        {!!evidence?.length && (
          <div>
            <b>{t.evidence}:</b>
            <ul className="mt-0.5 space-y-0.5">{evidence.map(path => <li key={path} className="break-all font-mono text-[11px]">{path}</li>)}</ul>
          </div>
        )}
      </div>
    } />
  );
}

/** The file a change goes to. */
function TargetLine({ target, children }: { target: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <FileText className="size-4 flex-none text-ink-3" />
      <span className="min-w-0 truncate font-mono text-ink-2">{target}</span>
      {children}
    </div>
  );
}

function Pre({ children }: { children: ReactNode }) {
  return <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-ground px-3 py-2 font-mono text-xs text-ink">{children}</pre>;
}

function MoreButton({ t, busy, onClick }: { t: Strings; busy?: boolean; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="self-center" disabled={busy} onClick={onClick}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronDown className="size-3.5" />}{t.loadMore}
    </Button>
  );
}

/** A tab's own line: its name, the explanation behind ⓘ. */
function TabNote({ label, hint }: { label: string; hint: string }) {
  return <p className="flex items-center gap-1 text-[13px] font-bold text-ink">{label}<InfoTip content={hint} /></p>;
}

/* ─── Review ─────────────────────────────────────────────────────────────── */

/** An item that installs a skill is decided by Install, not Approve: nothing
 *  installs an approved candidate. The backend refuses the same decisions
 *  (_installable() and decision_refusal() in knowledge_base.py). A skill-edit
 *  naming no repository is for a knowledge-base skill and keeps Approve. */
function isInstallable(item: ReviewItem): boolean {
  return INSTALL_KINDS.includes(item.kind) && !!item.install_state && !!item.install_target_repo;
}

/** Install adds a skill folder; Update carries a change to a skill already
 *  there. The gate, its reasons and the states are the same for both. */
function installWords(kind: string, t: Strings) {
  return kind === "skill-edit"
    ? { press: t.update, done: t.updateDone, blocked: t.updateBlockedLabel, failed: t.updateFailedLabel }
    : { press: t.install, done: t.installDone, blocked: t.installBlockedLabel, failed: t.installFailedLabel };
}

/** Once pressed, and once committed, there is nothing left to decide. */
function isInstallLocked(item: ReviewItem): boolean {
  return item.install_state === "requested" || item.install_state === "installed";
}

/** Install into (or Update in) the repository the item names, with Reject
 *  beside it while the item is still open. Pressing only records the intent;
 *  the laptop collects it within half an hour and makes the commit. */
function InstallPanel({ item, agents, t, onChanged, children }: {
  item: ReviewItem; agents: AgentState[] | null; t: Strings; onChanged: (item: ReviewItem) => void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const repo = item.install_target_repo;
  if (!repo || isInstallLocked(item) || ["rejected", "closed"].includes(item.status)) return null;

  const words = installWords(item.kind, t);
  const state = agents?.find(a => a.repo === repo) ?? null;
  // While the state is still loading, say nothing rather than "offline".
  const reason = agents === null ? null : installBlockReason(state);
  const pressable = agents !== null && reason === null;
  // Someone edited the skill after this update was written. The laptop will
  // refuse every retry the same way (harmless, so Update stays), but only a
  // rewrite against the current file can go in: Reject asks for that.
  const staleUpdate = item.kind === "skill-edit" && item.install_state === "blocked"
    && !!item.install_message?.includes(STALE_UPDATE);

  async function install() {
    setBusy(true);
    setError("");
    try {
      const res = await postJson<{ item: ReviewItem }>(`/kb/review/${encodeURIComponent(item.id)}/install`, {});
      onChanged(res.item);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tip content={reason ? blockText(reason, state, t) : undefined}>
          <span tabIndex={reason ? 0 : undefined} className="outline-none">
            <Button variant="emphasis" disabled={!pressable || busy} onClick={install}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <PackagePlus className="size-4" />}{words.press(repo)}
            </Button>
          </span>
        </Tip>
        {children}
      </div>
      {item.install_state === "blocked" && (
        <p className="text-xs font-semibold text-brick">{words.blocked}{item.install_message ? `: ${item.install_message}` : ""}</p>
      )}
      {staleUpdate && <p className="text-xs text-ink-2">{t.updateStale}</p>}
      {item.install_state === "failed" && (
        <p className="text-xs font-semibold text-brick">{words.failed}{item.install_message ? `: ${item.install_message}` : ""}</p>
      )}
      {reason && <p className="flex items-center gap-1.5 text-xs text-ink-3"><Clock className="size-3.5" />{blockText(reason, state, t)}</p>}
      {error && <ErrorLine message={error} />}
    </div>
  );
}

/** The item's status, or for an install what the laptop is doing with it. */
function StatusChip({ item, t }: { item: ReviewItem; t: Strings }) {
  if (item.install_state === "installed") {
    return (
      <Chip tone="ok" icon={GitCommitHorizontal} tip={item.install_commit ?? undefined}>
        {installWords(item.kind, t).done}{item.install_commit && <span className="font-mono"> {item.install_commit.slice(0, 7)}</span>}
      </Chip>
    );
  }
  if (item.install_state === "requested") return <SentenceChip tone="info" icon={Clock} text={t.installWaiting} />;
  const tone: ChipTone = item.status === "pending" ? "warn" : item.status === "rejected" ? "bad"
    : item.status === "applied" ? "ok" : item.status === "closed" ? "mute" : "info";
  const icon = item.status === "pending" ? Clock : item.status === "rejected" ? X : Check;
  return <SentenceChip tone={tone} icon={icon} text={statusLabel(item.status, t)} />;
}

function ReviewCard({ item, agents, t, lang, onDecided }: {
  item: ReviewItem; agents: AgentState[] | null; t: Strings; lang: Lang; onDecided: (item: ReviewItem) => void;
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
  const installable = isInstallable(item);
  const locked = installable && isInstallLocked(item);
  const changeable = !locked && ["approved", "approved_always", "rejected", "answered"].includes(item.status);
  const rejectButton = <IconButton icon={X} tip={t.reject} danger disabled={busy !== null} onClick={() => decide("reject")} />;

  return (
    <div className="step-enter flex flex-col gap-2.5 rounded-[18px] border border-border bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <BucketChip bucket={item.bucket} t={t} />
        <Chip tone="mute">{item.kind}</Chip>
        <span className="ml-auto text-[11.5px] text-ink-3">{formatWhen(item.created_at, lang)}</span>
      </div>
      <h3 className="text-[14.5px] font-bold leading-snug text-ink">{item.title}</h3>

      {item.target
        ? <TargetLine target={item.target}><WhyTip why={item.why} evidence={item.evidence} t={t} /></TargetLine>
        : (!!item.why || !!item.evidence?.length) && <div className="flex"><WhyTip why={item.why} evidence={item.evidence} t={t} /></div>}
      {item.body && (
        <div>
          <p className="mb-1 text-[11px] font-semibold text-ink-3">{item.bucket === "context" ? t.question : t.proposedChange}</p>
          <Pre>{item.body}</Pre>
        </div>
      )}

      {item.status === "answered" && item.answer && (
        <p className="whitespace-pre-wrap rounded-xl border border-taupe/40 bg-sand/50 px-3 py-2 text-xs text-ink">{item.answer}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-muted pt-2.5">
        <StatusChip item={item} t={t} />
        {item.decided_by && <span className="text-[11.5px] text-ink-3">{t.decidedBy(item.decided_by, formatWhen(item.decided_at, lang))}</span>}

        {/* The decisions, at the end of the line */}
        <span className="ml-auto flex items-center gap-1">
          {!installable && pending && item.bucket === "signoff" && (
            <>
              {rejectButton}
              {item.target && !NO_RULE_KINDS.includes(item.kind) && (
                <IconButton icon={CheckCheck} tip={t.approveAlways} disabled={busy !== null} onClick={() => decide("approve_always")} />
              )}
              <GoButton size="go-sm" icon={Check} tip={t.approve} disabled={busy !== null} onClick={() => decide("approve")} />
            </>
          )}
          {changeable && <IconButton icon={Undo2} tip={t.undo} disabled={busy !== null} onClick={() => decide("undo")} />}
        </span>
      </div>

      {installable && (
        <InstallPanel item={item} agents={agents} t={t} onChanged={onDecided}>
          {pending && rejectButton}
        </InstallPanel>
      )}
      {pending && item.bucket === "context" && (
        <div className="flex items-end gap-2">
          <textarea
            value={answer}
            onChange={e => setAnswer(e.target.value)}
            placeholder={t.answerPlaceholder}
            aria-label={t.answerPlaceholder}
            rows={3}
            className="min-w-0 flex-1 rounded-xl border border-border bg-ground px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-emerald/55 focus:bg-surface focus:ring-4 focus:ring-emerald/12"
          />
          <GoButton size="go-sm" icon={Send} tip={t.sendAnswer} disabled={busy !== null || !answer.trim()} onClick={() => decide("answer")} />
        </div>
      )}
      {error && <ErrorLine message={error} />}
    </div>
  );
}

function ReviewList({ t, lang, kind, excludeKind, hint, onChanged }: {
  t: Strings; lang: Lang; kind?: string; excludeKind?: string; hint?: string; onChanged: () => void;
}) {
  const [view, setView] = useState<ReviewView>("pending");
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [agents, setAgents] = useState<AgentState[] | null>(null);
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
      setItems(prev => (offset === 0 || !prev ? res.items
        : [...prev, ...res.items.filter(item => !prev.some(p => p.id === item.id))]));
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

  // Refresh remounts this list, so a heartbeat that clears a condition makes
  // the button pressable again without reloading the page.
  useEffect(() => {
    api<{ repos: AgentState[] }>("/kb/agent-state")
      .then(res => setAgents(res.repos))
      .catch(() => setAgents([]));  // no state reads as offline, which is the safe default
  }, []);

  // The server pages over the items still in this view. A card decided here
  // stays on screen with its new status but has left the view there, so it
  // is not counted: counting it skipped as many items as had been decided
  // (review 2026-09-25).
  function nextOffset(): number {
    return (items ?? []).filter(item => VIEW_STATUSES[view].includes(item.status)).length;
  }

  function handleDecided(updated: ReviewItem) {
    // Keep the card where it is, so the new status is visible where it was clicked.
    setItems(prev => (prev ?? []).map(item => (item.id === updated.id ? updated : item)));
    onChanged();
  }

  const groups: { bucket: ReviewItem["bucket"] | null; items: ReviewItem[] }[] = !items ? []
    : view === "pending"
      ? [{ bucket: "signoff" as const, items: items.filter(i => i.bucket === "signoff") },
         { bucket: "context" as const, items: items.filter(i => i.bucket === "context") }].filter(g => g.items.length > 0)
      : [{ bucket: null, items }];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SubTabs<ReviewView>
          value={view}
          onChange={setView}
          items={[
            { id: "pending", label: t.viewPending, icon: Clock },
            { id: "decided", label: t.viewDecided, icon: CheckCheck },
            { id: "done", label: t.viewDone, icon: Check },
          ]}
        />
        {hint && <InfoTip content={hint} />}
      </div>
      {error && <ErrorLine message={`${t.loadError} ${error}`} />}
      {items === null ? <Loading label={t.loading} />
        : items.length === 0 ? <EmptyState icon={Inbox} text={t.empty} />
        : groups.map(group => (
          <div key={group.bucket ?? "all"} className="flex flex-col gap-2.5">
            {group.bucket && (
              <p className="flex items-center gap-1.5 text-xs font-bold text-ink-3">
                {(() => { const Ico = BUCKET[group.bucket].icon; return <Ico className="size-3.5" />; })()}
                {group.bucket === "signoff" ? t.bucketSignoff : t.bucketContext}
                <span className="font-semibold tabular-nums text-ink-3/70">· {group.items.length}</span>
              </p>
            )}
            {group.items.map(item => <ReviewCard key={`${item.id}-${item.status}`} item={item} agents={agents} t={t} lang={lang} onDecided={handleDecided} />)}
          </div>
        ))}
      {hasMore && <MoreButton t={t} busy={loading} onClick={() => load(nextOffset())} />}
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
    <Panel title={<>{t.rulesTitle}<InfoTip content={t.rulesHint} /></>} icon={ShieldCheck} className="bg-ground/50">
      {error && <ErrorLine message={error} />}
      {rules === null ? <Loading label={t.loading} />
        : rules.length === 0 ? <p className="text-xs text-ink-3">{t.rulesEmpty}</p>
        : (
          <ul className="flex flex-col gap-1.5">
            {rules.map(rule => (
              <li key={rule.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs">
                <Chip tone="mute">{rule.kind}</Chip>
                <span className="min-w-0 flex-1 break-all font-mono text-ink-2">{rule.target}</span>
                <span className="text-ink-3">{rule.created_by ?? "—"} · {formatWhen(rule.created_at, lang)}</span>
                <IconButton size="sm" icon={Trash2} tip={t.removeRule} danger onClick={() => remove(rule.id)} />
              </li>
            ))}
          </ul>
        )}
    </Panel>
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
    <div className="flex flex-col gap-3">
      <TabNote label={t.tabChangeLog} hint={t.changeLogHint} />
      {error && <ErrorLine message={`${t.loadError} ${error}`} />}
      {entries === null ? <Loading label={t.loading} />
        : entries.length === 0 ? <EmptyState icon={History} text={t.empty} />
        : (
          <ul className="flex flex-col gap-2">
            {entries.map(entry => {
              const open = expanded === entry.id;
              return (
                <li key={entry.id} className="rounded-[18px] border border-border bg-surface">
                  <button className="flex w-full items-start gap-2.5 rounded-[18px] px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald/40" aria-expanded={open}
                    onClick={() => setExpanded(open ? "" : entry.id)}>
                    <ChevronRight className={cn("mt-0.5 size-4 flex-none text-ink-3/60 transition-transform duration-200", open && "rotate-90")} />
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {entry.bucket === "auto"
                          ? <BucketChip bucket="auto" t={t} />
                          : <Chip tone="info" icon={Check}>{t.approvedBy(entry.decided_by ?? "—")}</Chip>}
                        {entry.install_commit
                          ? <Chip tone="ok" icon={GitCommitHorizontal} tip={entry.install_commit}>{installWords(entry.kind, t).done}</Chip>
                          : entry.applied_by_run && <Chip tone="mute" icon={Activity} tip={t.run}>{entry.applied_by_run}</Chip>}
                        <span className="ml-auto text-[11.5px] text-ink-3">{formatWhen(entry.applied_at, lang)}</span>
                      </span>
                      <span className="text-[14px] font-bold text-ink">{entry.title}</span>
                      {entry.target && <TargetLine target={entry.target} />}
                    </span>
                  </button>
                  {open && (
                    <div className="step-enter mx-4 flex flex-col gap-2.5 border-t border-muted py-3 pl-6">
                      {entry.body && (
                        <div>
                          <p className="mb-1 text-[11px] font-semibold text-ink-3">{t.changeMade}</p>
                          <Pre>{entry.body}</Pre>
                        </div>
                      )}
                      {entry.action && <p className="text-xs text-ink"><span className="font-semibold text-ink-3">{t.actionDone}:</span> {entry.action}</p>}
                      {entry.verify && <p className="text-xs text-ink"><span className="font-semibold text-ink-3">{t.howToVerify}:</span> {entry.verify}</p>}
                      {entry.why && <p className="text-xs text-ink"><span className="font-semibold text-ink-3">{t.why}:</span> {entry.why}</p>}
                      {!!entry.evidence?.length && (
                        <div className="text-xs text-ink-3">
                          <span className="font-semibold">{t.evidence}:</span>
                          <ul className="mt-1 flex flex-col gap-0.5">{entry.evidence.map(path => <li key={path} className="break-all font-mono text-ink-2">{path}</li>)}</ul>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      {hasMore && <MoreButton t={t} busy={loading} onClick={() => load(entries?.length ?? 0)} />}
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
        <div className="flex items-start gap-2">
          <IconButton icon={ArrowLeft} tip={t.backToList} onClick={() => setOpen(null)} />
          <div className="min-w-0">
            <h3 className="text-base font-bold text-ink">{open.title ?? open.path}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
              <Chip tone="mute">{kindLabel(open.kind, t)}</Chip>
              {open.topic && <span>{open.topic}</span>}
              {open.source_date && <span>· {open.source_date}</span>}
              <span className="break-all font-mono">· {open.path}</span>
            </div>
          </div>
        </div>
        {open.content
          ? <pre className="whitespace-pre-wrap rounded-xl border border-border bg-ground px-4 py-3 font-mono text-xs text-ink">{open.content}</pre>
          : <EmptyState icon={FileText} text={t.noContent} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-9 min-w-[200px] flex-1 items-center gap-2 rounded-xl border border-border bg-ground px-3 transition-colors focus-within:border-emerald/55 focus-within:bg-surface focus-within:ring-4 focus-within:ring-emerald/12">
          <Search className="size-4 flex-none text-ink-3" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t.searchPlaceholder} aria-label={t.searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3/50" />
        </div>
        <SubTabs<string>
          value={kind}
          onChange={setKind}
          items={[
            { id: "", label: t.kindAll },
            { id: "thread_summary", label: t.kindThread },
            { id: "curated", label: t.kindCurated },
            { id: "inbox", label: t.kindInbox },
            { id: "wiki", label: t.kindWiki },
          ]}
        />
      </div>
      {error && <ErrorLine message={`${t.loadError} ${error}`} />}
      {docs === null ? <Loading label={t.loading} />
        : docs.length === 0 ? <EmptyState icon={Library} text={t.empty} />
        : (
          <ul className="overflow-hidden rounded-[18px] border border-border">
            {docs.map(doc => (
              <li key={doc.path} className="border-b border-muted last:border-0">
                <button onClick={() => openDoc(doc.path)} disabled={opening !== ""}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-ground/60 focus-visible:bg-ground disabled:opacity-60">
                  {opening === doc.path ? <Loader2 className="mt-0.5 size-4 flex-none animate-spin text-emerald" /> : <FileText className="mt-0.5 size-4 flex-none text-ink-3" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-ink">{doc.title ?? doc.path}</span>
                    {doc.snippet && <span className="mt-0.5 line-clamp-2 block text-xs text-ink-3">{doc.snippet}</span>}
                  </span>
                  <span className="flex flex-none flex-col items-end gap-1">
                    <Chip tone="mute">{kindLabel(doc.kind, t)}</Chip>
                    <span className="text-[11px] text-ink-3">{doc.source_date ?? formatWhen(doc.synced_at, lang)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      {hasMore && <MoreButton t={t} busy={loading} onClick={() => load(docs?.length ?? 0)} />}
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
    <div className="flex flex-col gap-3">
      <TabNote label={t.tabRuns} hint={t.runsHint} />
      {error && <ErrorLine message={`${t.loadError} ${error}`} />}
      {runs === null ? <Loading label={t.loading} />
        : runs.length === 0 ? <EmptyState icon={Activity} text={t.empty} />
        : (
          <ul className="overflow-hidden rounded-[18px] border border-border">
            {runs.map(run => {
              const open = expanded === run.id;
              return (
                <li key={run.id} className="border-b border-muted last:border-0">
                  <button className="flex w-full flex-wrap items-center gap-2.5 px-4 py-3 text-left outline-none transition-colors hover:bg-ground/60 focus-visible:bg-ground"
                    aria-expanded={open} onClick={() => setExpanded(open ? "" : run.id)}>
                    <ChevronRight className={cn("size-4 flex-none text-ink-3/60 transition-transform duration-200", open && "rotate-90", !run.summary && "invisible")} />
                    <Code>{run.skill}</Code>
                    <Chip tone={run.status === "ok" ? "ok" : run.status ? "warn" : "mute"} icon={run.status === "ok" ? Check : TriangleAlert}>{run.status ?? "—"}</Chip>
                    <span className="ml-auto text-[11.5px] text-ink-3">{formatWhen(run.started_at, lang)}</span>
                  </button>
                  {open && run.summary && (
                    <div className="step-enter px-4 pb-3 pl-10"><Pre>{run.summary}</Pre></div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      {hasMore && <MoreButton t={t} onClick={() => loadRuns(runs?.length ?? 0)} />}
    </div>
  );
}

/* ─── Module ─────────────────────────────────────────────────────────────── */

export default function KnowledgeBase({ lang }: { lang: Lang }) {
  const all = translations[lang];
  const t = all.knowledgeBase;
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

  const reviewCount = (overview?.pending_review ?? 0) + (overview?.pending_questions ?? 0);
  const proposalCount = overview?.pending_proposals ?? 0;

  return (
    <div>
      <ModuleHeader tab="knowledge" t={all} info={t.intro}
        chips={overview ? <Chip tone="info" icon={Library} tip={t.tabLibrary}>{overview.documents.toLocaleString(lang)}</Chip> : null}
        actions={<IconButton icon={RefreshCw} tip={t.refresh} onClick={() => setRefreshKey(k => k + 1)} />}
      />
      <div className="px-5 pb-3">
        <ModuleTabs<SubTab>
          value={tab}
          onChange={setTab}
          items={[
            { id: "review", icon: Inbox, label: t.tabReview, count: reviewCount, countTip: t.pendingCount(String(reviewCount)) },
            { id: "proposals", icon: FileText, label: t.tabProposals, count: proposalCount, countTip: t.pendingCount(String(proposalCount)) },
            { id: "changelog", icon: History, label: t.tabChangeLog },
            { id: "library", icon: Library, label: t.tabLibrary },
            { id: "runs", icon: Activity, label: t.tabRuns },
          ]}
        />
      </div>

      <div key={`${tab}-${refreshKey}`} className="step-enter max-h-[calc(100vh-300px)] overflow-y-auto border-t border-muted px-5 py-4">
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
