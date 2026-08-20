#!/usr/bin/env tsx
/**
 * Shows what the retention purge WOULD affect, without changing anything.
 * Run this before trusting the scheduled job — especially the first time, and
 * after ever changing RAW_PAYLOAD_RETENTION_DAYS / PII_RETENTION_DAYS.
 *
 *   npx tsx --env-file=.env scripts/purge-dry-run.ts
 *
 * Pass --apply to actually run the purge once, immediately, instead of waiting
 * for the worker's 04:00 UTC schedule.
 */
import { loadRootDotenv } from "../packages/core/src/bootstrap.js";
import { loadEnv, closeDb } from "../packages/core/src/index.js";
import { purgeExpiredData } from "../packages/publisher/src/retention.js";

loadRootDotenv();

const apply = process.argv.includes("--apply");

async function main() {
  const env = loadEnv();

  console.log(
    `Retention windows: raw webhook payloads ${env.RAW_PAYLOAD_RETENTION_DAYS}d, commenter PII ${env.PII_RETENTION_DAYS}d`
  );
  console.log(apply ? "\nAPPLYING purge...\n" : "\nDry run — nothing will be modified.\n");

  const result = await purgeExpiredData({ dryRun: !apply });

  console.log(`  Raw webhook payloads (OpenReply "WebhookEvent")  ${result.webhookEventsDeleted}`);
  console.log(`  Raw webhook payloads (ours, webhook_events)      ${result.ourWebhookEventsDeleted}`);
  console.log(`  DM logs anonymised (OpenReply "DmLog")           ${result.dmLogsAnonymised}`);
  console.log(`  Comment events anonymised (ours)                 ${result.commentEventsAnonymised}`);
  console.log(apply ? "\n(applied)" : "\n(would be affected)\n\nRe-run with --apply to actually perform the purge.");

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
