import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { writeFile, mkdir } from "fs/promises";
import { logOperation } from "@/lib/db";

function runPython(scriptPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, ...args], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0 && !stdout) reject(new Error(stderr || `Exit ${code}`));
      else resolve(stdout);
    });
  });
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const xlsxFile = formData.get("xlsx") as File | null;

  if (!xlsxFile) {
    return NextResponse.json({ error: "No xlsx file provided" }, { status: 400 });
  }

  // Save uploaded xlsx temporarily
  const tmpDir = path.join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `upload_${Date.now()}.xlsx`);
  const bytes = await xlsxFile.arrayBuffer();
  await writeFile(tmpPath, Buffer.from(bytes));

  const scriptPath = path.join(process.cwd(), "python", "photo_uploader.py");

  try {
    const output = await runPython(scriptPath, ["--xlsx", tmpPath]);

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(output);
    } catch {
      data = { message: output.trim() };
    }

    await logOperation("photo_upload", null, {}, { file: xlsxFile.name });
    return NextResponse.json({ success: true, ...data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
