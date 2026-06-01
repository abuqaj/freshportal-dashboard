import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
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
  const { fixes } = await req.json();
  if (!fixes || !Array.isArray(fixes) || fixes.length === 0) {
    return NextResponse.json({ error: "No fixes provided" }, { status: 400 });
  }

  const scriptPath = path.join(process.cwd(), "python", "fix_runner.py");

  try {
    const output = await runPython(scriptPath, ["--fixes", JSON.stringify(fixes)]);
    const data = JSON.parse(output);

    if (data.error) {
      return NextResponse.json({ error: data.error }, { status: 500 });
    }

    await logOperation("vbn_fix", null, { fixed: data.fixed, failed: data.failed }, { fixes });

    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
