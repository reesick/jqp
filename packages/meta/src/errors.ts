import { AuthError, NonRetryableError, RateLimitError, RetryableError } from "@jqp/core";

/**
 * Meta Graph API error code classification. These codes are the
 * current well-documented set as of this build (May 2026 knowledge
 * cutoff) — Meta can and does change error codes over time. Before
 * production, re-verify against
 * https://developers.facebook.com/docs/graph-api/guides/error-handling
 * (plan section 54/91). If you see an error code NOT in these sets,
 * it falls through to the generic HTTP-status-based classification
 * below, which is a safe default either way.
 */

// Rate limiting / transient API-service errors — safe to retry with backoff.
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 613]);

// Token invalid/expired/revoked or missing permission — retrying will not help; the account needs reconnecting.
const AUTH_CODES = new Set([190, 102, 10]);

// Container/media specific errors that mean "this media will never publish" (malformed URL, unsupported format, deleted).
const MEDIA_NON_RETRYABLE_CODES = new Set([9004]);

export interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export function classifyMetaError(status: number, body: MetaErrorBody | undefined, context?: Record<string, unknown>): Error {
  const err = body?.error;
  const code = err?.code;
  const message = err?.message ?? `Meta API error (HTTP ${status})`;
  const details = { httpStatus: status, code, subcode: err?.error_subcode, type: err?.type, fbtraceId: err?.fbtrace_id, ...context };

  if (code !== undefined && AUTH_CODES.has(code)) {
    return new AuthError(message, details);
  }
  if (code !== undefined && MEDIA_NON_RETRYABLE_CODES.has(code)) {
    return new NonRetryableError(message, "META_MEDIA_ERROR", details);
  }
  if (status === 429 || (code !== undefined && RETRYABLE_CODES.has(code)) || status >= 500) {
    return new RateLimitError(message, undefined, details);
  }
  if (status >= 400 && status < 500) {
    return new NonRetryableError(message, "META_CLIENT_ERROR", details);
  }
  return new RetryableError(message, "META_UNKNOWN_ERROR", details);
}
