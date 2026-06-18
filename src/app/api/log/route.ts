import { NextRequest, NextResponse } from "next/server";
import { logOperation } from "@/lib/db";
import { auth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const session = await auth();
  const username = session?.user?.name ?? null;
  const { type, vbn_filter, stats, details } = await req.json();
  await logOperation(type, vbn_filter ?? null, stats ?? {}, details ?? {}, username);
  return NextResponse.json({ ok: true });
}
