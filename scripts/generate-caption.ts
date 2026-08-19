#!/usr/bin/env tsx
/**
 * Writes caption.md for a post folder using AWS Bedrock. Standalone —
 * run this BEFORE ingesting the folder. Never called by the pipeline
 * itself (plan section 7).
 *
 * Usage:
 *   npm run generate-caption -- "D:\jqp\posts\POST_002" "a cozy neighborhood coffee shop, morning light, latte art"
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRootDotenv } from "../packages/core/src/bootstrap.js";
loadRootDotenv();

import { generateCaption } from "../packages/ai/src/generate-caption.js";

const folderPath = process.argv[2];
const brief = process.argv[3];

if (!folderPath || !brief) {
  console.error('Usage: npm run generate-caption -- "<folder-path>" "<brief>"');
  process.exit(1);
}

generateCaption({ brief })
  .then(async (caption) => {
    const captionPath = resolve(folderPath, "caption.md");
    await writeFile(captionPath, caption + "\n", "utf-8");
    console.log(`Wrote ${captionPath}:\n\n${caption}`);
  })
  .catch((err) => {
    console.error("Caption generation failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
