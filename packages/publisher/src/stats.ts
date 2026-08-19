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

async function openReplyTablesExist(): Promise<boolean> {
  const sql = getDb();
  const rows = await sql<{ exists: boolean }[]>`select to_regclass('public."DmLog"') is not null as exists`;
  return rows[0]?.exists ?? false;
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
