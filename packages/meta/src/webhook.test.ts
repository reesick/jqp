import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { __resetEnvCacheForTests } from "@jqp/core";
import { verifyWebhookSignature, verifyWebhookChallenge, parseCommentWebhookPayload } from "./webhook.js";

beforeAll(() => {
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "my-verify-token";
  process.env.APP_BASE_URL ??= "http://localhost:3000";
  process.env.DASHBOARD_SHARED_SECRET ??= "test-secret";
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-key";
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/postgres";
  process.env.META_APP_ID ??= "123";
  process.env.META_GRAPH_VERSION ??= "v23.0";
  process.env.META_API_BASE ??= "https://graph.facebook.com";
  process.env.META_IG_USER_ID ??= "999";
  process.env.META_OAUTH_REDIRECT_URI ??= "http://localhost:3000/api/meta/oauth/callback";
  process.env.ENCRYPTION_KEY ??= "a".repeat(64);
  process.env.BRIDGE_SHARED_SECRET ??= "bridge-secret";
  __resetEnvCacheForTests();
});

function sign(body: string): string {
  const digest = createHmac("sha256", "test-app-secret").update(body).digest("hex");
  return `sha256=${digest}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = sign(body);
    const tamperedBody = JSON.stringify({ hello: "world!" });
    expect(verifyWebhookSignature(tamperedBody, signature)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature("{}", null)).toBe(false);
    expect(verifyWebhookSignature("{}", undefined)).toBe(false);
  });

  it("rejects a malformed signature header", () => {
    expect(verifyWebhookSignature("{}", "not-sha256=abc")).toBe(false);
  });
});

describe("verifyWebhookChallenge", () => {
  it("echoes the challenge when verify_token matches", () => {
    const result = verifyWebhookChallenge({
      "hub.mode": "subscribe",
      "hub.verify_token": "my-verify-token",
      "hub.challenge": "abc123"
    });
    expect(result).toBe("abc123");
  });

  it("returns null when verify_token does not match", () => {
    const result = verifyWebhookChallenge({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
      "hub.challenge": "abc123"
    });
    expect(result).toBeNull();
  });

  it("returns null when mode is not subscribe", () => {
    const result = verifyWebhookChallenge({
      "hub.mode": "unsubscribe",
      "hub.verify_token": "my-verify-token",
      "hub.challenge": "abc123"
    });
    expect(result).toBeNull();
  });
});

describe("parseCommentWebhookPayload", () => {
  it("extracts a comment change event from a valid envelope", () => {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: 1700000000,
          changes: [
            {
              field: "comments",
              value: {
                id: "comment_123",
                text: "INFO",
                from: { id: "user_456", username: "someuser" },
                media: { id: "media_789" }
              }
            }
          ]
        }
      ]
    };

    const events = parseCommentWebhookPayload(payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      igUserId: "17841400000000000",
      commentId: "comment_123",
      mediaId: "media_789",
      text: "INFO",
      fromId: "user_456",
      fromUsername: "someuser"
    });
  });

  it("ignores non-comments fields", () => {
    const payload = {
      object: "instagram",
      entry: [{ id: "1", changes: [{ field: "mentions", value: {} }] }]
    };
    expect(parseCommentWebhookPayload(payload)).toHaveLength(0);
  });

  it("returns empty array for a non-instagram object", () => {
    expect(parseCommentWebhookPayload({ object: "page", entry: [] })).toHaveLength(0);
  });

  it("returns empty array for malformed input without throwing", () => {
    expect(parseCommentWebhookPayload(null)).toHaveLength(0);
    expect(parseCommentWebhookPayload(undefined)).toHaveLength(0);
    expect(parseCommentWebhookPayload({})).toHaveLength(0);
    expect(parseCommentWebhookPayload("not an object")).toHaveLength(0);
  });

  it("skips entries missing required fields", () => {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "1",
          changes: [{ field: "comments", value: { text: "hi" /* missing id, media */ } }]
        }
      ]
    };
    expect(parseCommentWebhookPayload(payload)).toHaveLength(0);
  });
});
