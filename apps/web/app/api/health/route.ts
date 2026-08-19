import { NextResponse } from "next/server";
import { getDb, loadEnv } from "@jqp/core";

export const dynamic = "force-dynamic";

export async function GET() {
  const env = loadEnv();
  let dbOk = false;
  let dbError: string | undefined;

  try {
    const sql = getDb();
    await sql`select 1`;
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const body = {
    success: dbOk,
    db: dbOk ? "ok" : "error",
    dbError,
    mockMeta: env.MOCK_META,
    nodeEnv: env.NODE_ENV,
    ts: new Date().toISOString()
  };

  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
