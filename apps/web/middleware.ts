import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@jqp/core/edge-safe";

// Edge runtime middleware — deliberately does not import the main @jqp/core
// entrypoint (its barrel export pulls in postgres.js, which needs Node's
// net/tls modules and isn't edge-compatible). @jqp/core/edge-safe is a
// separate Web-Crypto-only subpath built for exactly this.

const COOKIE_NAME = "jqp_session";
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/health"]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Forwarded so server components (e.g. the dashboard sidebar) can
  // highlight the active link without needing a client component.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);

  // /api/cron/* is called by a scheduler with a bearer token, not a browser with a cookie;
  // each route enforces that token itself (app/api/_lib/cron-auth.ts) and refuses when unset.
  // WARNING: anything added under /api/cron/ skips the cookie check, so every new route
  // there MUST call requireMonitorToken() first.
  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith("/api/cron/")) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Defence in depth on top of SameSite=Lax: refuse state-changing requests that
  // the browser says came from another site. Requests without the header
  // (curl, older browsers) are unaffected.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (request.method !== "GET" && request.method !== "HEAD" && fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return NextResponse.json({ success: false, error: "Cross-site request blocked" }, { status: 403 });
  }

  const secret = process.env.DASHBOARD_SHARED_SECRET;
  const cookie = request.cookies.get(COOKIE_NAME)?.value;

  // The cookie is an expiring HMAC token (see createSessionToken): signed with
  // the secret, time-limited, and rotating the secret invalidates every session.
  // Trim to match loadEnv(), which trims this value when login signs the token.
  const authorized = await verifySessionToken(cookie, secret?.trim() ?? "");

  if (!authorized) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
