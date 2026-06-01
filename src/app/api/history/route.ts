import { NextResponse } from "next/server";
import { getHistory } from "@/lib/db";

export async function GET() {
  const rows = await getHistory(50);
  return NextResponse.json({ history: rows });
}
