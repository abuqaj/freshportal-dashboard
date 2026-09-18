"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import { FP_SYSTEMS } from "@/lib/systems"

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? ""

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)   return "just now"
  if (mins < 60)  return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7)   return `${days}d ago`
  return new Date(iso).toLocaleDateString("pl-PL")
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

/** Which modules live under which system. Systems missing here grant access
 *  to the FreshPortal system itself and nothing else. */
const MODULES_BY_SYSTEM: Record<string, { perm: string; label: string }[]> = {
  stamgegevens: [
    { perm: "vbn:check",       label: "VBN Check" },
    { perm: "vbn:fix",         label: "VBN Fix" },
    { perm: "products:create", label: "New Products" },
    { perm: "photos:upload",   label: "Photo Uploader" },
  ],
  ecuador: [
    { perm: "delivery:import", label: "Delivery Import" },
    { perm: "analysis:view",   label: "Analysis Tool" },
  ],
  kenya: [
    { perm: "boxweight:run", label: "Box Weight" },
    { perm: "supplier:add",  label: "Add Supplier" },
  ],
  // Only modules whose endpoints follow the selected system can be offered on
  // the test tenant; VBN Check/Fix and Photo Uploader always run against
  // Stamgegevens, so they are not listed here.
  test: [
    { perm: "products:create", label: "New Products" },
  ],
}

/** Built from FP_SYSTEMS so the name, the colour and the order here always
 *  match the system selector — they used to be a second copy that drifted. */
const SYSTEM_DEFS: { id: string; label: string; dot: string; modules: { perm: string; label: string }[] }[] =
  FP_SYSTEMS.map(s => ({
    id: s.id,
    label: s.name,
    dot: s.accent,
    modules: MODULES_BY_SYSTEM[s.id] ?? [],
  }))

/** Modules not tied to a system: shown in every system to groups holding the permission. */
const SHARED_MODULES: { perm: string; label: string; note: string }[] = [
  { perm: "knowledge:review", label: "Knowledge Base", note: "every system · review, library, runs" },
]

const PERM_LABELS: Record<string, string> = {
  "vbn:check":       "VBN Check",
  "vbn:fix":         "VBN Fix",
  "products:create": "New Products",
  "photos:upload":   "Photo Uploader",
  "delivery:import": "Delivery Import",
  "boxweight:run":   "Box Weight",
  "supplier:add":    "Add Supplier",
  "analysis:view":   "Analysis Tool",
  "knowledge:review": "Knowledge Base",
  "admin:manage":    "Admin",
}

/* ─── Badge ─── */
function Badge({ children, variant = "neutral" }: {
  children: React.ReactNode
  variant?: "green" | "red" | "neutral" | "blue" | "amber"
}) {
  const cls = {
    green:   "bg-emerald/10 text-emerald border-emerald/20",
    red:     "bg-ember/10 text-ember border-ember/20",
    neutral: "bg-muted text-ink-3 border-border",
    blue:    "bg-[#1A6FD4]/10 text-[#1A6FD4] border-[#1A6FD4]/20",
    amber:   "bg-amber-500/10 text-amber-600 border-amber-500/20",
  }[variant]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${cls}`}>
      {children}
    </span>
  )
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-4 py-2.5 text-[10px] font-semibold text-ink-3 uppercase tracking-widest ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  )
}

/* ─── Modal wrapper ─── */
/** Rendered into document.body. Inside the module the dialog sits under a
 *  scrolled container, and any transformed ancestor would turn its
 *  position:fixed into position:absolute — which put the dialog at the top of
 *  the page and left you scrolling up to find it. A portal cannot be caught
 *  that way again. */
function Modal({ title, onClose, wide, children }: {
  title: string; onClose: () => void; wide?: boolean; children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  if (!mounted) return null

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className={`bg-surface rounded-3xl border border-border shadow-2xl w-full ${wide ? "max-w-lg" : "max-w-md"}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink hover:bg-ground transition-colors">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-4 overflow-y-auto max-h-[75vh]">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest mb-1.5">{label}</p>
      {children}
    </div>
  )
}

const INPUT = "w-full h-9 px-3 rounded-xl border border-border bg-ground text-sm text-ink focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all"

