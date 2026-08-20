import { NextResponse } from "next/server";
import { getDb, rootLogger } from "@jqp/core";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated by design — it's in middleware.ts's PUBLIC_PATHS so uptime
 * checks and Render/Vercel probes can reach it without a session.
 *
 * Because it IS public, it must not describe the system. It previously
 * returned the raw postgres.js error message plus NODE_ENV and MOCK_META;
 * driver errors routinely carry the DB host, port, database name and role, so
 * that handed anyone on the internet a map of the infrastructure. Now the
 * detail goes to the logs and the caller gets a liveness signal only.
 */
export async function GET() {
  let dbOk = false;

  try {
    const sql = getDb();
    await sql`select 1`;
    dbOk = true;
  } catch (err) {
    rootLogger.error("health_check_db_failed", { error: err instanceof Error ? err.message : String(err) });
  }

  return NextResponse.json(
    { success: dbOk, db: dbOk ? "ok" : "error", ts: new Date().toISOString() },
    { status: dbOk ? 200 : 503 }
  );
}
