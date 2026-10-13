import { loadRootDotenv } from "@jqp/core/bootstrap";
loadRootDotenv();

import { loadEnv, rootLogger, registerDbShutdownHooks } from "@jqp/core";
import {
  ensureQueues,
  registerPublishPostWorker,
  registerSyncCampaignWorker,
  registerPurgeExpiredDataWorker,
  schedulePurgeExpiredData,
  registerRefreshTokensWorker,
  scheduleTokenRefresh,
  registerQueueShutdownHooks
} from "@jqp/queue";
import { runPublishPipeline, syncCampaignToOpenReply, purgeExpiredData, refreshStoredTokens, recordEvent } from "@jqp/publisher";
import { setMetaUsageObserver } from "@jqp/meta";
import { RateLimitError } from "@jqp/core";
import { startHealthServer } from "./health.js";

async function main() {
  const env = loadEnv();
  const log = rootLogger.child({ service: "worker" });
  log.info("worker_starting", { queueConcurrency: env.QUEUE_CONCURRENCY, mockMeta: env.MOCK_META });

  // Render (and most PaaS) inject the port to bind as PORT and will kill a
  // service that binds anything else. Prefer it when present so this same
  // build runs as a Render web service — which matters because free-tier
  // Render offers web services but not always-on background workers.
  const healthPort = Number(process.env.PORT) || env.WORKER_HEALTH_PORT;
  const { setReady } = startHealthServer(healthPort);

  registerDbShutdownHooks();
  registerQueueShutdownHooks();

  // Record when Meta usage gets high (one event per 10 minutes at most), so the System page and alert emails
  // show a throttle coming before posts start failing.
  setMetaUsageObserver((usage, path) => {
    void recordEvent({
      level: usage.regainMinutes > 0 ? "error" : "warn",
      source: "publish",
      code: usage.regainMinutes > 0 ? "meta_throttled" : "meta_usage_high",
      message: usage.regainMinutes > 0 ? `Meta is throttling this account; access returns in about ${usage.regainMinutes} min` : `Meta API usage is at ${Math.round(usage.callCountPct)}% of the limit`,
      meta: { callCountPct: Math.round(usage.callCountPct), totalTimePct: Math.round(usage.totalTimePct), regainMinutes: usage.regainMinutes, path }
    });
  });

  await ensureQueues();

  await registerPublishPostWorker(async (data) => {
    try {
      await runPublishPipeline(data.postId);
    } catch (err) {
      // A throttle is expected to clear on its own; note it, then let the queue retry on its schedule.
      if (err instanceof RateLimitError) {
        void recordEvent({ level: "warn", source: "publish", code: "publish_rate_limited", message: `Publishing deferred by Meta rate limit: ${err.message}`, meta: { postId: data.postId, retryAfterMs: err.retryAfterMs ?? 0 } });
      }
      throw err;
    }
  });

  await registerSyncCampaignWorker(async (data) => {
    await syncCampaignToOpenReply(data.campaignId);
  });

  await registerPurgeExpiredDataWorker(async () => {
    await purgeExpiredData();
  });
  await schedulePurgeExpiredData();

  await registerRefreshTokensWorker(async () => {
    await refreshStoredTokens();
  });
  await scheduleTokenRefresh();

  setReady(true);
  log.info("worker_ready");
}

main().catch((err) => {
  rootLogger.error("worker_fatal_startup_error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
