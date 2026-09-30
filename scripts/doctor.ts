#!/usr/bin/env tsx
/**
 * Integration doctor: verifies every link in the chain actually works, using
 * the real credentials in .env, and tells you which link is broken.
 *
 *   npm run doctor
 *
 * Read-only. Prints PASS / FAIL / WARN lines and never a secret value.
 * `npm run smoke` tests the deployed web surface from the outside; this tests
 * the inside: database schema, Meta token and webhook subscription, the
 * OpenReply account the bridge depends on, storage, Redis, and the bridge's
 * own column contract.
 */
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { config as loadDotenv, parse } from "dotenv";
import { readFileSync } from "node:fs";

for (const p of [".env", "vendor/openreply/.env"]) {
  const full = resolve(process.cwd(), p);
  if (existsSync(full)) loadDotenv({ path: full });
}

type Status = "PASS" | "FAIL" | "WARN" | "SKIP";
const results: { group: string; name: string; status: Status; detail: string }[] = [];
let group = "";

function record(name: string, status: Status, detail = ""): void {
  results.push({ group, name, status, detail });
  const icon = { PASS: "✓", FAIL: "✗", WARN: "!", SKIP: "-" }[status];
  console.log(`  ${icon} ${status.padEnd(4)} ${name}${detail ? `  — ${detail}` : ""}`);
}
function section(name: string): void {
  group = name;
  console.log(`\n${name}`);
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/postgres(ql)?:\/\/\S+/gi, "[db-url]").slice(0, 160);

const env = process.env;
const META_BASE = (env.META_API_BASE ?? "https://graph.instagram.com").replace(/\/$/, "");
const META_VER = env.META_GRAPH_VERSION ?? "v25.0";
const IG_USER_ID = env.META_IG_USER_ID ?? "";
const TOKEN = env.META_LONG_LIVED_ACCESS_TOKEN ?? "";

async function getJson(url: string, timeoutMs = 15_000): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { status: 0, body: null };
  }
}

