#!/usr/bin/env tsx
/**
 * Replace the Postgres connection string everywhere it is used, without the
 * password appearing in a terminal or chat.
 *
 *   1. Supabase → Project Settings → Database → Connection string → "Session pooler"
 *      (port 5432). Put your real password in place of [YOUR-PASSWORD]. Copy the whole string.
 *   2. npm run set-database-url                 (reads it from your clipboard)
 *      npm run set-database-url -- --vercel     (also updates Vercel production)
 *
 * The string must connect and answer a real query BEFORE any file or Vercel
 * variable is touched. Local .env files are backed up first (git-ignored).
 *
 * Changes:  .env DATABASE_URL, vendor/openreply/.env DATABASE_URL
 *           with --vercel: jqp-web and jqp-openreply-1 DATABASE_URL (production)
 * Does not reach: the DM worker host (Render / Oracle VM), which has its own copy.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fail, readClipboard, updateLocalFiles, updateVercel, type FileTarget, type VercelTarget } from "./lib/env-update.js";

const args = process.argv.slice(2);
const withVercel = args.includes("--vercel");
const urlFlag = args.indexOf("--url");

const FILES: FileTarget[] = [
  { path: ".env", key: "DATABASE_URL" },
  { path: "vendor/openreply/.env", key: "DATABASE_URL" }
];
const VERCEL: VercelTarget[] = [
  { project: "jqp-web", key: "DATABASE_URL" },
  { project: "jqp-openreply-1", key: "DATABASE_URL" }
];

async function main(): Promise<void> {
  const raw = (urlFlag >= 0 ? args[urlFlag + 1] ?? "" : readClipboard()).trim();
  if (!raw) fail("Nothing found. Copy the connection string from Supabase first.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("What is on the clipboard is not a connection string. Copy the whole postgresql://… line.");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") fail(`Expected a postgresql:// string but found "${url.protocol}//".`);
  if (!url.password) fail("The string has no password.");
  if (/\[YOUR-PASSWORD\]|%5BYOUR-PASSWORD%5D/i.test(raw)) fail("The placeholder [YOUR-PASSWORD] is still in the string. Replace it with your real password first.");

  const host = url.hostname;
  console.log(`Candidate database: user ${url.username.split(".")[0]}${url.username.includes(".") ? ".<ref>" : ""} @ ${host}:${url.port || "5432"}`);

  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(host)) {
    fail("That is the DIRECT host. It is IPv6-only and fails from Vercel (P1001 / 'db: error'). Use the Session pooler string instead: host like aws-0-<region>.pooler.supabase.com, port 5432.");
  }
  if (host.endsWith(".pooler.supabase.com") && url.port === "6543") {
    fail("Port 6543 is the Transaction pooler. pg-boss needs session semantics (LISTEN/NOTIFY, prepared statements). Use the Session pooler on port 5432.");
  }
  if (!host.endsWith(".pooler.supabase.com")) console.log("! Not a Supabase pooler address. Fine for another provider, but check it works from Vercel (IPv4).");

  const require = createRequire(resolve(process.cwd(), "package.json"));
  const postgres = require("postgres") as typeof import("postgres").default;
  const sql = postgres(raw, { ssl: "require", connect_timeout: 10, max: 1, onnotice: () => undefined });
  try {
    const [who] = await sql<{ u: string }[]>`select current_user as u`;
    const [counts] = await sql<{ posts: string; campaigns: string }[]>`select (select count(*) from posts) as posts, (select count(*) from campaigns) as campaigns`;
    console.log(`✓ Connected as ${who?.u}. Found ${counts?.posts} posts and ${counts?.campaigns} campaigns, so this is the jqp database.\n`);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).split(url.password).join("***");
    return fail(`Could not use that connection string: ${msg}. Nothing was changed.`);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }

  updateLocalFiles(raw, FILES);
  if (withVercel) updateVercel(raw, VERCEL);

  console.log(`
Still to do by hand:
  ${withVercel ? "" : "- Vercel: set DATABASE_URL on jqp-web and jqp-openreply-1 (or re-run with --vercel)\n  "}- Redeploy jqp-web and jqp-openreply-1 so they pick up the new value
  - Update DATABASE_URL on the DM worker host (Render dashboard, or the Oracle VM) and restart it
  - Then run:  npm run doctor   and   npm run smoke
`);
}

void main();
