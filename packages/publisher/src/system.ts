import { getDb, loadEnv } from "@jqp/core";
import { listRecentEvents, scrubText, type SystemEvent } from "./events.js";
import { getDashboardStats, getTokenHealth, type DashboardStats, type TokenHealth } from "./stats.js";
import { publishingChecks } from "./publishing-checks.js";

/**
 * One consolidated, privacy-safe view of "is the system working?".
 *
 * Consumed by the /system page and by the scheduled monitor (which turns the
 * `failing` checks into alert emails). Everything here is aggregate or
 * technical: no commenter names, no comment text, no tokens.
 */

export type ServiceState = "ok" | "warn" | "down";

export interface ServiceStatus {
  key: string;
  label: string;
  state: ServiceState;
  detail: string;
  latencyMs?: number;
}

export interface DmWindow {
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
}

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface SystemSnapshot {
  generatedAt: string;
  services: ServiceStatus[];
  dm: {
    last24h: DmWindow;
    lastHourSent: number;
    hourlyLimit: number;
    failureRate24h: number | null;
    byDay: { day: string; sent: number; failed: number }[];
    topFailures: { reason: string; count: number }[];
  };
  queue: QueueCounts | null;
  failedPosts: number;
  lastWebhookAt: string | null;
  token: TokenHealth;
  events: SystemEvent[];
  openReplyErrors: { id: string; source: string; level: string; message: string; createdAt: string }[];
}

/** OpenReply's documented per-account ceiling for private replies; see docs/COMPLIANCE.md. */
export const HOURLY_DM_LIMIT = 750;

const FAILURE_RATE_WARN = 0.1;
const FAILURE_RATE_DOWN = 0.5;
const MIN_ATTEMPTS_FOR_RATE = 10;
const QUEUE_BACKLOG_WARN = 200;

interface OpenReplyHealth {
  reachable: boolean;
  timedOut: boolean;
  httpStatus?: number;
  latencyMs: number;
  checks?: {
    database?: { status?: string };
    redis?: { status?: string; detail?: string };
    queue?: { status?: string; counts?: Partial<QueueCounts> };
    worker?: { healthy?: boolean; ageMs?: number | null };
  };
}