/* ─── User edit modal ─── */
function UserEditModal({ user, currentUsername, onSaved, onClose }: {
  user: User; currentUsername: string | undefined
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
    if (!r.ok) throw new Error((await r.json()).error ?? "Failed")
  }

  async function save() {
    if (!username.trim()) { setError("Username is required"); return }
    if (groupId == null) { setError("A group must be selected"); return }
    if (password && password !== confirmPw) { setError("Passwords do not match"); return }
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
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Edit user: ${user.username}`} onClose={onClose}>
      <Field label="Username">
        <input className={INPUT} value={username} onChange={e => setUsername(e.target.value)} />
      </Field>

      <Field label="Group">
        {groups.length === 0
          ? <p className="text-xs text-ink-3">Loading…</p>
          : (
            <div className="flex flex-col gap-1.5">
              {groups.map(g => (
                <label key={g.id} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="group" className="accent-emerald"
                    checked={groupId === g.id}
                    onChange={() => setGroupId(g.id)} />
                  <span className="text-sm font-medium text-ink">{g.name}</span>
                  {g.permissions.length > 0 && (
                    <span className="text-xs text-ink-3">
                      ({g.permissions.filter(p => !p.startsWith("system:")).map(p => PERM_LABELS[p] ?? p).join(", ")}
                      {g.permissions.some(p => p.startsWith("system:")) &&
                        ` · ${g.permissions.filter(p => p.startsWith("system:")).length} system(s)`})
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
      </Field>

      {!isSelf && (
        <Field label="Status">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="accent-emerald w-4 h-4"
              checked={isActive} onChange={e => setIsActive(e.target.checked)} />
            <span className="text-sm text-ink">Active</span>
          </label>
        </Field>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest">Change password <span className="normal-case font-normal">(leave blank to keep)</span></p>
        <Field label="New password">
          <input type="password" className={INPUT} value={password}
            onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
        </Field>
        <Field label="Confirm password">
          <input type="password" className={INPUT} value={confirmPw}
            onChange={e => setConfirmPw(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
        </Field>
      </div>

      {error && <p className="text-xs text-ember font-medium">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button onClick={save} disabled={saving}
          className="flex-1 h-9 rounded-xl bg-emerald text-white text-sm font-semibold hover:bg-emerald/90 disabled:opacity-50 transition-colors">
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onClose}
          className="h-9 px-4 rounded-xl border border-border text-sm font-medium text-ink-3 hover:bg-ground transition-colors">
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/* ─── Shared permission picker (used in both edit and create modals) ─── */
function PermPicker({ perms, setPerms }: { perms: string[]; setPerms: (p: string[]) => void }) {
  function hasSystem(sysId: string) { return perms.includes(`system:${sysId}`) }
  function hasPerm(p: string)        { return perms.includes(p) }

  function toggleSystem(sysId: string, checked: boolean) {
    const sysPerm  = `system:${sysId}`
    const modPerms = SYSTEM_DEFS.find(s => s.id === sysId)?.modules.map(m => m.perm) ?? []
    if (checked) {
      setPerms([...perms.filter(p => p !== sysPerm), sysPerm])
    } else {
      setPerms(perms.filter(p => p !== sysPerm && !modPerms.includes(p)))
    }
  }

  function togglePerm(p: string, checked: boolean) {
    setPerms(checked ? [...perms, p] : perms.filter(x => x !== p))
  }

  return (
    <div className="space-y-4">
      <Field label="Systems & Modules">
        <div className="flex flex-col gap-1.5">
          {SYSTEM_DEFS.map(sys => {
            const sysChecked = hasSystem(sys.id)
            const checkedModules = sys.modules.filter(m => hasPerm(m.perm))
            const allModules = sys.modules.length > 0 && checkedModules.length === sys.modules.length
            return (
              <div key={sys.id}
                className={`rounded-xl border overflow-hidden transition-all ${sysChecked ? "border-emerald/30 bg-emerald/5" : "border-border bg-ground/30"}`}>
                {/* Colour bar — the same system accent the group cards use */}
                <span className={`block h-[3px] ${sys.dot} ${sysChecked ? "" : "opacity-30"}`} />
                {/* System row */}
                <label className="flex items-center gap-2.5 cursor-pointer px-3 py-2.5">
                  <input type="checkbox" className="accent-emerald w-4 h-4 flex-shrink-0"
                    checked={sysChecked}
                    onChange={e => toggleSystem(sys.id, e.target.checked)} />
                  <span className="text-sm font-semibold text-ink flex-1">{sys.label}</span>
                  {sys.modules.length > 0 ? (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                      sysChecked
                        ? checkedModules.length > 0
                          ? "bg-emerald/15 text-emerald"
                          : "bg-amber-500/10 text-amber-600"
                        : "bg-muted text-ink-3/50"
                    }`}>
                      {sysChecked
                        ? `${checkedModules.length}/${sys.modules.length} modules`
                        : `${sys.modules.length} modules`}
                    </span>
                  ) : (
                    <span className="text-[10px] text-ink-3/30">access only</span>
                  )}
                </label>
                {/* Module checkboxes — shown when system is checked */}
                {sysChecked && sys.modules.length > 0 && (
                  <div className="px-3 pb-2.5 flex flex-col gap-1.5 border-t border-emerald/15 pt-2 ml-6">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest">Modules</p>
                      <button type="button"
                        onClick={() => setPerms(allModules
                          ? perms.filter(p => !sys.modules.some(m => m.perm === p))
                          : [...perms.filter(p => !sys.modules.some(m => m.perm === p)), ...sys.modules.map(m => m.perm)])}
                        className="text-[10px] font-semibold text-emerald hover:underline">
                        {allModules ? "none" : "all"}
                      </button>
                    </div>
                    {sys.modules.map(mod => (
                      <label key={mod.perm} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" className="accent-emerald w-3.5 h-3.5"
                          checked={hasPerm(mod.perm)}
                          onChange={e => togglePerm(mod.perm, e.target.checked)} />
                        <span className="text-sm text-ink">{mod.label}</span>
                      </label>
                    ))}
                  </div>
                )}
                {/* Module perms survive from older grants; without the system they open nothing. */}
                {!sysChecked && checkedModules.length > 0 && (
                  <p className="px-3 pb-2.5 text-[10px] font-medium text-amber-600">
                    {checkedModules.map(m => m.label).join(", ")} granted, but hidden until this system is ticked
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </Field>

      <Field label="Shared">
        <div className="flex flex-col gap-1.5">
          <div className={`rounded-xl border px-3 py-2.5 transition-all ${hasPerm("admin:manage") ? "border-emerald/30 bg-emerald/5" : "border-border bg-ground/30"}`}>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" className="accent-emerald w-4 h-4"
                checked={hasPerm("admin:manage")}
                onChange={e => togglePerm("admin:manage", e.target.checked)} />
              <span className="text-sm font-semibold text-ink">Admin & Management</span>
              <span className="text-xs text-ink-3 ml-1">all systems · users · history</span>
            </label>
          </div>
          {SHARED_MODULES.map(mod => (
            <div key={mod.perm} className={`rounded-xl border px-3 py-2.5 transition-all ${hasPerm(mod.perm) ? "border-emerald/30 bg-emerald/5" : "border-border bg-ground/30"}`}>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input type="checkbox" className="accent-emerald w-4 h-4"
                  checked={hasPerm(mod.perm)}
                  onChange={e => togglePerm(mod.perm, e.target.checked)} />
                <span className="text-sm font-semibold text-ink">{mod.label}</span>
                <span className="text-xs text-ink-3 ml-1">{mod.note}</span>
              </label>
            </div>
          ))}
        </div>
      </Field>
    </div>
  )
}

