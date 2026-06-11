import { NextRequest, NextResponse } from "next/server";
import { getHistory, logOperation } from "@/lib/db";

export async function GET() {
  const rows = await getHistory(50);
  return NextResponse.json({ history: rows });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  await logOperation(body.type, body.vbn_filter ?? null, body.stats ?? {}, body.details ?? {});
  return NextResponse.json({ ok: true });
}
