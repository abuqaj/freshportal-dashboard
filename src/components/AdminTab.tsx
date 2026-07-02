"use client"

import { useState, useEffect, useCallback, useRef } from "react"

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

const SYSTEM_DEFS: { id: string; label: string; dot: string; modules: { perm: string; label: string }[] }[] = [
  {
    id: "stamgegevens", label: "Stamgegevens", dot: "bg-emerald",
    modules: [
      { perm: "vbn:check",       label: "VBN Check" },
      { perm: "vbn:fix",         label: "VBN Fix" },
      { perm: "products:create", label: "New Products" },
      { perm: "photos:upload",   label: "Photo Uploader" },
    ],
  },
  {
    id: "ecuador", label: "Ecuador", dot: "bg-[#E8A200]",
    modules: [
      { perm: "delivery:import", label: "Delivery Import" },
      { perm: "catalogue:sync",  label: "Catalogue Sync" },
    ],
  },
  { id: "piazza",      label: "Piazza dei Fiori", dot: "bg-[#009246]", modules: [] },
  { id: "netherlands", label: "Netherlands",       dot: "bg-[#AE1C28]", modules: [] },
  { id: "kenya",       label: "Kenya",             dot: "bg-[#006600]", modules: [] },
  { id: "coloriginz",  label: "Coloriginz",        dot: "bg-[#7C3AED]", modules: [] },
]

const PERM_LABELS: Record<string, string> = {
  "vbn:check":       "VBN Check",
  "vbn:fix":         "VBN Fix",
  "products:create": "New Products",
  "photos:upload":   "Photo Uploader",
  "delivery:import": "Delivery Import",
  "catalogue:sync":  "Catalogue Sync",
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
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="bg-surface rounded-3xl border border-border shadow-2xl w-full max-w-md">
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
    </div>
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
            return (
              <div key={sys.id}
                className={`rounded-xl border transition-all ${sysChecked ? "border-emerald/30 bg-emerald/5" : "border-border bg-ground/30"}`}>
                {/* System row */}
                <label className="flex items-center gap-2.5 cursor-pointer px-3 py-2.5">
                  <input type="checkbox" className="accent-emerald w-4 h-4 flex-shrink-0"
                    checked={sysChecked}
                    onChange={e => toggleSystem(sys.id, e.target.checked)} />
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sys.dot}`} />
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
              </div>
            )
          })}
        </div>
      </Field>

      <Field label="Shared">
        <div className={`rounded-xl border px-3 py-2.5 transition-all ${hasPerm("admin:manage") ? "border-emerald/30 bg-emerald/5" : "border-border bg-ground/30"}`}>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" className="accent-emerald w-4 h-4"
              checked={hasPerm("admin:manage")}
              onChange={e => togglePerm("admin:manage", e.target.checked)} />
            <span className="text-sm font-semibold text-ink">Admin & Management</span>
            <span className="text-xs text-ink-3 ml-1">all systems · users · history</span>
          </label>
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
    <Modal title={`Edit group: ${group.name}`} onClose={onClose}>
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

/* ─── Group row ─── */
function GroupRow({ group, onRefresh }: { group: Group; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  async function del() {
    if (!confirm(`Delete group "${group.name}"? Users lose these permissions.`)) return
    setSaving(true)
    try {
      await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", groupId: group.id }),
      })
      onRefresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {editing && (
        <GroupEditModal group={group} onSaved={onRefresh} onClose={() => setEditing(false)} />
      )}
      <tr className="border-b border-border hover:bg-ground/40 transition-colors">
        <td className="px-4 py-3">
          <span className="text-sm font-medium text-ink">{group.name}</span>
        </td>
        <td className="px-4 py-3 text-xs text-ink-3">{group.description || <span className="opacity-30">—</span>}</td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {group.permissions.filter(p => p.startsWith("system:")).map(p => {
              const sysId = p.replace("system:", "")
              const sys = SYSTEM_DEFS.find(s => s.id === sysId)
              return (
                <span key={p} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border bg-muted text-ink-3 border-border">
                  <span className={`w-1.5 h-1.5 rounded-full ${sys?.dot ?? "bg-ink-3"}`} />
                  {sys?.label ?? sysId}
                </span>
              )
            })}
            {group.permissions.filter(p => !p.startsWith("system:")).map(p =>
              <Badge key={p} variant="green">{PERM_LABELS[p] ?? p}</Badge>
            )}
            {group.permissions.length === 0 && <span className="text-xs text-ink-3/40">—</span>}
          </div>
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-1.5">
            <button onClick={() => setEditing(true)}
              className="h-7 px-2.5 rounded-lg text-xs font-medium text-ink-3 bg-ground border border-border hover:bg-border/40 transition-colors">
              Edit
            </button>
            <button disabled={saving} onClick={del}
              className="h-7 px-2.5 rounded-lg text-xs font-medium text-ember bg-ember/10 hover:bg-ember/20 disabled:opacity-40 transition-colors">
              Delete
            </button>
          </div>
        </td>
      </tr>
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
    <Modal title="New group" onClose={onClose}>
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

/* ─── Groups table ─── */
function GroupsTable() {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch("/api/admin/groups").then(r => r.json())
      setGroups(r.groups ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="overflow-x-auto">
      {showNew && (
        <NewGroupModal onCreated={() => { setShowNew(false); load() }} onClose={() => setShowNew(false)} />
      )}
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-ground/60">
            <Th>Name</Th>
            <Th>Description</Th>
            <Th>Permissions</Th>
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
                  + New group
                </button>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-ink-3">Loading…</td></tr>
          ) : groups.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-ink-3">No groups</td></tr>
          ) : groups.map(g => (
            <GroupRow key={g.id} group={g} onRefresh={load} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ─── Main ─── */
export default function AdminTab({ currentUsername }: { currentUsername?: string }) {
  const [activeTab, setActiveTab] = useState<"users" | "groups">("users")

  return (
    <div>
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-center gap-1 bg-ground border border-border rounded-xl p-1 w-fit">
          {(["users", "groups"] as const).map(tab => (
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
        : <GroupsTable />}
    </div>
  )
}
