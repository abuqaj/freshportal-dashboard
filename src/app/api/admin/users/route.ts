import { NextRequest, NextResponse } from "next/server"
import type { Session } from "next-auth"
import { auth } from "@/lib/auth"
import {
  listUsers, createUser, updateUserPassword, updateUsername,
  toggleUserActive, deleteUser, setUserGroups, unlockUser,
} from "@/lib/auth-db"

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
  const users = await listUsers()
  return NextResponse.json({ users })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  const deny = requireAdmin(session)
  if (deny) return deny

  const { action, userId, username, newUsername, password, groupIds, isActive } = await req.json()

  try {
    switch (action) {
      case "create": {
        if (!username || !password) return NextResponse.json({ error: "Username and password required" }, { status: 400 })
        const user = await createUser(username, password, groupIds ?? [])
        return NextResponse.json({ ok: true, user })
      }
      case "updateUsername": {
        if (!userId || !newUsername) return NextResponse.json({ error: "userId and newUsername required" }, { status: 400 })
        await updateUsername(userId, newUsername)
        return NextResponse.json({ ok: true })
      }
      case "changePassword": {
        if (!userId || !password) return NextResponse.json({ error: "userId and password required" }, { status: 400 })
        await updateUserPassword(userId, password)
        return NextResponse.json({ ok: true })
      }
      case "toggleActive": {
        if (userId == null || isActive == null) return NextResponse.json({ error: "userId and isActive required" }, { status: 400 })
        await toggleUserActive(userId, isActive)
        return NextResponse.json({ ok: true })
      }
      case "setGroups": {
        if (userId == null || !Array.isArray(groupIds)) return NextResponse.json({ error: "userId and groupIds required" }, { status: 400 })
        await setUserGroups(userId, groupIds)
        return NextResponse.json({ ok: true })
      }
      case "unlock": {
        if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 })
        await unlockUser(userId)
        return NextResponse.json({ ok: true })
      }
      case "delete": {
        if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 })
        // Prevent deleting own account
        if (String(userId) === session?.user?.id) return NextResponse.json({ error: "Cannot delete own account" }, { status: 400 })
        await deleteUser(userId)
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
