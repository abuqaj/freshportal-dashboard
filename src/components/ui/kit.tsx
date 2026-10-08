"use client";

import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { ArrowRight, Check, Info, Play, TriangleAlert, Upload, X } from "lucide-react";
import type { translations, Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Popup } from "./dialog";
import { Tip } from "./tooltip";
import MascotRunner from "@/components/MascotRunner";
import { MODULES, ModuleIcon, moduleColors, type Tab } from "@/components/shell/modules";

// The pieces every module screen is built from (user, 2026-10-07: the module
// screens should match the rest of the system). They are the ones delivery
// import and the Analysis Tool settled first: a header in the card, steps or
// tabs under it, the round emerald button for a step's action, icons with
// tooltips for the rest, chips in the system palette's roles, the company
// runner while something is written to FreshPortal, and the portal's own
// dialog instead of the browser's confirm().

type T = (typeof translations)[Lang];
type Icon = ComponentType<{ className?: string; strokeWidth?: number }>;

/* ─── Header and sections ─── */

/** The top of a module card: the module's badge in its own gradient, its
 *  name, the explanation behind ⓘ, a few fact chips and icon actions. With
 *  `bare` it brings no padding, for a card that pads itself. */
export function ModuleHeader({ tab, t, info, chips, actions, bare }: {
  tab: Tab;
  t: T;
  info?: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
  bare?: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", !bare && "px-5 py-4")}>
      <span
        style={moduleColors(tab)}
        className="grid size-10 flex-none place-items-center rounded-[13px] bg-[linear-gradient(135deg,var(--g1),var(--g2))] text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.14)] [--ic-bg:var(--g1)]"
      >
        <ModuleIcon id={tab} className="size-[21px]" />
      </span>
      <div className="flex min-w-0 items-center gap-1.5">
        <h2 className="truncate text-[17px] font-bold tracking-tight text-ink">{MODULES[tab].label(t)}</h2>
        {info && <InfoTip content={info} />}
      </div>
      {chips && <div className="flex flex-wrap items-center gap-1.5">{chips}</div>}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
  );
}

/** A band of the card, divided from the one above. */
export function Section({ children, tight, className }: { children: ReactNode; tight?: boolean; className?: string }) {
  return <div className={cn("border-t border-muted px-5", tight ? "py-3" : "py-[18px]", className)}>{children}</div>;
}

