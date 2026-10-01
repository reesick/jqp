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
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const withVercel = args.includes("--vercel");
const urlFlag = args.indexOf("--url");

const FILES = [
  { path: "vendor/openreply/.env", key: "REDIS_URL" },
  { path: ".env", key: "OPENREPLY_REDIS_URL" }
];
const VERCEL_TARGETS = [
  { project: "jqp-openreply-1", key: "REDIS_URL" },
  { project: "jqp-web", key: "OPENREPLY_REDIS_URL" }
];

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function readClipboard(): string {
  try {
    if (process.platform === "win32") return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" });
    if (process.platform === "darwin") return execFileSync("pbpaste", { encoding: "utf8" });
    return execFileSync("xclip", ["-selection", "clipboard", "-o"], { encoding: "utf8" });
  } catch {
    fail("Could not read the clipboard. Copy the Upstash URL again and re-run, or pass --url (the value will then be visible in your shell history).");
  }
}

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

  // Local files: back up, then replace (or append) the single variable.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const f of FILES) {
    const full = resolve(process.cwd(), f.path);
    if (!existsSync(full)) {
      console.log(`- ${f.path}: not present, skipped`);
      continue;
    }
    copyFileSync(full, `${full}.bak-redis-${stamp}`);
    const original = readFileSync(full, "utf8");
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const line = `${f.key}=${raw}`;
    const pattern = new RegExp(`^${f.key}=.*$`, "m");
    const updated = pattern.test(original) ? original.replace(pattern, () => line) : `${original.replace(/\s*$/, "")}${eol}${line}${eol}`;
    writeFileSync(full, updated);
    console.log(`✓ ${f.path}: ${f.key} updated (backup kept next to it)`);
  }

  if (withVercel) {
    console.log("\nVercel (production):");
    const work = mkdtempSync(join(tmpdir(), "jqp-redis-"));
    try {
      for (const t of VERCEL_TARGETS) {
        const dir = join(work, t.project);
        mkdirSync(dir, { recursive: true });
        const run = (argv: string[], input?: string) => spawnSync("vercel", argv, { cwd: dir, input, encoding: "utf8", shell: process.platform === "win32" });
        const link = run(["link", "--project", t.project, "--yes"]);
        if (link.status !== 0) {
          console.log(`✗ ${t.project}: could not link (${(link.stderr || link.stdout).trim().split("\n").pop()}). Update ${t.key} by hand in the Vercel dashboard.`);
          continue;
        }
        run(["env", "rm", t.key, "production", "--yes"]);
        const add = run(["env", "add", t.key, "production", "--sensitive"], `${raw}\n`);
        const ok = add.status === 0;
        console.log(`${ok ? "✓" : "✗"} ${t.project}: ${t.key} ${ok ? "set for production" : `FAILED (${(add.stderr || add.stdout).trim().split("\n").pop()}). Set it by hand`}`);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  console.log(`
Still to do by hand:
  ${withVercel ? "" : "- Vercel: set REDIS_URL on jqp-openreply-1 and OPENREPLY_REDIS_URL on jqp-web (or re-run with --vercel)\n  "}- Redeploy jqp-openreply-1 so it picks up the new value (Vercel → Deployments → ⋯ → Redeploy)
  - Update REDIS_URL on the DM worker host (Render dashboard, or the Oracle VM) and restart it
  - Then run:  npm run check-redis   and   npm run smoke
`);
}

void main();
