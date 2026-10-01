// Runs OpenReply's DM worker on THIS computer, using the env from vendor/openreply/.env.
//
//   npm run dm-worker
//
// WARNING: this sends real DMs. The worker consumes the DM queue AND polls Meta every
// 5 minutes for recent comments, queueing a DM for anyone who commented a trigger word
// on a post with an active automation and has not been messaged yet. Start it only when
// you want that to happen. Ctrl+C stops it; queued jobs stay in Redis until a worker runs.
//
// It only runs while this computer is on. For 24/7 operation host it on a server
// (docs/ORACLE-WORKER.md) with the same REDIS_URL and DATABASE_URL.
const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { parse } = require("dotenv");

const dir = resolve(__dirname, "../vendor/openreply");
const envFile = resolve(dir, ".env");
if (!existsSync(envFile)) {
  console.error("vendor/openreply/.env not found. Run: npm run sync-openreply-env");
  process.exit(1);
}
const env = { ...process.env, ...parse(readFileSync(envFile)) };
if (!env.REDIS_URL || !env.DATABASE_URL) {
  console.error("REDIS_URL or DATABASE_URL is missing from vendor/openreply/.env.");
  process.exit(1);
}
console.log("Starting the DM worker. It will send real DMs. Ctrl+C to stop.");
const child = spawn(process.execPath, ["--import", "tsx", "worker/dm-worker.ts"], { cwd: dir, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
