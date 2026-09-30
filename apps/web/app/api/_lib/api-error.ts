import { NextResponse } from "next/server";
import { loadEnv, rootLogger, newCorrelationId } from "@jqp/core";
import { recordEvent } from "@jqp/publisher";

/**
 * Turns an exception into an HTTP response without leaking internals.
 *
 * In production the caller gets a generic message plus a correlation id; the
 * real message goes to the logs under that same id, so support is still
 * possible ("send me the id") without putting driver errors — which carry the
 * DB host, port, database and role — into a browser, a screenshot, or a proxy
 * access log.
 *
 * In development the real message is returned inline, because this is a
 * single-operator tool and losing the error text behind an id every time you
 * typo a column name is a genuinely worse experience for no security gain.
 */
export function apiError(
  event: string,
  err: unknown,
  opts: { status?: number; publicMessage?: string; fields?: Record<string, unknown> } = {}
): NextResponse {
  const env = loadEnv();
  const status = opts.status ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  const correlationId = newCorrelationId("err");

  rootLogger.error(event, { ...opts.fields, correlationId, error: message });
  // Durable copy so the failure is still visible tomorrow (Vercel keeps logs briefly).
  // Fire-and-forget: recording must never slow down or break the error response.
  if (status >= 500) void recordEvent({ level: "error", source: "api", code: event, message, correlationId });

  const body =
    env.NODE_ENV === "production"
      ? { success: false, error: opts.publicMessage ?? "Something went wrong.", correlationId }
      : { success: false, error: message, correlationId };

  return NextResponse.json(body, { status });
}