async function fetchOpenReplyHealth(): Promise<OpenReplyHealth> {
  const base = loadEnv().OPENREPLY_DASHBOARD_URL.replace(/\/$/, "");
  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(6000) });
    const body = (await res.json().catch(() => ({}))) as { checks?: OpenReplyHealth["checks"] };
    return { reachable: true, timedOut: false, httpStatus: res.status, latencyMs: Date.now() - started, checks: body.checks };
  } catch (err) {
    // A hung health endpoint is what an unreachable Redis looks like: OpenReply's
    // queue client retries forever, so the request never answers.
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { reachable: false, timedOut, latencyMs: Date.now() - started };
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  const sql = getDb();
  const services: ServiceStatus[] = [];

  // 1. Our database, with latency.
  const dbStart = Date.now();
  let dbOk = true;
  try {
    await sql`select 1`;
  } catch {
    dbOk = false;
  }
  const dbMs = Date.now() - dbStart;
  services.push({
    key: "database",
    label: "Database",
    state: !dbOk ? "down" : dbMs > 1500 ? "warn" : "ok",
    detail: !dbOk ? "Cannot reach Postgres" : dbMs > 1500 ? `Slow: ${dbMs}ms for a trivial query` : `Responding in ${dbMs}ms`,
    latencyMs: dbMs
  });

  if (!dbOk) {
    return {
      generatedAt: new Date().toISOString(),
      services,
      dm: { last24h: { sent: 0, failed: 0, skipped: 0, pending: 0 }, lastHourSent: 0, hourlyLimit: HOURLY_DM_LIMIT, failureRate24h: null, byDay: [], topFailures: [] },
      queue: null,
      failedPosts: 0,
      lastWebhookAt: null,
      token: { expiring: [], lastRefreshError: null },
      events: [],
      openReplyErrors: []
    };
  }

  // 2. OpenReply health (Redis, queue, DM worker) in parallel with the data reads.
  // The page must render even if the database hiccups after the first check, so each read
  // falls back to an empty value and the gap is reported as a warning instead of a 500.
  let dataReadFailed = false;
  const soft = <T,>(promise: Promise<T>, fallback: T): Promise<T> =>
    promise.catch(() => {
      dataReadFailed = true;
      return fallback;
    });
  const emptyStats: DashboardStats = {
    posts: { total: 0, published: 0, failed: 0, inProgress: 0 },
    campaigns: { total: 0, enabled: 0, synced: 0 },
    dm: { totalSent: 0, sentLast7Days: 0, totalFailed: 0 }
  };
  const [health, stats, token, events] = await Promise.all([
    fetchOpenReplyHealth(),
    soft(getDashboardStats(), emptyStats),
    soft(getTokenHealth(), { expiring: [], lastRefreshError: null } as TokenHealth),
    soft(listRecentEvents({ limit: 30, sinceHours: 24 * 7 }), [] as SystemEvent[])
  ]);

  const c = health.checks;
  if (!health.reachable) {
    services.push({
      key: "openreply",
      label: "OpenReply",
      state: "down",
      detail: health.timedOut ? "No answer after 6s. Usually means Redis is unreachable" : "Could not be reached",
      latencyMs: health.latencyMs
    });
  } else {
    services.push({ key: "openreply", label: "OpenReply", state: "ok", detail: `Responding in ${health.latencyMs}ms`, latencyMs: health.latencyMs });
    services.push({
      key: "redis",
      label: "Message queue (Redis)",
      state: c?.redis?.status === "ok" ? "ok" : "down",
      detail: c?.redis?.status === "ok" ? "Connected" : "Not connected. DMs cannot be queued"
    });
    const counts = c?.queue?.counts;
    const backlog = (counts?.waiting ?? 0) + (counts?.delayed ?? 0);
    services.push({
      key: "queue",
      label: "DM queue",
      state: c?.queue?.status !== "ok" ? "down" : backlog > QUEUE_BACKLOG_WARN ? "warn" : "ok",
      detail: c?.queue?.status !== "ok" ? "Cannot read the queue" : `${counts?.waiting ?? 0} waiting, ${counts?.active ?? 0} sending, ${counts?.failed ?? 0} failed`
    });
    const workerAge = c?.worker?.ageMs;
    services.push({
      key: "dm-worker",
      label: "DM worker",
      state: c?.worker?.healthy ? "ok" : "down",
      detail: c?.worker?.healthy ? `Heartbeat ${Math.round((workerAge ?? 0) / 1000)}s ago` : "No recent heartbeat. DMs will not send until it runs"
    });
  }

  // 3. DM outcomes. Aggregates only; failure reasons are scrubbed before grouping.
  const last24h: DmWindow = { sent: 0, failed: 0, skipped: 0, pending: 0 };
  let lastHourSent = 0;
  let byDay: SystemSnapshot["dm"]["byDay"] = [];
  let topFailures: SystemSnapshot["dm"]["topFailures"] = [];
  let lastWebhookAt: string | null = null;
  let openReplyErrors: SystemSnapshot["openReplyErrors"] = [];

  try {
  const tablesExist = (await sql<{ exists: boolean }[]>`select to_regclass('public."DmLog"') is not null as exists`)[0]?.exists ?? false;
  if (tablesExist) {
    const [windowRows, hourRows, dayRows, failureRows, webhookRows, opRows] = await Promise.all([
      sql<{ status: string; count: string }[]>`
        select status, count(*) from "DmLog" where "createdAt" > now() - interval '24 hours' group by status`,
      sql<{ count: string }[]>`
        select count(*) from "DmLog" where status = 'SENT' and "dmSentAt" > now() - interval '1 hour'`,
      sql<{ day: string; sent: string; failed: string }[]>`
        select to_char(date_trunc('day', ("createdAt" at time zone 'UTC') at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as day,
               count(*) filter (where status = 'SENT') as sent,
               count(*) filter (where status = 'FAILED') as failed
        from "DmLog" where "createdAt" > now() - interval '7 days'
        group by 1 order by 1`,
      sql<{ reason: string | null }[]>`
        select "errorMessage" as reason from "DmLog"
        where status = 'FAILED' and "createdAt" > now() - interval '24 hours'
        limit 500`,
      sql<{ at: string | null }[]>`select max("createdAt") as at from "WebhookEvent"`,
      sql<{ id: string; source: string; level: string; message: string; createdAt: string }[]>`
        select id, source::text, level::text, message, "createdAt" from "OperationalEvent"
        where level in ('WARNING', 'ERROR') and "createdAt" > now() - interval '24 hours'
        order by "createdAt" desc limit 10`
    ]);

    for (const row of windowRows) {
      const n = Number(row.count);
      if (row.status === "SENT") last24h.sent += n;
      else if (row.status === "FAILED") last24h.failed += n;
      else if (row.status === "PENDING") last24h.pending += n;
      else last24h.skipped += n;
    }
    lastHourSent = Number(hourRows[0]?.count ?? 0);
    byDay = dayRows.map((r) => ({ day: r.day, sent: Number(r.sent), failed: Number(r.failed) }));

    const grouped = new Map<string, number>();
    for (const r of failureRows) {
      const reason = scrubText(r.reason ?? "Unknown reason").slice(0, 140) || "Unknown reason";
      grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
    }
    topFailures = [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    lastWebhookAt = webhookRows[0]?.at ?? null;
    openReplyErrors = opRows.map((r) => ({ ...r, message: scrubText(r.message) }));
  }

  } catch {
    dataReadFailed = true;
  }

  // 4. Derived service states from the outcomes above.
  const attempts = last24h.sent + last24h.failed;
  const failureRate24h = attempts >= MIN_ATTEMPTS_FOR_RATE ? last24h.failed / attempts : null;
  services.push({
    key: "dm-delivery",
    label: "DM delivery (24h)",
    state: failureRate24h === null ? "ok" : failureRate24h >= FAILURE_RATE_DOWN ? "down" : failureRate24h >= FAILURE_RATE_WARN ? "warn" : "ok",
    detail:
      attempts === 0
        ? "No DMs attempted in the last 24 hours"
        : `${last24h.sent} sent, ${last24h.failed} failed${failureRate24h === null ? "" : ` (${pct(failureRate24h)} failure rate)`}`
  });

  const headroom = lastHourSent / HOURLY_DM_LIMIT;
  services.push({
    key: "rate-limit",
    label: "Hourly send limit",
    state: headroom >= 0.9 ? "down" : headroom >= 0.7 ? "warn" : "ok",
    detail: `${lastHourSent} of ${HOURLY_DM_LIMIT} used in the last hour`
  });

  const tokenIssue = token.lastRefreshError !== null || token.expiring.some((a) => (a.daysLeft ?? 99) <= 7);
  services.push({
    key: "instagram-token",
    label: "Instagram connection",
    state: token.lastRefreshError || token.expiring.some((a) => (a.daysLeft ?? 99) <= 3) ? "down" : tokenIssue ? "warn" : "ok",
    detail: token.lastRefreshError
      ? "Automatic token refresh failed"
      : token.expiring.length > 0
        ? `Token expires in ${token.expiring[0]?.daysLeft ?? "?"} days`
        : "Token healthy"
  });

  // 5. Publishing health: stuck posts, campaigns that never reached OpenReply, and the publishing token's expiry.
  const [stuckRows, syncRows, tokenRows] = await Promise.all([
    soft(
      sql<{ n: number }[]>`
        select count(*)::int as n from posts
        where status::text in ('VALIDATING','UPLOADING','CREATING_CHILDREN','WAITING_FOR_CHILDREN','CREATING_CAROUSEL','WAITING_FOR_CAROUSEL','PUBLISHING')
          and updated_at < now() - interval '30 minutes'`,
      [{ n: 0 }]
    ),
    soft(
      sql<{ failed: number; stuck: number }[]>`
        select count(*) filter (where c.sync_status::text = 'DM_SYNC_FAILED')::int as failed,
               count(*) filter (where c.enabled and p.status::text = 'PUBLISHED' and c.sync_status::text <> 'DM_SYNCED' and c.sync_status::text <> 'DM_SYNC_FAILED' and p.published_at < now() - interval '15 minutes')::int as stuck
        from campaigns c join posts p on p.id = c.post_id`,
      [{ failed: 0, stuck: 0 }]
    ),
    soft(
      sql<{ username: string | null; token_expires_at: string | null }[]>`
        select username, token_expires_at from ig_accounts where is_active and access_token_encrypted is not null`,
      [] as { username: string | null; token_expires_at: string | null }[]
    )
  ]);
  services.push(
    ...publishingChecks({
      stuckPosts: stuckRows[0]?.n ?? 0,
      syncFailed: syncRows[0]?.failed ?? 0,
      syncStuck: syncRows[0]?.stuck ?? 0,
      tokens: tokenRows.map((t) => ({ username: t.username, expiresAt: t.token_expires_at }))
    })
  );

  services.push({
    key: "publishing",
    label: "Publishing",
    state: stats.posts.failed > 0 ? "warn" : "ok",
    detail: stats.posts.failed > 0 ? `${stats.posts.failed} failed ${stats.posts.failed === 1 ? "post needs" : "posts need"} a retry` : "No failed posts"
  });

  if (dataReadFailed) {
    services.push({ key: "data-read", label: "Dashboard data", state: "warn", detail: "Some figures could not be read just now and may be incomplete" });
  }

  return {
    generatedAt: new Date().toISOString(),
    services,
    dm: { last24h, lastHourSent, hourlyLimit: HOURLY_DM_LIMIT, failureRate24h, byDay, topFailures },
    queue: c?.queue?.counts
      ? { waiting: c.queue.counts.waiting ?? 0, active: c.queue.counts.active ?? 0, delayed: c.queue.counts.delayed ?? 0, failed: c.queue.counts.failed ?? 0 }
      : null,
    failedPosts: stats.posts.failed,
    lastWebhookAt,
    token,
    events,
    openReplyErrors
  };
}

/** Services that should trigger an alert. `warn` alerts too, so a problem is known before it is an outage. */
export function failingChecks(snapshot: SystemSnapshot): ServiceStatus[] {
  return snapshot.services.filter((s) => s.state !== "ok");
}
