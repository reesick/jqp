import type PgBoss from "pg-boss";
import { rootLogger } from "@jqp/core";
import { getBoss } from "./boss.js";

export const QUEUE = {
  PUBLISH_POST: "publish-post",
  SYNC_CAMPAIGN: "sync-campaign-to-openreply",
  PURGE_EXPIRED_DATA: "purge-expired-data",
  REFRESH_IG_TOKENS: "refresh-ig-tokens"
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/**
 * One publish-post job runs the ENTIRE DISCOVERED -> PUBLISHED
 * pipeline for a post, including container polling — there is no
 * separate poll-containers queue. This is safe specifically because
 * apps/worker is a persistent Render process, not a serverless
 * function with a short timeout (plan section 25's whole reason for
 * Render existing): a job can block on Meta's polling loop for a
 * couple of minutes without anything timing out. Every state
 * transition is still checkpointed to Postgres (see
 * packages/publisher/src/pipeline.ts), so if the worker process
 * itself dies mid-job, pg-boss's retry re-enqueues publish-post and
 * the pipeline resumes from the last persisted status rather than
 * starting over (plan section 66).
 */
export interface PublishPostJobData {
  postId: string; // posts.id
}

export interface SyncCampaignJobData {
  campaignId: string; // campaigns.id (our staging table, not OpenReply's Automation id)
}

/**
 * Retry schedule approximating plan section 51 (30s, 2m, 10m, then
 * stop and surface for manual review): retryLimit 3 means 1 initial
 * attempt + 3 retries = 4 total attempts, retryDelay 30s as the base
 * with exponential backoff. expireInSeconds bounds how long a single
 * attempt may run before pg-boss considers it stalled and retries it —
 * generous here because Meta container polling can legitimately take
 * a couple of minutes.
 */
const QUEUE_DEFAULTS: Omit<PgBoss.Queue, "name"> = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 300
};

/** Creates all queues used by this app if they don't already exist. Safe to call on every process start. */
export async function ensureQueues(): Promise<void> {
  const boss = await getBoss();
  for (const name of Object.values(QUEUE)) {
    const existing = await boss.getQueue(name);
    if (!existing) {
      await boss.createQueue(name, { ...QUEUE_DEFAULTS, name });
      rootLogger.info("queue_created", { name });
    }
  }
}

export async function enqueuePublishPost(data: PublishPostJobData, options: { retry?: boolean } = {}): Promise<string | null> {
  const boss = await getBoss();
  // Retry schedule sized for Meta throttles, which last minutes to hours, not seconds: 8 retries with exponential
  // backoff from 60s (about 1, 2, 4, 8, 16, 32, 64, 128 minutes) cover roughly four hours before the job gives up
  // and the post is left for a manual retry. Per-job options override the queue defaults above.
  //
  // On a standard pg-boss queue a bare singletonKey does nothing. singletonKey + singletonSeconds is a throttle:
  // a second send for the same post inside 30 seconds (a double click) returns null instead of queueing a copy.
  // Longer-term duplicates are stopped inside the pipeline (compare-and-set status changes and the check for an
  // already-live post). expireInSeconds is 15 minutes because one job runs the whole upload, container and publish
  // sequence, which can take several minutes when Meta is slow.
  return boss.send(QUEUE.PUBLISH_POST, data, {
    // A Retry is a deliberate new attempt after a reset, so it gets its own key and cannot be swallowed by the double-click throttle.
    singletonKey: options.retry ? `post:${data.postId}:retry:${Date.now()}` : `post:${data.postId}`,
    singletonSeconds: 30,
    expireInSeconds: 900,
    retryLimit: 8,
    retryDelay: 60,
    retryBackoff: true
  });
}

export async function enqueueSyncCampaign(data: SyncCampaignJobData): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(QUEUE.SYNC_CAMPAIGN, data, { singletonKey: `sync:${data.campaignId}` });
}

async function registerWorker<T extends object>(queueName: QueueName, handler: (data: T, jobId: string) => Promise<void>): Promise<void> {
  const boss = await getBoss();
  // One job at a time. The handlers below run a fetched batch one after another while all of them share the
  // queue's expiry clock, so a larger batch only made later jobs expire before they started.
  await boss.work<T>(queueName, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const log = rootLogger.child({ queue: queueName, jobId: job.id });
      try {
        await handler(job.data, job.id);
      } catch (err) {
        log.error("job_handler_error", { error: err });
        throw err; // rethrow so pg-boss records the failure and applies retry policy
      }
    }
  });
}

export function registerPublishPostWorker(handler: (data: PublishPostJobData, jobId: string) => Promise<void>): Promise<void> {
  return registerWorker(QUEUE.PUBLISH_POST, handler);
}

export function registerSyncCampaignWorker(handler: (data: SyncCampaignJobData, jobId: string) => Promise<void>): Promise<void> {
  return registerWorker(QUEUE.SYNC_CAMPAIGN, handler);
}

export function registerPurgeExpiredDataWorker(handler: () => Promise<void>): Promise<void> {
  return registerWorker<Record<string, never>>(QUEUE.PURGE_EXPIRED_DATA, handler);
}

export function registerRefreshTokensWorker(handler: () => Promise<void>): Promise<void> {
  return registerWorker<Record<string, never>>(QUEUE.REFRESH_IG_TOKENS, handler);
}

/** Refreshes stored Instagram tokens every Monday 03:00 UTC (a long-lived token lasts 60 days and can be renewed once it is a day old). */
export async function scheduleTokenRefresh(): Promise<void> {
  const boss = await getBoss();
  await boss.schedule(QUEUE.REFRESH_IG_TOKENS, "0 3 * * 1", {}, { tz: "UTC" });
  rootLogger.info("token_refresh_schedule_registered", { cron: "0 3 * * 1" });
}

/**
 * Schedules the retention purge daily at 04:00 UTC. pg-boss treats schedule()
 * as an upsert keyed on queue name, so calling it on every worker boot is safe
 * and keeps the cron definition in code rather than in someone's dashboard.
 */
export async function schedulePurgeExpiredData(): Promise<void> {
  const boss = await getBoss();
  await boss.schedule(QUEUE.PURGE_EXPIRED_DATA, "0 4 * * *", {}, { tz: "UTC" });
  rootLogger.info("purge_schedule_registered", { cron: "0 4 * * *" });
}
