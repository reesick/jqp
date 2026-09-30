import { getDb } from "@jqp/core";

/**
 * Cross-schema stats — OpenReply's tables live in the same `public`
 * schema as ours now (see openreply-bridge.ts for why), so we can
 * query its DmLog/Automation tables directly instead of round-
 * tripping through its API. This is read-only and best-effort: if
 * OpenReply's tables don't exist yet (fresh install, migrations not
 * run), every OpenReply-derived stat just falls back to zero rather
 * than breaking the dashboard.
 */

export interface DashboardStats {
  posts: { total: number; published: number; failed: number; inProgress: number };
  campaigns: { total: number; enabled: number; synced: number };
  dm: { totalSent: number; sentLast7Days: number; totalFailed: number };
}

export interface RecentDm {
  id: string;
  commenterName: string | null;
  commentText: string | null;
  matchedKeyword: string | null;
  status: string;
  dmSentAt: string | null;
  createdAt: string;
}

// OpenReply's tables never disappear once migrated, so a positive answer is
// cached for the life of the process. Without this every DM query paid an
// extra database round trip first. A negative answer is deliberately not
// cached, so the dashboard picks the tables up as soon as they exist.
let openReplyTablesKnown = false;

async function openReplyTablesExist(): Promise<boolean> {
  if (openReplyTablesKnown) return true;
  const sql = getDb();
  const rows = await sql<{ exists: boolean }[]>`select to_regclass('public."DmLog"') is not null as exists`;
  openReplyTablesKnown = rows[0]?.exists ?? false;
  return openReplyTablesKnown;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const sql = getDb();

  const [postRows, campaignRows] = await Promise.all([
    sql<{ status: string; count: string }[]>`select status, count(*) from posts group by status`,
    sql<{ enabled: boolean; sync_status: string; count: string }[]>`select enabled, sync_status, count(*) from campaigns group by enabled, sync_status`
  ]);

  const posts = { total: 0, published: 0, failed: 0, inProgress: 0 };
  for (const row of postRows) {
    const count = Number(row.count);
    posts.total += count;
    if (row.status === "PUBLISHED") posts.published += count;
    else if (row.status === "FAILED" || row.status === "VALIDATION_FAILED") posts.failed += count;
    else posts.inProgress += count;
  }

  const campaigns = { total: 0, enabled: 0, synced: 0 };
  for (const row of campaignRows) {
    const count = Number(row.count);
    campaigns.total += count;
    if (row.enabled) campaigns.enabled += count;
    if (row.sync_status === "DM_SYNCED") campaigns.synced += count;
  }

  const dm = { totalSent: 0, sentLast7Days: 0, totalFailed: 0 };
  if (await openReplyTablesExist()) {
    const dmRows = await sql<{ status: string; count: string; recent: string }[]>`
      select status, count(*), count(*) filter (where "dmSentAt" > now() - interval '7 days') as recent
      from "DmLog" group by status
    `;
    for (const row of dmRows) {
      const count = Number(row.count);
      if (row.status === "SENT") {
        dm.totalSent += count;
        dm.sentLast7Days += Number(row.recent);
      } else if (row.status === "FAILED") {
        dm.totalFailed += count;
      }
    }
  }

  return { posts, campaigns, dm };
}

export async function getRecentDms(limit = 8): Promise<RecentDm[]> {
  const sql = getDb();
  if (!(await openReplyTablesExist())) return [];
  return sql<RecentDm[]>`
    select id, "commenterName", "commentText", "matchedKeyword", status, "dmSentAt", "createdAt"
    from "DmLog"
    order by "createdAt" desc
    limit ${limit}
  `;
}

export interface TokenHealth {
  /** Accounts whose token expires within the warning horizon, or has already expired. */
  expiring: { username: string; instagramId: string; tokenExpiresAt: string | null; daysLeft: number | null }[];
  /** Most recent TOKEN_REFRESH failure, if any is still unresolved. */
  lastRefreshError: { message: string; createdAt: string } | null;
}

/**
 * Instagram token expiry / refresh health.
 *
 * OpenReply's daily refresh cron logs an OperationalEvent on failure, returns
 * 200 and moves on — no retry, no alert, no account disable. Left alone, a
 * token quietly expires and every publish and DM stops working with nothing
 * visible anywhere. This surfaces both signals on our own dashboard so the
 * failure is loud instead of silent.
 */
export async function getTokenHealth(warnWithinDays = 14): Promise<TokenHealth> {
  const sql = getDb();
  const empty: TokenHealth = { expiring: [], lastRefreshError: null };
  if (!(await openReplyTablesExist())) return empty;

  const [accounts, errors] = await Promise.all([
    sql<{ username: string; instagramId: string; tokenExpiresAt: string | null }[]>`
      select "username", "instagramId", "tokenExpiresAt"
      from "InstagramAccount"
      where "tokenExpiresAt" is not null
        and "tokenExpiresAt" < now() + ${`${warnWithinDays} days`}::interval
    `,
    sql<{ message: string; createdAt: string }[]>`
      select "message", "createdAt"
      from "OperationalEvent"
      where "source" = 'TOKEN_REFRESH' and "level" = 'ERROR' and "resolvedAt" is null
      order by "createdAt" desc
      limit 1
    `
  ]);

  return {
    expiring: accounts.map((a) => ({
      ...a,
      daysLeft: a.tokenExpiresAt
        ? Math.floor((new Date(a.tokenExpiresAt).getTime() - Date.now()) / 86_400_000)
        : null
    })),
    lastRefreshError: errors[0] ?? null
  };
}

export async function getDmLogs(opts: { status?: string; limit?: number; offset?: number } = {}): Promise<{ rows: RecentDm[]; total: number }> {
  const sql = getDb();
  if (!(await openReplyTablesExist())) return { rows: [], total: 0 };

  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const [rows, countRows] = await Promise.all([
    opts.status
      ? sql<RecentDm[]>`
          select id, "commenterName", "commentText", "matchedKeyword", status, "dmSentAt", "createdAt"
          from "DmLog"
          where status = ${opts.status}
          order by "createdAt" desc
          limit ${limit} offset ${offset}
        `
      : sql<RecentDm[]>`
          select id, "commenterName", "commentText", "matchedKeyword", status, "dmSentAt", "createdAt"
          from "DmLog"
          order by "createdAt" desc
          limit ${limit} offset ${offset}
        `,
    opts.status
      ? sql<{ count: string }[]>`select count(*) from "DmLog" where status = ${opts.status}`
      : sql<{ count: string }[]>`select count(*) from "DmLog"`
  ]);

  return { rows, total: Number(countRows[0]?.count ?? 0) };
}
