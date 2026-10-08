"use client"

import { Fragment, useState, useEffect, useCallback, useRef, type ComponentType, type ReactNode } from "react"
import {
  Archive, Ban, Building2, Check, ChevronRight, Download, ExternalLink, FileText, LockOpen, Pencil, Plus, RefreshCw, Search, Shield,
  ShieldCheck, Sparkles, Trash2, TriangleAlert, UserPlus, Users, X,
} from "lucide-react"
import { translations, Lang } from "@/lib/i18n"
import { FP_SYSTEMS, type FPSystem } from "@/lib/systems"
import { saveBlob } from "@/lib/save-blob"
import { Button } from "@/components/ui/button"
import { Popup } from "@/components/ui/dialog"
import { Tip } from "@/components/ui/tooltip"
import { Chip, Code, ConfirmDialog, EmptyState, GoButton, IconButton, ModuleHeader, ModuleTabs, SubTabs } from "@/components/ui/kit"
import { MODULES, ModuleIcon, moduleColors, type Tab } from "@/components/shell/modules"
import { ArtDot } from "@/components/shell/TopBar"
import { cn } from "@/lib/utils"

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? ""

type T = (typeof translations)[Lang]

function ago(iso: string, t: T): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)   return t.admin.justNow
  if (mins < 60)  return t.admin.minAgo(mins)
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return t.admin.hoursAgo(hrs)
  const days = Math.floor(hrs / 24)
  if (days < 7)   return t.admin.daysAgo(days)
  return new Date(iso).toLocaleDateString()
}

interface User {
  id: number
  username: string
  is_active: boolean
  created_at: string
  last_login_at: string | null
  groups: string[]
  failed_attempts: number
  locked_until: string | null
}

interface Group {
  id: number
  name: string
  description: string
  permissions: string[]
}

/** Which module each permission opens, for its icon and its name. VBN
 *  Checker has two permissions, checking and fixing. */
const PERM_MODULE: Record<string, Tab> = {
  "vbn:check": "vbn", "vbn:fix": "vbn", "products:create": "create", "photos:upload": "photos",
  "delivery:import": "delivery", "analysis:view": "analysis", "boxweight:run": "boxweight", "supplier:add": "supplier",
  "knowledge:review": "knowledge", "admin:manage": "admin",
}

function permLabel(perm: string, t: T): string {
  if (perm === "vbn:check") return `${MODULES.vbn.label(t)} · ${t.vbn.stepCheck}`
  if (perm === "vbn:fix") return `${MODULES.vbn.label(t)} · ${t.vbn.stepFix}`
  const tab = PERM_MODULE[perm]
  return tab ? MODULES[tab].label(t) : perm
}

/** Which modules live under which system. Systems missing here grant access
 *  to the FreshPortal system itself and nothing else. */
const MODULES_BY_SYSTEM: Record<string, string[]> = {
  stamgegevens: ["vbn:check", "vbn:fix", "products:create", "photos:upload"],
  ecuador: ["delivery:import", "analysis:view"],
  kenya: ["boxweight:run", "supplier:add"],
  // Only modules whose endpoints follow the selected system can be offered on
  // the test tenant; VBN Check/Fix and Photo Uploader always run against
  // Stamgegevens, so they are not listed here.
  test: ["products:create"],
}

/** Built from FP_SYSTEMS so the name, the flag and the order here always
 *  match the system selector — they used to be a second copy that drifted. */
const SYSTEM_DEFS: { id: string; system: FPSystem; modules: string[] }[] =
  FP_SYSTEMS.map(s => ({ id: s.id, system: s, modules: MODULES_BY_SYSTEM[s.id] ?? [] }))

/** Modules not tied to a system: shown in every system to groups holding the permission. */
const SHARED_PERMS = ["knowledge:review"]

/* ─── Small pieces ─── */

/** A module as its own coloured badge, its name in the tooltip. */
function ModBadge({ tab, tip, dim, size = "sm" }: { tab: Tab; tip?: string; dim?: boolean; size?: "sm" | "xs" }) {
  const badge = (
    <span style={moduleColors(tab)} tabIndex={tip ? 0 : undefined}
      className={cn("grid flex-none place-items-center bg-[linear-gradient(135deg,var(--g1),var(--g2))] text-white outline-none [--ic-bg:var(--g1)]",
        size === "sm" ? "size-6 rounded-[7px]" : "size-5 rounded-[6px]", dim && "opacity-35 grayscale")}>
      <ModuleIcon id={tab} className={size === "sm" ? "size-3.5" : "size-3"} />
    </span>
  )
  return tip ? <Tip content={tip}>{badge}</Tip> : badge
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="grid size-7 flex-none place-items-center rounded-full bg-sage/60 text-[10.5px] font-bold uppercase text-emerald-dark">
      {name.slice(0, 2)}
    </span>
  )
}

function Th({ children, right, first }: { children?: ReactNode; right?: boolean; first?: boolean }) {
  return (
    <th className={cn("px-3 py-2.5 text-[11px] font-semibold text-ink-3", right ? "text-right" : "text-left", first && "pl-5")}>
      {children}
    </th>
  )
}

const INPUT = "h-10 w-full rounded-xl border border-border bg-ground px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-3/50 focus:border-emerald/55 focus:bg-surface focus:ring-4 focus:ring-emerald/12"

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink-3">
        {label}
        {hint && <span className="font-normal text-ink-3/70">· {hint}</span>}
      </span>
      {children}
    </label>
  )
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[12.5px] font-semibold text-brick">
      <TriangleAlert className="mt-px size-[15px] flex-none" /><span className="break-words">{children}</span>
    </p>
  )
}

/** A dialog that holds a form: title with an icon, the fields, the answers. */
function FormDialog({ title, icon: Ico, t, onClose, footer, children }: {
  title: string; icon: ComponentType<{ className?: string }>; t: T; onClose: () => void; footer: ReactNode; children: ReactNode
}) {
  return (
    <Popup title={title} onClose={onClose}
      className="left-1/2 top-1/2 flex max-h-[88vh] w-[min(540px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[22px] bg-surface shadow-2xl">
      <div className="flex items-center gap-3 border-b border-muted px-6 py-4">
        <span className="grid size-9 flex-none place-items-center rounded-full bg-sage/60 text-emerald-dark"><Ico className="size-[18px]" /></span>
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{title}</h3>
        <IconButton icon={X} tip={t.common.cancel} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">{children}</div>
      <div className="flex justify-end gap-2 border-t border-muted px-6 py-4">{footer}</div>
    </Popup>
  )
}

/** The answer buttons of a form dialog. */
function FormFooter({ t, saving, onSave, onClose, saveLabel, savingLabel }: {
  t: T; saving: boolean; onSave: () => void; onClose: () => void; saveLabel?: string; savingLabel?: string
}) {
  return (
    <>
      <Button variant="outline" onClick={onClose}><X className="size-4" />{t.common.cancel}</Button>
      <Button variant="primary" disabled={saving} onClick={onSave}>
        <Check className="size-4" />{saving ? (savingLabel ?? t.admin.saving) : (saveLabel ?? t.admin.save)}
      </Button>
    </>
  )
}

