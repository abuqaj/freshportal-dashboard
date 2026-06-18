import { sql } from "@vercel/postgres";

// Runs DDL exactly once per Lambda instance. Subsequent calls return the
// cached Promise — no round-trips to Neon on warm requests.
let _ready: Promise<void> | null = null;

export function ensureTables(): Promise<void> {
  if (!_ready) {
    _ready = _migrate().catch((err) => {
      // Reset so the next cold-start attempt can retry.
      _ready = null;
      throw err;
    });
  }
  return _ready;
}

async function _migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS operations (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      vbn_filter TEXT,
      stats JSONB,
      details JSONB,
      username TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS username TEXT`;
}

export async function logOperation(
  type: string,
  vbn_filter: string | null,
  stats: object,
  details: object,
  username?: string | null
) {
  try {
    await ensureTables();
    await sql`
      INSERT INTO operations (type, vbn_filter, stats, details, username)
      VALUES (${type}, ${vbn_filter}, ${JSON.stringify(stats)}, ${JSON.stringify(details)}, ${username ?? null})
    `;
  } catch {
    console.warn("DB log failed (DB not configured?)");
  }
}

export async function getHistory(limit = 50, offset = 0) {
  try {
    await ensureTables();
    const { rows } = await sql`
      SELECT id, type, vbn_filter, stats, details, username, created_at
      FROM operations
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows;
  } catch {
    return [];
  }
}
