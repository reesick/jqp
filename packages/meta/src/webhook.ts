import { createHmac } from "node:crypto";
import { loadEnv, timingSafeEqualString } from "@jqp/core";

/**
 * Verifies Meta's X-Hub-Signature-256 header against the RAW request
 * body. This MUST run against the exact bytes Meta sent — do not
 * verify against a re-serialized JSON.stringify(parsedBody), because
 * key ordering/whitespace differences would break every signature.
 * The web framework's route handler is responsible for giving us the
 * raw body before any JSON parsing middleware touches it.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | null | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const env = loadEnv();
  const expected = createHmac("sha256", env.META_APP_SECRET).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  return timingSafeEqualString(expected, provided);
}

/**
 * Handles the GET verification handshake Meta performs when you
 * subscribe a webhook URL. Returns the challenge string to echo back,
 * or null if verify_token doesn't match (caller should respond 403).
 */
export function verifyWebhookChallenge(query: { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string }): string | null {
  const env = loadEnv();
  if (query["hub.mode"] !== "subscribe") return null;
  if (query["hub.verify_token"] !== env.META_WEBHOOK_VERIFY_TOKEN) return null;
  return query["hub.challenge"] ?? null;
}

// --------------------------------------------------------------------
// Payload shapes — Instagram webhook "comments" field.
// Verify current shape against Meta's webhook reference before
// production (plan section 91: "current webhook fields/subscriptions").
// --------------------------------------------------------------------

export interface CommentWebhookChange {
  igUserId: string; // entry.id — the IG account the event belongs to
  timestamp: number;
  commentId: string;
  mediaId: string;
  text: string;
  fromId?: string;
  fromUsername?: string;
  parentId?: string;
}

interface RawWebhookEnvelope {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{
      field?: string;
      value?: {
        id?: string;
        text?: string;
        from?: { id?: string; username?: string };
        media?: { id?: string };
        parent_id?: string;
      };
    }>;
  }>;
}

/**
 * Flattens a raw Meta webhook envelope into zero or more comment
 * change events. Ignores non-"comments" fields and malformed entries
 * rather than throwing — a single odd payload should not crash the
 * webhook route (plan section 42: validate, don't do heavy work here).
 */
export function parseCommentWebhookPayload(rawPayload: unknown): CommentWebhookChange[] {
  const envelope = rawPayload as RawWebhookEnvelope;
  if (envelope?.object !== "instagram" || !Array.isArray(envelope.entry)) return [];

  const events: CommentWebhookChange[] = [];

  for (const entry of envelope.entry) {
    if (!entry.id || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (change.field !== "comments") continue;
      const value = change.value;
      if (!value?.id || !value.media?.id || typeof value.text !== "string") continue;

      events.push({
        igUserId: entry.id,
        timestamp: entry.time ?? Date.now() / 1000,
        commentId: value.id,
        mediaId: value.media.id,
        text: value.text,
        fromId: value.from?.id,
        fromUsername: value.from?.username,
        parentId: value.parent_id
      });
    }
  }

  return events;
}
