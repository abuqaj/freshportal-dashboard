export async function register() {
  // Only runs in Node.js runtime — Vercel Postgres is not available in Edge.
  // Fires once per Lambda cold start, warming the DDL singleton so the first
  // real request doesn't pay the migration round-trip cost.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureTables } = await import("./lib/db");
    const { ensureAuthTables } = await import("./lib/auth-db");
    await Promise.all([ensureTables(), ensureAuthTables()]).catch(() => {
      // DB not reachable at startup (e.g. missing POSTGRES_URL in dev) — ignore,
      // each call site will retry and handle its own error.
    });
  }
}
