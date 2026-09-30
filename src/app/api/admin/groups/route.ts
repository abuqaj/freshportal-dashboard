import { NextRequest, NextResponse } from "next/server"
import type { Session } from "next-auth"
import { auth } from "@/lib/auth"
import { listGroups, createGroup, updateGroup, deleteGroup } from "@/lib/auth-db"

function requireAdmin(session: Session | null) {
  if (!session?.user?.permissions?.includes("admin:manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  return null
}

// Default groups are no longer re-seeded on a cold start, so a change that
// leaves no group with admin:manage shuts everyone out of Admin for good, with
// no way back through the UI. Returns the refusal, or null when it is safe.
async function refuseIfLastAdminGroup(gid: number, keepsAdmin: boolean) {
  const groups = await listGroups()
  const target = groups.find(g => g.id === gid)
  if (!target) return NextResponse.json({ error: "Group not found" }, { status: 404 })
  if (keepsAdmin) return null
  const adminGroups = groups.filter(g => g.permissions?.includes("admin:manage"))
  if (adminGroups.length === 1 && adminGroups[0].id === gid) {
    return NextResponse.json({
      error: `"${target.name}" is the only group with Admin & Management. Give another group that permission first, or nobody can reach Admin again.`,
    }, { status: 409 })
  }
  return null
}

export async function GET() {
  const session = await auth()
  const deny = requireAdmin(session)
  if (deny) return deny
  const groups = await listGroups()
  return NextResponse.json({ groups })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  const deny = requireAdmin(session)
  if (deny) return deny

  const { action, groupId, name, description, permissions } = await req.json()

  try {
    switch (action) {
      case "create": {
        if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 })
        const group = await createGroup(name, description ?? "", permissions ?? [])
        return NextResponse.json({ ok: true, group })
      }
      case "update": {
        if (!groupId) return NextResponse.json({ error: "groupId required" }, { status: 400 })
        // Unticking Admin & Management on the last group that has it locks
        // Admin just as deleting that group does (review 2026-09-25).
        const refusal = await refuseIfLastAdminGroup(
          Number(groupId), (permissions ?? []).includes("admin:manage"))
        if (refusal) return refusal
        await updateGroup(groupId, description ?? "", permissions ?? [], name?.trim() || undefined)
        return NextResponse.json({ ok: true })
      }
      case "delete": {
        if (!groupId) return NextResponse.json({ error: "groupId required" }, { status: 400 })
        const gid = Number(groupId)
        const refusal = await refuseIfLastAdminGroup(gid, false)
        if (refusal) return refusal
        await deleteGroup(gid)
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
