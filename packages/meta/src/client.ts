import { loadEnv, rootLogger, type Logger } from "@jqp/core";
import { classifyMetaError, type MetaErrorBody } from "./errors.js";
import { RetryableError, RateLimitError } from "@jqp/core";

export interface GraphRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  params?: Record<string, string | number | boolean | undefined>;
  accessToken: string;
  /** Max attempts for retryable errors (network, 429, 5xx). Default 4, matching plan section 51's backoff schedule shape. */
  maxAttempts?: number;
  logger?: Logger;
}

/** Resolves the Graph API base URL, honoring MOCK_META for local end-to-end testing (see docs/LOCAL.md). */
export function resolveApiBase(): string {
  const env = loadEnv();
  if (env.MOCK_META) {
    return `http://localhost:${env.MOCK_META_PORT}`;
  }
  return env.META_API_BASE;
}

function buildUrl(path: string, params: Record<string, string | number | boolean | undefined> | undefined): string {
  const env = loadEnv();
  const base = resolveApiBase();
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(`${base}/${env.META_GRAPH_VERSION}/${cleanPath}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const BACKOFF_SCHEDULE_MS = [1000, 3000, 8000]; // between attempts 1->2, 2->3, 3->4

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * ms * 0.25);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls the Meta Graph API with retry/backoff on transient failures.
 * Throws a classified error (AuthError / RateLimitError / NonRetryableError)
 * from @jqp/core on final failure — callers should not need to inspect
 * HTTP status codes themselves.
 */
/** Performs exactly one HTTP attempt. Always throws an @jqp/core AppError subclass — never a bare Error/TypeError — so the retry loop below can classify purely by `instanceof`. */
async function attemptOnce<T>(url: string, method: "GET" | "POST" | "DELETE", path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method, headers: { "content-type": "application/json" } });
  } catch (networkErr) {
    const message = networkErr instanceof Error ? networkErr.message : String(networkErr);
    throw new RetryableError(`Network error calling Meta API: ${message}`, "META_NETWORK_ERROR", { path });
  }

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw classifyMetaError(response.status, parsed as MetaErrorBody, { path, method });
  }

  return parsed as T;
}

export async function graphRequest<T>(path: string, options: GraphRequestOptions): Promise<T> {
  const { method = "GET", params = {}, accessToken, maxAttempts = 4 } = options;
  const log = options.logger ?? rootLogger;
  const url = buildUrl(path, { ...params, access_token: accessToken });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptOnce<T>(url, method, path);
    } catch (err) {
      // Non-retryable (AuthError, NonRetryableError) always propagates immediately — retrying cannot fix it.
      if (!(err instanceof RetryableError) || attempt >= maxAttempts) {
        throw err;
      }
      const waitMs = err instanceof RateLimitError && err.retryAfterMs ? err.retryAfterMs : jitter(BACKOFF_SCHEDULE_MS[attempt - 1] ?? 8000);
      log.warn("meta_request_retrying", { path, attempt, maxAttempts, waitMs, error: err.message });
      await sleep(waitMs);
    }
  }

  throw new RetryableError(`Meta API request exhausted ${maxAttempts} attempts`, "META_RETRIES_EXHAUSTED", { path });
}
