"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { flushSync, createPortal } from "react-dom";
import {
  CalendarClock, Check, ChevronRight, CircleAlert, Clock, EyeOff, List, Loader2, Play, RotateCcw, Search, TriangleAlert, Undo2, X, Zap,
} from "lucide-react";
import { translations, Lang } from "@/lib/i18n";
import { VbnResult, Stats, AutoVbnRun } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import {
  Chip, Code, ConfirmDialog, DoneState, GoButton, IconButton, InfoTip, ModuleHeader, Panel, ProgressWait, RunnerWait, Section, Steps,
} from "@/components/ui/kit";
import { preloadMascot } from "@/components/MascotRunner";
import { cn } from "@/lib/utils";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface Props {
  lang: Lang;
  onAutoVbnChange?: (enabled: boolean, nextRun: string | null) => void;
  initialAutoEnabled?: boolean | null;
  initialAutoNextRun?: string | null;
}

/** Which lines of the result the error table shows; the stat chips set it. */
type Filter = "all" | "ERROR" | "WARNING";

export default function VbnChecker({ lang, onAutoVbnChange, initialAutoEnabled, initialAutoNextRun }: Props) {
  const t = translations[lang];
  preloadMascot();

  const [vbnInput, setVbnInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [checkProgress, setCheckProgress] = useState<number | null>(null);
  const [results, setResults] = useState<VbnResult[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixMessage, setFixMessage] = useState<string | null>(null);
  const [vbnNameCache, setVbnNameCache] = useState<Record<string, string>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const abortRef = useRef<AbortController | null>(null);
  const checkCancelRef = useRef<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ product_id: string; items: { id: string; name: string }[] } | null>(null);
  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number } | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [showOk, setShowOk] = useState(false);

  // Auto VBN — initialise from parent's already-fetched value to avoid the loading flash
  const [vbnAutoEnabled, setVbnAutoEnabled] = useState(initialAutoEnabled ?? false);
  const [vbnAutoLastRun, setVbnAutoLastRun] = useState<AutoVbnRun | null>(null);
  const [vbnAutoNextRun, setVbnAutoNextRun] = useState<string | null>(initialAutoNextRun ?? null);
  const [vbnAutoTogglingLoading, setVbnAutoTogglingLoading] = useState(false);
  const [vbnAutoRunNowLoading, setVbnAutoRunNowLoading] = useState(false);
  // true once the fresh fetch from Railway has resolved; false while pending
  const [autoStatusLoaded, setAutoStatusLoaded] = useState(initialAutoEnabled != null);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);

  // Fix result — persists until user explicitly resets (replaces auto-clearing fixSuccess)
  const [fixResult, setFixResult] = useState<{ fixed: number; failed: number; message: string } | null>(null);

  const localeStr = lang === "en" ? "en-GB" : lang === "nl" ? "nl-NL" : lang === "es" ? "es-ES" : "pl-PL";
  const when = (iso: string) => new Date(iso).toLocaleString(localeStr, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  const loadVbnAutoStatus = useCallback(async () => {
    if (!RAILWAY) return;
    try {
      const res = await fetch(`${RAILWAY}/vbn-auto/status`);
      const data = await res.json();
      setVbnAutoEnabled(data.enabled ?? false);
      setVbnAutoLastRun(data.lastRun ?? null);
      setVbnAutoNextRun(data.nextRun ?? null);
      onAutoVbnChange?.(data.enabled ?? false, data.nextRun ?? null);
    } catch { /* ignore */ }
    finally { setAutoStatusLoaded(true); }
  }, [onAutoVbnChange]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadVbnAutoStatus(); }, []);

  const toggleVbnAuto = useCallback(async (enabled: boolean) => {
    if (!RAILWAY) return;
    setVbnAutoTogglingLoading(true);
    try {
      await fetch(`${RAILWAY}/vbn-auto/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await loadVbnAutoStatus();
    } catch { /* ignore */ }
    setVbnAutoTogglingLoading(false);
  }, [loadVbnAutoStatus]);

  const runVbnAutoNow = useCallback(async () => {
    if (!RAILWAY) return;
    setVbnAutoRunNowLoading(true);
    try {
      await fetch(`${RAILWAY}/vbn-auto/run-now`, { method: "POST" });
      await new Promise((r) => setTimeout(r, 3000));
      await loadVbnAutoStatus();
    } catch { /* ignore */ }
    setVbnAutoRunNowLoading(false);
  }, [loadVbnAutoStatus]);

  const step = fixing ? "fixing"
    : fixResult !== null ? "done"
    : results !== null ? "results"
    : loading ? "loading"
    : "search";

  function resetAll() {
    setResults(null); setStats(null); setVbnInput(""); setVbnNameCache({});
    setFixResult(null); setFixMessage(null); setCheckError(null);
    setStatusMessage(null); setCheckProgress(null); setFilter("all"); setShowOk(false);
  }

  function resetToSearch() {
    setResults(null); setStats(null); setFixResult(null);
    setFixMessage(null); setCheckError(null); setCheckProgress(null); setFilter("all"); setShowOk(false);
  }

  const errorResults = results?.filter((r) => !r.excluded && r.status !== "OK") ?? [];
  const toFixRows = results?.filter((r) => r.status !== "OK") ?? [];
  const shownRows = toFixRows.filter((r) => filter === "all" || r.status === filter);
  const willUpdate = errorResults.filter((r) => r.edited_vbn?.trim()).length;

  function cancelOp() {
    abortRef.current?.abort();
    abortRef.current = null;
    const token = checkCancelRef.current;
    checkCancelRef.current = null;
    if (token && RAILWAY) {
      fetch(`${RAILWAY}/cancel/${token}`, { method: "POST" }).catch(() => {});
    }
  }

  async function handleCheck() {
    if (!vbnInput.trim()) return;
    if (!RAILWAY) {
      setCheckError("NEXT_PUBLIC_RAILWAY_API_URL not configured — redeploy Vercel after adding the env var.");
      return;
    }
    cancelOp();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    flushSync(() => {
      setLoading(true);
      setCheckError(null);
      setResults(null);
      setStats(null);
      setFixMessage(null);
      setStatusMessage(t.common.connecting);
    });

    try {
      const cancelToken = crypto.randomUUID();
      checkCancelRef.current = cancelToken;
      const res = await fetch(`${RAILWAY}/vbn-check/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vbn: vbnInput.trim(), lang, cancel_token: cancelToken }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === "status") {
            const msg = event.message as string;
            const prog = typeof event.progress === "number" ? event.progress : null;
            flushSync(() => {
              setStatusMessage(msg);
              setCheckProgress(prog);
            });
          } else if (event.type === "result") {
            const data = event.data as { results: VbnResult[]; stats: Stats };
            const withEdits = data.results.map((r) => ({ ...r, edited_vbn: r.proposed_vbn, excluded: false }));
            setResults(withEdits);
            setStats(data.stats);
            const seedCache: Record<string, string> = {};
            data.results.forEach((r) => {
              if (r.proposed_vbn && r.proposed_vbn_name) seedCache[r.proposed_vbn] = r.proposed_vbn_name;
              if (r.current_vbn && r.official_name) seedCache[r.current_vbn] = r.official_name;
            });
            setVbnNameCache(seedCache);
            fetch("/api/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "vbn_check", vbn_filter: vbnInput.trim(), stats: data.stats, details: { result_count: data.results.length } }),
            }).catch(() => {});
          } else if (event.type === "error") {
            throw new Error(event.message as string);
          }
        }
      }
    } catch (e: unknown) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        setCheckError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
      setStatusMessage(null);
      setCheckProgress(null);
    }
  }

  function updateVbn(product_id: string, val: string) {
    setResults((prev) => prev ? prev.map((r) => (r.product_id === product_id ? { ...r, edited_vbn: val } : r)) : prev);
    const trimmed = val.trim();
    if (!trimmed || !RAILWAY) { setSuggestions(null); return; }
    if (debounceTimers.current[product_id]) clearTimeout(debounceTimers.current[product_id]);

    if (/^\d+$/.test(trimmed)) {
      setSuggestions(null);
      setVbnNameCache((prev) => ({ ...prev, [trimmed]: prev[trimmed] && prev[trimmed] !== "…" ? prev[trimmed] : "…" }));
      debounceTimers.current[product_id] = setTimeout(async () => {
        try {
          const res = await fetch(`${RAILWAY}/vbn-name/${trimmed}`);
          const data = await res.json();
          setVbnNameCache((prev) => ({ ...prev, [trimmed]: data.found ? (data.name ?? "") : t.vbn.unknownCode }));
        } catch {
          setVbnNameCache((prev) => ({ ...prev, [trimmed]: "" }));
        }
      }, 600);
    } else {
      debounceTimers.current[product_id] = setTimeout(async () => {
        const el = inputRefs.current[product_id];
        if (el) {
          const rect = el.getBoundingClientRect();
          setDropdownAnchor({ top: rect.bottom + 4, left: rect.left });
        }
        try {
          const res = await fetch(`${RAILWAY}/vbn-search?q=${encodeURIComponent(trimmed)}&limit=15`);
          const data = await res.json();
          setSuggestions({ product_id, items: data.results ?? [] });
        } catch {
          setSuggestions(null);
        }
      }, 500);
    }
  }

  function applySuggestion(product_id: string, id: string, name: string) {
    setResults((prev) => prev ? prev.map((r) => (r.product_id === product_id ? { ...r, edited_vbn: id } : r)) : prev);
    setVbnNameCache((prev) => ({ ...prev, [id]: name }));
    setSuggestions(null);
  }

  function toggleExclude(product_id: string) {
    setResults((prev) => prev ? prev.map((r) => (r.product_id === product_id ? { ...r, excluded: !r.excluded } : r)) : prev);
  }

  async function handleFix() {
    if (!results) return;
    const toFix = results
      .filter((r) => !r.excluded && r.status !== "OK" && r.edited_vbn?.trim())
      .map((r) => ({ product_id: r.product_id, new_vbn: r.edited_vbn!.trim(), old_vbn: r.current_vbn, name: r.name }));

    if (toFix.length === 0) { setFixMessage(t.vbn.nothingToFix); return; }

    cancelOp();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    flushSync(() => { setFixing(true); setFixMessage(null); });
    try {
      const fixPayload = toFix.map(({ product_id, new_vbn }) => ({ product_id, new_vbn }));
      const res = await fetch(`${RAILWAY}/vbn-fix/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixes: fixPayload, lang }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (event.type === "status") {
            flushSync(() => setFixMessage(event.message as string));
          } else if (event.type === "result") {
            const data = event.data as { fixed: number; failed: number };
            setResults(null); setStats(null); setVbnInput(""); setVbnNameCache({});
            setFixResult({ fixed: data.fixed, failed: data.failed, message: t.vbn.fixedMsg(data.fixed, data.failed) });
            fetch("/api/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "vbn_fix", vbn_filter: null, stats: { fixed: data.fixed, failed: data.failed }, details: { fixes: toFix } }),
            }).catch(() => {});
          } else if (event.type === "error") {
            throw new Error(event.message as string);
          }
        }
      }
    } catch (e: unknown) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        setFixMessage(`${t.common.error}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setFixing(false);
    }
  }

  // The schedule as one row of facts: when it last ran and with what, when it
  // runs next, and the two controls. The words live in the tooltips.
  const autoRow = (
    <Panel className="flex flex-wrap items-center gap-2.5">
      <span className="grid size-[34px] flex-none place-items-center rounded-[11px] bg-sage text-emerald-dark"><Zap className="size-[18px]" /></span>
      <div className="flex items-center gap-1.5">
        <b className="text-[13.5px] text-ink">{t.vbn.autoCheckTitle}</b>
        <InfoTip content={t.vbn.autoCheckDesc} />
      </div>
      {!autoStatusLoaded ? (
        <Loader2 className="size-4 animate-spin text-ink-3" />
      ) : vbnAutoLastRun ? (
        <>
          <Chip tone="info" icon={Clock} tip={t.vbn.autoCheckLastRun}>{when(vbnAutoLastRun.started_at)}</Chip>
          {vbnAutoLastRun.checked_count != null && (
            <>
              <Chip tone="mute" icon={Search} tip={t.vbn.autoCheckChecked}>{vbnAutoLastRun.checked_count.toLocaleString(localeStr)}</Chip>
              <Chip tone="ok" icon={Check} tip={t.vbn.autoCheckFixed}>{vbnAutoLastRun.fixed_count ?? 0}</Chip>
            </>
          )}
        </>
      ) : (
        <Chip tone="mute" icon={Clock}>{t.vbn.autoCheckNeverRun}</Chip>
      )}
      {vbnAutoEnabled && vbnAutoNextRun && (
        <Chip tone="ok" icon={CalendarClock} tip={t.vbn.autoCheckNextRun}>{when(vbnAutoNextRun)}</Chip>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <IconButton icon={vbnAutoRunNowLoading ? Loader2 : Play} spin={vbnAutoRunNowLoading}
          tip={vbnAutoRunNowLoading ? t.vbn.autoCheckRunning : t.vbn.autoCheckRunNow}
          disabled={vbnAutoRunNowLoading} onClick={runVbnAutoNow} />
        <Tip content={t.vbn.autoCheckTitle}>
          <button
            type="button"
            role="switch"
            aria-checked={vbnAutoEnabled}
            aria-label={t.vbn.autoCheckTitle}
            onClick={() => { if (vbnAutoEnabled) { setShowDisableConfirm(true); } else { toggleVbnAuto(true); } }}
            disabled={vbnAutoTogglingLoading || !autoStatusLoaded}
            className={cn("relative inline-flex h-6 w-[42px] flex-shrink-0 items-center rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-emerald/40 disabled:opacity-40",
              vbnAutoEnabled ? "bg-emerald" : "bg-border")}
          >
            <span className={cn("inline-block size-[18px] rounded-full bg-white shadow transition-transform duration-300 ease-[cubic-bezier(.34,1.36,.64,1)]",
              vbnAutoEnabled ? "translate-x-[21px]" : "translate-x-[3px]")} />
          </button>
        </Tip>
      </div>
    </Panel>
  );

  // The proposed code's name under its field: found, unknown, or still looking.
  const proposedName = (r: VbnResult) => {
    const code = r.edited_vbn?.trim() ?? "";
    if (!code || !/^\d+$/.test(code)) return null;
    const name = vbnNameCache[code];
    if (name === undefined) return null;
    if (name === "…") return <span className="text-ink-3/60">…</span>;
    if (name.startsWith("⚠")) return <span className="flex items-center gap-1 text-brick"><CircleAlert className="size-3" />{name.replace(/^⚠\s*/, "")}</span>;
    return name ? <span className="flex items-center gap-1 text-ink-3"><Check className="size-3 text-emerald" strokeWidth={2.6} />{name}</span> : null;
  };

  return (
    <div>
      {showDisableConfirm && (
        <ConfirmDialog
          icon={Zap}
          title={t.vbn.autoCheckDisableTitle}
          text={t.vbn.autoCheckDisableDesc}
          confirmLabel={t.vbn.autoCheckDisableConfirm}
          cancelLabel={t.common.cancel}
          onClose={() => setShowDisableConfirm(false)}
          onConfirm={() => { setShowDisableConfirm(false); toggleVbnAuto(false); }}
        />
      )}

      {/* VBN autocomplete dropdown portal */}
      {suggestions && dropdownAnchor && typeof document !== "undefined" && createPortal(
        <div style={{ position: "fixed", top: dropdownAnchor.top, left: dropdownAnchor.left, width: 320, zIndex: 9999 }}
          className="max-h-64 overflow-hidden overflow-y-auto rounded-xl border border-border bg-surface shadow-xl">
          {suggestions.items.length === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-3">{t.vbn.noFloricode}</p>
          ) : suggestions.items.map((s) => (
            <button key={s.id} onMouseDown={() => applySuggestion(suggestions.product_id, s.id, s.name)}
              className="flex w-full items-center gap-3 border-b border-muted px-4 py-2.5 text-left text-xs transition-colors last:border-0 hover:bg-emerald-light">
              <span className="w-12 shrink-0 font-mono font-semibold text-emerald">{s.id}</span>
              <span className="leading-snug text-ink">{s.name}</span>
            </button>
          ))}
        </div>,
        document.body
      )}

      <ModuleHeader
        tab="vbn"
        t={t}
        info={t.vbn.description}
        chips={step !== "search" && step !== "done" && vbnInput.trim() ? <Chip tone="info" icon={Search} tip={t.vbn.resultsFor}>{vbnInput.trim()}</Chip> : null}
        actions={step === "results" ? <IconButton icon={RotateCcw} tip={t.vbn.backToSearch.replace(/^←\s*/, "")} onClick={resetToSearch} /> : null}
      />
      <Section tight>
        <Steps
          labels={[t.vbn.stepSearch, t.vbn.stepCheck, t.vbn.stepFix]}
          current={step === "search" ? 0 : step === "loading" || step === "results" ? 1 : step === "fixing" ? 2 : 3}
        />
      </Section>

      {/* "backwards", not "both": a kept transform would frame the module's fixed popups. */}
      <div key={step} className="step-enter">

        {/* ── Search ── */}
        {step === "search" && (
          <Section className="flex flex-col gap-4">
            <div>
              <label htmlFor="vbn-codes" className="mb-1.5 block text-xs font-semibold text-ink-3">{t.vbn.codesLabel}</label>
              <div className="flex items-center gap-2.5">
                <div className="flex h-11 max-w-[420px] flex-1 items-center gap-2.5 rounded-[13px] border border-border bg-ground px-3 transition-colors focus-within:border-emerald/55 focus-within:bg-surface focus-within:ring-4 focus-within:ring-emerald/12">
                  <Search className="size-[17px] flex-none text-ink-3" />
                  <input
                    id="vbn-codes"
                    type="text"
                    value={vbnInput}
                    onChange={(e) => setVbnInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCheck()}
                    placeholder={t.vbn.placeholder}
                    className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3/50"
                    autoFocus
                  />
                </div>
                <GoButton icon="arrow" tip={t.vbn.checkBtn} disabled={loading || !vbnInput.trim()} onClick={handleCheck} />
              </div>
              {checkError && (
                <p role="alert" className="mt-2.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-brick">
                  <CircleAlert className="size-[15px] flex-none" />{checkError}
                </p>
              )}
            </div>
            {autoRow}
          </Section>
        )}

        {/* ── Checking ── */}
        {step === "loading" && (
          <Section>
            <ProgressWait status={statusMessage ?? t.common.connecting} percent={checkProgress}>
              <Button variant="outline" size="sm" onClick={cancelOp}><X className="size-3.5" />{t.common.cancel}</Button>
            </ProgressWait>
          </Section>
        )}

        {/* ── Results ── */}
        {step === "results" && results !== null && (
          <Section className="flex flex-col gap-3.5">
            {stats && (
              <div className="flex flex-wrap gap-2">
                <Chip tone="info" size="lg" icon={List} tip={t.vbn.statTotal}><b>{stats.total}</b></Chip>
                <Chip tone="bad" size="lg" icon={CircleAlert} tip={t.vbn.statErrors} pressed={filter === "ERROR"}
                  onClick={() => setFilter(f => (f === "ERROR" ? "all" : "ERROR"))}><b>{stats.errors}</b></Chip>
                <Chip tone="warn" size="lg" icon={TriangleAlert} tip={t.vbn.statWarnings} pressed={filter === "WARNING"}
                  onClick={() => setFilter(f => (f === "WARNING" ? "all" : "WARNING"))}><b>{stats.warnings}</b></Chip>
                <Chip tone="ok" size="lg" icon={Check} tip={t.vbn.okExpand(stats.ok)} pressed={showOk}
                  onClick={() => setShowOk(v => !v)}><b>{stats.ok}</b></Chip>
              </div>
            )}

            <div className="overflow-hidden rounded-2xl border border-border">
              {toFixRows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
                  <span className="done-icon grid size-12 place-items-center rounded-full bg-sage/60 text-emerald-dark"><Check className="size-6" strokeWidth={2.4} /></span>
                  <p className="text-sm font-semibold text-emerald-dark">{t.vbn.allOk.replace(/^✓\s*/, "")}</p>
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-border text-left text-[11px] font-semibold text-ink-3">
                          <th className="px-3 py-2.5 pl-4">{t.vbn.tableProduct}</th>
                          <th className="px-3 py-2.5">{t.vbn.tableCurrent}</th>
                          <th className="px-3 py-2.5">{t.vbn.tableReason}</th>
                          <th className="px-3 py-2.5">{t.vbn.tableProposed}</th>
                          <th className="px-3 py-2.5"><span className="sr-only">{t.vbn.tableAction}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownRows.map((r) => (
                          <tr key={r.product_id}
                            className={cn("border-b border-muted transition-colors last:border-0 hover:bg-ground/40",
                              r.excluded && "opacity-40",
                              r.status === "ERROR" ? "[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-brick)]" : "[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-blush)]")}>
                            <td className="px-3 py-2.5 pl-4">
                              <p className="font-semibold leading-snug text-ink">{r.name}</p>
                              {r.short_name && <p className="mt-0.5 text-[11.5px] text-ink-3">{r.short_name}</p>}
                            </td>
                            <td className="px-3 py-2.5">
                              <Code tone={r.status === "ERROR" ? "bad" : "warn"} tip={r.official_name || undefined}>{r.current_vbn}</Code>
                            </td>
                            <td className="max-w-xs px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">{r.reason || "—"}</td>
                            <td className="min-w-[170px] px-3 py-2.5">
                              <input
                                ref={(el) => { inputRefs.current[r.product_id] = el; }}
                                type="text"
                                value={r.edited_vbn ?? ""}
                                onChange={(e) => updateVbn(r.product_id, e.target.value)}
                                onBlur={() => setTimeout(() => setSuggestions(null), 150)}
                                disabled={r.excluded}
                                placeholder={t.vbn.editPlaceholder}
                                aria-label={t.vbn.tableProposed}
                                className="h-8 w-36 rounded-[9px] border border-border bg-surface px-2.5 font-mono text-xs outline-none transition-colors focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 disabled:bg-muted"
                              />
                              <div className="mt-1 text-[11px] leading-snug">{proposedName(r)}</div>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <IconButton size="sm" icon={r.excluded ? Undo2 : EyeOff} tip={r.excluded ? t.vbn.restore : t.vbn.skip}
                                onClick={() => toggleExclude(r.product_id)} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 border-t border-border bg-ground px-4 py-3">
                    {fixMessage && <Chip tone="warn" icon={TriangleAlert}>{fixMessage}</Chip>}
                    <span className="ml-auto" />
                    <GoButton icon="play" tip={`${t.vbn.fixBtn} · ${willUpdate} ${t.vbn.willBeUpdated}`} count={willUpdate}
                      disabled={fixing || willUpdate === 0} onClick={handleFix} />
                  </div>
                </>
              )}
            </div>

            {/* The products that are right, folded until their chip opens them */}
            {stats && stats.ok > 0 && showOk && (
              <div className="step-enter overflow-hidden rounded-2xl border border-border">
                <button type="button" onClick={() => setShowOk(false)}
                  className="flex w-full items-center gap-2 border-b border-border bg-ground/60 px-4 py-2.5 text-left text-[13px] text-ink-3 hover:text-ink">
                  <ChevronRight className="size-4 rotate-90 transition-transform" />
                  <Chip tone="ok" icon={Check}>{stats.ok}</Chip>
                </button>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] font-semibold text-ink-3">
                      <th className="px-4 py-2">{t.vbn.okName}</th>
                      <th className="px-3 py-2">{t.vbn.okVbn}</th>
                      <th className="px-3 py-2">{t.vbn.okOfficial}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.filter((r) => r.status === "OK").map((r) => (
                      <tr key={r.product_id} className="border-b border-muted last:border-0 hover:bg-ground/40">
                        <td className="px-4 py-2 text-ink">{r.name}</td>
                        <td className="px-3 py-2"><Code tone="ok">{r.current_vbn}</Code></td>
                        <td className="px-3 py-2 text-ink-3">{r.official_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        {/* ── Fixing ── */}
        {step === "fixing" && (
          <Section>
            <RunnerWait title={t.vbn.fixingTitle} status={fixMessage}>
              <Button variant="outline" size="sm" onClick={cancelOp}><X className="size-3.5" />{t.common.cancel}</Button>
            </RunnerWait>
          </Section>
        )}

        {/* ── Done ── */}
        {step === "done" && fixResult && (
          <Section>
            <DoneState
              tone={fixResult.failed === 0 ? "ok" : "warn"}
              title={t.vbn.doneTitle}
              sub={fixResult.message.replace(/^✓\s*/, "")}
              chips={<>
                <Chip tone="ok" size="lg" icon={Check}><b>{fixResult.fixed}</b></Chip>
                {fixResult.failed > 0 && <Chip tone="bad" size="lg" icon={X} tip={t.vbn.doneFailed(fixResult.failed)}><b>{fixResult.failed}</b></Chip>}
              </>}
            >
              <Button variant="outline" onClick={resetAll}><RotateCcw className="size-4" />{t.vbn.checkAgain}</Button>
            </DoneState>
          </Section>
        )}

      </div>
    </div>
  );
}
