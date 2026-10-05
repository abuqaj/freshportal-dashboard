"use client";

import { useState } from "react";
import { LoaderCircle, Play, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popup } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { addDays, api, isoDay, useAnalysis } from "./shared";
import type { SyncHistory } from "./types";

// The data sync, for admins only, behind an icon in the module header: it
// runs by itself at 05:00 and 20:00 Amsterdam time, so users never need it.

export function SyncDialog({ history, onClose, onStarted }: {
  history: SyncHistory | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { t, fmt } = useAnalysis();
  const today = isoDay(new Date());
  const [from, setFrom] = useState(addDays(today, -1));
  const [starting, setStarting] = useState(false);
  const running = !!history?.running;
  const last = history?.history?.[0] ?? null;
  const stats = history?.stats ?? null;

  async function run() {
    setStarting(true);
    try {
      await fetch(api("/bi-sync/run-range", { start_date: from, end_date: today }), { method: "POST" });
      onStarted();
    } finally {
      setStarting(false);
    }
  }

  return (
    <Popup
      title={t.syncTitle}
      onClose={onClose}
      className="inset-x-4 top-1/2 mx-auto flex max-h-[calc(100vh-2rem)] max-w-lg -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-2xl border-2 border-emerald bg-surface p-6 shadow-[0_16px_48px_rgba(17,26,20,0.35)]"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-ink">{t.syncTitle}</h2>
          <p className="mt-1 text-xs text-ink-3">{t.syncDesc}</p>
        </div>
        <Button variant="ghost" size="icon" className="ml-auto" onClick={onClose} aria-label={t.close}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex items-end gap-3">
        <label className="flex flex-col gap-1 text-[11px] text-ink-3">
          {t.syncFrom}
          <input
            id="analysis-sync-from"
            type="date"
            value={from}
            max={today}
            onChange={e => setFrom(e.target.value)}
            className="h-10 rounded-xl border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-emerald/50"
          />
        </label>
        <Tip content={running ? t.syncRunning : t.runSync}>
          <Button variant="go" size="go-sm" aria-disabled={running || starting} onClick={() => { if (!running && !starting) run(); }} aria-label={t.runSync}>
            {running || starting ? <LoaderCircle className="size-5 animate-spin" /> : <Play className="size-5 translate-x-px" />}
          </Button>
        </Tip>
      </div>

      {stats && (
        <p className="text-xs tabular-nums text-ink-3">
          {fmt.int(stats.stock_entry_dim_count ?? 0)} {t.statStockEntries} · {t.statOnlineToday(fmt.int(stats.offers_online_today ?? 0))} ·{" "}
          {fmt.int(stats.order_lines_count ?? 0)} {t.statOrderLines} · {fmt.int(stats.invoice_customer_count ?? 0)} {t.statInvoiceMaps}
        </p>
      )}

      {last?.error && <p className="whitespace-pre-wrap break-all rounded-xl bg-blush/40 p-3 font-mono text-xs text-brick">{last.error}</p>}

      {!!last?.messages?.length && (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-3 hover:text-ink">{t.lastRunLog(last.mutation_from ?? "?", last.status)}</summary>
          <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-all rounded-xl bg-muted p-3 font-mono text-ink-3">
            {last.messages.map((m, i) => <div key={i}>{m}</div>)}
          </div>
        </details>
      )}
    </Popup>
  );
}