async function checkEnv(): Promise<void> {
  section("Configuration");
  const { envSchema } = await import("../packages/core/src/env.js");
  const parsed = envSchema.safeParse(env);
  if (parsed.success) record("root .env satisfies the schema", "PASS");
  else record("root .env satisfies the schema", "FAIL", parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  record("MONITOR_TOKEN set (enables alerts + cloud retention)", (env.MONITOR_TOKEN ?? "").length >= 24 ? "PASS" : "WARN", (env.MONITOR_TOKEN ?? "").length >= 24 ? "" : "not set: /api/cron/* stays closed, nothing calls the monitor");
  record("ALERT_EMAIL_TO set (failure emails)", env.ALERT_EMAIL_TO ? "PASS" : "WARN", env.ALERT_EMAIL_TO ? "" : "not set: failures show on /system but nobody is emailed");
  const secret = (env.DASHBOARD_SHARED_SECRET ?? "").trim();
  record("dashboard password is strong", secret.length >= 32 ? "PASS" : "WARN", secret.length >= 32 ? "" : `${secret.length} characters; use 32+ random characters`);
}

async function checkDatabase(): Promise<void> {
  section("Database");
  const { getDb, closeDb } = await import("../packages/core/src/db.js");
  const sql = getDb();
  try {
    await sql`select 1`;
    record("connects", "PASS");
  } catch (e) {
    record("connects", "FAIL", errText(e));
    await closeDb();
    return;
  }

  const tables = async (names: string[]) => {
    const rows = await sql<{ name: string }[]>`select table_name as name from information_schema.tables where table_schema = 'public'`;
    const have = new Set(rows.map((r) => r.name));
    return names.filter((n) => !have.has(n));
  };

  const ours = await tables(["posts", "post_media", "campaigns", "ig_accounts"]);
  record("our tables exist (migrations 0001-0006)", ours.length === 0 ? "PASS" : "FAIL", ours.length ? `missing: ${ours.join(", ")}` : "");
  const theirs = await tables(["Automation", "InstagramAccount", "DmLog", "WebhookEvent", "OperationalEvent", "Workspace"]);
  record("OpenReply tables exist", theirs.length === 0 ? "PASS" : "FAIL", theirs.length ? `missing: ${theirs.join(", ")} (run prisma migrate deploy in vendor/openreply)` : "");
  const newer = await tables(["system_events", "alert_state"]);
  record("monitoring tables exist (migration 0008)", newer.length === 0 ? "PASS" : "WARN", newer.length ? "not applied yet: run supabase/migrations/0008_system_events.sql in the Supabase SQL editor" : "");

  try {
    const idx = await sql<{ indexname: string }[]>`select indexname from pg_indexes where schemaname = 'public' and indexname in ('idx_dmlog_status_created', 'idx_dmlog_created_at')`;
    record("DM log indexes exist (needed at 500+ DMs/day)", idx.length === 2 ? "PASS" : "WARN", idx.length === 2 ? "" : "missing: part of migration 0008");
  } catch (e) {
    record("DM log indexes exist", "WARN", errText(e));
  }

  try {
    const pol = await sql<{ policyname: string }[]>`select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'instagram-media public read'`;
    record("media bucket listing is closed (migration 0007)", pol.length === 0 ? "PASS" : "FAIL", pol.length ? "policy still present: run supabase/migrations/0007_storage_no_list.sql" : "");
  } catch (e) {
    record("media bucket listing is closed", "WARN", errText(e));
  }

  // The bridge writes these exact Automation columns; a renamed one means a silent sync failure.
  try {
    const cols = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'Automation'`;
    const have = new Set(cols.map((c) => c.column_name));
    const need = ["id", "workspaceId", "instagramAccountId", "name", "postId", "keywords", "matchAnyWord", "matchAnyPost", "pendingNextReel", "wholeWordMatch", "dmMessage", "dmTriggerEnabled", "publicReplyEnabled", "publicReplyMessage", "publicReplyMessages", "openingDmEnabled", "openingDmMessage", "openingDmButtonLabel", "isActive", "createdAt", "updatedAt"];
    const missing = need.filter((c) => !have.has(c));
    record("bridge column contract matches OpenReply's Automation table", missing.length === 0 ? "PASS" : "FAIL", missing.length ? `missing columns: ${missing.join(", ")}. OpenReply's schema drifted; update openreply-bridge.ts` : `${need.length} columns verified`);
  } catch (e) {
    record("bridge column contract", "FAIL", errText(e));
  }

  // The bridge needs an Instagram account connected INSIDE OpenReply (its own OAuth), separate from the dashboard's.
  try {
    const accts = await sql<{ username: string | null; tokenExpiresAt: string | null }[]>`select "username", "tokenExpiresAt" from "InstagramAccount"`;
    if (accts.length === 0) {
      record("an Instagram account is connected inside OpenReply", "FAIL", "none. Campaigns cannot sync to OpenReply until you connect the account in OpenReply's own dashboard (Connections)");
    } else {
      const soon = accts.filter((a) => a.tokenExpiresAt && new Date(a.tokenExpiresAt).getTime() < Date.now() + 7 * 86_400_000);
      record("an Instagram account is connected inside OpenReply", "PASS", `${accts.length} account(s): ${accts.map((a) => "@" + (a.username ?? "?")).join(", ")}`);
      record("OpenReply's Instagram token is not about to expire", soon.length === 0 ? "PASS" : "WARN", soon.length ? `${soon.length} expire within 7 days` : "");
    }
  } catch (e) {
    record("OpenReply account check", "FAIL", errText(e));
  }

  try {
    const [c] = await sql<{ total: string; enabled: string; synced: string; failed: string }[]>`
      select count(*) as total,
             count(*) filter (where enabled) as enabled,
             count(*) filter (where sync_status = 'DM_SYNCED') as synced,
             count(*) filter (where sync_status = 'DM_SYNC_FAILED') as failed
      from campaigns`;
    const [a] = await sql<{ active: string }[]>`select count(*) filter (where "isActive") as active from "Automation"`;
    record("campaigns vs automations", Number(c?.failed ?? 0) > 0 ? "WARN" : "PASS", `${c?.total ?? 0} campaigns (${c?.enabled ?? 0} enabled, ${c?.synced ?? 0} synced, ${c?.failed ?? 0} failed sync); ${a?.active ?? 0} active automations in OpenReply`);
  } catch (e) {
    record("campaigns vs automations", "WARN", errText(e));
  }

  await closeDb();
}

async function checkMeta(): Promise<void> {
  section("Meta (Instagram API with Instagram Login)");
  if (!TOKEN || !IG_USER_ID) {
    record("publishing credentials", "FAIL", "META_LONG_LIVED_ACCESS_TOKEN or META_IG_USER_ID missing; publishing uses these env vars");
    return;
  }
  const me = await getJson(`${META_BASE}/${META_VER}/me?fields=user_id,username&access_token=${encodeURIComponent(TOKEN)}`);
  if (me.status === 200 && me.body) {
    const id = String(me.body.user_id ?? me.body.id ?? "");
    record("publishing token is valid", "PASS", `@${String(me.body.username ?? "?")}`);
    record("token belongs to META_IG_USER_ID", id === IG_USER_ID ? "PASS" : "FAIL", id === IG_USER_ID ? "" : "the token's account differs from META_IG_USER_ID");
  } else {
    const err = (me.body?.error as { message?: string; code?: number } | undefined) ?? {};
    record("publishing token is valid", "FAIL", me.status === 0 ? "could not reach Meta" : `HTTP ${me.status}${err.code ? `, code ${err.code}` : ""}: ${String(err.message ?? "").slice(0, 120)}`);
  }

  const subs = await getJson(`${META_BASE}/${META_VER}/${IG_USER_ID}/subscribed_apps?access_token=${encodeURIComponent(TOKEN)}`);
  const fields = ((subs.body?.data as { subscribed_fields?: string[] }[] | undefined) ?? []).flatMap((d) => d.subscribed_fields ?? []);
  if (subs.status !== 200) {
    record("webhook subscription readable", "WARN", `HTTP ${subs.status}`);
  } else {
    record("webhook subscribed to comments", fields.includes("comments") ? "PASS" : "FAIL", fields.includes("comments") ? "" : "not subscribed: no comment will ever trigger a DM");
    record("webhook subscribed to messaging_postbacks", fields.includes("messaging_postbacks") ? "PASS" : "FAIL", fields.includes("messaging_postbacks") ? "" : "not subscribed: the two-step button tap would do nothing (subscribe through the API)");
    record("messaging_seen is NOT subscribed (deliberate)", fields.includes("messaging_seen") ? "WARN" : "PASS", fields.includes("messaging_seen") ? "subscribed: the link could be sent without a tap; see docs/COMPLIANCE.md" : "");
  }
}

async function checkStorage(): Promise<void> {
  section("Supabase Storage");
  const url = (env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const bucket = env.SUPABASE_STORAGE_BUCKET ?? "instagram-media";
  if (!url || !key) {
    record("bucket check", "SKIP", "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
    return;
  }
  try {
    const res = await fetch(`${url}/storage/v1/bucket/${bucket}`, { headers: { apikey: key, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { public?: boolean } | null;
    record(`bucket "${bucket}" exists`, res.status === 200 ? "PASS" : "FAIL", `HTTP ${res.status}`);
    if (res.status === 200) record("bucket is public (Meta must be able to fetch images)", body?.public === true ? "PASS" : "FAIL", body?.public === true ? "" : "private bucket: Meta cannot download the images and every publish will fail");
  } catch (e) {
    record("bucket check", "FAIL", errText(e));
  }
}

async function checkRedis(): Promise<void> {
  section("Redis (DM queue)");
  const file = resolve(process.cwd(), "vendor/openreply/.env");
  const url = existsSync(file) ? parse(readFileSync(file))["REDIS_URL"]?.trim() : env.OPENREPLY_REDIS_URL;
  if (!url) {
    record("REDIS_URL configured", "FAIL", "not set");
    return;
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    record("REDIS_URL is a valid URL", "FAIL");
    return;
  }
  try {
    await lookup(host);
    record(`host ${host} resolves`, "PASS");
  } catch {
    record(`host ${host} resolves`, "FAIL", "the Redis database no longer exists. Create a new one (Upstash) and update REDIS_URL everywhere; see docs/MORNING-CHECKLIST.md");
    return;
  }
  const require = createRequire(resolve(process.cwd(), "vendor/openreply/package.json"));
  const Redis = require("ioredis") as typeof import("ioredis").default;
  const redis = new Redis(url, { connectTimeout: 8000, maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true, tls: url.startsWith("rediss:") ? {} : undefined });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    record("PING succeeds", (await redis.ping()) === "PONG" ? "PASS" : "FAIL");
  } catch (e) {
    record("PING succeeds", "FAIL", errText(e));
  } finally {
    redis.disconnect();
  }
}

async function checkLive(): Promise<void> {
  section("Live services (same view as the System page)");
  try {
    const { getSystemSnapshot } = await import("../packages/publisher/src/system.js");
    const { closeDb } = await import("../packages/core/src/db.js");
    const snap = await getSystemSnapshot();
    for (const s of snap.services) record(s.label, s.state === "ok" ? "PASS" : s.state === "warn" ? "WARN" : "FAIL", s.detail);
    await closeDb();
  } catch (e) {
    record("system snapshot", "FAIL", errText(e));
  }
}

async function main(): Promise<void> {
  console.log("jqp integration doctor");
  await checkEnv();
  await checkDatabase();
  await checkMeta();
  await checkStorage();
  await checkRedis();
  await checkLive();

  const count = (s: Status) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("PASS")} passed · ${count("FAIL")} failed · ${count("WARN")} warnings · ${count("SKIP")} skipped`);
  const failed = results.filter((r) => r.status === "FAIL");
  if (failed.length > 0) {
    console.log("\nFix these first:");
    for (const r of failed) console.log(`  ✗ [${r.group.split(" (")[0]}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    process.exit(1);
  }
}

void main();
