/**
 * Error taxonomy used across the whole system. The queue's retry
 * policy (packages/queue) decides whether to retry a failed job
 * purely by checking `error instanceof RetryableError` — so every
 * place that throws (Meta client, storage, validator) must throw one
 * of these, not a bare Error, or a job will retry (or fail to retry)
 * for the wrong reason.
 */

export class AppError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

/** Input/content is wrong and will NEVER succeed by retrying (bad folder, invalid image, missing caption). */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", details);
  }
}

/** Transient failure — network blip, Meta rate limit, temporary container processing error. Safe to retry with backoff. */
export class RetryableError extends AppError {
  constructor(message: string, code = "RETRYABLE", details?: Record<string, unknown>) {
    super(message, code, details);
  }
}

/** Failure that retrying will not fix without a human/config change (bad permissions, malformed request, deleted media). */
export class NonRetryableError extends AppError {
  constructor(message: string, code = "NON_RETRYABLE", details?: Record<string, unknown>) {
    super(message, code, details);
  }
}

/** Token expired, invalid, or revoked. Non-retryable until the account is reconnected — but distinct from other non-retryable errors so the dashboard can surface "reconnect Instagram" specifically. */
export class AuthError extends NonRetryableError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "AUTH_ERROR", details);
  }
}

/** Meta rate limit hit. Retryable, but callers should back off longer than a generic RetryableError — see packages/meta's retry-after handling. */
export class RateLimitError extends RetryableError {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number, details?: Record<string, unknown>) {
    super(message, "RATE_LIMIT", details);
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof RetryableError;
}
