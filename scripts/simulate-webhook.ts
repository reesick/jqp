#!/usr/bin/env tsx
/**
 * Posts a correctly-signed fake Instagram comment webhook event to
 * OpenReply's own /api/webhook endpoint — that's where Meta's real
 * webhook callback URL points now (comment-to-DM is entirely
 * OpenReply's territory, see docs/SETUP.md), not this app.
 *
 * Reads INSTAGRAM_APP_SECRET / FACEBOOK_APP_SECRET straight from
 * vendor/openreply/.env (a separate file from this repo's root .env)
 * and signs the payload exactly the way OpenReply's own
 * verifyWebhookSignature expects (vendor/openreply/lib/meta/webhook.ts):
 * header "x-hub-signature-256: sha256=<hex hmac>".
 *
 * Usage:
 *   npm run simulate-webhook -- --media-id media_123 --account-id 17841400000000001 --comment "INFO"
 *
 * Requires vendor/openreply's web app to be running (npm run dev -- -p 3100).
 */
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key?.startsWith("--")) {
      args[key.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return args;
}

function readOpenReplyEnvSecret(): string {
  const envPath = resolve(process.cwd(), "vendor/openreply/.env");
  if (!existsSync(envPath)) {
    console.error(`vendor/openreply/.env not found. Run this from the repo root after setting up OpenReply (docs/SETUP.md).`);
    process.exit(1);
  }
  const contents = readFileSync(envPath, "utf-8");
  const line = contents.split("\n").find((l) => l.startsWith("INSTAGRAM_APP_SECRET=") || l.startsWith("FACEBOOK_APP_SECRET="));
  const secret = line?.split("=").slice(1).join("=").trim();
  if (!secret) {
    console.error("Neither INSTAGRAM_APP_SECRET nor FACEBOOK_APP_SECRET is set in vendor/openreply/.env yet — fill those in first (docs/SETUP.md).");
    process.exit(1);
  }
  return secret;
}

async function main() {
  const args = parseArgs();
  const mediaId = args["media-id"] ?? "mock_media_id";
  const accountId = args["account-id"] ?? "17841400000000001";
  const commentText = args["comment"] ?? "INFO";
  const commenterId = args["commenter-id"] ?? "9999999999999";
  const targetUrl = args["url"] ?? "http://localhost:3100/api/webhook";

  const secret = readOpenReplyEnvSecret();

  const payload = {
    object: "instagram",
    entry: [
      {
        id: accountId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "comments",
            value: {
              id: `comment_${Date.now()}`,
              text: commentText,
              from: { id: commenterId, username: "simulated_user" },
              media: { id: mediaId }
            }
          }
        ]
      }
    ]
  };

  const rawBody = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");

  console.log(`POST ${targetUrl}`);
  console.log(rawBody);

  const response = await fetch(targetUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: rawBody
  });

  console.log(`\n<- ${response.status} ${response.statusText}`);
  console.log(await response.text());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