/* ─── Group edit modal ─── */
function GroupEditModal({ group, onSaved, onClose }: {
  group: Group; onSaved: () => void; onClose: () => void
}) {
  const [name, setName] = useState(group.name)
  const [desc, setDesc] = useState(group.description)
  const [perms, setPerms] = useState<string[]>(group.permissions)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function save() {
    if (!name.trim()) { setError("Name is required"); return }
    setError("")
    setSaving(true)
    try {
      const r = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", groupId: group.id, name: name.trim(), description: desc, permissions: perms }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed")
      onSaved()
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Edit group: ${group.name}`} onClose={onClose} wide>
      <Field label="Name">
        <input className={INPUT} value={name} onChange={e => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <input className={INPUT} value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional" />
      </Field>

      <PermPicker perms={perms} setPerms={setPerms} />

      {error && <p className="text-xs text-ember font-medium">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button onClick={save} disabled={saving}
          className="flex-1 h-9 rounded-xl bg-emerald text-white text-sm font-semibold hover:bg-emerald/90 disabled:opacity-50 transition-colors">
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button onClick={onClose}
          className="h-9 px-4 rounded-xl border border-border text-sm font-medium text-ink-3 hover:bg-ground transition-colors">
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/* ─── User row ─── */
function UserRow({ user, currentUsername, onRefresh }: {
  user: User; currentUsername: string | undefined; onRefresh: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const isSelf = user.username === currentUsername
  const isLocked = !!user.locked_until && new Date(user.locked_until) > new Date()

  async function call(body: object) {
    setSaving(true)
    try {
      await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      onRefresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {editing && (
        <UserEditModal
          user={user}
          currentUsername={currentUsername}
          onSaved={onRefresh}
          onClose={() => setEditing(false)}
        />
      )}
      <tr className={`border-b border-border hover:bg-ground/40 transition-colors ${!user.is_active ? "opacity-50" : ""}`}>
        <td className="px-4 py-3 w-8">
          <div className={`w-2 h-2 rounded-full ${isLocked ? "bg-amber-500" : user.is_active ? "bg-emerald" : "bg-ink-3/30"}`} />
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">{user.username}</span>
            {isSelf && <Badge variant="blue">you</Badge>}
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {user.groups.length ? user.groups.map(g => <Badge key={g} variant="neutral">{g}</Badge>) : <span className="text-xs text-ink-3/40">—</span>}
          </div>
        </td>
        <td className="px-4 py-3">
          {isLocked
            ? <Badge variant="amber">locked</Badge>
            : user.is_active
              ? <Badge variant="green">active</Badge>
              : <Badge variant="red">inactive</Badge>}
        </td>
        <td className="px-4 py-3 text-xs text-ink-3 tabular-nums whitespace-nowrap">
          {new Date(user.created_at).toLocaleDateString("pl-PL")}
        </td>
        <td className="px-4 py-3 text-xs tabular-nums whitespace-nowrap">
          {user.last_login_at
            ? <span className="text-ink" title={new Date(user.last_login_at).toLocaleString("pl-PL")}>
                {formatRelative(user.last_login_at)}
              </span>
            : <span className="text-ink-3/40">—</span>}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-1.5">
            {isLocked && (
              <button disabled={saving} onClick={() => call({ action: "unlock", userId: user.id })}
                className="h-7 px-2.5 rounded-lg text-xs font-medium text-amber-600 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-50 transition-colors">
                Unlock
              </button>
            )}
            <button onClick={() => setEditing(true)}
              className="h-7 px-2.5 rounded-lg text-xs font-medium text-ink-3 bg-ground border border-border hover:bg-border/40 transition-colors">
              Edit
            </button>
            <button disabled={saving || isSelf}
              onClick={() => { if (confirm(`Delete "${user.username}"?`)) call({ action: "delete", userId: user.id }) }}
              className="h-7 px-2.5 rounded-lg text-xs font-medium text-ember bg-ember/10 hover:bg-ember/20 disabled:opacity-40 transition-colors">
              Delete
            </button>
          </div>
        </td>
      </tr>
    </>
  )
}

/* ─── New user row ─── */
function NewUserRow({ onCreated, onCancel }: {
  onCreated: () => void; onCancel: () => void
}) {
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
      if (!r.ok) setError((await r.json()).error ?? "Failed")
      else onCreated()
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="border-b border-border bg-emerald/5">
      <td colSpan={7} className="px-4 py-3">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div>
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest mb-1.5">Username</p>
            <input required autoFocus value={username} onChange={e => setUsername(e.target.value)} placeholder="username"
              className="h-8 px-3 rounded-xl border border-border bg-surface text-xs text-ink w-36
                         focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all" />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest mb-1.5">Password</p>
            <input required type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
              className="h-8 px-3 rounded-xl border border-border bg-surface text-xs text-ink w-36
                         focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all" />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest mb-1.5">Group</p>
            <select value={groupId ?? ""} onChange={e => setGroupId(e.target.value ? Number(e.target.value) : null)}
              className="h-8 px-2 rounded-xl border border-border bg-surface text-xs text-ink
                         focus:outline-none focus:border-emerald/60 transition-all">
              <option value="">— none —</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="flex gap-2 items-center">
            {error && <p className="text-xs text-ember">{error}</p>}
            <button type="submit" disabled={saving}
              className="h-8 px-4 rounded-xl bg-emerald text-white text-xs font-semibold hover:bg-emerald/90 disabled:opacity-50 transition-colors">
              {saving ? "Creating…" : "Create"}
            </button>
            <button type="button" onClick={onCancel}
              className="h-8 px-3 rounded-xl text-xs font-medium text-ink-3 bg-ground border border-border hover:bg-border/40 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      </td>
    </tr>
  )
}

/* ─── Users table ─── */
function UsersTable({ currentUsername }: { currentUsername: string | undefined }) {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch("/api/admin/users").then(r => r.json())
      setUsers(r.users ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-ground/60">
            <Th />
            <Th>Username</Th>
            <Th>Group</Th>
            <Th>Status</Th>
            <Th>Since</Th>
            <Th>Last login</Th>
            <th className="px-4 py-2.5 text-right">
              <div className="flex items-center justify-end gap-2">
                <button onClick={load} disabled={loading}
                  className="w-7 h-7 rounded-lg bg-surface border border-border flex items-center justify-center text-ink-3 hover:bg-border/40 disabled:opacity-40 transition-colors">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className={loading ? "animate-spin" : ""}>
                    <path d="M21 12a9 9 0 11-3.2-6.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    <path d="M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <button onClick={() => setShowNew(v => !v)}
                  className="h-7 px-3 rounded-lg bg-emerald text-white text-xs font-semibold hover:bg-emerald/90 transition-colors whitespace-nowrap">
                  + New user
                </button>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {showNew && (
            <NewUserRow onCreated={() => { setShowNew(false); load() }} onCancel={() => setShowNew(false)} />
          )}
          {loading ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-ink-3">Loading…</td></tr>
          ) : users.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-ink-3">No users</td></tr>
          ) : users.map(u => (
            <UserRow key={u.id} user={u} currentUsername={currentUsername} onRefresh={load} />
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
 *  renders that tree, so the flat badge list stops hiding which module sits
 *  under which system — and which modules are granted but unreachable.
 */
interface ModuleState { perm: string; label: string; granted: boolean }
interface SystemState {
  id: string; label: string; dot: string
  open: boolean                 // the group can enter this system
  modules: ModuleState[]
}

const KNOWN_PERMS = new Set<string>([
  ...SYSTEM_DEFS.flatMap(s => [`system:${s.id}`, ...s.modules.map(m => m.perm)]),
  ...SHARED_MODULES.map(m => m.perm),
  "admin:manage",
])

function readPerms(perms: string[]) {
  const isAdmin = perms.includes("admin:manage")
  const sysIds = perms.filter(p => p.startsWith("system:")).map(p => p.slice("system:".length))
  // Same rule as the hub: an admin group with no system: perm reaches every system.
  const allSystems = isAdmin && sysIds.length === 0
  const systems: SystemState[] = SYSTEM_DEFS.map(s => ({
    id: s.id, label: s.label, dot: s.dot,
    open: allSystems || sysIds.includes(s.id),
    modules: s.modules.map(m => ({ ...m, granted: perms.includes(m.perm) })),
  }))
  return {
    isAdmin,
    systems,
    other: perms.filter(p => !KNOWN_PERMS.has(p)),
    moduleCount: systems.reduce((n, s) => n + s.modules.filter(m => m.granted).length, 0),
    systemCount: systems.filter(s => s.open).length,
  }
}

/* ─── State glyphs ─── */
function Tick() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="flex-shrink-0">
      <path d="M2 6.3l2.6 2.7L10 3.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function Hollow() {
  return <span className="w-[11px] h-[11px] rounded-full border border-current opacity-40 flex-shrink-0" />
}

/** One module under a system. "admin" = not granted outright, but the group
 *  holds admin:manage, which the hub treats as holding every module perm. */
function ModuleLine({ label, state }: { label: string; state: "on" | "off" | "admin" }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] leading-tight"
      title={state === "admin" ? "Open because the group holds Admin & Management" : undefined}>
      {state === "off"
        ? <Hollow />
        : <span className={state === "on" ? "text-emerald" : "text-emerald/50"}><Tick /></span>}
      <span className={
        state === "on"      ? "font-medium text-ink"
        : state === "admin" ? "text-ink-3"
        : "text-ink-3/45"
      }>{label}</span>
      {state === "admin" && (
        <span className="text-[9px] font-semibold text-ink-3/40 uppercase tracking-wide">admin</span>
      )}
    </span>
  )
}

/** One system with the modules activated for it listed underneath. */
function SystemPanel({ sys, isAdmin }: { sys: SystemState; isAdmin: boolean }) {
  const granted = sys.modules.filter(m => m.granted).length
  // Module perms held without the system perm: granted, but the hub never
  // shows them, so the panel says so instead of looking like working access.
  const orphan = !sys.open

  return (
    <div className={`rounded-xl border overflow-hidden ${
      orphan ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-ground/40"
    }`}>
      <span className={`block h-[3px] ${orphan ? "bg-amber-500/50" : sys.dot}`} />
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sys.dot} ${orphan ? "opacity-40" : ""}`} />
        <span className={`text-xs font-semibold flex-1 truncate ${orphan ? "text-ink-3" : "text-ink"}`}>
          {sys.label}
        </span>
        {sys.modules.length > 0 ? (
          <span className={`text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full ${
            orphan                           ? "bg-amber-500/15 text-amber-600"
            : granted === sys.modules.length ? "bg-emerald/15 text-emerald"
            : granted > 0                    ? "bg-emerald/10 text-emerald/80"
            : "bg-muted text-ink-3/60"
          }`}>
            {granted}/{sys.modules.length}
          </span>
        ) : (
          <span className="text-[10px] text-ink-3/50">access only</span>
        )}
      </div>

      {sys.modules.length > 0 && (
        <div className="px-2.5 pb-2.5 flex flex-col gap-1.5">
          {sys.modules.map(m => (
            <ModuleLine key={m.perm} label={m.label}
              state={m.granted ? "on" : isAdmin ? "admin" : "off"} />
          ))}
        </div>
      )}

      {orphan && (
        <p className="px-2.5 pb-2 text-[10px] font-medium text-amber-600 leading-snug">
          No system access — these modules stay hidden
        </p>
      )}
    </div>
  )
}

