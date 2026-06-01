import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { logOperation } from "@/lib/db";

function runPython(scriptPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, ...args], {
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(stderr || `Process exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function POST(req: NextRequest) {
  const { vbn } = await req.json();
  if (!vbn || typeof vbn !== "string") {
    return NextResponse.json({ error: "Missing vbn parameter" }, { status: 400 });
  }

  const scriptPath = path.join(process.cwd(), "python", "vbn_runner.py");

  try {
    const output = await runPython(scriptPath, ["--vbn", vbn]);
    const data = JSON.parse(output);

    if (data.error) {
      return NextResponse.json({ error: data.error }, { status: 500 });
    }

    await logOperation("vbn_check", vbn, data.stats ?? {}, { result_count: data.results?.length ?? 0 });

    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
