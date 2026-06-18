import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { listGroups } from "@/lib/auth-db"

export async function GET() {
  const session = await auth()
  if (!session?.user?.permissions?.includes("admin:manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const groups = await listGroups()
  return NextResponse.json({ groups })
}
