import { NextRequest, NextResponse } from "next/server";
import { logOperation } from "@/lib/db";

const RAILWAY_URL = process.env.RAILWAY_API_URL;

export async function POST(req: NextRequest) {
  if (!RAILWAY_URL) {
    return NextResponse.json({ error: "RAILWAY_API_URL not configured" }, { status: 500 });
  }

  const { fixes } = await req.json();
  if (!fixes || !Array.isArray(fixes) || fixes.length === 0) {
    return NextResponse.json({ error: "No fixes provided" }, { status: 400 });
  }

  try {
    const res = await fetch(`${RAILWAY_URL}/vbn-fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixes }),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json({ error: data.detail ?? "Railway API error" }, { status: res.status });
    }

    await logOperation("vbn_fix", null, { fixed: data.fixed, failed: data.failed }, { fixes });

    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
