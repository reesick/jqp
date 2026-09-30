import { getDb, loadEnv, rootLogger } from "@jqp/core";

/**
 * Durable event log (table: system_events, migration 0008).
 *
 * Rules this file enforces so callers can't get them wrong:
 *  - It NEVER throws and never makes a caller wait on the database for long.
 *    Recording a failure must not be able to cause a second failure.
 *  - It stores nothing personal. `message` and `meta` are scrubbed: secrets and
 *    connection strings are redacted, long opaque blobs are cut, and meta keys
 *    that look like personal content (names, text, emails, tokens) are dropped.
 *  - If the table doesn't exist yet (migration not applied) it degrades to a
 *    log line, so deploying the code before the SQL is safe.
 */

export type EventLevel = "info" | "warn" | "error";
export type EventSource = "publish" | "dm-sync" | "api" | "auth" | "monitor" | "retention";

export interface RecordEventInput {
  level: EventLevel;
  source: EventSource;
  /** Stable machine-readable code, e.g. "post_publish_failed". Alerts and counts key on this. */
  code: string;
  message: string;
  correlationId?: string;
  meta?: Record<string, unknown>;
}

export interface SystemEvent {
  id: number;
  created_at: string;
  level: EventLevel;
  source: string;
  code: string;
  message: string;
  correlation_id: string | null;
  meta: Record<string, unknown>;
}

const MAX_MESSAGE = 300;
const DROP_META_KEYS = /(name|text|comment|email|username|handle|token|secret|password|authorization|cookie|key|url|payload|body)/i;

/** Redacts things that must never be persisted. Exported for tests. */
export function scrubText(input: string): string {
  return input
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"')]+/gi, "[url]") // any URL, incl. postgres://user:pass@host
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]") // long opaque strings: tokens, keys, hashes
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

/** Keeps only primitive, non-personal meta values. Exported for tests. */
export function scrubMeta(meta: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!meta) return out;
  for (const [key, value] of Object.entries(meta)) {
    if (DROP_META_KEYS.test(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = scrubText(value).slice(0, 120);
  }
  return out;
}

let warnedMissingTable = false;

function isMissingTable(err: unknown): boolean {
  const text = String(err);
  return /system_events|alert_state/.test(text) && /does not exist/.test(text);
}

export async function recordEvent(input: RecordEventInput): Promise<void> {
  try {
    const sql = getDb();
    const meta = scrubMeta(input.meta);
    await Promise.race([
      sql`
        insert into system_events (level, source, code, message, correlation_id, meta)
        values (${input.level}, ${input.source}, ${input.code.slice(0, 80)}, ${scrubText(input.message)}, ${input.correlationId?.slice(0, 80) ?? null}, ${sql.json(meta)})
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error("recordEvent timed out")), 4000))
    ]);
  } catch (err) {
    if (isMissingTable(err)) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        rootLogger.warn("system_events_table_missing", { hint: "apply supabase/migrations/0008_system_events.sql" });
      }
      return;
    }
    rootLogger.warn("record_event_failed", { code: input.code, error: scrubText(err instanceof Error ? err.message : String(err)) });
  }
}

export async function listRecentEvents(opts: { limit?: number; levels?: EventLevel[]; sinceHours?: number } = {}): Promise<SystemEvent[]> {
  const sql = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const levels = opts.levels ?? ["warn", "error"];
  const since = new Date(Date.now() - (opts.sinceHours ?? 24 * 7) * 3_600_000);
  try {
    return await sql<SystemEvent[]>`
      select id, created_at, level, source, code, message, correlation_id, meta
      from system_events
      where level in ${sql(levels)} and created_at > ${since}
      order by created_at desc
      limit ${limit}
    `;
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export async function purgeOldEvents(): Promise<number> {
  const sql = getDb();
  const days = loadEnv().SYSTEM_EVENT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  try {
    const rows = await sql`delete from system_events where created_at < ${cutoff} returning id`;
    return rows.length;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}
