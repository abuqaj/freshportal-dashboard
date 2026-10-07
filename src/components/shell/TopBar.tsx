"use client";

import { useState, type ReactNode } from "react";
import { signOut } from "next-auth/react";
import { Activity, Check, ChevronDown, Database, Globe, LayoutGrid, LogOut, RefreshCw, Search, Zap } from "lucide-react";
import { LANGUAGES, type Lang, type translations } from "@/lib/i18n";
import type { SyncStatus } from "@/lib/types";
import type { FPSystem } from "@/lib/systems";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import Wordmark from "./Wordmark";
import RollingNumber from "./RollingNumber";

type T = (typeof translations)[Lang];

export const LOCALES: Record<Lang, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

const ICON_BUTTON = "grid size-9 flex-none place-items-center rounded-xl text-ink-2 transition-[background-color,color,scale] hover:bg-ground hover:text-ink active:scale-90 [&_svg]:size-[18px]";
const MENU_ROW = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink transition-colors hover:bg-ground [&>svg]:size-4 [&>svg]:flex-none";
const MENU_HEAD = "px-2.5 pb-1.5 pt-2 text-[11px] font-bold uppercase tracking-[0.06em] text-ink-3";

/**
 * The bar over every screen once signed in. Everything is an icon with its
 * meaning in a tooltip (user, 2026-09-30): the logo goes to the hub, the
 * system's flag opens the system switch, the module strip sits in the middle
 * (`strip`, absent on the system choice), and on the right the status, the
 * search, the language and the user's menu.
 */
export default function TopBar({
  t, lang, setLang, systems, system, showSystem, strip, onHome, onPickSystem, onAllSystems, onSearch,
  syncStatus, railwayOnline, autoEnabled, autoNextRun, username, isAdmin,
}: {
  t: T;
  lang: Lang;
  setLang: (l: Lang) => void;
  systems: FPSystem[];
  system: FPSystem;
  showSystem: boolean;
  strip: ReactNode;
  onHome: () => void;
  onPickSystem: (s: FPSystem) => void;
  onAllSystems: () => void;
  onSearch: () => void;
  syncStatus: SyncStatus | null;
  railwayOnline: boolean | null;
  autoEnabled: boolean | null;
  autoNextRun: string | null;
  username?: string;
  isAdmin: boolean;
}) {
  return (
    <header
      className="relative z-20 flex h-14 flex-none items-center gap-2.5 border-b border-border bg-surface px-3 max-sm:gap-1 max-sm:px-2"
      style={{ viewTransitionName: "navbar" }}
    >
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-1">
        <Tip content={t.hub.back}>
          <button type="button" onClick={onHome} aria-label={t.hub.back}
            className="hidden h-9 flex-none items-center rounded-xl px-2 text-ink transition-colors hover:bg-ground sm:flex">
            <Wordmark vtName="brand" className="h-auto w-[100px] md:w-[132px]" />
          </button>
        </Tip>
        {showSystem && <SystemSwitch t={t} systems={systems} system={system} onPick={onPickSystem} onAll={onAllSystems} />}
      </div>

      {strip && <div className="hidden flex-none md:block">{strip}</div>}

      <div className="flex min-w-0 flex-1 basis-0 items-center justify-end gap-1">
        <StatusMenu t={t} lang={lang} syncStatus={syncStatus} railwayOnline={railwayOnline} autoEnabled={autoEnabled} autoNextRun={autoNextRun} />
        <Tip content={`${t.shell.search} · Ctrl K`}>
          <button type="button" onClick={onSearch} aria-label={t.shell.search} className={ICON_BUTTON}><Search /></button>
        </Tip>
        <LanguageMenu t={t} lang={lang} setLang={setLang} />
        {username && <ProfileMenu t={t} username={username} isAdmin={isAdmin} />}
      </div>
    </header>
  );
}

