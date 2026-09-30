import { NextResponse } from "next/server";
import { purgeExpiredData, purgeOldEvents, recordEvent } from "@jqp/publisher";
import { apiError } from "../../_lib/api-error";
import { requireMonitorToken } from "../../_lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily data-retention run, triggered from the cloud so it no longer depends on
 * the operator's PC being on (the local worker used to be the only thing that
 * ran it). Anonymises commenter data past PII_RETENTION_DAYS, deletes raw
 * webhook payloads past RAW_PAYLOAD_RETENTION_DAYS, and prunes old system events.
 */
export async function POST(request: Request) {
  const refused = requireMonitorToken(request);
  if (refused) return refused;

  try {
    const purge = await purgeExpiredData();
    const eventsDeleted = await purgeOldEvents();
    await recordEvent({
      level: "info",
      source: "retention",
      code: "retention_run_completed",
      message: "Retention purge completed",
      meta: { ...purge, eventsDeleted }
    });
    return NextResponse.json({ success: true, data: { ...purge, eventsDeleted } });
  } catch (err) {
    return apiError("purge_failed", err, { publicMessage: "Retention run failed." });
  }
}
