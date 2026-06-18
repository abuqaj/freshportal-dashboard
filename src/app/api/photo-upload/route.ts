import { NextRequest, NextResponse } from "next/server";
import { logOperation } from "@/lib/db";
import { auth } from "@/lib/auth";

export const maxDuration = 300;

const RAILWAY_URL = process.env.RAILWAY_API_URL;

export async function POST(req: NextRequest) {
  const session = await auth();
  const username = session?.user?.name ?? null;
  if (!RAILWAY_URL) {
    return NextResponse.json({ error: "RAILWAY_API_URL not configured" }, { status: 500 });
  }

  const formData = await req.formData();
  const xlsxFile = formData.get("xlsx") as File | null;

  if (!xlsxFile) {
    return NextResponse.json({ error: "No xlsx file provided" }, { status: 400 });
  }

  try {
    // Forward the file directly to Railway
    const fd = new FormData();
    fd.append("xlsx", xlsxFile);

    const res = await fetch(`${RAILWAY_URL}/photo-upload`, {
      method: "POST",
      body: fd,
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json({ error: data.detail ?? "Railway API error" }, { status: res.status });
    }

    await logOperation("photo_upload", null, {}, { file: xlsxFile.name }, username);

    return NextResponse.json({ success: true, ...data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
