#!/usr/bin/env tsx
/**
 * Registers the publishing account with the DM engine (OpenReply) without the browser sign-in and OAuth round trip.
 *
 * OpenReply is a separate app with its own "InstagramAccount" table, so it does not see the token stored by
 * connect-account. This does exactly what OpenReply's own connect callback does (vendor/openreply
 * app/api/instagram/callback/route.ts): encrypt the token with OpenReply's key (AES-256-GCM, iv + tag + data, base64),
 * upsert the "InstagramAccount" row, and subscribe the account to webhooks. The token is read from our own encrypted
 * ig_accounts row, so nothing is copied, printed or put on a command line.
 *
 *   node --import tsx scripts/connect-openreply-account.ts --expect addaddy.ai --check
 *   node --import tsx scripts/connect-openreply-account.ts --expect addaddy.ai
 *   (add --workspace <id> when OpenReply has more than one workspace)
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { loadRootDotenv } from "@jqp/core/bootstrap";
loadRootDotenv();
import { closeDb, getDb, loadEnv } from "@jqp/core";
import { listAccountsWithTokens } from "@jqp/publisher";
import { fail } from "./lib/env-update.js";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};

const WANTED_FIELDS = ["comments", "messages", "messaging_postbacks"];

function encryptLikeOpenReply(plaintext: string, keyHex: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function decryptLikeOpenReply(b64: string, keyHex: string): string {
  const all = Buffer.from(b64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), all.subarray(0, 16));
  decipher.setAuthTag(all.subarray(16, 32));
  return Buffer.concat([decipher.update(all.subarray(32)), decipher.final()]).toString("utf8");
}

async function main(): Promise<void> {
  const env = loadEnv();
  const expected = value("expect")?.replace(/^@/, "").toLowerCase();
  if (!expected) fail("Pass --expect <username> so the wrong account cannot be registered.");

  const orFile = resolve(process.cwd(), "vendor/openreply/.env");
  const keyHex = existsSync(orFile) ? parse(readFileSync(orFile)).ENCRYPTION_KEY : undefined;
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) fail("OpenReply ENCRYPTION_KEY is missing or not 32-byte hex in its env file.");

  const accounts = await listAccountsWithTokens();
  const account = accounts.find((a) => a.username?.toLowerCase() === expected);
  if (!account) fail(`No stored token for @${expected}. Run connect-account first.`);

  const sql = getDb();
  const workspaces = await sql<{ id: string; name: string | null }[]>`select "id", "name" from "Workspace" order by "createdAt" asc`;
  let workspaceId = value("workspace");
  if (!workspaceId) {
    if (workspaces.length === 1) workspaceId = workspaces[0]?.id;
    else fail(`OpenReply has ${workspaces.length} workspaces; pass --workspace <id>. Ids: ${workspaces.map((w) => `${w.id} (${w.name ?? "unnamed"})`).join(", ")}`);
  }
  if (!workspaces.some((w) => w.id === workspaceId)) fail(`Workspace ${workspaceId} does not exist.`);

  const existing = await sql<{ workspaceId: string; webhookSubscribed: boolean }[]>`
    select "workspaceId", "webhookSubscribed" from "InstagramAccount" where "instagramId" = ${account.igUserId}`;
  console.log(`Workspace: ${workspaceId}. @${expected} (${account.igUserId}) ${existing.length ? "already has an OpenReply row" : "has no OpenReply row yet"}.`);
  // Moving an account between workspaces changes who owns its campaigns, so it only happens when asked for.
  if (existing[0] && existing[0].workspaceId !== workspaceId && !flag("move")) {
    fail(`@${expected} already belongs to workspace ${existing[0].workspaceId}. Pass --move to move it to ${workspaceId}.`);
  }
  if (flag("check")) {
    console.log("--check: nothing was changed.");
    return;
  }

  const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt) : null;
  const encrypted = encryptLikeOpenReply(account.accessToken, keyHex);
  if (decryptLikeOpenReply(encrypted, keyHex) !== account.accessToken) fail("Encryption round trip failed; nothing was written.");

  // Subscribe first, like OpenReply's callback: a failure is recorded as webhookSubscribed=false, not fatal.
  const base = `https://graph.instagram.com/${env.META_GRAPH_VERSION}`;
  let subscribed = false;
  try {
    const res = await fetch(`${base}/${account.igUserId}/subscribed_apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.accessToken}` },
      body: JSON.stringify({ subscribed_fields: WANTED_FIELDS })
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string } };
    subscribed = res.ok && body.success === true;
    console.log(subscribed ? "✓ Subscribed to webhook fields." : `✗ Webhook subscription failed: ${body.error?.message?.slice(0, 160) ?? res.status}`);
  } catch (err) {
    console.log(`✗ Webhook subscription failed: ${err instanceof Error ? err.message.slice(0, 160) : "unknown error"}`);
  }

  await sql`
    insert into "InstagramAccount" ("id", "workspaceId", "instagramId", "username", "accessToken", "tokenExpiresAt", "webhookSubscribed", "connectedAt", "updatedAt")
    values (${`jqp_${account.igUserId}`}, ${workspaceId as string}, ${account.igUserId}, ${expected}, ${encrypted}, ${expiresAt}, ${subscribed}, now(), now())
    on conflict ("instagramId") do update set
      "workspaceId" = excluded."workspaceId", "username" = excluded."username", "accessToken" = excluded."accessToken",
      "tokenExpiresAt" = excluded."tokenExpiresAt", "webhookSubscribed" = excluded."webhookSubscribed", "updatedAt" = now()`;
  console.log("✓ OpenReply InstagramAccount row saved (token encrypted with OpenReply's key).");

  // Read back what Instagram now has on file.
  try {
    const res = await fetch(`${base}/${account.igUserId}/subscribed_apps`, { headers: { Authorization: `Bearer ${account.accessToken}` } });
    const body = (await res.json()) as { data?: { subscribed_fields?: string[] }[] };
    console.log(`Subscribed fields now: ${(body.data?.[0]?.subscribed_fields ?? []).join(", ") || "(none)"}`);
  } catch {
    /* informational only */
  }
}

main()
  .catch((err) => fail(err instanceof Error ? err.message : String(err)))
  .finally(() => closeDb());
