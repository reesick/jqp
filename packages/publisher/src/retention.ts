import { getDb, loadEnv, rootLogger } from "@jqp/core";

/**
 * Retention purge for commenter PII.
 *
 * Neither this app nor OpenReply had any retention policy — DM logs, raw
 * webhook payloads and comment events accumulated forever. That is a real
 * data-protection exposure (we hold other people's usernames and comment
 * text, not our own data) and Meta's platform terms expect data minimisation.
 *
 * Two different treatments, deliberately:
 *   - Raw webhook payloads are DELETED. They are an unstructured copy of
 *     everything Meta sent, they are only useful for short-term debugging,
 *     and nothing downstream reads them.
 *   - DM/comment logs are ANONYMISED IN PLACE, not deleted — the row stays so
 *     historical counts on the dashboard don't silently change, but the
 *     columns identifying a specific human are nulled out.
 *
 * Runs against OpenReply's tables as well as our own; both live in the same
 * `public` schema (see openreply-bridge.ts). Every statement is guarded on
 * table existence so a fresh install without OpenReply migrated doesn't fail.
 */

export interface PurgeResult {
  webhookEventsDeleted: number;
  dmLogsAnonymised: number;
  commentEventsAnonymised: number;
  ourWebhookEventsDeleted: number;
}

async function tableExists(name: string): Promise<boolean> {
  const sql = getDb();
  const rows = await sql<{ exists: boolean }[]>`select to_regclass(${`public.${name}`}) is not null as exists`;
  return rows[0]?.exists ?? false;
}

/**
 * @param dryRun when true, counts what WOULD be affected without changing
 * anything — always run this first against real data.
 */
export async function purgeExpiredData(opts: { dryRun?: boolean } = {}): Promise<PurgeResult> {
  const sql = getDb();
  const env = loadEnv();
  const dryRun = opts.dryRun ?? false;
  const log = rootLogger.child({ job: "purge-expired-data", dryRun });

  const rawDays = env.RAW_PAYLOAD_RETENTION_DAYS;
  const piiDays = env.PII_RETENTION_DAYS;
  const result: PurgeResult = {
    webhookEventsDeleted: 0,
    dmLogsAnonymised: 0,
    commentEventsAnonymised: 0,
    ourWebhookEventsDeleted: 0
  };

  // postgres.js can't parameterise an interval literal, so build it from the
  // validated integer in env (zod guarantees it's a positive int, never user input).
  const rawCutoff = new Date(Date.now() - rawDays * 86_400_000);
  const piiCutoff = new Date(Date.now() - piiDays * 86_400_000);

  if (await tableExists('"WebhookEvent"')) {
    if (dryRun) {
      const rows = await sql<{ count: string }[]>`select count(*) from "WebhookEvent" where "createdAt" < ${rawCutoff}`;
      result.webhookEventsDeleted = Number(rows[0]?.count ?? 0);
    } else {
      const rows = await sql`delete from "WebhookEvent" where "createdAt" < ${rawCutoff} returning 1`;
      result.webhookEventsDeleted = rows.length;
    }
  }

  if (await tableExists('"DmLog"')) {
    if (dryRun) {
      const rows = await sql<{ count: string }[]>`
        select count(*) from "DmLog" where "createdAt" < ${piiCutoff} and "commenterName" is not null
      `;
      result.dmLogsAnonymised = Number(rows[0]?.count ?? 0);
    } else {
      // Row kept (dashboard counts stay stable), identifying columns cleared.
      // commenterId is left in place: it's an opaque Meta-scoped id, and it's the
      // dedup key the send path relies on.
      const rows = await sql`
        update "DmLog"
        set "commenterName" = null, "commentText" = ''
        where "createdAt" < ${piiCutoff} and "commenterName" is not null
        returning 1
      `;
      result.dmLogsAnonymised = rows.length;
    }
  }

  if (await tableExists("comment_events")) {
    if (dryRun) {
      const rows = await sql<{ count: string }[]>`
        select count(*) from comment_events where created_at < ${piiCutoff} and commenter_username is not null
      `;
      result.commentEventsAnonymised = Number(rows[0]?.count ?? 0);
    } else {
      const rows = await sql`
        update comment_events
        set commenter_username = null, comment_text = ''
        where created_at < ${piiCutoff} and commenter_username is not null
        returning 1
      `;
      result.commentEventsAnonymised = rows.length;
    }
  }

  if (await tableExists("webhook_events")) {
    if (dryRun) {
      const rows = await sql<{ count: string }[]>`select count(*) from webhook_events where received_at < ${rawCutoff}`;
      result.ourWebhookEventsDeleted = Number(rows[0]?.count ?? 0);
    } else {
      const rows = await sql`delete from webhook_events where received_at < ${rawCutoff} returning 1`;
      result.ourWebhookEventsDeleted = rows.length;
    }
  }

  log.info("purge_completed", { ...result, rawDays, piiDays });
  return result;
}
