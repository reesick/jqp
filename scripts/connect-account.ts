#!/usr/bin/env tsx
/**
 * Connects the Instagram account that posts will be published from, using an access token you copy to the clipboard.
 * The token is never printed, never put on the command line and never written anywhere in plain text except the
 * local root env file (which the local publish worker reads) and the database, where it is stored encrypted.
 *
 *   1. Copy the token (Meta console, Instagram, API setup with Instagram login, Generate token).
 *   2. node --import tsx scripts/connect-account.ts --expect addaddy.ai --check      (looks only, changes nothing)
 *   3. node --import tsx scripts/connect-account.ts --expect addaddy.ai               (saves it)
 *
 * What it checks before it saves anything:
 *   - the token works and belongs to the account you expect (--expect <username>)
 *   - the account can publish (content_publishing_limit answers) and is a professional account
 *   - which webhook fields the account is subscribed to (comments, messaging_postbacks)
 * What it saves:
 *   - ig_accounts row (token encrypted with ENCRYPTION_KEY, expiry recorded), so the weekly refresh job keeps it alive
 *   - META_IG_USER_ID and META_LONG_LIVED_ACCESS_TOKEN in the root .env (backed up to the private backup folder first)
 *   - META_IG_USER_ID on Vercel jqp-web (skip with --no-vercel). The token itself is not needed on Vercel.
 */
import { loadRootDotenv } from "@jqp/core/bootstrap";
loadRootDotenv();
import { closeDb, loadEnv } from "@jqp/core";
import { exchangeForLongLivedToken, graphRequest, refreshLongLivedToken, resolveInstagramAccount } from "@jqp/meta";
import { upsertIgAccount } from "@jqp/publisher";
import { fail, readClipboard, updateLocalFiles, updateVercel } from "./lib/env-update.js";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};

const SIXTY_DAYS = 60 * 24 * 3600;

function line(ok: boolean | "warn", text: string): void {
  console.log(`${ok === true ? "✓" : ok === "warn" ? "!" : "✗"} ${text}`);
}

async function main(): Promise<void> {
  loadEnv(); // fails early with a clear message if the root env is incomplete

  const raw = readClipboard().trim();
  if (!raw || /\s/.test(raw) || raw.length < 40) fail("The clipboard does not look like an access token (too short, or it has spaces). Copy the token again and re-run.");
  let token = raw;

  // 1. Who does this token belong to?
  let who: { igUserId: string; username?: string };
  try {
    who = await resolveInstagramAccount(token);
  } catch (err) {
    fail(`Instagram rejected the token: ${err instanceof Error ? err.message.split("\n")[0]?.slice(0, 200) : "unknown error"}. Generate a new one and copy it again.`);
  }
  line(true, `Token works. It belongs to @${who.username ?? "(no username returned)"} (account id ${who.igUserId}).`);

  const expected = value("expect")?.replace(/^@/, "").toLowerCase();
  if (expected && who.username?.toLowerCase() !== expected) {
    fail(`This token is for @${who.username}, not @${expected}. Nothing was saved. Copy the token for @${expected} and re-run.`);
  }
  if (!expected) line("warn", "No --expect given, so the account name was not checked. Use --expect <username> to be safe.");

  // 2. Make it long-lived if it is not, and learn when it expires.
  let expiresInSeconds = SIXTY_DAYS;
  let expiryKnown = false;
  try {
    const long = await exchangeForLongLivedToken(token); // only succeeds for a short-lived token
    token = long.access_token;
    expiresInSeconds = long.expires_in ?? SIXTY_DAYS;
    expiryKnown = true;
    line(true, `Exchanged a short-lived token for a long-lived one (about ${Math.round(expiresInSeconds / 86400)} days).`);
  } catch {
    try {
      const refreshed = await refreshLongLivedToken(token); // succeeds for a long-lived token at least a day old
      token = refreshed.access_token;
      expiresInSeconds = refreshed.expires_in ?? SIXTY_DAYS;
      expiryKnown = true;
      line(true, `Token is long-lived and was renewed (about ${Math.round(expiresInSeconds / 86400)} days left).`);
    } catch {
      line("warn", "Could not confirm the expiry (a brand new long-lived token cannot be renewed for the first day). Assuming 60 days; the weekly refresh job will correct it.");
    }
  }

  // 3. Can it publish? Is it subscribed to the webhook fields we need?
  let canPublish = false;
  try {
    const limit = await graphRequest<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(`/${who.igUserId}/content_publishing_limit`, {
      accessToken: token,
      params: { fields: "quota_usage,config" }
    });
    const first = limit.data?.[0];
    canPublish = true;
    line(true, `Publishing permission works (${first?.quota_usage ?? 0} of ${first?.config?.quota_total ?? 100} posts used in the last 24 hours).`);
  } catch (err) {
    line(false, `Publishing check failed: ${err instanceof Error ? err.message.split("\n")[0]?.slice(0, 160) : "unknown"}. The token probably lacks instagram_business_content_publish, or the account is not a professional account.`);
  }

  let fields: string[] = [];
  try {
    const subs = await graphRequest<{ data?: { subscribed_fields?: string[] }[] }>(`/${who.igUserId}/subscribed_apps`, { accessToken: token });
    fields = subs.data?.flatMap((d) => d.subscribed_fields ?? []) ?? [];
  } catch {
    /* reported below */
  }
  const need = ["comments", "messaging_postbacks"];
  const missing = need.filter((f) => !fields.includes(f));
  if (fields.length === 0) line("warn", "No webhook subscription found for this account yet. Connect it in OpenReply (Settings, Connect Instagram) and add messaging_postbacks.");
  else if (missing.length) line("warn", `Webhook fields present: ${fields.join(", ")}. Missing: ${missing.join(", ")}.`);
  else line(true, `Webhook fields present: ${fields.join(", ")}.`);
  if (fields.includes("messaging_seen")) line("warn", "messaging_seen is subscribed. This system keeps it off on purpose.");

  if (flag("check")) {
    console.log("\n--check: nothing was saved. Re-run without --check to save.");
    return;
  }
  if (!canPublish && !flag("force")) fail("Publishing does not work with this token, so it was not saved. Fix the permission (or pass --force to save it anyway).");

  // 4. Save.
  await upsertIgAccount({ igUserId: who.igUserId, username: who.username, accessToken: token, expiresInSeconds });
  line(true, `Stored (encrypted) in the database${expiryKnown ? "" : " with an assumed 60 day expiry"}.`);

  console.log("\nLocal env file:");
  updateLocalFiles(who.igUserId, [{ path: ".env", key: "META_IG_USER_ID" }]);
  updateLocalFiles(token, [{ path: ".env", key: "META_LONG_LIVED_ACCESS_TOKEN" }]);

  if (!flag("no-vercel")) {
    updateVercel(who.igUserId, [{ project: "jqp-web", key: "META_IG_USER_ID" }]);
    console.log("Vercel needs a redeploy before the new META_IG_USER_ID applies: push to main, or `vercel --prod` in apps/web.");
  }

  console.log(
    `\nDone. Posts and campaigns now use @${who.username ?? who.igUserId}. Remaining by hand: connect the same account in OpenReply (Settings, Connect Instagram), then run: npm run doctor`
  );
}

main()
  .catch((err) => fail(err instanceof Error ? err.message : String(err)))
  .finally(() => void closeDb().catch(() => undefined));
