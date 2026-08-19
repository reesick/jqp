#!/usr/bin/env tsx
/**
 * CLI convenience wrapper around ingestPostFolder — the same thing
 * the dashboard's "Ingest folder" form does, without opening a
 * browser. Useful for scripted local testing.
 *
 * Usage: npm run ingest -- "D:\jqp\posts\POST_001"
 */
import { loadRootDotenv } from "../packages/core/src/bootstrap.js";
loadRootDotenv();

import { ingestPostFolder } from "../packages/publisher/src/pipeline.js";

const folderPath = process.argv[2];
if (!folderPath) {
  console.error("Usage: npm run ingest -- <absolute-folder-path>");
  process.exit(1);
}

ingestPostFolder(folderPath)
  .then((post) => {
    console.log(`Ingested: ${post.campaign_id} (id=${post.id}, status=${post.status})`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Ingest failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
