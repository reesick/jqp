import { describe, expect, it } from "vitest";
import { AuthError, NonRetryableError, RateLimitError } from "@jqp/core";
import { classifyMetaError } from "./errors.js";

describe("classifyMetaError", () => {
  it("classifies token-invalid (190) as AuthError", () => {
    const err = classifyMetaError(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    expect(err).toBeInstanceOf(AuthError);
  });

  it("classifies permission errors (102, 10) as AuthError", () => {
    expect(classifyMetaError(400, { error: { message: "Session expired", code: 102 } })).toBeInstanceOf(AuthError);
    expect(classifyMetaError(403, { error: { message: "Permission denied", code: 10 } })).toBeInstanceOf(AuthError);
  });

  it("classifies rate-limit codes (4, 17, 32, 613) as RateLimitError", () => {
    for (const code of [4, 17, 32, 613]) {
      const err = classifyMetaError(400, { error: { message: "Rate limited", code } });
      expect(err).toBeInstanceOf(RateLimitError);
    }
  });

  it("classifies Instagram's business-use-case limit (80002) as a retryable rate limit, not a permanent failure", () => {
    const err = classifyMetaError(400, { error: { message: "Application request limit reached", code: 80002 } });
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it("carries Meta's wait time from the response headers", () => {
    const headers = { get: (n: string) => (n === "x-business-use-case-usage" ? JSON.stringify({ "1": [{ call_count: 100, estimated_time_to_regain_access: 12 }] }) : null) };
    const err = classifyMetaError(400, { error: { message: "limit", code: 80002 } }, undefined, headers) as RateLimitError;
    expect(err.retryAfterMs).toBe(12 * 60_000);
  });

  it("classifies HTTP 429 as RateLimitError even without a recognized code", () => {
    const err = classifyMetaError(429, { error: { message: "Too many requests" } });
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it("classifies HTTP 5xx as RateLimitError (transient, safe to retry)", () => {
    const err = classifyMetaError(503, { error: { message: "Service unavailable" } });
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it("classifies a known media/container error (9004) as NonRetryableError", () => {
    const err = classifyMetaError(400, { error: { message: "Media processing failed", code: 9004 } });
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err).not.toBeInstanceOf(AuthError);
  });

  it("classifies a generic 4xx as NonRetryableError", () => {
    const err = classifyMetaError(400, { error: { message: "Bad request", code: 100 } });
    expect(err).toBeInstanceOf(NonRetryableError);
  });

  it("preserves the original message and context in the thrown error", () => {
    const err = classifyMetaError(400, { error: { message: "Something specific broke", code: 100 } }, { path: "/123/media" });
    expect(err.message).toBe("Something specific broke");
    expect((err as NonRetryableError).details).toMatchObject({ path: "/123/media", code: 100 });
  });

  it("falls back to a generic message when the body has no error object", () => {
    const err = classifyMetaError(500, undefined);
    expect(err.message).toContain("500");
  });
});
