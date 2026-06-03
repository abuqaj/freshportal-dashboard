import { NextRequest, NextResponse } from "next/server";
import { logOperation } from "@/lib/db";

export const maxDuration = 300;

const RAILWAY_URL = process.env.RAILWAY_API_URL;

export async function POST(req: NextRequest) {
  if (!RAILWAY_URL) {
    return NextResponse.json({ error: "RAILWAY_API_URL not configured" }, { status: 500 });
  }

  const { vbn } = await req.json();
  if (!vbn || typeof vbn !== "string") {
    return NextResponse.json({ error: "Missing vbn parameter" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${RAILWAY_URL}/vbn-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vbn }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Cannot reach Railway: ${msg}` }, { status: 502 });
  }

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: `Railway error (${res.status}): ${text.slice(0, 300)}` }, { status: 502 });
  }

  if (!res.ok) {
    return NextResponse.json({ error: data.detail ?? "Railway API error" }, { status: res.status });
  }

  await logOperation("vbn_check", vbn, data.stats ?? {}, { result_count: (data.results as unknown[])?.length ?? 0 });

  return NextResponse.json(data);
}
