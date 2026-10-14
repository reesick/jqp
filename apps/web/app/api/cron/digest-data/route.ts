import { NextResponse } from "next/server";
import { timingSafeEqualString } from "@jqp/core/edge-safe";
import { getDigestSection } from "@jqp/publisher";
import { apiError } from "../../_lib/api-error";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The system half of the combined health email, as data. The VM fetches this every 6 hours and sends ONE email with
 * its own readings next to it. It has its own secret (VM_REPORT_TOKEN), separate from the monitor token, and returns
 * only counts, check names and already-scrubbed event messages. Closed unless the secret is set and long enough.
 */
export async function POST(request: Request) {
  const token = (process.env.VM_REPORT_TOKEN ?? "").trim();
  if (token.length < 24) return NextResponse.json({ success: false, error: "Not configured." }, { status: 503 });
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !timingSafeEqualString(presented, token)) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    return NextResponse.json({ success: true, data: await getDigestSection() });
  } catch (err) {
    return apiError("digest_data_failed", err, { publicMessage: "Could not build the system report." });
  }
}
