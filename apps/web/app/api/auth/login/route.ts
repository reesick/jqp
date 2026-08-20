import { NextRequest, NextResponse } from "next/server";
import { loadEnv, rootLogger } from "@jqp/core";
import { sha256Hex, timingSafeEqualString } from "@jqp/core/edge-safe";

const COOKIE_NAME = "jqp_session";

/**
 * In-memory failed-attempt limiter.
 *
 * The dashboard is guarded by a single shared secret with no lockout, so an
 * unthrottled endpoint is an open invitation to grind it. In-memory (rather
 * than Redis) is proportionate here: this is a single-operator dashboard, and
 * per-instance counters are still enough to make online guessing impractical.
 * If this ever scales to several instances, move the counter to Redis —
 * per-instance windows multiply the effective allowance by the instance count.
 */
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string): { allowed: boolean } {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 0, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }
  return { allowed: entry.count < MAX_ATTEMPTS };
}

function recordFailure(key: string): void {
  const entry = attempts.get(key);
  if (entry) entry.count += 1;
}

function clearFailures(key: string): void {
  attempts.delete(key);
}

/**
 * `next` comes from a query param, and `new URL(next, base)` happily resolves
 * an absolute URL — so an unvalidated value turns the login form into an open
 * redirect (`/login?next=https://evil.com` bounces the operator to the attacker
 * straight after a successful login, which is a clean phishing handoff).
 *
 * Resolve first, then compare origins — do NOT try to pattern-match the unsafe
 * prefixes. Testing found `/\evil.com` defeats a `startsWith("//")` check,
 * because the WHATWG URL parser treats a backslash as equivalent to a forward
 * slash and resolves it off-site. Checking the resolved origin is immune to
 * that whole class of trick.
 */
function safeNext(value: string, base: string): string {
  try {
    const resolved = new URL(value, base);
    if (resolved.origin !== new URL(base).origin) return "/";
    return resolved.pathname + resolved.search;
  } catch {
    return "/";
  }
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const secret = String(form.get("secret") ?? "");
  const next = safeNext(String(form.get("next") ?? "/"), request.url);
  const env = loadEnv();

  // x-forwarded-for is spoofable, but behind Vercel/Render it's set by the
  // platform. Worst case a determined attacker rotates it and we're back to
  // the unthrottled behaviour we had before — no worse.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  if (!rateLimit(ip).allowed) {
    rootLogger.warn("login_rate_limited", { ip });
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "1");
    return NextResponse.redirect(url, { status: 303 });
  }

  const ok = secret.length > 0 && timingSafeEqualString(await sha256Hex(secret), await sha256Hex(env.DASHBOARD_SHARED_SECRET));

  if (!ok) {
    recordFailure(ip);
    rootLogger.warn("login_failed", { ip });
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "1");
    if (next) url.searchParams.set("next", next);
    return NextResponse.redirect(url, { status: 303 });
  }

  clearFailures(ip);

  // Store a hash of the secret, not the secret itself — a leaked cookie
  // can't be replayed as DASHBOARD_SHARED_SECRET anywhere else, only as
  // this specific session (see apps/web/middleware.ts for the check).
  const response = NextResponse.redirect(new URL(next, request.url), { status: 303 });
  response.cookies.set(COOKIE_NAME, await sha256Hex(env.DASHBOARD_SHARED_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
  return response;
}
