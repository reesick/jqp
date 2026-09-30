import { NextResponse } from "next/server";
import { loadEnv } from "@jqp/core";
import { timingSafeEqualString } from "@jqp/core/edge-safe";

/**
 * Bearer-token guard for /api/cron/* (called by a scheduler, not a browser, so
 * the dashboard's cookie login doesn't apply). Returns a response to send when
 * the request must be refused, or null when it may proceed.
 *
 * Refuses everything unless MONITOR_TOKEN is set to something long enough to
 * resist guessing, so an unconfigured deployment is closed rather than open.
 */
export function requireMonitorToken(request: Request): NextResponse | null {
  let token = "";
  try {
    token = loadEnv().MONITOR_TOKEN.trim();
  } catch {
    // An invalid environment is a configuration problem, not a server crash.
    return NextResponse.json({ success: false, error: "Monitoring endpoint is not configured." }, { status: 503 });
  }
  if (token.length < 24) {
    return NextResponse.json({ success: false, error: "Monitoring endpoint is not configured." }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !timingSafeEqualString(presented, token)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
