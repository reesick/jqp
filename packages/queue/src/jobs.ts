import type PgBoss from "pg-boss";
import { loadEnv, rootLogger } from "@jqp/core";
import { getBoss } from "./boss.js";

export const QUEUE = {
  PUBLISH_POST: "publish-post",
  SYNC_CAMPAIGN: "sync-campaign-to-openreply"
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

export async function enqueuePublishPost(data: PublishPostJobData): Promise<string | null> {
  const boss = await getBoss();
  // singletonKey prevents the same post from ever having two publish-post jobs in flight at once (plan section 48's idempotency requirement).
  return boss.send(QUEUE.PUBLISH_POST, data, { singletonKey: `post:${data.postId}` });
}

export async function enqueueSyncCampaign(data: SyncCampaignJobData): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(QUEUE.SYNC_CAMPAIGN, data, { singletonKey: `sync:${data.campaignId}` });
}

async function registerWorker<T extends object>(queueName: QueueName, handler: (data: T, jobId: string) => Promise<void>): Promise<void> {
  const boss = await getBoss();
  const env = loadEnv();
  await boss.work<T>(queueName, { batchSize: env.QUEUE_CONCURRENCY }, async (jobs) => {
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
