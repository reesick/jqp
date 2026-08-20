import { loadRootDotenv } from "@jqp/core/bootstrap";
loadRootDotenv();

import { loadEnv, rootLogger, registerDbShutdownHooks } from "@jqp/core";
import {
  ensureQueues,
  registerPublishPostWorker,
  registerSyncCampaignWorker,
  registerPurgeExpiredDataWorker,
  schedulePurgeExpiredData,
  registerQueueShutdownHooks
} from "@jqp/queue";
import { runPublishPipeline, syncCampaignToOpenReply, purgeExpiredData } from "@jqp/publisher";
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

  await ensureQueues();

  await registerPublishPostWorker(async (data) => {
    await runPublishPipeline(data.postId);
  });

  await registerSyncCampaignWorker(async (data) => {
    await syncCampaignToOpenReply(data.campaignId);
  });

  await registerPurgeExpiredDataWorker(async () => {
    await purgeExpiredData();
  });
  await schedulePurgeExpiredData();

  setReady(true);
  log.info("worker_ready");
}

main().catch((err) => {
  rootLogger.error("worker_fatal_startup_error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