/** A box inside a section that holds one thing. */
export function Panel({ title, icon: Ico, actions, children, className }: {
  title?: ReactNode; icon?: Icon; actions?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("rounded-[18px] border border-border bg-surface px-4 py-3.5", className)}>
      {(title || actions) && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          {title && <h4 className="flex items-center gap-1.5 text-[13px] font-bold text-ink">{Ico && <Ico className="size-4 text-ink-3" />}{title}</h4>}
          {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** An ⓘ that carries the sentence a label would otherwise spell out. */
export function InfoTip({ content }: { content: ReactNode }) {
  return (
    <Tip content={content}>
      <span tabIndex={0} aria-label={typeof content === "string" ? content : undefined}
        className="inline-grid size-5 flex-none cursor-help place-items-center rounded-full text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-emerald/40">
        <Info className="size-[15px]" />
      </span>
    </Tip>
  );
}

/* ─── Chips and codes ─── */

// The palette's roles (user, 2026-09-25): sage and emerald for what is sure,
// brick and blush for what is wrong or blocks, sand for what is neutral.
const CHIP_TONE = {
  ok: "border-emerald/20 bg-sage/55 text-emerald-dark",
  bad: "border-brick/30 bg-blush/55 text-brick",
  warn: "border-blush bg-blush/20 text-brick",
  info: "border-taupe/40 bg-sand/70 text-ink",
  mute: "border-border bg-ground text-ink-3",
} as const;
export type ChipTone = keyof typeof CHIP_TONE;

/** One fact in a word or two, the sentence in its tooltip. With `onClick` it
 *  filters what it counts and shows so pressed. */
export function Chip({ tone = "info", icon: Ico, tip, size, onClick, pressed, children }: {
  tone?: ChipTone; icon?: Icon; tip?: ReactNode; size?: "lg"; onClick?: () => void; pressed?: boolean; children?: ReactNode;
}) {
  const cls = cn(
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald/40",
    size === "lg" ? "h-8 px-3 text-[13px] [&_b]:text-[15px]" : "h-[26px] px-2.5 text-xs",
    CHIP_TONE[tone],
  );
  const icon = Ico && <Ico className={size === "lg" ? "size-3.5" : "size-[13px]"} />;
  return (
    <Tip content={tip}>
      {onClick ? (
        <button type="button" onClick={onClick} aria-pressed={pressed}
          className={cn(cls, "cursor-pointer hover:brightness-[0.97]", pressed && "ring-2 ring-current/40")}>
          {icon}{typeof tip === "string" && <span className="sr-only">{tip} </span>}{children}
        </button>
      ) : (
        <span tabIndex={tip ? 0 : undefined} className={cls}>{icon}{children}</span>
      )}
    </Tip>
  );
}

const CODE_TONE = { ok: "bg-sage/55 text-emerald-dark", bad: "bg-blush/55 text-brick", warn: "bg-blush/25 text-brick", mute: "bg-ground text-ink-2" } as const;

/** A code (VBN, product number, GTIN) as a small monospaced label. */
export function Code({ tone = "mute", tip, children }: { tone?: keyof typeof CODE_TONE; tip?: ReactNode; children: ReactNode }) {
  return (
    <Tip content={tip}>
      <span tabIndex={tip ? 0 : undefined} className={cn("inline-flex h-[22px] items-center rounded-[7px] px-[7px] font-mono text-xs font-semibold", CODE_TONE[tone])}>
        {children}
      </span>
    </Tip>
  );
}

/* ─── Buttons ─── */

/** A step's action: the round emerald button with an icon, and how many
 *  things it acts on. It stays hoverable while it cannot act, so its tooltip
 *  can say what it waits for. */
export function GoButton({ icon = "play", tip, count, disabled, onClick, size = "go", type = "button" }: {
  icon?: "play" | "arrow" | Icon;
  tip: string;
  count?: number;
  disabled?: boolean;
  onClick?: () => void;
  size?: "go" | "go-sm";
  type?: "button" | "submit";
}) {
  const Ico = typeof icon === "string" ? null : icon;
  return (
    <Tip content={tip}>
      <Button variant="go" size={size} type={type} aria-label={tip} aria-disabled={disabled}
        onClick={e => { if (disabled) { e.preventDefault(); return; } onClick?.(); }}>
        {icon === "play" ? <Play className="size-5 fill-current" strokeWidth={1.5} />
          : icon === "arrow" ? <ArrowRight className="size-5" strokeWidth={2.4} />
          : Ico && <Ico className="size-5" strokeWidth={2} />}
        {count != null && (
          <span className={cn("absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-surface px-1 text-[11px] font-bold leading-none tabular-nums text-white",
            disabled ? "bg-taupe" : "bg-emerald-dark")}>
            {count}
          </span>
        )}
      </Button>
    </Tip>
  );
}

/** An action as an icon, its name in the tooltip. */
export function IconButton({ icon: Ico, tip, onClick, danger, active, disabled, size = "md", spin }: {
  icon: Icon; tip: string; onClick?: () => void; danger?: boolean; active?: boolean; disabled?: boolean; size?: "sm" | "md"; spin?: boolean;
}) {
  return (
    <Tip content={tip}>
      <button
        type="button"
        aria-label={tip}
        aria-pressed={active}
        aria-disabled={disabled}
        onClick={() => { if (!disabled) onClick?.(); }}
        className={cn(
          "inline-grid flex-none place-items-center text-ink-3 outline-none transition-[background-color,color,scale] focus-visible:ring-2 focus-visible:ring-emerald/40 active:scale-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:active:scale-100",
          size === "sm" ? "size-7 rounded-[9px] [&_svg]:size-4" : "size-[34px] rounded-[11px] [&_svg]:size-[18px]",
          danger ? "hover:bg-blush/40 hover:text-brick" : "hover:bg-ground hover:text-ink",
          active && "bg-emerald-light text-emerald-dark",
        )}
      >
        <Ico className={spin ? "animate-spin" : undefined} />
      </button>
    </Tip>
  );
}

/* ─── Steps and tabs ─── */

/** Where a multi-step module is: done steps ticked, the current one ringed. */
export function Steps({ labels, current }: { labels: string[]; current: number }) {
  return (
    <div className="flex w-full items-center gap-2">
      {labels.map((label, i) => {
        const done = i < current;
        const on = i === current;
        return (
          <div key={i} className={cn("flex items-center gap-2", i > 0 && "min-w-0 flex-1")}>
            {i > 0 && <span className={cn("h-0.5 min-w-4 flex-1 rounded-full transition-colors duration-500", done || on ? "bg-emerald" : "bg-border")} />}
            <span className={cn("flex flex-none items-center gap-2 text-xs font-semibold", on ? "text-emerald-dark" : "text-ink-3")}>
              <span className={cn("grid size-[26px] place-items-center rounded-full text-xs transition-colors",
                done ? "bg-emerald text-white" : on ? "bg-surface text-emerald ring-2 ring-inset ring-emerald" : "bg-surface ring-2 ring-inset ring-border")}>
                {done ? <Check key="done" className="step-dot-pop size-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className="max-sm:hidden">{label}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A module's views, as the Analysis Tool shows them: icon and name, the
 *  open one on white. A count marks views that wait for someone. */
export function ModuleTabs<V extends string>({ items, value, onChange }: {
  items: { id: V; icon: Icon; label: string; count?: number; countTip?: string }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <nav role="tablist" className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-2xl bg-muted p-1 [scrollbar-width:none]">
      {items.map(({ id, icon: Ico, label, count, countTip }) => {
        const on = id === value;
        return (
          <button key={id} type="button" role="tab" aria-selected={on} onClick={() => onChange(id)}
            className={cn("inline-flex h-[34px] flex-none items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald/40",
              on ? "bg-surface text-emerald-dark shadow-[0_1px_3px_rgba(17,26,20,0.12)]" : "text-ink-3 hover:bg-surface/60 hover:text-ink")}>
            <Ico className="size-4" />
            {label}
            {!!count && (
              <Tip content={countTip}>
                <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brick px-1.5 text-[10.5px] font-bold text-white">{count}</span>
              </Tip>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** A small one-of-n switch inside a view. */
export function SubTabs<V extends string>({ items, value, onChange }: {
  items: { id: V; label: string; icon?: Icon }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div role="tablist" className="inline-flex flex-wrap gap-0.5 rounded-xl border border-border bg-ground p-[3px]">
      {items.map(({ id, label, icon: Ico }) => (
        <button key={id} type="button" role="tab" aria-selected={id === value} onClick={() => onChange(id)}
          className={cn("inline-flex h-7 items-center gap-1.5 rounded-[9px] px-2.5 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald/40",
            id === value ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.1)]" : "text-ink-3 hover:text-ink")}>
          {Ico && <Ico className="size-3.5" />}
          {label}
        </button>
      ))}
    </div>
  );
}

/* ─── Waiting, done, empty ─── */

/** While something is written to FreshPortal: the company runner, as delivery
 *  import shows him, and what is happening now. */
export function RunnerWait({ title, status, children }: { title: string; status?: string | null; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <MascotRunner label={title} />
      {status && <p className="shimmer-ink max-w-md text-xs">{status}</p>}
      {children && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  );
}

/** While something is read: a bar for the share done, or one that slides
 *  while nothing is known yet. */
export function ProgressWait({ status, percent, children }: { status?: string | null; percent?: number | null; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="h-2 w-full max-w-[420px] overflow-hidden rounded-full bg-emerald/15">
        {percent != null
          ? <div className="h-full rounded-full bg-emerald transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
          : <div className="h-full w-2/5 rounded-full bg-emerald animate-[progress-slide_1.4s_ease-in-out_infinite]" />}
      </div>
      {status && <p className="shimmer-ink text-[13px]">{status}{percent != null ? ` · ${percent}%` : ""}</p>}
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

const DONE_TONE = { ok: "bg-sage/60 text-emerald-dark", warn: "bg-blush/35 text-brick", bad: "bg-blush/55 text-brick" } as const;

/** The end of a run: what happened in a few words, the numbers as chips, what
 *  to do next. */
export function DoneState({ tone = "ok", icon: Ico, title, sub, chips, children }: {
  tone?: keyof typeof DONE_TONE; icon?: Icon; title: ReactNode; sub?: ReactNode; chips?: ReactNode; children?: ReactNode;
}) {
  const Fallback = tone === "ok" ? Check : tone === "warn" ? TriangleAlert : X;
  const Shown = Ico ?? Fallback;
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <span className={cn("done-icon grid size-16 place-items-center rounded-full", DONE_TONE[tone])}>
        <Shown className="size-[30px]" strokeWidth={2.4} />
      </span>
      <h3 className="text-lg font-bold tracking-tight text-ink">{title}</h3>
      {sub && <div className="max-w-md text-[13px] text-ink-3">{sub}</div>}
      {chips && <div className="flex flex-wrap justify-center gap-2">{chips}</div>}
      {children && <div className="mt-1.5 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

/** Nothing to show: an icon and a short phrase. */
export function EmptyState({ icon: Ico, text, hint }: { icon: Icon; text: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-12 text-center text-sm text-ink-3">
      <Ico className="size-7 text-taupe" />
      <span className="max-w-sm">{text}</span>
      {hint && <span className="max-w-sm text-xs text-ink-3/70">{hint}</span>}
    </div>
  );
}

/** Where files are dropped or picked; the formats it takes as chips. */
export function DropZone({ title, exts, accept, multiple, onFiles, disabled, children }: {
  title: string; exts: string[]; accept: string; multiple?: boolean; onFiles: (files: FileList) => void; disabled?: boolean; children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && !disabled) { e.preventDefault(); input.current?.click(); } }}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); if (!disabled && e.dataTransfer.files.length) onFiles(e.dataTransfer.files); }}
      className={cn("group flex cursor-pointer flex-col items-center gap-3 rounded-[20px] border-2 border-dashed px-5 py-10 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald/40",
        over ? "border-emerald bg-emerald-light/70" : "border-emerald/30 bg-emerald-light/30 hover:border-emerald/60 hover:bg-emerald-light/50",
        disabled && "cursor-wait opacity-60")}
    >
      <input ref={input} type="file" accept={accept} multiple={multiple} className="hidden"
        onChange={e => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ""; }} />
      <span className="grid size-[52px] place-items-center rounded-2xl bg-surface text-emerald shadow-[0_0_0_1px_var(--color-border)] transition-transform group-hover:-translate-y-0.5">
        <Upload className="size-6" />
      </span>
      <p className="text-sm font-semibold text-ink">{title}</p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {exts.map(x => <span key={x} className="rounded-[7px] border border-border bg-surface px-[7px] py-0.5 font-mono text-[11px] text-ink-3">{x}</span>)}
      </div>
      {children}
    </div>
  );
}

/* ─── Confirmation ─── */

/** The portal's own yes/no, in place of the browser's confirm(): a short
 *  question, one line on what follows, and the two answers. */
export function ConfirmDialog({ icon: Ico = TriangleAlert, title, text, confirmLabel, cancelLabel, danger = true, busy, onConfirm, onClose }: {
  icon?: Icon; title: string; text?: ReactNode; confirmLabel: string; cancelLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Popup title={title} onClose={onClose}
      className="left-1/2 top-1/2 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-[22px] bg-surface p-6 shadow-2xl">
      <div className="flex items-start gap-4">
        <span className={cn("grid size-10 flex-none place-items-center rounded-full", danger ? "bg-blush/45 text-brick" : "bg-sage/60 text-emerald-dark")}>
          <Ico className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">{title}</p>
          {text && <div className="mt-1 text-sm text-ink-3">{text}</div>}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}><X className="size-4" />{cancelLabel}</Button>
        <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}
          className={danger ? "border-brick bg-brick text-white hover:bg-[#8B2016] hover:text-white" : undefined}>
          <Ico className="size-4" />{confirmLabel}
        </Button>
      </div>
    </Popup>
  );
}
