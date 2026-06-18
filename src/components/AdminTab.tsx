"use client"

import { useState, useEffect, useCallback } from "react"
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

const PERM_LABELS: Record<string, string> = {
  "vbn:check":      "VBN Check",
  "vbn:fix":        "VBN Fix",
  "products:create":"Create products",
  "photos:upload":  "Upload photos",
  "admin:manage":   "Admin",
}

function Badge({ children, variant = "neutral" }: { children: React.ReactNode; variant?: "green" | "red" | "neutral" | "blue" }) {
  const cls = {
    green:   "bg-emerald/10 text-emerald border-emerald/20",
    red:     "bg-ember/10 text-ember border-ember/20",
    neutral: "bg-muted text-ink-3 border-border",
    blue:    "bg-[#1A6FD4]/10 text-[#1A6FD4] border-[#1A6FD4]/20",
  }[variant]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${cls}`}>
      {children}
    </span>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wider">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}

/* ─── New User Form ─── */
function NewUserForm({ groups, onCreated, onCancel }: {
  groups: Group[]
  onCreated: () => void
  onCancel: () => void
}) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [selectedGroups, setSelectedGroups] = useState<number[]>([])
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
        body: JSON.stringify({ action: "create", username, password, groupIds: selectedGroups }),
      })
      if (!r.ok) {
        const d = await r.json()
        setError(d.error ?? "Failed")
      } else {
        onCreated()
      }
    } catch {
      setError("Network error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="bg-ground border border-border rounded-2xl p-4 space-y-3">
      <div className="flex gap-2">
        <input
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          className="flex-1 h-9 px-3 rounded-xl border border-border bg-surface text-sm text-ink
                     focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="flex-1 h-9 px-3 rounded-xl border border-border bg-surface text-sm text-ink
                     focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => (
          <label key={g.id} className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={selectedGroups.includes(g.id)}
              onChange={(e) => setSelectedGroups(prev =>
                e.target.checked ? [...prev, g.id] : prev.filter(id => id !== g.id)
              )}
              className="accent-emerald"
            />
            <span className="text-xs text-ink">{g.name}</span>
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-ember">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving}
          className="h-8 px-4 rounded-xl bg-emerald text-white text-xs font-semibold hover:bg-emerald/90 disabled:opacity-50 transition-colors">
          {saving ? "Creating…" : "Create user"}
        </button>
        <button type="button" onClick={onCancel}
          className="h-8 px-4 rounded-xl bg-muted text-ink-3 text-xs font-medium hover:bg-border/40 transition-colors">
          Cancel
        </button>
      </div>
    </form>
  )
}

/* ─── User Row ─── */
function UserRow({ user, groups, onRefresh, currentUserId }: {
  user: User
  groups: Group[]
  onRefresh: () => void
  currentUserId: string | undefined
}) {
  const [expanded, setExpanded] = useState(false)
  const [newPw, setNewPw] = useState("")
  const [saving, setSaving] = useState(false)
  const [selectedGroups, setSelectedGroups] = useState<number[]>([])

  useEffect(() => {
    const gids = user.groups.map(gName => groups.find(g => g.name === gName)?.id).filter(Boolean) as number[]
    setSelectedGroups(gids)
  }, [user.groups, groups])

  async function apiCall(body: object) {
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

  const isSelf = String(user.id) === currentUserId
  const isLocked = !!user.locked_until && new Date(user.locked_until) > new Date()

  return (
    <div className={`border rounded-2xl overflow-hidden ${isLocked ? "border-ember/40" : "border-border"} ${!user.is_active ? "opacity-60" : ""}`}>
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-ground/60 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isLocked ? "bg-ember" : user.is_active ? "bg-emerald" : "bg-ink-3/30"}`} />
        <span className="text-sm font-medium text-ink flex-1">{user.username}</span>
        {isSelf && <Badge variant="blue">you</Badge>}
        {isLocked && <Badge variant="red">locked</Badge>}
        {user.groups.map(g => <Badge key={g} variant="neutral">{g}</Badge>)}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
          className={`text-ink-3/50 transition-transform ${expanded ? "rotate-180" : ""}`}>
          <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {expanded && (
        <div className="border-t border-border bg-ground px-4 py-3 space-y-3">
          {/* Groups */}
          <div>
            <p className="text-xs font-medium text-ink-3 mb-2">Groups</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={selectedGroups.includes(g.id)}
                    onChange={(e) => setSelectedGroups(prev =>
                      e.target.checked ? [...prev, g.id] : prev.filter(id => id !== g.id)
                    )}
                    className="accent-emerald"
                  />
                  <span className="text-xs text-ink">{g.name}</span>
                </label>
              ))}
            </div>
            <button
              disabled={saving}
              onClick={() => apiCall({ action: "setGroups", userId: user.id, groupIds: selectedGroups })}
              className="h-7 px-3 rounded-lg bg-emerald/10 text-emerald text-xs font-medium hover:bg-emerald/20 disabled:opacity-50 transition-colors"
            >
              Save groups
            </button>
          </div>

          {/* Change password */}
          <div>
            <p className="text-xs font-medium text-ink-3 mb-2">Change password</p>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="New password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                className="flex-1 h-8 px-3 rounded-xl border border-border bg-surface text-xs text-ink
                           focus:outline-none focus:border-emerald/60 focus:ring-2 focus:ring-emerald/15 transition-all"
              />
              <button
                disabled={saving || !newPw}
                onClick={() => { apiCall({ action: "changePassword", userId: user.id, password: newPw }); setNewPw("") }}
                className="h-8 px-3 rounded-xl bg-ground border border-border text-xs font-medium text-ink hover:bg-border/40 disabled:opacity-50 transition-colors"
              >
                Save
              </button>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 flex-wrap">
            {isLocked && (
              <button
                disabled={saving}
                onClick={() => apiCall({ action: "unlock", userId: user.id })}
                className="h-7 px-3 rounded-lg bg-amber-500/10 text-amber-600 text-xs font-medium hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
              >
                Unlock
              </button>
            )}
            <button
              disabled={saving || isSelf}
              onClick={() => apiCall({ action: "toggleActive", userId: user.id, isActive: !user.is_active })}
              className="h-7 px-3 rounded-lg bg-ground border border-border text-xs font-medium text-ink-3 hover:bg-border/40 disabled:opacity-50 transition-colors"
            >
              {user.is_active ? "Deactivate" : "Activate"}
            </button>
            <button
              disabled={saving || isSelf}
              onClick={() => { if (confirm(`Delete user "${user.username}"?`)) apiCall({ action: "delete", userId: user.id }) }}
              className="h-7 px-3 rounded-lg bg-ember/10 text-ember text-xs font-medium hover:bg-ember/20 disabled:opacity-50 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Main Component ─── */