/** A system's flag or logo in a small circle. */
export function ArtDot({ system, className }: { system: FPSystem; className?: string }) {
  return (
    <span className={cn("relative size-6 flex-none overflow-hidden rounded-full bg-white ring-1 ring-border", className)}>
      <img src={system.svgPath} alt="" decoding="async" draggable={false}
        className={cn("absolute inset-0 size-full", system.art === "logo" ? "object-contain p-[3px]" : "object-cover")} />
    </span>
  );
}

function SystemSwitch({ t, systems, system, onPick, onAll }: {
  t: T; systems: FPSystem[]; system: FPSystem; onPick: (s: FPSystem) => void; onAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const face = (
    <>
      <ArtDot system={system} />
      <span className="truncate max-sm:max-w-[120px]">{system.name}</span>
    </>
  );
  if (systems.length < 2) {
    return <span className="inline-flex h-9 min-w-0 items-center gap-2 px-1.5 text-[13px] font-semibold text-ink">{face}</span>;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip content={t.shell.changeSystem}>
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex h-9 min-w-0 items-center gap-2 rounded-xl pl-1.5 pr-2 text-[13px] font-semibold text-ink transition-colors hover:bg-ground">
            {face}
            <ChevronDown className="size-3.5 flex-none text-ink-3" />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-60 p-1.5">
        <p className={MENU_HEAD}>{t.shell.systems}</p>
        {systems.map(s => (
          <button key={s.id} type="button" className={MENU_ROW} onClick={() => { setOpen(false); onPick(s); }}>
            <ArtDot system={s} />
            <span className="truncate">{s.name}</span>
            {s.id === system.id && <Check className="ml-auto text-emerald" />}
          </button>
        ))}
        <hr className="my-1 border-muted" />
        <button type="button" className={MENU_ROW} onClick={() => { setOpen(false); onAll(); }}>
          <LayoutGrid className="text-ink-3" />
          {t.hub.selectSystemTitle}
        </button>
      </PopoverContent>
    </Popover>
  );
}

function StatusMenu({ t, lang, syncStatus, railwayOnline, autoEnabled, autoNextRun }: {
  t: T; lang: Lang; syncStatus: SyncStatus | null; railwayOnline: boolean | null; autoEnabled: boolean | null; autoNextRun: string | null;
}) {
  if (railwayOnline === null && !syncStatus) return null;
  const locale = LOCALES[lang];
  const when = (iso: string) => new Date(iso).toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const count = syncStatus?.product_count ?? 0;
  const running = !!syncStatus?.running;
  const last = syncStatus?.last_sync ? (syncStatus.last_sync.finished_at ?? syncStatus.last_sync.started_at) : null;
  const dbText = t.hub.topbarDb(count);
  const dbNumber = count.toLocaleString();
  const at = dbText.indexOf(dbNumber);
  return (
    <Popover>
      <Tip content={t.shell.status}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={t.shell.status}
            className="mr-1 inline-flex h-9 flex-none items-center gap-2.5 rounded-xl border border-border bg-surface px-2.5 text-xs font-semibold tabular-nums text-ink-3 transition-colors hover:bg-ground [&_svg]:size-[15px]">
            {running && <RefreshCw className="animate-spin text-emerald" />}
            {count > 0 && (
              <span className="hidden items-center gap-1.5 md:inline-flex">
                <Database />
                {new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(count)}
              </span>
            )}
            {railwayOnline !== null && (
              <span className={cn("inline-flex items-center gap-1.5", railwayOnline ? "text-emerald" : "text-taupe")}>
                <Activity />
                <LiveDot on={railwayOnline} />
              </span>
            )}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-[268px] p-1.5">
        <p className={MENU_HEAD}>{t.shell.status}</p>
        {railwayOnline !== null && (
          <div className={cn(MENU_ROW, "hover:bg-transparent")}>
            <Activity className="text-ink-3" />
            <span>VBN</span>
            <span className={cn(
              "ml-auto inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold",
              railwayOnline ? "border-emerald/20 bg-sage/60 text-emerald-dark" : "border-blush bg-ember-light text-brick",
            )}>
              <LiveDot on={railwayOnline} />
              {railwayOnline ? t.shell.online : t.shell.offline}
            </span>
          </div>
        )}
        {count > 0 && (
          <div className={cn(MENU_ROW, "hover:bg-transparent")}>
            <Database className="text-ink-3" />
            {at < 0 ? <span>{dbText}</span> : (
              <span>{dbText.slice(0, at)}<RollingNumber text={dbNumber} />{dbText.slice(at + dbNumber.length)}</span>
            )}
          </div>
        )}
        {syncStatus && (running || last) && (
          <div className={cn(MENU_ROW, "hover:bg-transparent")}>
            <RefreshCw className={cn("text-ink-3", running && "animate-spin text-emerald")} />
            {running ? <span className="shimmer-ink font-semibold">{t.hub.syncRunning}</span> : (
              <>
                <span>{t.shell.lastSync}</span>
                {last && <span className="ml-auto text-xs tabular-nums text-ink-3">{when(last)}</span>}
              </>
            )}
          </div>
        )}
        {autoEnabled !== null && (
          <div className={cn(MENU_ROW, "hover:bg-transparent")}>
            <Zap className="text-ink-3" />
            <span>{autoEnabled ? t.hub.autoVbnActive : t.hub.autoVbnDisabled}</span>
            {autoEnabled && autoNextRun && <span className="ml-auto text-xs tabular-nums text-ink-3">{when(autoNextRun)}</span>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A status dot; a live one pulses. */
export function LiveDot({ on }: { on: boolean }) {
  return (
    <span className="relative size-[7px] flex-none">
      {on && <span className="pulse-ring absolute inset-0 rounded-full" />}
      <span className="relative block size-[7px] rounded-full bg-current" />
    </span>
  );
}

/** The language: a globe and the code, the four languages in a menu. Also on the login page (`framed`). */
export function LanguageMenu({ t, lang, setLang, framed }: { t: T; lang: Lang; setLang: (l: Lang) => void; framed?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip content={t.shell.language}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={t.shell.language}
            className={cn(ICON_BUTTON, "flex w-auto gap-1.5 px-2.5", framed && "border border-border bg-surface")}>
            <Globe />
            <b className={cn("text-xs", !framed && "max-sm:hidden")}>{lang.toUpperCase()}</b>
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-48 p-1.5">
        {LANGUAGES.map(l => (
          <button key={l.code} type="button" className={MENU_ROW} onClick={() => { setOpen(false); setLang(l.code); }}>
            <span className="w-6 text-[11px] font-bold text-ink-3">{l.code.toUpperCase()}</span>
            {l.label}
            {l.code === lang && <Check className="ml-auto text-emerald" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function initials(name: string): string {
  const parts = name.split(/[.\s_@-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

function ProfileMenu({ t, username, isAdmin }: { t: T; username: string; isAdmin: boolean }) {
  const avatar = "grid flex-none place-items-center rounded-full bg-sage font-bold text-emerald-dark";
  return (
    <Popover>
      <Tip content={username}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={username}
            className={cn(avatar, "ml-1 size-[34px] text-xs transition-[box-shadow,scale] hover:ring-[3px] hover:ring-sage/70 active:scale-90")}>
            {initials(username)}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-60 p-1.5">
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <span className={cn(avatar, "size-[38px] text-[13px]")}>{initials(username)}</span>
          <div className="min-w-0">
            <b className="block truncate text-[13px] text-ink">{username}</b>
            {isAdmin && <span className="mt-0.5 inline-flex h-5 items-center rounded-full bg-sand px-2 text-[11px] font-semibold text-ink-2">{t.hub.adminLabel}</span>}
          </div>
        </div>
        <hr className="my-1 border-muted" />
        <button type="button" className={MENU_ROW} onClick={() => signOut({ callbackUrl: "/login" })}>
          <LogOut className="text-ink-3" />
          {t.hub.signOut}
        </button>
        <hr className="my-1 border-muted" />
        <p className="px-2.5 pb-1 pt-1.5 text-[11px] text-ink-3">{t.hub.footer}</p>
      </PopoverContent>
    </Popover>
  );
}
