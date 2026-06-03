import { NextRequest, NextResponse } from "next/server";
import { logOperation } from "@/lib/db";

export async function POST(req: NextRequest) {
  const { type, vbn_filter, stats, details } = await req.json();
  await logOperation(type, vbn_filter ?? null, stats ?? {}, details ?? {});
  return NextResponse.json({ ok: true });
}
