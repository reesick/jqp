/**
 * Reads Meta's rate-limit headers.
 *
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 *   X-App-Usage                  { call_count, total_cputime, total_time }   (percentages, rolling hour)
 *   X-Business-Use-Case-Usage    { "<id>": [ { type, call_count, total_cputime, total_time,
 *                                              estimated_time_to_regain_access } ] }   (minutes)
 *   Retry-After                  seconds (not always sent)
 *
 * Instagram calls are limited per business use case; error code 80002 means the
 * limit was hit. The only safe response is to stop calling until the time Meta
 * gives in `estimated_time_to_regain_access`.
 */

export interface MetaUsage {
  /** Highest call_count percentage seen across app and business-use-case headers (0-100). */
  callCountPct: number;
  totalTimePct: number;
  totalCpuPct: number;
  /** Minutes until access returns, as reported by Meta; 0 when not throttled. */
  regainMinutes: number;
}

interface UsageBlock {
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
  estimated_time_to_regain_access?: number;
}

export interface HeaderReader {
  get(name: string): string | null;
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Returns null when Meta sent no usage headers at all. */
export function parseMetaUsage(headers: HeaderReader): MetaUsage | null {
  const blocks: UsageBlock[] = [];

  const app = parseJson(headers.get("x-app-usage"));
  if (app && typeof app === "object" && !Array.isArray(app)) blocks.push(app as UsageBlock);

  const buc = parseJson(headers.get("x-business-use-case-usage"));
  if (buc && typeof buc === "object") {
    for (const entries of Object.values(buc as Record<string, unknown>)) {
      if (Array.isArray(entries)) for (const e of entries) if (e && typeof e === "object") blocks.push(e as UsageBlock);
    }
  }

  if (blocks.length === 0) return null;
  return {
    callCountPct: Math.max(...blocks.map((b) => num(b.call_count))),
    totalTimePct: Math.max(...blocks.map((b) => num(b.total_time))),
    totalCpuPct: Math.max(...blocks.map((b) => num(b.total_cputime))),
    regainMinutes: Math.max(...blocks.map((b) => num(b.estimated_time_to_regain_access)))
  };
}

/** How long to wait before the next call, in ms, from the headers Meta sent (0 if it gave no hint). */
export function retryAfterMsFromHeaders(headers: HeaderReader): number {
  const usage = parseMetaUsage(headers);
  const fromUsage = usage ? usage.regainMinutes * 60_000 : 0;
  const retryAfter = Number(headers.get("retry-after"));
  const fromRetryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
  return Math.max(fromUsage, fromRetryAfter);
}

/** Usage level at which we warn: the limit is a hard stop, so act well before it. */
export const USAGE_WARN_PCT = 75;

type UsageObserver = (usage: MetaUsage, path: string) => void;
let observer: UsageObserver | undefined;
let lastWarnAt = 0;
const WARN_INTERVAL_MS = 10 * 60 * 1000;

/** The worker registers a callback here to record high-usage warnings. Throttled to one per 10 minutes. */
export function setMetaUsageObserver(fn: UsageObserver | undefined): void {
  observer = fn;
}

export function noteMetaUsage(usage: MetaUsage | null, path: string): void {
  if (!usage || !observer) return;
  const worst = Math.max(usage.callCountPct, usage.totalTimePct, usage.totalCpuPct);
  if (worst < USAGE_WARN_PCT && usage.regainMinutes === 0) return;
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  try {
    observer(usage, path);
  } catch {
    // Monitoring must never break an API call.
  }
}
