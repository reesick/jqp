#!/usr/bin/env tsx
/**
 * End-to-end smoke test against the LIVE deployment.
 *
 *   npm run smoke
 *
 * Exercises what a real operator depends on: the dashboard (health, auth wall,
 * real login, every page, API, logout), OpenReply (public pages, webhook
 * verification, health incl. Redis/queue/worker) and the Supabase API lockdown.
 *
 * Secrets are read from .env at runtime and only ever sent to the services
 * they belong to. Nothing sensitive is printed — only PASS / FAIL / WARN lines.
 * It is read-only except for one login/logout pair and one deliberately wrong
 * login (which the rate limiter counts; 1 attempt out of 8 per 15 minutes).
 *
 * Targets default to APP_BASE_URL and OPENREPLY_DASHBOARD_URL from .env;
 * override with SMOKE_WEB_URL / SMOKE_OPENREPLY_URL.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

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

const env = process.env;
const WEB = (env.SMOKE_WEB_URL ?? env.APP_BASE_URL ?? "").replace(/\/$/, "");
const OPENREPLY = (env.SMOKE_OPENREPLY_URL ?? env.OPENREPLY_DASHBOARD_URL ?? "").replace(/\/$/, "");
const SECRET = (env.DASHBOARD_SHARED_SECRET ?? "").trim();
const WEBHOOK_TOKEN = (env.WEBHOOK_VERIFY_TOKEN ?? env.META_WEBHOOK_VERIFY_TOKEN ?? "").trim();
const SUPABASE_URL = (env.SUPABASE_URL ?? "").replace(/\/$/, "");
const ANON = env.SUPABASE_ANON_KEY ?? "";
const BUCKET = env.SUPABASE_STORAGE_BUCKET ?? "instagram-media";

async function req(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 25_000, ...rest } = init;
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), ...rest });
    const text = await res.text().catch(() => "");
    return { res, text, ms: Date.now() - started, error: null as string | null };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { res: null, text: "", ms: Date.now() - started, error: name === "TimeoutError" ? `no response after ${timeoutMs / 1000}s` : String(err) };
  }
}

const isRedirectToLogin = (res: Response | null) =>
  res !== null && [301, 302, 303, 307, 308].includes(res.status) && (res.headers.get("location") ?? "").includes("/login");

async function checkWeb(): Promise<void> {
  section(`Dashboard  ${WEB}`);

  const health = await req(`${WEB}/api/health`);
  let ok = false;
  try {
    ok = health.res?.status === 200 && JSON.parse(health.text).db === "ok";
  } catch {
    ok = false;
  }
  record("health endpoint reports database ok", ok ? "PASS" : "FAIL", health.error ?? `HTTP ${health.res?.status} in ${health.ms}ms`);
  if (health.ms > 2500) record("health latency", "WARN", `${health.ms}ms (cold start or wrong region?)`);

  for (const path of ["/", "/posts", "/campaigns", "/dm-activity", "/settings"]) {
    const r = await req(`${WEB}${path}`);
    record(`logged-out ${path} redirects to /login`, isRedirectToLogin(r.res) ? "PASS" : "FAIL", r.error ?? `HTTP ${r.res?.status}`);
  }

  const api = await req(`${WEB}/api/posts`);
  record("logged-out API is refused", api.res?.status === 401 ? "PASS" : "FAIL", `HTTP ${api.res?.status}`);

  const login = await req(`${WEB}/login`);
  const h = login.res?.headers;
  record("security headers present", h?.get("x-frame-options") && h?.get("x-content-type-options") && h?.get("referrer-policy") ? "PASS" : "FAIL");
  record("X-Powered-By hidden", h?.get("x-powered-by") ? "FAIL" : "PASS");

  const legacy = await req(`${WEB}/posts`, { headers: { cookie: "jqp_session=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" } });
  record("old-format session cookie rejected", isRedirectToLogin(legacy.res) ? "PASS" : "FAIL");

  for (const path of ["/api/cron/monitor", "/api/cron/purge"]) {
    const r = await req(`${WEB}${path}`, { method: "POST" });
    record(`${path} refuses callers without the token`, r.res?.status === 401 || r.res?.status === 503 ? "PASS" : "FAIL", `HTTP ${r.res?.status}`);
    const wrong = await req(`${WEB}${path}`, { method: "POST", headers: { authorization: "Bearer definitely-not-the-token-000000000" } });
    record(`${path} refuses a wrong token`, wrong.res?.status === 401 || wrong.res?.status === 503 ? "PASS" : "FAIL", `HTTP ${wrong.res?.status}`);
  }

  const xsite = await req(`${WEB}/api/posts/00000000-0000-0000-0000-000000000000/retry`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
  record("cross-site POST blocked", xsite.res?.status === 403 ? "PASS" : "FAIL", `HTTP ${xsite.res?.status}`);

  if (!SECRET) {
    record("real login", "SKIP", "DASHBOARD_SHARED_SECRET not set in .env");
    return;
  }

  const bad = await req(`${WEB}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: "definitely-not-the-password", next: "/" })
  });
  record("wrong password rejected", (bad.res?.headers.get("location") ?? "").includes("error=1") ? "PASS" : "FAIL", `HTTP ${bad.res?.status}`);

  const good = await req(`${WEB}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: SECRET, next: "/" })
  });
  const setCookie = good.res?.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.startsWith("jqp_session="));
  const token = sessionCookie?.split(";")[0]?.split("=")[1] ?? "";
  record("login with your secret succeeds", good.res?.status === 303 && token.startsWith("v1.") ? "PASS" : "FAIL", `HTTP ${good.res?.status}${token ? "" : ", no session cookie"}`);
  if (!token) return;
  const cookie = `jqp_session=${token}`;

  const flags = (sessionCookie ?? "").toLowerCase();
  record("session cookie is HttpOnly + Secure + SameSite", flags.includes("httponly") && flags.includes("secure") && flags.includes("samesite") ? "PASS" : "FAIL");

  for (const [path, label] of [["/", "Home"], ["/posts", "Posts"], ["/campaigns", "Automations"], ["/dm-activity", "Activity"], ["/settings", "Settings"]] as const) {
    const r = await req(`${WEB}${path}`, { headers: { cookie } });
    const crashed = /Application error|something went wrong|Internal Server Error/i.test(r.text);
    const status: Status = r.res?.status === 200 && !crashed ? (r.ms > 4000 ? "WARN" : "PASS") : "FAIL";
    record(`${label} page renders`, status, r.error ?? `HTTP ${r.res?.status}, ${r.ms}ms${crashed ? ", error text in page" : ""}`);
  }

  for (const path of ["/api/posts", "/api/campaigns"]) {
    const r = await req(`${WEB}${path}`, { headers: { cookie } });
    let success = false;
    try {
      success = JSON.parse(r.text).success === true;
    } catch {
      success = false;
    }
    record(`GET ${path} returns data`, r.res?.status === 200 && success ? "PASS" : "FAIL", r.error ?? `HTTP ${r.res?.status}`);
  }

  const sys = await req(`${WEB}/system`, { headers: { cookie } });
  const sysCrashed = /Application error|Internal Server Error/i.test(sys.text);
  record("System page renders", sys.res?.status === 200 && !sysCrashed ? (sys.ms > 9000 ? "WARN" : "PASS") : "FAIL", sys.error ?? `HTTP ${sys.res?.status}, ${sys.ms}ms`);

  const out = await req(`${WEB}/api/auth/logout`, { method: "POST", headers: { cookie } });
  const cleared = (out.res?.headers.getSetCookie?.() ?? []).some((c) => c.startsWith("jqp_session=") && /max-age=0|expires=/i.test(c));
  record("logout clears the session", out.res?.status === 303 && cleared ? "PASS" : "FAIL", `HTTP ${out.res?.status}`);
}

async function checkOpenReply(): Promise<void> {
  section(`OpenReply (comment → DM)  ${OPENREPLY}`);

  for (const path of ["/", "/privacy", "/terms", "/data-deletion"]) {
    const r = await req(`${OPENREPLY}${path}`);
    record(`${path} is public`, r.res?.status === 200 ? "PASS" : "FAIL", r.error ?? `HTTP ${r.res?.status}`);
  }

  if (!WEBHOOK_TOKEN) {
    record("webhook verification", "SKIP", "WEBHOOK_VERIFY_TOKEN not found in .env or vendor/openreply/.env");
  } else {
    const wrong = await req(`${OPENREPLY}/api/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=abc123`);
    record("webhook rejects a wrong verify token", wrong.res?.status === 403 ? "PASS" : "FAIL", `HTTP ${wrong.res?.status}`);

    const right = await req(`${OPENREPLY}/api/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WEBHOOK_TOKEN)}&hub.challenge=abc123`);
    record("webhook answers Meta's verification", right.res?.status === 200 && right.text === "abc123" ? "PASS" : "FAIL", r2(right));
  }

  const health = await req(`${OPENREPLY}/api/health`, { timeoutMs: 15_000 });
  if (health.error) {
    record("health endpoint responds", "FAIL", `${health.error}. This is what an unreachable Redis looks like (ioredis retries forever). Check Upstash and REDIS_URL.`);
    return;
  }
  try {
    // OpenReply nests its results under `checks`: { status, checks: { database, redis, queue, worker } }.
    const parsed = JSON.parse(health.text) as { checks?: Record<string, unknown> };
    const body = parsed.checks ?? {};
    const detail = (k: string) => {
      const v = body[k] as { status?: string; healthy?: boolean } | undefined;
      return v?.status ?? (v?.healthy === true ? "ok" : v?.healthy === false ? "down" : "missing");
    };
    record("database reachable", detail("database") === "ok" ? "PASS" : "FAIL", detail("database"));
    record("Redis reachable", detail("redis") === "ok" ? "PASS" : "FAIL", detail("redis"));
    record("queue readable", detail("queue") === "ok" ? "PASS" : "FAIL", detail("queue"));
    record("DM worker heartbeat", detail("worker") === "ok" ? "PASS" : "FAIL", detail("worker") === "ok" ? "" : "no recent heartbeat; DMs will not send until the worker is running");
  } catch {
    record("health endpoint returns JSON", "FAIL", `HTTP ${health.res?.status}`);
  }
}

function r2(r: { res: Response | null; error: string | null }): string {
  return r.error ?? `HTTP ${r.res?.status}`;
}

async function checkSupabase(): Promise<void> {
  section("Supabase API lockdown");
  if (!SUPABASE_URL || !ANON) {
    record("anon-key checks", "SKIP", "SUPABASE_URL / SUPABASE_ANON_KEY not set");
    return;
  }
  const headers = { apikey: ANON, authorization: `Bearer ${ANON}` };

  for (const table of ["posts", "campaigns", "ig_accounts"]) {
    const r = await req(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, { headers });
    let leaked = false;
    try {
      const body = JSON.parse(r.text);
      leaked = r.res?.status === 200 && Array.isArray(body) && body.length > 0;
    } catch {
      leaked = false;
    }
    record(`anon key cannot read ${table}`, leaked ? "FAIL" : "PASS", `HTTP ${r.res?.status}`);
  }

  const list = await req(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 1 })
  });
  let enumerable = false;
  try {
    const body = JSON.parse(list.text);
    enumerable = list.res?.status === 200 && Array.isArray(body) && body.length > 0;
  } catch {
    enumerable = false;
  }
  record("anon key cannot list the media bucket", enumerable ? "WARN" : "PASS", enumerable ? "draft images are enumerable; apply supabase/migrations/0007_storage_no_list.sql" : `HTTP ${list.res?.status}`);
}

async function main(): Promise<void> {
  console.log("jqp smoke test");
  if (!WEB) {
    console.error("\nNo dashboard URL. Set APP_BASE_URL in .env or SMOKE_WEB_URL.");
    process.exit(2);
  }
  await checkWeb();
  if (OPENREPLY) await checkOpenReply();
  else {
    section("OpenReply");
    record("checks", "SKIP", "OPENREPLY_DASHBOARD_URL not set");
  }
  await checkSupabase();

  const count = (s: Status) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("PASS")} passed · ${count("FAIL")} failed · ${count("WARN")} warnings · ${count("SKIP")} skipped`);
  if (count("FAIL") > 0) {
    console.log("\nFailures:");
    for (const r of results.filter((x) => x.status === "FAIL")) console.log(`  ✗ [${r.group.split("  ")[0]}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    process.exit(1);
  }
}

void main();
