#!/usr/bin/env tsx
/**
 * Rotates the Supabase database password end to end without ever printing it.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... npm run rotate-db-password -- --dry-run   (checks only)
 *   SUPABASE_ACCESS_TOKEN=sbp_... npm run rotate-db-password                (does it)
 *
 * Order (chosen so a failure can be undone):
 *   1. verify the token, the project and the CURRENT password
 *   2. generate a new password and set it (Supabase Management API: PATCH /database/password)
 *   3. prove the NEW password connects; if not, put the OLD one back and stop
 *   4. update the local env files (old values are backed up) and both Vercel projects
 * Then redeploy jqp-web and jqp-openreply-1: running deployments keep the old
 * password until they are redeployed, so do it straight away (about 2 minutes).
 *
 * Hosts and users are kept; only the password changes. OpenReply keeps the
 * transaction-pooler port (6543), everything else the session pooler (5432).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import postgres from "postgres";
import { fail, updateLocalFiles, updateVercel } from "./lib/env-update.js";

const dry = process.argv.includes("--dry-run");
const token = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!token) fail("Set SUPABASE_ACCESS_TOKEN for this one command (a Supabase personal access token).");

const current = parse(readFileSync(resolve(process.cwd(), ".env"))).DATABASE_URL ?? "";
let oldUrl: URL;
try {
  oldUrl = new URL(current);
} catch {
  fail("DATABASE_URL in the root env file is not a valid URL.");
}
const ref = oldUrl.username.split(".")[1];
if (!ref || !oldUrl.hostname.endsWith(".pooler.supabase.com")) fail("DATABASE_URL is not a Supabase pooler URL (expected user postgres.<ref>).");
const oldPassword = decodeURIComponent(oldUrl.password);

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000)
  });
}
// SQL cannot do this (Supabase forbids ALTER ROLE on postgres); the management API has a dedicated endpoint.
async function setPassword(password: string): Promise<void> {
  const res = await api("/database/password", { method: "PATCH", body: JSON.stringify({ password }) });
  if (!res.ok) throw new Error(`Supabase API ${res.status}: ${(await res.text()).slice(0, 160).split(password).join("***")}`);
}
function withPassword(base: URL, password: string, port?: string): string {
  const u = new URL(base.toString());
  u.password = password;
  if (port) u.port = port;
  return u.toString();
}
async function connects(url: string): Promise<boolean> {
  const sql = postgres(url, { ssl: "require", connect_timeout: 10, max: 1, onnotice: () => undefined });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const proj = await api("");
  if (!proj.ok) fail(`The access token was refused (HTTP ${proj.status}).`);
  const info = (await proj.json()) as { name?: string; status?: string };
  console.log(`Project: ${info.name} (${ref}), status ${info.status}`);
  if (info.name !== "jqp") fail(`Refusing to continue: the project at this reference is named "${info.name}", not "jqp".`);
  if (!(await connects(current))) fail("The CURRENT password in .env does not connect. Fix that first; nothing was changed.");
  console.log("✓ token valid, project is jqp, current password connects");
  if (dry) {
    console.log("Dry run: nothing changed.");
    return;
  }

  const fresh = randomBytes(24).toString("base64url"); // 32 chars, URL-safe, no quote characters
  await setPassword(fresh);

  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    ok = await connects(withPassword(oldUrl, fresh));
  }
  if (!ok) {
    await setPassword(oldPassword);
    fail("The new password did not connect, so the old one was restored. Nothing else was changed.");
  }
  console.log("✓ database password changed and the new one connects");

  const sessionUrl = withPassword(oldUrl, fresh, "5432");
  const txUrl = withPassword(oldUrl, fresh, "6543");
  updateLocalFiles(sessionUrl, [{ path: ".env", key: "DATABASE_URL" }]);
  updateLocalFiles(txUrl, [{ path: "vendor/openreply/.env", key: "DATABASE_URL" }]);
  updateVercel(sessionUrl, [{ project: "jqp-web", key: "DATABASE_URL" }]);
  updateVercel(txUrl, [{ project: "jqp-openreply-1", key: "DATABASE_URL" }]);
  console.log("\nNow redeploy jqp-web and jqp-openreply-1 (running deployments still hold the old password).");
}

main().catch((err) => {
  console.error("Failed:", err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/gi, "[db-url]") : err);
  process.exit(1);
});