export default function AdminTab({ currentUsername }: { currentUsername?: string }) {
  const [users, setUsers] = useState<User[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewUser, setShowNewUser] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ur, gr] = await Promise.all([
        fetch("/api/admin/users").then(r => r.json()),
        fetch("/api/admin/groups").then(r => r.json()),
      ])
      setUsers(ur.users ?? [])
      setGroups(gr.groups ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const currentUserId = users.find(u => u.username === currentUsername)?.id?.toString()

  return (
    <div>
      {/* Header */}
      <div className="px-6 py-5 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink">Admin</h2>
          <p className="text-xs text-ink-3 mt-0.5">Manage users and permissions</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="w-8 h-8 rounded-xl bg-ground border border-border flex items-center justify-center text-ink-3 hover:bg-border/40 transition-colors disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              className={loading ? "animate-spin" : ""}>
              <path d="M21 12a9 9 0 11-3.2-6.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <path d="M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="h-8 px-3 rounded-xl bg-ground border border-border text-xs font-medium text-ink-3 hover:bg-border/40 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="p-6 space-y-8">
        {/* Users section */}
        <Section
          title="Users"
          action={
            <button
              onClick={() => setShowNewUser(v => !v)}
              className="h-7 px-3 rounded-xl bg-emerald text-white text-xs font-semibold hover:bg-emerald/90 transition-colors"
            >
              + New user
            </button>
          }
        >
          {showNewUser && (
            <div className="mb-3">
              <NewUserForm
                groups={groups}
                onCreated={() => { setShowNewUser(false); load() }}
                onCancel={() => setShowNewUser(false)}
              />
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center h-16 text-ink-3 text-sm">Loading…</div>
          ) : users.length === 0 ? (
            <div className="text-sm text-ink-3 text-center py-4">No users</div>
          ) : (
            <div className="space-y-2">
              {users.map(u => (
                <UserRow key={u.id} user={u} groups={groups} onRefresh={load} currentUserId={currentUserId} />
              ))}
            </div>
          )}
        </Section>

        {/* Groups section */}
        <Section title="Groups & permissions">
          {loading ? (
            <div className="flex items-center justify-center h-16 text-ink-3 text-sm">Loading…</div>
          ) : (
            <div className="space-y-2">
              {groups.map(g => (
                <div key={g.id} className="bg-ground border border-border rounded-2xl px-4 py-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium text-ink">{g.name}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(g.permissions ?? []).map(p => (
                      <Badge key={p} variant="green">{PERM_LABELS[p] ?? p}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
