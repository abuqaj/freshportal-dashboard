import { NextRequest, NextResponse } from "next/server";
import { getHistory, logOperation } from "@/lib/db";

const PAGE_SIZE = 10;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit  = Math.min(parseInt(searchParams.get("limit")  ?? String(PAGE_SIZE), 10), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10), 0);

  // Fetch one extra to detect hasMore
  const rows = await getHistory(limit + 1, offset);
  const hasMore = rows.length > limit;
  return NextResponse.json({ history: rows.slice(0, limit), hasMore });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  await logOperation(body.type, body.vbn_filter ?? null, body.stats ?? {}, body.details ?? {});
  return NextResponse.json({ ok: true });
}
