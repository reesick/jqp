import { NextResponse } from "next/server";
import { sendHealthDigest } from "@jqp/publisher";
import { apiError } from "../../_lib/api-error";
import { requireMonitorToken } from "../../_lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Emails the full health and activity summary. Called on a schedule by .github/workflows/monitor.yml. */
export async function POST(request: Request) {
  const refused = requireMonitorToken(request);
  if (refused) return refused;

  try {
    const result = await sendHealthDigest();
    return NextResponse.json({ success: result.sent, data: result }, { status: result.sent ? 200 : 502 });
  } catch (err) {
    return apiError("digest_failed", err, { publicMessage: "Digest run failed." });
  }
}
