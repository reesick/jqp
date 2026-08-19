import { loadRootDotenv } from "@jqp/core/bootstrap";
loadRootDotenv();

import { loadEnv, rootLogger, registerDbShutdownHooks } from "@jqp/core";
import { ensureQueues, registerPublishPostWorker, registerSyncCampaignWorker, registerQueueShutdownHooks } from "@jqp/queue";
import { runPublishPipeline, syncCampaignToOpenReply } from "@jqp/publisher";
import { startHealthServer } from "./health.js";

async function main() {
  const env = loadEnv();
  const log = rootLogger.child({ service: "worker" });
  log.info("worker_starting", { queueConcurrency: env.QUEUE_CONCURRENCY, mockMeta: env.MOCK_META });

  const { setReady } = startHealthServer(env.WORKER_HEALTH_PORT);

  registerDbShutdownHooks();
  registerQueueShutdownHooks();

  await ensureQueues();

  await registerPublishPostWorker(async (data) => {
    await runPublishPipeline(data.postId);
  });

  await registerSyncCampaignWorker(async (data) => {
    await syncCampaignToOpenReply(data.campaignId);
  });

  setReady(true);
  log.info("worker_ready");
}

main().catch((err) => {
  rootLogger.error("worker_fatal_startup_error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