/** A permission that is not tied to one system. */
function PermChip({ label, note, on }: { label: string; note?: string; on: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full text-[11px] border ${
      on ? "bg-emerald/10 border-emerald/25 text-emerald" : "bg-ground border-border text-ink-3/50"
    }`}>
      {on ? <Tick /> : <Hollow />}
      <span className="font-medium">{label}</span>
      {note && <span className={on ? "text-emerald/60" : "text-ink-3/40"}>· {note}</span>}
    </span>
  )
}

/* ─── Group card ─── */
function GroupCard({ group, members, onRefresh }: {
  group: Group; members: string[]; onRefresh: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState("")

  const v = readPerms(group.permissions)
  const open   = v.systems.filter(s => s.open)
  const orphan = v.systems.filter(s => !s.open && s.modules.some(m => m.granted))
  const shut   = v.systems.filter(s => !s.open && !s.modules.some(m => m.granted))
  const panels = [...open, ...orphan]

  async function del() {
    const warning = members.length > 0
      ? `Delete group "${group.name}"? ${members.length} user(s) lose these permissions.`
      : `Delete group "${group.name}"?`
    if (!confirm(warning)) return
    setSaving(true)
    setError("")
    try {
      // The reply was ignored here, so a refused delete looked like a silent
      // no-op: the row simply came back on the refresh with no reason given.
      const r = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", groupId: group.id }),
      })
      if (!r.ok) {
        setError((await r.json().catch(() => ({}))).error ?? `Delete failed (${r.status})`)
        return
      }
      onRefresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {editing && (
        <GroupEditModal group={group} onSaved={onRefresh} onClose={() => setEditing(false)} />
      )}
      <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
        {/* Header — click to open. Collapsed, it still shows a colour dot per
            open system, so a glance says how much the group reaches. */}
        <div className={`flex items-start gap-3 px-4 py-3 bg-ground/30 ${expanded ? "border-b border-border" : ""}`}>
          <button type="button" onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
            aria-controls={`group-perms-${group.id}`}
            className="min-w-0 flex-1 flex items-start gap-2.5 text-left group/head">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
              className={`mt-1 flex-shrink-0 text-ink-3/60 group-hover/head:text-ink transition-transform ${expanded ? "rotate-90" : ""}`}>
              <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-ink group-hover/head:text-emerald transition-colors">{group.name}</span>
                {v.isAdmin && <Badge variant="blue">Admin</Badge>}
                <span className="text-[11px] text-ink-3/70 tabular-nums">
                  {members.length === 0
                    ? "no members"
                    : `${members.length} ${members.length === 1 ? "user" : "users"}`}
                </span>
              </div>
              {group.description && (
                <p className="text-xs text-ink-3 mt-0.5 truncate">{group.description}</p>
              )}
              <div className="flex items-center gap-2 mt-1">
                <span className="flex items-center gap-1">
                  {open.map(s => (
                    <span key={s.id} title={s.label}
                      className={`w-2 h-2 rounded-full ${s.dot} ring-1 ring-black/5`} />
                  ))}
                  {orphan.length > 0 && (
                    <span title={`${orphan.length} system(s) with modules granted but no access`}
                      className="w-2 h-2 rounded-full bg-amber-500" />
                  )}
                </span>
                <span className="text-[10px] text-ink-3/60 tabular-nums">
                  {v.systemCount}/{v.systems.length} systems · {v.moduleCount} modules
                </span>
              </div>
            </div>
          </button>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button onClick={() => setEditing(true)}
              className="h-7 px-2.5 rounded-lg text-xs font-medium text-ink-3 bg-surface border border-border hover:bg-border/40 transition-colors">
              Edit
            </button>
            <button disabled={saving} onClick={del}
              className="h-7 px-2.5 rounded-lg text-xs font-medium text-ember bg-ember/10 hover:bg-ember/20 disabled:opacity-40 transition-colors">
              Delete
            </button>
          </div>
        </div>

        {error && (
          <p className="px-4 py-2 text-[11px] font-medium text-ember bg-ember/5 border-t border-ember/20">
            {error}
          </p>
        )}

        {/* Systems, each with its activated modules underneath */}
        {expanded && (
        <div id={`group-perms-${group.id}`} className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest">
              Systems &amp; modules
            </p>
            <span className="h-px flex-1 bg-border" />
          </div>

          {panels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center">
              <p className="text-xs font-medium text-ink-3">No system access</p>
              <p className="text-[11px] text-ink-3/60 mt-0.5">
                Members can sign in, but the hub stays empty. Use Edit to open a system.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {panels.map(sys => <SystemPanel key={sys.id} sys={sys} isAdmin={v.isAdmin} />)}
            </div>
          )}

          <div className="pt-1">
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest mb-1.5">
              Every system
            </p>
            <div className="flex flex-wrap gap-1.5">
              <PermChip label="Admin & Management" note="users · groups · history" on={v.isAdmin} />
              {SHARED_MODULES.map(m => (
                <PermChip key={m.perm} label={m.label} note={m.note.replace("every system · ", "")}
                  on={group.permissions.includes(m.perm)} />
              ))}
            </div>
          </div>

          {/* Only worth naming when some systems are open — otherwise the
              empty state above already says the group reaches nothing. */}
          {shut.length > 0 && panels.length > 0 && (
            <p className="flex items-center gap-x-2 gap-y-1 flex-wrap text-[10px] text-ink-3/50 pt-0.5">
              <span className="font-semibold uppercase tracking-widest">Closed</span>
              {shut.map(s => (
                <span key={s.id} className="inline-flex items-center gap-1">
                  <span className={`w-1.5 h-1.5 rounded-full ${s.dot} opacity-30`} />
                  {s.label}
                </span>
              ))}
            </p>
          )}

          {v.other.length > 0 && (
            <p className="text-[10px] text-ink-3/50 pt-0.5">Unrecognised: {v.other.join(", ")}</p>
          )}

          {members.length > 0 && (
            <p className="text-[10px] text-ink-3/50 pt-0.5">
              <span className="font-semibold uppercase tracking-widest">Members</span>{" "}
              {members.join(", ")}
            </p>
          )}
        </div>
        )}
      </div>
    </>
  )
}

/* ─── New group modal ─── */
function NewGroupModal({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const [name, setName] = useState("")
  const [desc, setDesc] = useState("")
  const [perms, setPerms] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function save() {
    if (!name.trim()) { setError("Name is required"); return }
    setError("")
    setSaving(true)
    try {
      const r = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: name.trim(), description: desc, permissions: perms }),
      })
      if (!r.ok) setError((await r.json()).error ?? "Failed")
      else onCreated()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="New group" onClose={onClose} wide>
      <Field label="Name">
        <input autoFocus className={INPUT} value={name} onChange={e => setName(e.target.value)} placeholder="group-name" />
      </Field>
      <Field label="Description">
        <input className={INPUT} value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional" />
      </Field>

      <PermPicker perms={perms} setPerms={setPerms} />

      {error && <p className="text-xs text-ember font-medium">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button onClick={save} disabled={saving}
          className="flex-1 h-9 rounded-xl bg-emerald text-white text-sm font-semibold hover:bg-emerald/90 disabled:opacity-50 transition-colors">
          {saving ? "Creating…" : "Create group"}
        </button>
        <button onClick={onClose}
          className="h-9 px-4 rounded-xl border border-border text-sm font-medium text-ink-3 hover:bg-ground transition-colors">
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/* ─── Groups ─── */
function GroupsPanel() {
  const [groups, setGroups] = useState<Group[]>([])
  const [members, setMembers] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

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

  useEffect(() => { load() }, [load])

  return (
    <div>
      {showNew && (
        <NewGroupModal onCreated={() => { setShowNew(false); load() }} onClose={() => setShowNew(false)} />
      )}

      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border bg-ground/60">
        <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest">
          {loading ? "Loading…" : `${groups.length} ${groups.length === 1 ? "group" : "groups"}`}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading}
            className="w-7 h-7 rounded-lg bg-surface border border-border flex items-center justify-center text-ink-3 hover:bg-border/40 disabled:opacity-40 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className={loading ? "animate-spin" : ""}>
              <path d="M21 12a9 9 0 11-3.2-6.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <path d="M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button onClick={() => setShowNew(true)}
            className="h-7 px-3 rounded-lg bg-emerald text-white text-xs font-semibold hover:bg-emerald/90 transition-colors whitespace-nowrap">
            + New group
          </button>
        </div>
      </div>

      <div className="p-4 space-y-3 bg-ground/40">
        {loading ? (
          <p className="py-10 text-center text-sm text-ink-3">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-3">No groups</p>
        ) : (
          <>
            {groups.map(g => (
              <GroupCard key={g.id} group={g} members={members[g.name] ?? []} onRefresh={load} />
            ))}
            <p className="flex items-center gap-1.5 flex-wrap pt-1 text-[10px] text-ink-3/60">
              Click a group to see its systems and the modules under them · an
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              dot means modules are granted while their system stays closed
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/* ─── Customers table ─── */
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
const CUSTOMER_SYSTEMS: { id: CustomerSystem; label: string; flagLabel: string }[] = [
  { id: "ecuador", label: "Ecuador", flagLabel: "Used in delivery import" },
  { id: "kenya",   label: "Kenya",   flagLabel: "Used in box weight" },
]

function CustomersTable() {
  const [system, setSystem] = useState<CustomerSystem>("ecuador")
  const [rows, setRows] = useState<CustomerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [savingAll, setSavingAll] = useState(false)
  const [query, setQuery] = useState("")
  const selectAllRef = useRef<HTMLInputElement>(null)

  const active = CUSTOMER_SYSTEMS.find(s => s.id === system)!

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

  useEffect(() => { load() }, [load])
  useEffect(() => { setQuery("") }, [system])

  // Select-all is Ecuador-only on purpose: that list is short and every entry
  // is a plausible delivery-import target, whereas Kenya's is the tenant's
  // whole customer book and ticking all of it would point the box-weight
  // module at every invoice on the system.
  const canSelectAll = system === "ecuador"
  const allChecked = rows.length > 0 && rows.every(r => r.checked)
  const someChecked = rows.some(r => r.checked)

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
      <div className="px-5 py-3 border-b border-border flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-ground border border-border rounded-xl p-1 w-fit">
          {CUSTOMER_SYSTEMS.map(s => (
            <button key={s.id} onClick={() => setSystem(s.id)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                system === s.id ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"
              }`}>
              {s.label}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search name or id…"
          className="h-8 px-3 rounded-lg text-xs border border-border bg-surface outline-none focus:border-emerald/50 transition-colors w-56"
        />
        <span className="text-xs text-ink-3">
          {someChecked ? `${rows.filter(r => r.checked).length} selected` : "none selected"}
          {query.trim() && ` · showing ${visible.length} of ${rows.length}`}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-ground/60">
              <Th>Customer</Th>
              <Th>ID</Th>
              <th className="px-4 py-2.5 text-center text-[10px] font-semibold text-ink-3 uppercase tracking-widest">
                <div className="flex flex-col items-center gap-1">
                  <span>{active.flagLabel}</span>
                  {canSelectAll && (
                    <label className="flex items-center gap-1.5 normal-case font-medium text-ink-3 cursor-pointer">
                      <input ref={selectAllRef} type="checkbox" className="accent-emerald w-3.5 h-3.5 cursor-pointer"
                        checked={allChecked}
                        disabled={savingAll || loading || rows.length === 0}
                        onChange={e => toggleAll(e.target.checked)} />
                      <span>Select all</span>
                    </label>
                  )}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={3} className="px-4 py-10 text-center text-sm text-ink-3">Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={3} className="px-4 py-10 text-center text-sm text-ink-3">
                {rows.length === 0 ? "No customers" : "Nothing matches that search"}
              </td></tr>
            ) : visible.map(r => (
              <tr key={r.id} className="border-b border-border hover:bg-ground/40 transition-colors">
                <td className="px-4 py-3 text-sm font-medium text-ink">{r.name}</td>
                <td className="px-4 py-3 text-xs text-ink-3 tabular-nums">#{r.id}</td>
                <td className="px-4 py-3 text-center">
                  <input type="checkbox" className="accent-emerald w-4 h-4 cursor-pointer"
                    checked={r.checked}
                    disabled={savingId === r.id}
                    onChange={e => toggle(r, e.target.checked)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─── Main ─── */
export default function AdminTab({ currentUsername }: { currentUsername?: string }) {
  const [activeTab, setActiveTab] = useState<"users" | "groups" | "customers">("users")

  return (
    <div>
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-center gap-1 bg-ground border border-border rounded-xl p-1 w-fit">
          {(["users", "groups", "customers"] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                activeTab === tab ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"
              }`}>
              {tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "users"
        ? <UsersTable currentUsername={currentUsername} />
        : activeTab === "groups"
        ? <GroupsPanel />
        : <CustomersTable />}
    </div>
  )
}
