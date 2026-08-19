#!/usr/bin/env tsx
/**
 * Validates .env against the schema in packages/core/src/env.ts and
 * prints a readable pass/fail table. Run this before anything else.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { envSchema } from "../packages/core/src/env.js";

const envPath = resolve(process.cwd(), ".env");

if (!existsSync(envPath)) {
  console.error(`\n✗ No .env file found at ${envPath}\n`);
  console.error(`  Run:  cp .env.example .env   (or copy it manually on Windows)`);
  console.error(`  Then fill in every value and re-run: npm run check-env\n`);
  process.exit(1);
}

loadDotenv({ path: envPath });

const exampleKeys = readFileSync(resolve(process.cwd(), ".env.example"), "utf-8")
  .split("\n")
  .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
  .filter((k): k is string => Boolean(k));

const result = envSchema.safeParse(process.env);

const rows: { key: string; status: string; detail: string }[] = [];

for (const key of exampleKeys) {
  const issue = result.success ? undefined : result.error.issues.find((i) => i.path[0] === key);
  const raw = process.env[key];
  if (issue) {
    rows.push({ key, status: "✗ FAIL", detail: issue.message });
  } else if (!raw || raw.trim() === "") {
    rows.push({ key, status: "○ empty", detail: "no value set (may be optional)" });
  } else {
    rows.push({ key, status: "✓ ok", detail: "" });
  }
}

const keyWidth = Math.max(...rows.map((r) => r.key.length), 24);
const statusWidth = 9;

console.log("");
console.log(`${"KEY".padEnd(keyWidth)}  ${"STATUS".padEnd(statusWidth)}  DETAIL`);
console.log("-".repeat(keyWidth + statusWidth + 40));
for (const row of rows) {
  console.log(`${row.key.padEnd(keyWidth)}  ${row.status.padEnd(statusWidth)}  ${row.detail}`);
}
console.log("");

if (result.success) {
  console.log("✓ Environment is valid. All required variables are set correctly.\n");
  process.exit(0);
} else {
  const failCount = result.error.issues.length;
  console.error(`✗ ${failCount} problem(s) found. Fix the FAIL rows above and re-run.\n`);
  process.exit(1);
}