/* ─── User edit dialog ─── */
function UserEditDialog({ t, user, currentUsername, onSaved, onClose }: {
  t: T; user: User; currentUsername: string | undefined
  onSaved: () => void; onClose: () => void
}) {
  const [groups, setGroups] = useState<Group[]>([])
  const [username, setUsername] = useState(user.username)
  const [groupId, setGroupId] = useState<number | null>(null)
  const [isActive, setIsActive] = useState(user.is_active)
  const [password, setPassword] = useState("")
  const [confirmPw, setConfirmPw] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/groups").then(r => r.json()).then(d => {
      const fresh: Group[] = d.groups ?? []
      setGroups(fresh)
      const matched = fresh.find(g => g.name === user.groups[0])
      setGroupId(matched?.id ?? fresh[0]?.id ?? null)
    })
  }, [user.groups])

  const isSelf = user.username === currentUsername

  async function api(body: object) {
    const r = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error((await r.json()).error ?? t.admin.failed(r.status))
  }

  async function save() {
    if (!username.trim()) { setError(t.admin.errUsername); return }
    if (groupId == null) { setError(t.admin.errGroup); return }
    if (password && password !== confirmPw) { setError(t.admin.errPasswords); return }
    setError("")
    setSaving(true)
    try {
      if (username !== user.username) await api({ action: "updateUsername", userId: user.id, newUsername: username.trim() })
      await api({ action: "setGroups", userId: user.id, groupIds: [groupId] })
      if (!isSelf) await api({ action: "toggleActive", userId: user.id, isActive })
      if (password) await api({ action: "changePassword", userId: user.id, password })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormDialog title={t.admin.editUser(user.username)} icon={Pencil} t={t} onClose={onClose}
      footer={<FormFooter t={t} saving={saving} onSave={save} onClose={onClose} />}>
      <Field label={t.admin.username}>
        <input className={INPUT} value={username} onChange={e => setUsername(e.target.value)} />
      </Field>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-ink-3">{t.admin.colGroup}</p>
        {groups.length === 0
          ? <p className="text-xs text-ink-3">{t.common.loading}</p>
          : (
            <div role="radiogroup" className="flex flex-col gap-1.5">
              {groups.map(g => {
                const on = groupId === g.id
                const tabs = [...new Set(g.permissions.map(p => PERM_MODULE[p]).filter(Boolean))] as Tab[]
                return (
                  <button key={g.id} type="button" role="radio" aria-checked={on} onClick={() => setGroupId(g.id)}
                    className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald/40",
                      on ? "border-emerald/40 bg-sage/35" : "border-border hover:bg-ground")}>
                    <span className={cn("grid size-4 flex-none place-items-center rounded-full border-2", on ? "border-emerald" : "border-border")}>
                      {on && <span className="size-2 rounded-full bg-emerald" />}
                    </span>
                    <span className="text-sm font-semibold text-ink">{g.name}</span>
                    <span className="ml-auto flex flex-wrap justify-end gap-1">
                      {tabs.map(tab => <ModBadge key={tab} tab={tab} size="xs" />)}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
      </div>

      {!isSelf && (
        <label className="flex cursor-pointer items-center gap-2.5">
          <input type="checkbox" className="size-4 accent-emerald" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          <span className="text-sm font-medium text-ink">{t.admin.activeLabel}</span>
        </label>
      )}

      <div className="space-y-3 border-t border-muted pt-4">
        <Field label={t.admin.newPassword} hint={t.admin.passwordKeep}>
          <input type="password" className={INPUT} value={password}
            onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
        </Field>
        <Field label={t.admin.confirmPassword}>
          <input type="password" className={INPUT} value={confirmPw}
            onChange={e => setConfirmPw(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
        </Field>
      </div>

      {error && <ErrorLine>{error}</ErrorLine>}
    </FormDialog>
  )
}

/* ─── Shared permission picker (used in both edit and create dialogs) ─── */
function PermPicker({ t, perms, setPerms }: { t: T; perms: string[]; setPerms: (p: string[]) => void }) {
  function hasSystem(sysId: string) { return perms.includes(`system:${sysId}`) }
  function hasPerm(p: string)        { return perms.includes(p) }

  function toggleSystem(sysId: string, checked: boolean) {
    const sysPerm  = `system:${sysId}`
    const modPerms = SYSTEM_DEFS.find(s => s.id === sysId)?.modules ?? []
    if (checked) {
      setPerms([...perms.filter(p => p !== sysPerm), sysPerm])
    } else {
      setPerms(perms.filter(p => p !== sysPerm && !modPerms.includes(p)))
    }
  }

  function togglePerm(p: string, checked: boolean) {
    setPerms(checked ? [...perms, p] : perms.filter(x => x !== p))
  }

  const tile = (on: boolean) => cn("rounded-xl border transition-colors", on ? "border-emerald/35 bg-sage/25" : "border-border bg-ground/40")

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-semibold text-ink-3">{t.admin.systemsModules}</p>
        <div className="flex flex-col gap-1.5">
          {SYSTEM_DEFS.map(sys => {
            const sysChecked = hasSystem(sys.id)
            const checkedModules = sys.modules.filter(m => hasPerm(m))
            const allModules = sys.modules.length > 0 && checkedModules.length === sys.modules.length
            return (
              <div key={sys.id} className={tile(sysChecked)}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5">
                  <input type="checkbox" className="size-4 flex-none accent-emerald"
                    checked={sysChecked} onChange={e => toggleSystem(sys.id, e.target.checked)} />
                  <ArtDot system={sys.system} className={cn(!sysChecked && "opacity-50 grayscale")} />
                  <span className="flex-1 text-sm font-semibold text-ink">{sys.system.name}</span>
                  {sys.modules.length > 0
                    ? <Chip tone={!sysChecked ? "mute" : checkedModules.length > 0 ? "ok" : "warn"} tip={t.admin.modules}>
                        {sysChecked ? `${checkedModules.length}/${sys.modules.length}` : sys.modules.length}
                      </Chip>
                    : <span className="text-[11px] text-ink-3/60">{t.admin.accessOnly}</span>}
                </label>
                {sysChecked && sys.modules.length > 0 && (
                  <div className="ml-6 flex flex-col gap-1.5 border-t border-emerald/15 px-3 pb-2.5 pt-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold text-ink-3">{t.admin.modules}</p>
                      <button type="button"
                        onClick={() => setPerms(allModules
                          ? perms.filter(p => !sys.modules.includes(p))
                          : [...perms.filter(p => !sys.modules.includes(p)), ...sys.modules])}
                        className="text-[11px] font-semibold text-emerald hover:underline">
                        {allModules ? t.admin.none : t.admin.all}
                      </button>
                    </div>
                    {sys.modules.map(perm => (
                      <label key={perm} className="flex cursor-pointer items-center gap-2">
                        <input type="checkbox" className="size-3.5 accent-emerald"
                          checked={hasPerm(perm)} onChange={e => togglePerm(perm, e.target.checked)} />
                        <ModBadge tab={PERM_MODULE[perm]} size="xs" />
                        <span className="text-sm text-ink">{permLabel(perm, t)}</span>
                      </label>
                    ))}
                  </div>
                )}
                {/* Module perms survive from older grants; without the system they open nothing. */}
                {!sysChecked && checkedModules.length > 0 && (
                  <p className="px-3 pb-2.5 text-[11px] font-semibold text-brick">
                    {t.admin.grantedHidden(checkedModules.map(m => permLabel(m, t)).join(", "))}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-ink-3">{t.admin.everySystem}</p>
        <div className="flex flex-col gap-1.5">
          {["admin:manage", ...SHARED_PERMS].map(perm => (
            <label key={perm} className={cn(tile(hasPerm(perm)), "flex cursor-pointer items-center gap-2.5 px-3 py-2.5")}>
              <input type="checkbox" className="size-4 accent-emerald"
                checked={hasPerm(perm)} onChange={e => togglePerm(perm, e.target.checked)} />
              <ModBadge tab={PERM_MODULE[perm]} />
              <span className="text-sm font-semibold text-ink">{perm === "admin:manage" ? t.admin.adminManage : permLabel(perm, t)}</span>
              <span className="ml-1 text-xs text-ink-3">{perm === "admin:manage" ? t.admin.adminManageNote : t.admin.kbNote}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ─── Group dialogs ─── */
function GroupDialog({ t, group, onSaved, onClose }: {
  t: T; group: Group | null; onSaved: () => void; onClose: () => void
}) {
  const [name, setName] = useState(group?.name ?? "")
  const [desc, setDesc] = useState(group?.description ?? "")
  const [perms, setPerms] = useState<string[]>(group?.permissions ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function save() {
    if (!name.trim()) { setError(t.admin.errName); return }
    setError("")
    setSaving(true)
    try {
      const body = group
        ? { action: "update", groupId: group.id, name: name.trim(), description: desc, permissions: perms }
        : { action: "create", name: name.trim(), description: desc, permissions: perms }
      const r = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? t.admin.failed(r.status))
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormDialog title={group ? t.admin.editGroup(group.name) : t.admin.newGroup} icon={group ? Pencil : Shield} t={t} onClose={onClose}
      footer={<FormFooter t={t} saving={saving} onSave={save} onClose={onClose}
        saveLabel={group ? undefined : t.admin.create} savingLabel={group ? undefined : t.admin.creating} />}>
      <Field label={t.admin.groupName}>
        <input autoFocus={!group} className={INPUT} value={name} onChange={e => setName(e.target.value)} placeholder="group-name" />
      </Field>
      <Field label={t.admin.groupDescription}>
        <input className={INPUT} value={desc} onChange={e => setDesc(e.target.value)} placeholder={t.admin.optional} />
      </Field>
      <PermPicker t={t} perms={perms} setPerms={setPerms} />
      {error && <ErrorLine>{error}</ErrorLine>}
    </FormDialog>
  )
}

/* ─── Users ─── */
function NewUserRow({ t, onCreated, onCancel }: { t: T; onCreated: () => void; onCancel: () => void }) {
  const [groups, setGroups] = useState<Group[]>([])
  useEffect(() => {
    fetch("/api/admin/groups").then(r => r.json()).then(d => setGroups(d.groups ?? []))
  }, [])
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [groupId, setGroupId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError("")
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", username, password, groupIds: groupId != null ? [groupId] : [] }),
      })
      if (!r.ok) setError((await r.json()).error ?? t.admin.failed(r.status))
      else onCreated()
    } finally {
      setSaving(false)
    }
  }

  const small = "h-9 rounded-xl border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-emerald/55 focus:ring-4 focus:ring-emerald/12"
  return (
    <tr className="step-enter border-b border-muted bg-sage/20">
      <td colSpan={6} className="px-5 py-3">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <label>
            <span className="mb-1 block text-[11px] font-semibold text-ink-3">{t.admin.username}</span>
            <input required autoFocus value={username} onChange={e => setUsername(e.target.value)} placeholder="username" className={cn(small, "w-40")} />
          </label>
          <label>
            <span className="mb-1 block text-[11px] font-semibold text-ink-3">{t.admin.password}</span>
            <input required type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
              autoComplete="new-password" className={cn(small, "w-40")} />
          </label>
          <label>
            <span className="mb-1 block text-[11px] font-semibold text-ink-3">{t.admin.colGroup}</span>
            <select value={groupId ?? ""} onChange={e => setGroupId(e.target.value ? Number(e.target.value) : null)} className={cn(small, "pr-2")}>
              <option value="">{t.admin.noGroup}</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-1.5">
            <GoButton size="go-sm" type="submit" icon={Check} tip={saving ? t.admin.creating : t.admin.create} disabled={saving} />
            <IconButton icon={X} tip={t.common.cancel} onClick={onCancel} />
          </div>
          {error && <div className="w-full"><ErrorLine>{error}</ErrorLine></div>}
        </form>
      </td>
    </tr>
  )
}

function UserRow({ t, user, currentUsername, onRefresh, onEdit, onDelete }: {
  t: T; user: User; currentUsername: string | undefined; onRefresh: () => void; onEdit: () => void; onDelete: () => void
}) {
  const [saving, setSaving] = useState(false)
  const isSelf = user.username === currentUsername
  const isLocked = !!user.locked_until && new Date(user.locked_until) > new Date()

  async function unlock() {
    setSaving(true)
    try {
      await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unlock", userId: user.id }),
      })
      onRefresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className={cn("border-b border-muted transition-colors last:border-0 hover:bg-ground/40", !user.is_active && "opacity-50")}>
      <td className="px-3 py-2.5 pl-5">
        <div className="flex items-center gap-2.5">
          <Avatar name={user.username} />
          <span className="text-[13.5px] font-semibold text-ink">{user.username}</span>
          {isSelf && <Chip tone="info">{t.admin.you}</Chip>}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap gap-1">
          {user.groups.length ? user.groups.map(g => <Chip key={g} tone="mute" icon={Shield}>{g}</Chip>) : <span className="text-xs text-ink-3/40">—</span>}
        </div>
      </td>
      <td className="px-3 py-2.5">
        {isLocked
          ? <Chip tone="warn" icon={LockOpen} tip={user.locked_until ? new Date(user.locked_until).toLocaleString() : undefined}>{t.admin.locked}</Chip>
          : user.is_active
            ? <Chip tone="ok" icon={Check}>{t.admin.active}</Chip>
            : <Chip tone="mute" icon={X}>{t.admin.inactive}</Chip>}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums text-ink-3">
        {new Date(user.created_at).toLocaleDateString()}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums">
        {user.last_login_at
          ? <Tip content={new Date(user.last_login_at).toLocaleString()}>
              <span tabIndex={0} className="text-ink outline-none">{ago(user.last_login_at, t)}</span>
            </Tip>
          : <span className="text-ink-3/40">—</span>}
      </td>
      <td className="px-3 py-2.5 pr-4 text-right">
        <div className="flex items-center justify-end gap-0.5">
          {isLocked && <IconButton size="sm" icon={LockOpen} tip={t.admin.unlock} disabled={saving} onClick={unlock} />}
          <IconButton size="sm" icon={Pencil} tip={t.admin.edit} onClick={onEdit} />
          {!isSelf && <IconButton size="sm" icon={Trash2} tip={t.admin.delete} danger disabled={saving} onClick={onDelete} />}
        </div>
      </td>
    </tr>
  )
}

function UsersPanel({ t, currentUsername, reload, adding, setAdding }: {
  t: T; currentUsername: string | undefined; reload: number; adding: boolean; setAdding: (v: boolean) => void
}) {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<User | null>(null)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch("/api/admin/users").then(r => r.json())
      setUsers(r.users ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, reload])

  async function remove(user: User) {
    setBusy(true)
    try {
      await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", userId: user.id }),
      })
      setDeleting(null)
      load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overflow-x-auto">
      {editing && (
        <UserEditDialog t={t} user={editing} currentUsername={currentUsername} onSaved={load} onClose={() => setEditing(null)} />
      )}
      {deleting && (
        <ConfirmDialog icon={Trash2} title={t.admin.deleteUserTitle(deleting.username)} text={t.admin.deleteUserText}
          confirmLabel={t.admin.delete} cancelLabel={t.common.cancel} busy={busy}
          onClose={() => setDeleting(null)} onConfirm={() => remove(deleting)} />
      )}
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <Th first>{t.admin.colUser}</Th>
            <Th>{t.admin.colGroup}</Th>
            <Th>{t.admin.colStatus}</Th>
            <Th>{t.admin.colSince}</Th>
            <Th>{t.admin.colLastLogin}</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {adding && <NewUserRow t={t} onCreated={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} />}
          {loading && users.length === 0 ? (
            <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-ink-3">{t.common.loading}</td></tr>
          ) : users.length === 0 ? (
            <tr><td colSpan={6}><EmptyState icon={Users} text={t.admin.noUsers} /></td></tr>
          ) : users.map(u => (
            <UserRow key={u.id} t={t} user={u} currentUsername={currentUsername} onRefresh={load}
              onEdit={() => setEditing(u)} onDelete={() => setDeleting(u)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ─── Group permission model ───────────────────────────────────────────────
 *  A group's permission list is flat, but the app reads it as a tree: a module
 *  only opens if its system is open too (the hub filters tiles by perm *and*
 *  by the system:* list), and admin:manage opens everything. The card below
 *  renders that tree, so the flat list stops hiding which module sits under
 *  which system — and which modules are granted but unreachable.
 */
interface SystemState {
  id: string; system: FPSystem
  open: boolean                 // the group can enter this system
  modules: { perm: string; granted: boolean }[]
}

const KNOWN_PERMS = new Set<string>([
  ...SYSTEM_DEFS.flatMap(s => [`system:${s.id}`, ...s.modules]),
  ...SHARED_PERMS,
  "admin:manage",
])

function readPerms(perms: string[]) {
  const isAdmin = perms.includes("admin:manage")
  const sysIds = perms.filter(p => p.startsWith("system:")).map(p => p.slice("system:".length))
  // Same rule as the hub: an admin group with no system: perm reaches every system.
  const allSystems = isAdmin && sysIds.length === 0
  const systems: SystemState[] = SYSTEM_DEFS.map(s => ({
    id: s.id, system: s.system,
    open: allSystems || sysIds.includes(s.id),
    modules: s.modules.map(perm => ({ perm, granted: perms.includes(perm) })),
  }))
  return {
    isAdmin,
    systems,
    other: perms.filter(p => !KNOWN_PERMS.has(p)),
  }
}

/** One system with its modules: granted, open through Admin, or not. */
function SystemPanel({ t, sys, isAdmin }: { t: T; sys: SystemState; isAdmin: boolean }) {
  const granted = sys.modules.filter(m => m.granted).length
  // Module perms held without the system perm: granted, but the hub never
  // shows them, so the panel says so instead of looking like working access.
  const orphan = !sys.open
  return (
    <div className={cn("rounded-xl border px-3 py-2.5", orphan ? "border-blush bg-blush/15" : "border-border bg-surface")}>
      <div className="flex items-center gap-2">
        <ArtDot system={sys.system} className={cn("size-5", orphan && "opacity-50 grayscale")} />
        <span className={cn("min-w-0 flex-1 truncate text-xs font-semibold", orphan ? "text-ink-3" : "text-ink")}>{sys.system.name}</span>
        {sys.modules.length > 0
          ? <Chip tone={orphan ? "bad" : granted > 0 ? "ok" : "mute"}>{granted}/{sys.modules.length}</Chip>
          : <span className="text-[11px] text-ink-3/60">{t.admin.accessOnly}</span>}
      </div>
      {sys.modules.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {sys.modules.map(m => {
            const state = m.granted ? "on" : isAdmin ? "admin" : "off"
            const line = (
              <span className={cn("flex items-center gap-1.5 text-[11.5px] leading-tight", state === "off" && "opacity-45")}>
                <ModBadge tab={PERM_MODULE[m.perm]} size="xs" dim={state === "off"} />
                <span className={state === "on" ? "font-medium text-ink" : "text-ink-3"}>{permLabel(m.perm, t)}</span>
                {state === "admin" && <ShieldCheck className="size-3.5 text-ink-3/60" />}
              </span>
            )
            return state === "admin" ? <Tip key={m.perm} content={t.admin.viaAdmin}>{line}</Tip> : <Fragment key={m.perm}>{line}</Fragment>
          })}
        </div>
      )}
      {orphan && <p className="mt-2 text-[11px] font-semibold leading-snug text-brick">{t.admin.orphanText}</p>}
    </div>
  )
}

/* ─── Group card ─── */
function GroupCard({ t, group, members, onEdit, onDelete }: {
  t: T; group: Group; members: string[]; onEdit: () => void; onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const v = readPerms(group.permissions)
  const open   = v.systems.filter(s => s.open)
  // A closed system only hides a module no open system offers: New products
  // sits under Stamgegevens and the test tenant both.
  const reachable = new Set(open.flatMap(s => s.modules.map(m => m.perm)))
  const orphan = v.systems.filter(s => !s.open && s.modules.some(m => m.granted && !reachable.has(m.perm)))
  const shut   = v.systems.filter(s => !s.open && !orphan.includes(s))
  const panels = [...open, ...orphan]
  // The modules this group opens, each once, in the hub's order.
  const tabs = [...new Set(group.permissions.map(p => PERM_MODULE[p]).filter(Boolean))] as Tab[]
  if (v.isAdmin && !tabs.includes("history")) tabs.push("history")

  return (
    <div className="flex flex-col gap-2.5 rounded-[18px] border border-border bg-surface px-4 py-3.5">
      <div className="flex items-start gap-2">
        <button type="button" onClick={() => setExpanded(e => !e)} aria-expanded={expanded} aria-controls={`group-perms-${group.id}`}
          className="group/head flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald/40">
          <ChevronRight className={cn("size-4 flex-none text-ink-3/60 transition-transform duration-200 group-hover/head:text-ink", expanded && "rotate-90")} />
          <span className="truncate text-[14.5px] font-bold text-ink group-hover/head:text-emerald-dark">{group.name}</span>
        </button>
        <div className="flex flex-none items-center gap-1.5">
          {v.isAdmin && <Chip tone="info" icon={ShieldCheck}>Admin</Chip>}
          <Chip tone="mute" icon={Users} tip={members.length ? `${t.admin.members}: ${members.join(", ")}` : t.admin.noMembers}>{members.length}</Chip>
          <IconButton size="sm" icon={Pencil} tip={t.admin.edit} onClick={onEdit} />
          <IconButton size="sm" icon={Trash2} tip={t.admin.delete} danger onClick={onDelete} />
        </div>
      </div>
      {group.description && <p className="-mt-1 truncate pl-6 text-xs text-ink-3">{group.description}</p>}

      {/* At a glance: the systems it opens as their flags, the modules as their badges */}
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <span className="flex items-center -space-x-1.5">
          {open.length === 0
            ? <Chip tone="bad" icon={TriangleAlert} tip={t.admin.noSystemText}>{t.admin.noSystemTitle}</Chip>
            : open.map(s => (
              <Tip key={s.id} content={s.system.name}>
                <span tabIndex={0} className="inline-flex rounded-full outline-none ring-2 ring-surface"><ArtDot system={s.system} /></span>
              </Tip>
            ))}
        </span>
        {orphan.length > 0 && (
          <Chip tone="bad" icon={TriangleAlert} tip={`${orphan.map(s => s.system.name).join(", ")} · ${t.admin.orphanText}`}>{t.admin.orphanShort}</Chip>
        )}
        {tabs.length > 0 && <span className="h-[18px] w-px bg-border" />}
        <span className="flex flex-wrap items-center gap-1">
          {tabs.map(tab => <ModBadge key={tab} tab={tab} tip={MODULES[tab].label(t)} />)}
        </span>
      </div>

      {expanded && (
        <div id={`group-perms-${group.id}`} className="step-enter space-y-3 border-t border-muted pt-3">
          {panels.length === 0 ? (
            <EmptyState icon={Building2} text={t.admin.noSystemTitle} hint={t.admin.noSystemText} />
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {panels.map(sys => <SystemPanel key={sys.id} t={t} sys={sys} isAdmin={v.isAdmin} />)}
            </div>
          )}

          <div>
            <p className="mb-1.5 text-[11px] font-semibold text-ink-3">{t.admin.everySystem}</p>
            <div className="flex flex-wrap gap-1.5">
              <Chip tone={v.isAdmin ? "ok" : "mute"} icon={v.isAdmin ? Check : X} tip={t.admin.adminManageNote}>{t.admin.adminManage}</Chip>
              {SHARED_PERMS.map(p => (
                <Chip key={p} tone={group.permissions.includes(p) ? "ok" : "mute"} icon={group.permissions.includes(p) ? Check : X} tip={t.admin.kbNote}>
                  {permLabel(p, t)}
                </Chip>
              ))}
            </div>
          </div>

          {/* Only worth naming when some systems are open — otherwise the
              empty state above already says the group reaches nothing. */}
          {shut.length > 0 && panels.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3/70">
              <span className="font-semibold">{t.admin.closedSystems}</span>
              {shut.map(s => (
                <span key={s.id} className="inline-flex items-center gap-1">
                  <ArtDot system={s.system} className="size-4 opacity-40 grayscale" />{s.system.name}
                </span>
              ))}
            </div>
          )}

          {v.other.length > 0 && <p className="text-[11px] text-ink-3/60">{t.admin.unrecognised}: {v.other.join(", ")}</p>}
        </div>
      )}
    </div>
  )
}

function GroupsPanel({ t, reload, adding, setAdding }: { t: T; reload: number; adding: boolean; setAdding: (v: boolean) => void }) {
  const [groups, setGroups] = useState<Group[]>([])
  const [members, setMembers] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Group | null>(null)
  const [deleting, setDeleting] = useState<Group | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // The groups endpoint carries no member count, so the user list — already
      // admin-only, same as this screen — supplies it. A failure there only
      // costs the member line, so the groups still render.
      const [g, u] = await Promise.all([
        fetch("/api/admin/groups").then(r => r.json()),
        fetch("/api/admin/users").then(r => r.json()).catch(() => ({ users: [] })),
      ])
      setGroups(g.groups ?? [])
      const by: Record<string, string[]> = {}
      for (const user of (u.users ?? []) as User[]) {
        for (const name of user.groups ?? []) {
          if (!by[name]) by[name] = []
          by[name].push(user.username)
        }
      }
      setMembers(by)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, reload])

  async function remove(group: Group) {
    setBusy(true)
    setError("")
    try {
      // The reply was ignored once, so a refused delete looked like a silent
      // no-op: the card simply came back on the refresh with no reason given.
      const r = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", groupId: group.id }),
      })
      if (!r.ok) {
        setError(`${group.name}: ${(await r.json().catch(() => ({}))).error ?? t.admin.failed(r.status)}`)
      }
      setDeleting(null)
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 px-5 py-4">
      {(adding || editing) && (
        <GroupDialog t={t} group={editing} onSaved={load} onClose={() => { setAdding(false); setEditing(null) }} />
      )}
      {deleting && (
        <ConfirmDialog icon={Trash2} title={t.admin.deleteGroupTitle(deleting.name)}
          text={t.admin.deleteGroupText((members[deleting.name] ?? []).length)}
          confirmLabel={t.admin.delete} cancelLabel={t.common.cancel} busy={busy}
          onClose={() => setDeleting(null)} onConfirm={() => remove(deleting)} />
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {loading && groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-3">{t.common.loading}</p>
      ) : groups.length === 0 ? (
        <EmptyState icon={Shield} text={t.admin.noGroups} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
          {groups.map(g => (
            <GroupCard key={g.id} t={t} group={g} members={members[g.name] ?? []}
              onEdit={() => setEditing(g)} onDelete={() => setDeleting(g)} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── Customers ─── */
interface DfgCustomer {
  customer_id: string
  nm_customer: string
  used_in_delivery_import: boolean
}

interface KenyaCustomer {
  customer_id: string
  label: string | null
  enabled: boolean
}

/** Normalised row — the two systems store a different flag under a different
 *  name, but the table only needs id, name and ticked. */
interface CustomerRow { id: string; name: string; checked: boolean }

type CustomerSystem = "ecuador" | "kenya"

/** Kenya and Ecuador are separate FreshPortal tenants whose customer ids
 *  collide without referring to the same company — 62 ids appear in both
 *  lists under different names — so they are separate tables with separate
 *  flags, not one list with two checkboxes. */
const CUSTOMER_SYSTEMS: CustomerSystem[] = ["ecuador", "kenya"]

function CustomersPanel({ t, reload }: { t: T; reload: number }) {
  const [system, setSystem] = useState<CustomerSystem>("ecuador")
  const [rows, setRows] = useState<CustomerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [savingAll, setSavingAll] = useState(false)
  const [query, setQuery] = useState("")
  const selectAllRef = useRef<HTMLInputElement>(null)

  const flagLabel = system === "ecuador" ? t.admin.flagDelivery : t.admin.flagBoxWeight

  const load = useCallback(async () => {
    setLoading(true)
    setRows([])
    try {
      if (system === "ecuador") {
        const r = await fetch(`${RAILWAY}/dfg-customers`).then(r => r.json())
        setRows((r.customers ?? []).map((c: DfgCustomer) => ({
          id: c.customer_id, name: c.nm_customer, checked: c.used_in_delivery_import,
        })))
      } else {
        const r = await fetch(`${RAILWAY}/kenya/box-weight/customers`).then(r => r.json())
        setRows((r.customers ?? [])
          .map((c: KenyaCustomer) => ({
            id: c.customer_id, name: c.label || c.customer_id, checked: c.enabled,
          }))
          // customer_id is TEXT, so the server's ORDER BY puts "10" before
          // "2". Sort numerically here instead of in SQL, which would have to
          // cast a column that is not guaranteed to hold only digits.
          .sort((a: CustomerRow, b: CustomerRow) => Number(a.id) - Number(b.id)))
      }
    } finally {
      setLoading(false)
    }
  }, [system])

  useEffect(() => { load() }, [load, reload])
  useEffect(() => { setQuery("") }, [system])

  // Select-all is Ecuador-only on purpose: that list is short and every entry
  // is a plausible delivery-import target, whereas Kenya's is the tenant's
  // whole customer book and ticking all of it would point the box-weight
  // module at every invoice on the system.
  const canSelectAll = system === "ecuador"
  const allChecked = rows.length > 0 && rows.every(r => r.checked)
  const someChecked = rows.some(r => r.checked)
  const checkedCount = rows.filter(r => r.checked).length

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked && !allChecked
  }, [someChecked, allChecked])

  const visible = query.trim()
    ? rows.filter(r => `${r.name} ${r.id}`.toLowerCase().includes(query.trim().toLowerCase()))
    : rows

  async function toggle(row: CustomerRow, checked: boolean) {
    setSavingId(row.id)
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, checked } : r))
    try {
      const [url, body] = system === "ecuador"
        ? [`${RAILWAY}/dfg-customers/set-flag`,
           { customer_id: row.id, used_in_delivery_import: checked }]
        // No label: names come from the seeded list, and row.name falls back
        // to the raw id when one is missing — sending that would store "1"
        // as the customer's name and make it permanent.
        : [`${RAILWAY}/kenya/box-weight/customers`,
           { customer_id: row.id, enabled: checked }]
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    } finally {
      setSavingId(null)
    }
  }

  async function toggleAll(checked: boolean) {
    setSavingAll(true)
    setRows(prev => prev.map(r => ({ ...r, checked })))
    try {
      await fetch(`${RAILWAY}/dfg-customers/set-all-flags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ used_in_delivery_import: checked }),
      })
    } finally {
      setSavingAll(false)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5 px-5 py-3">
        <SubTabs<CustomerSystem>
          value={system}
          onChange={setSystem}
          items={CUSTOMER_SYSTEMS.map(id => ({ id, label: FP_SYSTEMS.find(s => s.id === id)?.name ?? id }))}
        />
        <div className="flex h-9 w-60 items-center gap-2 rounded-xl border border-border bg-ground px-3 transition-colors focus-within:border-emerald/55 focus-within:bg-surface focus-within:ring-4 focus-within:ring-emerald/12">
          <Search className="size-4 flex-none text-ink-3" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t.admin.searchCustomers} aria-label={t.admin.searchCustomers}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3/50" />
        </div>
        <Chip tone={someChecked ? "ok" : "mute"} icon={Check} tip={flagLabel}>{t.admin.selectedCount(checkedCount)}</Chip>
        {query.trim() && <Chip tone="mute" icon={Search}>{t.admin.shownOf(visible.length, rows.length)}</Chip>}
      </div>

      <div className="overflow-x-auto border-t border-muted">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <Th first>{t.admin.colCustomer}</Th>
              <Th>{t.admin.colId}</Th>
              <th className="px-3 py-2.5 pr-5 text-center text-[11px] font-semibold text-ink-3">
                <div className="flex flex-col items-center gap-1">
                  <span>{flagLabel}</span>
                  {canSelectAll && (
                    <label className="flex cursor-pointer items-center gap-1.5 font-medium">
                      <input ref={selectAllRef} type="checkbox" className="size-3.5 cursor-pointer accent-emerald"
                        checked={allChecked} disabled={savingAll || loading || rows.length === 0}
                        onChange={e => toggleAll(e.target.checked)} />
                      <span>{t.admin.selectAll}</span>
                    </label>
                  )}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={3} className="px-5 py-10 text-center text-sm text-ink-3">{t.common.loading}</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={3}><EmptyState icon={Building2} text={rows.length === 0 ? t.admin.noCustomers : t.admin.noMatch} /></td></tr>
            ) : visible.map(r => (
              <tr key={r.id} className="border-b border-muted transition-colors last:border-0 hover:bg-ground/40">
                <td className="px-3 py-2.5 pl-5 text-[13.5px] font-medium text-ink">{r.name}</td>
                <td className="px-3 py-2.5"><Code>#{r.id}</Code></td>
                <td className="px-3 py-2.5 pr-5 text-center">
                  <input type="checkbox" className="size-4 cursor-pointer accent-emerald" aria-label={`${flagLabel}: ${r.name}`}
                    checked={r.checked} disabled={savingId === r.id} onChange={e => toggle(r, e.target.checked)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─── File formats ─── */
/** Files delivery import could not read - PDF invoices, and delivery JSON
 *  (also sent as .txt) since 2026-10-01 - and the temporary layouts drafted
 *  for them (python/pdf_layout_store.py). IT adds a supplier's layout or
 *  parser with the new-delivery-json-format skill and closes the file here;
 *  a temporary layout is verified or rejected. "Create format" drafts one,
 *  within the same daily limit the delivery screen has. */
interface PdfLayoutRow {
  id: number
  kind: "pdf" | "json"
  status: "waiting" | "drafting" | "provisional" | "verified" | "rejected" | "failed" | "closed"
  supplier: string | null
  spec: Record<string, unknown> | null
  assumptions: string[]
  sample: {
    header?: Record<string, string>
    boxes?: number; stems?: number; bunches?: number; amount?: number
    printed_totals_checked?: Record<string, number>
    lines?: string[]; line_count?: number
  } | null
  error: string | null
  // Why a known supplier's layout could not read it (a new printout, say).
  read_error: string | null
  file_name: string | null
  model: string | null
  turns: number | null
  cost_usd: number | null
  created_by: string | null
  created_at: string
  draft_started_at: string | null
  drafted_by: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
}

function formatStatus(status: PdfLayoutRow["status"], t: T): { label: string; tone: "ok" | "bad" | "warn" | "info" | "mute" } {
  return {
    waiting:     { label: t.admin.fmtWaiting,     tone: "warn" as const },
    drafting:    { label: t.admin.fmtDrafting,    tone: "info" as const },
    provisional: { label: t.admin.fmtProvisional, tone: "warn" as const },
    verified:    { label: t.admin.fmtVerified,    tone: "ok" as const },
    rejected:    { label: t.admin.fmtRejected,    tone: "bad" as const },
    failed:      { label: t.admin.fmtFailed,      tone: "bad" as const },
    closed:      { label: t.admin.fmtClosed,      tone: "mute" as const },
  }[status]
}

/** A question about a format, with an optional note — in place of the
 *  browser's prompt(). */
type NoteAsk = { row: PdfLayoutRow; kind: "close" | "verify" | "reject" }

function FormatsPanel({ t, reload }: { t: T; reload: number }) {
  const [view, setView] = useState<"open" | "all">("open")
  const [rows, setRows] = useState<PdfLayoutRow[]>([])
  const [left, setLeft] = useState(0)
  const [perDay, setPerDay] = useState(0)
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [message, setMessage] = useState("")
  const [ask, setAsk] = useState<NoteAsk | null>(null)
  const [note, setNote] = useState("")

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${RAILWAY}/delivery/pdf-layouts?view=${view}`).then(r => r.json())
      setRows(r.layouts ?? [])
      setLeft(r.drafts_left_today ?? 0)
      setPerDay(r.drafts_per_day ?? 0)
      setAvailable(r.drafting_available !== false)
    } finally {
      setLoading(false)
    }
  }, [view])

  useEffect(() => { setLoading(true); load() }, [load, reload])

  // A draft runs on the server for a few minutes: follow it while one does.
  const drafting = rows.some(r => r.status === "drafting")
  useEffect(() => {
    if (!drafting) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [drafting, load])

  async function act(row: PdfLayoutRow, path: string, body?: unknown) {
    setBusy(row.id)
    setMessage("")
    try {
      const res = await fetch(`${RAILWAY}/delivery/pdf-layouts/${row.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
      if (!res.ok) {
        const detail = await res.json().then(b => b.detail).catch(() => null)
        setMessage(typeof detail === "string" ? detail : detail?.message ?? t.admin.failed(res.status))
      }
      await load()
    } finally {
      setBusy(null)
    }
  }

  // A preview is a blob: link in a new tab, alive only while this page
  // keeps it: revoked after a minute, saving from the browser's PDF viewer
  // failed with a network error (user, 2026-10-01). Kept until the panel
  // goes; the download button saves the file without one.
  const previews = useRef<string[]>([])
  useEffect(() => {
    const urls = previews.current
    return () => urls.forEach(url => URL.revokeObjectURL(url))
  }, [])

  async function fetchFile(row: PdfLayoutRow): Promise<Blob | null> {
    const res = await fetch(`${RAILWAY}/delivery/pdf-layouts/${row.id}/file`)
    if (!res.ok) { setMessage(t.admin.fileOpenFailed(res.status)); return null }
    return res.blob()
  }

  async function openFile(row: PdfLayoutRow) {
    const blob = await fetchFile(row)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    previews.current.push(url)
    window.open(url, "_blank")
  }

  async function downloadFile(row: PdfLayoutRow) {
    const blob = await fetchFile(row)
    if (blob) saveBlob(blob, row.file_name || `invoice-${row.id}.${row.kind ?? "pdf"}`)
  }

  function answer() {
    if (!ask) return
    if (ask.kind === "close") act(ask.row, "close", { note })
    else act(ask.row, "review", { decision: ask.kind, note })
    setAsk(null)
  }

  return (
    <div>
      {ask && (
        <ConfirmDialog
          icon={ask.kind === "close" ? Archive : ask.kind === "verify" ? Check : Ban}
          danger={ask.kind === "reject"}
          title={ask.kind === "close" ? t.admin.closeTitle : ask.kind === "verify" ? t.admin.verifyTitle : t.admin.rejectTitle}
          text={<>
            {ask.kind !== "verify" && <p>{ask.kind === "close" ? t.admin.closeText : t.admin.rejectText}</p>}
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder={t.admin.note} aria-label={t.admin.note} rows={2}
              className="mt-3 w-full resize-none rounded-xl border border-border bg-ground px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-emerald/55 focus:bg-surface focus:ring-4 focus:ring-emerald/12" />
          </>}
          confirmLabel={ask.kind === "close" ? t.admin.close : ask.kind === "verify" ? t.admin.verify : t.admin.reject}
          cancelLabel={t.common.cancel}
          onClose={() => setAsk(null)}
          onConfirm={answer}
        />
      )}

      <div className="flex flex-wrap items-center gap-2.5 px-5 py-3">
        <SubTabs<"open" | "all">
          value={view}
          onChange={setView}
          items={[{ id: "open", label: t.admin.fmtForIt }, { id: "all", label: t.admin.fmtAll }]}
        />
        {available
          ? <Chip tone={left > 0 ? "info" : "warn"} icon={Sparkles} tip={t.admin.fmtLeft(left, perDay)}>{left}/{perDay}</Chip>
          : <Chip tone="warn" icon={Sparkles} tip={`${t.admin.fmtUnavailable} (ANTHROPIC_API_KEY)`}>0</Chip>}
        {message && <span className="text-[12.5px] font-semibold text-brick">{message}</span>}
      </div>

      <div className="overflow-x-auto border-t border-muted">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <Th first>{t.admin.fmtInvoice}</Th>
              <Th>{t.admin.colStatus}</Th>
              <Th>{t.admin.fmtSaved}</Th>
              <Th>{t.admin.fmtFormat}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-5 py-10 text-center text-sm text-ink-3">{t.common.loading}</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5}><EmptyState icon={FileText} text={view === "open" ? t.admin.fmtNothing : t.admin.fmtNoFiles} /></td></tr>
            ) : rows.map(row => {
              const status = formatStatus(row.status, t)
              const canDraft = (row.status === "waiting" || row.status === "failed") && available && left > 0
              const isBusy = busy === row.id
              return (
                <Fragment key={row.id}>
                  <tr className="border-b border-muted align-top transition-colors last:border-0 hover:bg-ground/40">
                    <td className="px-3 py-3 pl-5">
                      <div className="flex items-start gap-2.5">
                        <FileText className="mt-0.5 size-[18px] flex-none text-ink-3" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[13.5px] font-semibold text-ink">{row.file_name || `${t.admin.fmtInvoice} #${row.id}`}</span>
                            <Code>{(row.kind ?? "pdf").toUpperCase()}</Code>
                          </div>
                          {row.supplier && <p className="text-xs text-ink-3">{row.supplier}</p>}
                          {row.read_error && <p className="mt-1 max-w-xs text-[11.5px] text-ink-3">{row.read_error}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Chip tone={status.tone} icon={row.status === "drafting" ? Sparkles : undefined}>{status.label}</Chip>
                      {row.error && <p className="mt-1 max-w-xs text-[11.5px] font-semibold text-brick">{row.error}</p>}
                      {row.review_note && <p className="mt-1 max-w-xs text-[11.5px] text-ink-3">{row.review_note}</p>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-ink-3">
                      <Tip content={new Date(row.created_at).toLocaleString()}><span tabIndex={0} className="outline-none">{ago(row.created_at, t)}</span></Tip>
                      {row.created_by && <span> · {row.created_by}</span>}
                    </td>
                    <td className="px-3 py-3">
                      {row.sample ? (
                        <button type="button" onClick={() => setOpen(open === row.id ? null : row.id)} aria-expanded={open === row.id}
                          className="flex flex-wrap items-center gap-1 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald/40">
                          <ChevronRight className={cn("size-4 text-ink-3 transition-transform", open === row.id && "rotate-90")} />
                          <Chip tone="mute" tip={t.admin.lines}>{row.sample.line_count ?? 0}</Chip>
                          <Chip tone="mute" tip={t.admin.boxes}>{row.sample.boxes ?? 0}</Chip>
                          <Chip tone="mute" tip={t.admin.amount}>${row.sample.amount?.toFixed(2)}</Chip>
                        </button>
                      ) : <span className="text-xs text-ink-3/50">—</span>}
                      {row.cost_usd != null && <p className="mt-1 text-[11px] text-ink-3">{t.admin.turnsCost(row.turns ?? 0, row.cost_usd.toFixed(2))}</p>}
                    </td>
                    <td className="px-3 py-3 pr-4">
                      <div className="flex flex-wrap justify-end gap-0.5">
                        <IconButton size="sm" icon={ExternalLink} tip={t.admin.open} onClick={() => openFile(row)} />
                        <IconButton size="sm" icon={Download} tip={t.admin.download} onClick={() => downloadFile(row)} />
                        {(row.status === "waiting" || row.status === "failed") && (
                          <IconButton size="sm" icon={Sparkles} disabled={!canDraft || isBusy} onClick={() => act(row, "draft")}
                            tip={!available ? t.admin.fmtUnavailable : left > 0 ? t.admin.makeDraft : `${t.admin.makeDraft} · ${t.admin.draftLimit}`} />
                        )}
                        {row.status === "drafting" && (
                          <IconButton size="sm" icon={X} tip={t.common.cancel} disabled={isBusy} onClick={() => act(row, "cancel")} />
                        )}
                        {(row.status === "provisional" || row.status === "rejected") && (
                          <IconButton size="sm" icon={Check} tip={t.admin.verify} disabled={isBusy} onClick={() => { setNote(""); setAsk({ row, kind: "verify" }) }} />
                        )}
                        {(row.status === "provisional" || row.status === "verified") && (
                          <IconButton size="sm" icon={Ban} tip={t.admin.reject} danger disabled={isBusy} onClick={() => { setNote(""); setAsk({ row, kind: "reject" }) }} />
                        )}
                        {row.status !== "drafting" && row.status !== "closed" && (
                          <IconButton size="sm" icon={Archive} tip={t.admin.close} disabled={isBusy} onClick={() => { setNote(""); setAsk({ row, kind: "close" }) }} />
                        )}
                      </div>
                    </td>
                  </tr>
                  {open === row.id && row.sample && (
                    <tr className="border-b border-muted bg-ground/50">
                      <td colSpan={5} className="px-5 py-3 text-xs text-ink-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <div>
                            <p className="mb-1 font-semibold text-ink">{t.admin.readFromInvoice}</p>
                            {Object.entries(row.sample.header ?? {}).filter(([, v]) => v).map(([k, v]) => (
                              <div key={k}><span className="text-ink-3">{k}:</span> <span className="text-ink">{v}</span></div>
                            ))}
                            <div className="mt-1">
                              {t.admin.checkedTotals}: {Object.entries(row.sample.printed_totals_checked ?? {})
                                .map(([k, v]) => `${k} ${v}`).join(", ") || "—"}
                            </div>
                            {row.assumptions.length > 0 && (
                              <>
                                <p className="mb-1 mt-2 font-semibold text-ink">{t.admin.assumed}</p>
                                <ul className="ml-5 list-disc">{row.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                              </>
                            )}
                          </div>
                          <div>
                            <p className="mb-1 font-semibold text-ink">{t.admin.lines}</p>
                            <div className="max-h-48 overflow-y-auto font-mono text-[11px]">
                              {(row.sample.lines ?? []).map((l, i) => <div key={i}>{l}</div>)}
                            </div>
                          </div>
                        </div>
                        {row.spec && (
                          <details className="mt-3">
                            <summary className="cursor-pointer font-semibold hover:text-ink">
                              {t.admin.layoutJson(row.kind === "json" ? "parser_delivery.py" : "pdf_layouts.py")}
                            </summary>
                            <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-surface p-2 font-mono text-[11px]">
                              {JSON.stringify(row.spec, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─── Main ─── */
type AdminView = "users" | "groups" | "customers" | "formats"

export default function AdminTab({ currentUsername, lang }: { currentUsername?: string; lang: Lang }) {
  const t = translations[lang]
  const [activeTab, setActiveTab] = useState<AdminView>("users")
  // The header's refresh and add buttons act on the open view.
  const [reload, setReload] = useState(0)
  const [adding, setAdding] = useState(false)
  const [waiting, setWaiting] = useState(0)

  // Files waiting for IT, as the count on the formats tab.
  useEffect(() => {
    if (!RAILWAY) return
    fetch(`${RAILWAY}/delivery/pdf-layouts/pending-count`).then(r => r.json()).then(d => setWaiting(d.count ?? 0)).catch(() => {})
  }, [reload])

  const canAdd = activeTab === "users" || activeTab === "groups"

  return (
    <div>
      <ModuleHeader tab="admin" t={t} info={MODULES.admin.desc(t)}
        actions={<>
          <IconButton icon={RefreshCw} tip={t.admin.refresh} onClick={() => setReload(n => n + 1)} />
          {canAdd && (
            <GoButton size="go-sm" icon={activeTab === "users" ? UserPlus : Plus}
              tip={activeTab === "users" ? t.admin.newUser : t.admin.newGroup} onClick={() => setAdding(a => !a)} />
          )}
        </>}
      />
      <div className="px-5 pb-3">
        <ModuleTabs<AdminView>
          value={activeTab}
          onChange={v => { setActiveTab(v); setAdding(false) }}
          items={[
            { id: "users", icon: Users, label: t.admin.tabUsers },
            { id: "groups", icon: Shield, label: t.admin.tabGroups },
            { id: "customers", icon: Building2, label: t.admin.tabCustomers },
            { id: "formats", icon: FileText, label: t.admin.tabFormats, count: waiting, countTip: t.admin.fmtForIt },
          ]}
        />
      </div>

      <div key={activeTab} className="step-enter border-t border-muted">
        {activeTab === "users"
          ? <UsersPanel t={t} currentUsername={currentUsername} reload={reload} adding={adding} setAdding={setAdding} />
          : activeTab === "groups"
          ? <GroupsPanel t={t} reload={reload} adding={adding} setAdding={setAdding} />
          : activeTab === "customers"
          ? <CustomersPanel t={t} reload={reload} />
          : <FormatsPanel t={t} reload={reload} />}
      </div>
    </div>
  )
}
