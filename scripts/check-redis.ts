#!/usr/bin/env tsx
/**
 * Answers "is the Redis that OpenReply's DM queue depends on reachable, and
 * which database is it?" without printing any secret.
 *
 *   npm run check-redis
 *
 * Reads REDIS_URL from vendor/openreply/.env and OPENREPLY_REDIS_URL from the
 * root .env, prints only the host / port / TLS / database number (enough to
 * find the database in the Upstash console), whether the two files agree, and
 * whether a PING succeeds. The password never leaves this process.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { parse } from "dotenv";

// ioredis is installed under vendor/openreply (it is OpenReply's dependency), not the root.
const require = createRequire(resolve(process.cwd(), "vendor/openreply/package.json"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Redis = require("ioredis") as typeof import("ioredis").default;

function readVar(file: string, key: string): string | undefined {
  const full = resolve(process.cwd(), file);
  if (!existsSync(full)) return undefined;
  const value = parse(readFileSync(full))[key]?.trim();
  return value ? value : undefined;
}

const sources = [
  { label: "vendor/openreply/.env  REDIS_URL", url: readVar("vendor/openreply/.env", "REDIS_URL") },
  { label: "root .env              OPENREPLY_REDIS_URL", url: readVar(".env", "OPENREPLY_REDIS_URL") }
];

const fingerprint = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 8);

console.log("Redis configuration found locally\n");
for (const s of sources) {
  if (!s.url) {
    console.log(`  ${s.label}: not set`);
    continue;
  }
  try {
    const u = new URL(s.url);
    console.log(`  ${s.label}`);
    console.log(`    host:     ${u.hostname}`);
    console.log(`    port:     ${u.port || "6379"}`);
    console.log(`    TLS:      ${u.protocol === "rediss:" ? "yes (rediss://)" : "NO (redis://) — Upstash requires rediss://"}`);
    console.log(`    user:     ${u.username || "(none)"}`);
    console.log(`    password: ${u.password ? "set" : "MISSING"}`);
    console.log(`    db:       ${u.pathname.replace("/", "") || "0"}`);
    console.log(`    id:       ${fingerprint(s.url)}  (hash, to compare files)`);
  } catch {
    console.log(`  ${s.label}: value is not a valid URL`);
  }
}

const set = sources.filter((s) => s.url);
if (set.length === 2) {
  console.log(`\n  The two files ${set[0]!.url === set[1]!.url ? "AGREE" : "DISAGREE — they point at different Redis instances"}.`);
}
console.log("  (Vercel's copy can't be read from here; compare its `id` by re-saving the same value there.)");

const target = set[0]?.url;
if (!target) {
  console.log("\nNo Redis URL to test.");
  process.exit(2);
}

async function main(): Promise<void> {
  const url = new URL(target!);
  const secret = url.password;
  const scrub = (text: string) => (secret ? text.split(secret).join("***") : text);

  console.log("\nConnecting (8s timeout, no retries)…");
  const redis = new Redis(target!, {
    connectTimeout: 8000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    lazyConnect: true,
    tls: url.protocol === "rediss:" ? {} : undefined
  });
  let lastEvent: NodeJS.ErrnoException | undefined;
  redis.on("error", (e: NodeJS.ErrnoException) => {
    lastEvent = e;
  });

  try {
    const addr = await lookup(url.hostname);
    console.log(`  DNS: ${url.hostname} → ${addr.address}`);
  } catch (dnsErr) {
    console.log(`  DNS: ${url.hostname} does NOT resolve (${(dnsErr as NodeJS.ErrnoException).code})`);
  }

  try {
    await redis.connect();
    const pong = await redis.ping();
    const dbsize = await redis.dbsize();
    const info = await redis.info("memory");
    const used = /used_memory_human:(\S+)/.exec(info)?.[1] ?? "?";
    const version = /redis_version:(\S+)/.exec(await redis.info("server"))?.[1] ?? "?";
    let queued = 0;
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "bull:*", "COUNT", 200);
      cursor = next;
      queued += keys.length;
    } while (cursor !== "0" && queued < 5000);

    console.log(`\n  ✓ CONNECTED  PING → ${pong}`);
    console.log(`    redis ${version}, ${dbsize} keys, ${used} in use, ${queued} BullMQ keys`);
    console.log("\nRedis is fine from this machine. If the deployed OpenReply still hangs, the value in Vercel is different from this one.");
  } catch (err) {
    // ioredis reports the real cause on the "error" event; the rejection is just "Connection is closed".
    const e = lastEvent ?? (err as NodeJS.ErrnoException);
    console.log(`\n  ✗ FAILED  ${e.code ?? e.name}: ${scrub(String(e.message))}`);
    if (e.code === "ENOTFOUND") console.log("    The hostname no longer exists. The Upstash database was deleted, or this URL is stale.");
    else if (e.code === "ECONNREFUSED") console.log("    The host resolves but refuses connections. Database paused/archived, or wrong port.");
    else if (/WRONGPASS|NOAUTH|invalid password/i.test(String(e.message))) console.log("    Reachable, but the password was rejected. The token was rotated; copy the new URL from Upstash.");
    else if (/timed out|ETIMEDOUT/i.test(String(e.message))) console.log("    No answer within 8s. Network block, or TLS/port mismatch.");
    process.exitCode = 1;
  } finally {
    redis.disconnect();
  }
}

void main();
