"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { signOut } from "next-auth/react"

interface User {
  id: number
  username: string
  is_active: boolean
  created_at: string
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

const ALL_PERMISSIONS = ["vbn:check", "vbn:fix", "products:create", "photos:upload", "admin:manage"]
const PERM_LABELS: Record<string, string> = {
  "vbn:check":       "VBN Check",
  "vbn:fix":         "VBN Fix",
  "products:create": "Products",
  "photos:upload":   "Photos",
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
        <div className="px-6 py-5 space-y-4">{children}</div>
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
function UserEditModal({ user, groups, currentUsername, onSaved, onClose }: {
  user: User; groups: Group[]; currentUsername: string | undefined
  onSaved: () => void; onClose: () => void
}) {
  const [username, setUsername] = useState(user.username)
  const [groupId, setGroupId] = useState<number | null>(
    user.groups.length > 0 ? (groups.find(g => g.name === user.groups[0])?.id ?? null) : null
  )
  const [isActive, setIsActive] = useState(user.is_active)
  const [password, setPassword] = useState("")
  const [confirmPw, setConfirmPw] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

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
    if (password && password !== confirmPw) { setError("Passwords do not match"); return }
    if (!username.trim()) { setError("Username is required"); return }
    setError("")
    setSaving(true)
    try {
      if (username !== user.username) await api({ action: "updateUsername", userId: user.id, newUsername: username.trim() })
      await api({ action: "setGroups", userId: user.id, groupIds: groupId != null ? [groupId] : [] })
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
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="group" className="accent-emerald"
              checked={groupId === null}
              onChange={() => setGroupId(null)} />
            <span className="text-sm text-ink-3 italic">No group</span>
          </label>
          {groups.map(g => (
            <label key={g.id} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="group" className="accent-emerald"
                checked={groupId === g.id}
                onChange={() => setGroupId(g.id)} />
              <span className="text-sm text-ink">{g.name}</span>
              <span className="text-xs text-ink-3">({g.permissions.map(p => PERM_LABELS[p] ?? p).join(", ")})</span>
            </label>
          ))}
        </div>
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

/* ─── Group edit modal ─── */
function GroupEditModal({ group, onSaved, onClose }: {
  group: Group; onSaved: () => void; onClose: () => void
}) {
  const [desc, setDesc] = useState(group.description)
  const [perms, setPerms] = useState<string[]>(group.permissions)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function save() {
    setError("")
    setSaving(true)
    try {
      const r = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", groupId: group.id, description: desc, permissions: perms }),
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
      <Field label="Description">
        <input className={INPUT} value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional" />
      </Field>

      <Field label="Permissions">
        <div className="flex flex-col gap-2">
          {ALL_PERMISSIONS.map(p => (
            <label key={p} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-emerald w-4 h-4"
                checked={perms.includes(p)}
                onChange={e => setPerms(prev => e.target.checked ? [...prev, p] : prev.filter(x => x !== p))} />
              <span className="text-sm text-ink">{PERM_LABELS[p] ?? p}</span>
            </label>
          ))}
        </div>
      </Field>

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
function UserRow({ user, groups, currentUsername, onRefresh }: {
  user: User; groups: Group[]; currentUsername: string | undefined; onRefresh: () => void
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
          groups={groups}
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
function NewUserRow({ groups, onCreated, onCancel }: {
  groups: Group[]; onCreated: () => void; onCancel: () => void
}) {
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
      <td colSpan={6} className="px-4 py-3">
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
function UsersTable({ groups, currentUsername }: { groups: Group[]; currentUsername: string | undefined }) {
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
                  className="h-7 px-3 rounded-lg bg-emerald text-white text-xs font-semibold hover:bg-emerald/90 transition-colors">
                  + New user
                </button>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {showNew && (
            <NewUserRow groups={groups} onCreated={() => { setShowNew(false); load() }} onCancel={() => setShowNew(false)} />
          )}
          {loading ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-ink-3">Loading…</td></tr>
          ) : users.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-ink-3">No users</td></tr>
          ) : users.map(u => (
            <UserRow key={u.id} user={u} groups={groups} currentUsername={currentUsername} onRefresh={load} />
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
            {group.permissions.length
              ? group.permissions.map(p => <Badge key={p} variant="green">{PERM_LABELS[p] ?? p}</Badge>)
              : <span className="text-xs text-ink-3/40">—</span>}
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

/* ─── New group row ─── */
function NewGroupRow({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState("")
  const [desc, setDesc] = useState("")
  const [perms, setPerms] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError("")
    try {
      const r = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name, description: desc, permissions: perms }),
      })
      if (!r.ok) setError((await r.json()).error ?? "Failed")
      else onCreated()
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="border-b border-border bg-emerald/5">
      <td colSpan={4} className="px-4 py-3">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div>
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest mb-1.5">Name</p>
            <input required autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="group-name"
              className="h-8 px-3 rounded-xl border border-border bg-surface text-xs text-ink w-32
                         focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all" />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest mb-1.5">Description</p>
            <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional"
              className="h-8 px-3 rounded-xl border border-border bg-surface text-xs text-ink w-44
                         focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all" />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-widest mb-1.5">Permissions</p>
            <div className="flex flex-wrap gap-3">
              {ALL_PERMISSIONS.map(p => (
                <label key={p} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" className="accent-emerald"
                    checked={perms.includes(p)}
                    onChange={e => setPerms(prev => e.target.checked ? [...prev, p] : prev.filter(x => x !== p))} />
                  <span className="text-xs text-ink">{PERM_LABELS[p] ?? p}</span>
                </label>
              ))}
            </div>
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
                  className="h-7 px-3 rounded-lg bg-emerald text-white text-xs font-semibold hover:bg-emerald/90 transition-colors">
                  + New group
                </button>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {showNew && (
            <NewGroupRow onCreated={() => { setShowNew(false); load() }} onCancel={() => setShowNew(false)} />
          )}
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
  const [groups, setGroups] = useState<Group[]>([])

  const loadGroups = useCallback(async () => {
    const r = await fetch("/api/admin/groups").then(r => r.json())
    setGroups(r.groups ?? [])
  }, [])

  useEffect(() => { loadGroups() }, [loadGroups])

  return (
    <div>
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-1 bg-ground border border-border rounded-xl p-1">
          {(["users", "groups"] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                activeTab === tab ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"
              }`}>
              {tab}
            </button>
          ))}
        </div>
        <button onClick={() => signOut({ callbackUrl: "/login" })}
          className="h-8 px-3 rounded-xl bg-ground border border-border text-xs font-medium text-ink-3 hover:bg-border/40 transition-colors">
          Sign out
        </button>
      </div>

      {activeTab === "users"
        ? <UsersTable groups={groups} currentUsername={currentUsername} />
        : <GroupsTable />}
    </div>
  )
}
