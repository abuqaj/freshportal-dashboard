import { sql } from "@vercel/postgres";

export async function ensureTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS operations (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      vbn_filter TEXT,
      stats JSONB,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

export async function logOperation(
  type: string,
  vbn_filter: string | null,
  stats: object,
  details: object
) {
  try {
    await ensureTables();
    await sql`
      INSERT INTO operations (type, vbn_filter, stats, details)
      VALUES (${type}, ${vbn_filter}, ${JSON.stringify(stats)}, ${JSON.stringify(details)})
    `;
  } catch {
    // non-fatal — log to console if DB unavailable
    console.warn("DB log failed (DB not configured?)");
  }
}

export async function getHistory(limit = 50) {
  try {
    await ensureTables();
    const { rows } = await sql`
      SELECT id, type, vbn_filter, stats, created_at
      FROM operations
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  } catch {
    return [];
  }
}
