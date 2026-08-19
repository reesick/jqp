import { NextRequest, NextResponse } from "next/server";
import { sha256Hex, timingSafeEqualString } from "@jqp/core/edge-safe";

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

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const secret = process.env.DASHBOARD_SHARED_SECRET;
  const cookie = request.cookies.get(COOKIE_NAME)?.value;

  // The cookie holds sha256(secret), never the raw secret itself (see
  // /api/auth/login) — a leaked cookie can't be reused as the secret
  // elsewhere, and the comparison is constant-time on the hash.
  const authorized = Boolean(secret) && Boolean(cookie) && timingSafeEqualString(cookie!, await sha256Hex(secret!));

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
