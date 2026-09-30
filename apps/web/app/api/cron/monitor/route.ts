import { NextResponse } from "next/server";
import { runMonitor } from "@jqp/publisher";
import { apiError } from "../../_lib/api-error";
import { requireMonitorToken } from "../../_lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Evaluates system health and emails on state changes. Call every 5-10 minutes
 * from a scheduler (.github/workflows/monitor.yml). Safe to call more often:
 * alerts fire on transitions, not on every call.
 */
export async function POST(request: Request) {
  const refused = requireMonitorToken(request);
  if (refused) return refused;

  try {
    const result = await runMonitor();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    return apiError("monitor_failed", err, { publicMessage: "Monitor run failed." });
  }
}
