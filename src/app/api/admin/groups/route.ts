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
        await updateGroup(groupId, description ?? "", permissions ?? [])
        return NextResponse.json({ ok: true })
      }
      case "delete": {
        if (!groupId) return NextResponse.json({ error: "groupId required" }, { status: 400 })
        await deleteGroup(groupId)
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
