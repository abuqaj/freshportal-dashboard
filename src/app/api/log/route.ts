import { NextRequest, NextResponse } from "next/server";
import { logOperation } from "@/lib/db";
import { auth } from "@/lib/auth";

const ALLOWED_TYPES = new Set(["vbn_check", "vbn_fix", "product_create", "photo_upload", "sync", "auto_vbn"]);

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const username = session.user?.name ?? null;
  const { type, vbn_filter, stats, details } = await req.json();
  if (!ALLOWED_TYPES.has(type)) return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  await logOperation(type, vbn_filter ?? null, stats ?? {}, details ?? {}, username);
  return NextResponse.json({ ok: true });
}
