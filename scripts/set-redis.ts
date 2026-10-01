#!/usr/bin/env tsx
/**
 * Swap in a new Redis (Upstash) connection URL everywhere it is used, without
 * the URL ever appearing in a terminal, a chat, or a log.
 *
 *   1. Create the database in the Upstash console and COPY its "rediss://" URL.
 *   2. npm run set-redis                 (reads the URL from your clipboard)
 *      npm run set-redis -- --vercel     (also updates Vercel production env)
 *
 * Order of operations is deliberate: the URL is validated and a real PING must
 * succeed BEFORE any file or Vercel variable is touched, so a bad paste can't
 * break a working setup. Local .env files are backed up first (the backups are
 * git-ignored).
 *
 * What it changes:
 *   vendor/openreply/.env   REDIS_URL
 *   root .env               OPENREPLY_REDIS_URL
 *   with --vercel:  jqp-openreply-1 REDIS_URL, jqp-web OPENREPLY_REDIS_URL (production)
 * What it cannot reach, and tells you about: the DM worker host (Render / Oracle VM).
 */
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fail, readClipboard, updateLocalFiles, updateVercel, type FileTarget, type VercelTarget } from "./lib/env-update.js";

const args = process.argv.slice(2);
const withVercel = args.includes("--vercel");
const urlFlag = args.indexOf("--url");

const FILES: FileTarget[] = [
  { path: "vendor/openreply/.env", key: "REDIS_URL" },
  { path: ".env", key: "OPENREPLY_REDIS_URL" }
];
const VERCEL_TARGETS: VercelTarget[] = [
  { project: "jqp-openreply-1", key: "REDIS_URL" },
  { project: "jqp-web", key: "OPENREPLY_REDIS_URL" }
];

async function main(): Promise<void> {
  const raw = (urlFlag >= 0 ? args[urlFlag + 1] ?? "" : readClipboard()).trim();
  if (!raw) fail("No URL found. Copy the connection URL from the Upstash console first.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("What is on the clipboard is not a URL. Copy the full rediss://… connection string.");
  }
  if (url.protocol !== "rediss:" && url.protocol !== "redis:") fail(`Expected a rediss:// URL but found "${url.protocol}//". Upstash's ioredis/TCP URL starts with rediss://, not https://.`);
  if (url.protocol === "redis:") console.log("! The URL is not TLS (redis://). Upstash requires rediss://; continuing so the PING can tell you.");
  if (!url.password) fail("The URL has no password. Copy the one from the Upstash console that looks like rediss://default:<password>@<host>:6379.");

  console.log(`Candidate Redis: ${url.hostname}:${url.port || "6379"} (TLS ${url.protocol === "rediss:" ? "yes" : "NO"}, password set)`);
  if (!url.hostname.endsWith(".upstash.io")) console.log("! The host is not an upstash.io address. Fine if you use another provider.");

  try {
    await lookup(url.hostname);
  } catch {
    fail(`The host ${url.hostname} does not resolve. Check you copied the whole URL from a database that exists.`);
  }

  const require = createRequire(resolve(process.cwd(), "vendor/openreply/package.json"));
  const Redis = require("ioredis") as typeof import("ioredis").default;
  const redis = new Redis(raw, { connectTimeout: 8000, maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true, tls: url.protocol === "rediss:" ? {} : undefined });
  let lastEvent: Error | undefined;
  redis.on("error", (e: Error) => {
    lastEvent = e;
  });
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") fail(`Unexpected reply to PING: ${pong}`);
    // A write/read round trip: some misconfigured plans accept PING but reject commands.
    await redis.set("jqp:set-redis:probe", "1", "EX", 30);
    if ((await redis.get("jqp:set-redis:probe")) !== "1") fail("Connected, but a test write could not be read back.");
  } catch (err) {
    const e = lastEvent ?? (err as Error);
    const msg = String(e.message).split(url.password).join("***");
    fail(`Could not use that Redis: ${msg}${/WRONGPASS|NOAUTH/i.test(msg) ? " (the password was rejected)" : ""}. Nothing was changed.`);
  } finally {
    redis.disconnect();
  }
  console.log("✓ Connected, PING ok, test write ok.\n");

  updateLocalFiles(raw, FILES);
  if (withVercel) updateVercel(raw, VERCEL_TARGETS);

  console.log(`
Still to do by hand:
  ${withVercel ? "" : "- Vercel: set REDIS_URL on jqp-openreply-1 and OPENREPLY_REDIS_URL on jqp-web (or re-run with --vercel)\n  "}- Redeploy jqp-openreply-1 so it picks up the new value (Vercel → Deployments → ⋯ → Redeploy)
  - Update REDIS_URL on the DM worker host (Render dashboard, or the Oracle VM) and restart it
  - Then run:  npm run check-redis   and   npm run smoke
`);
}

void main();
