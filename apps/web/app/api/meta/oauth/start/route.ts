import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { loadEnv } from "@jqp/core";

export const OAUTH_STATE_COOKIE = "jqp_oauth_state";

/**
 * Redirects the operator's browser to Instagram's own consent screen
 * (Instagram Login flow — see packages/meta/src/oauth.ts and
 * docs/SETUP.md for why this is NOT the Facebook Login for Business
 * authorize URL). The scopes requested here must match the
 * permissions actually approved for the Meta app.
 *
 * The `state` parameter is CSRF protection, not decoration. Without it, a
 * logged-in operator who follows a hostile link lands on the callback with an
 * attacker-supplied `code` — and because the session cookie is sameSite="lax",
 * a top-level navigation still carries it, so the callback would happily bind
 * the ATTACKER'S Instagram account to this dashboard. We mint a random value,
 * park it in a short-lived httpOnly cookie, and require the callback to match.
 */
export async function GET() {
  const env = loadEnv();
  const state = randomBytes(32).toString("hex");

  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", env.META_APP_ID);
  url.searchParams.set("redirect_uri", env.META_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set(
    "scope",
    ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments", "instagram_business_manage_messages"].join(",")
  );

  const response = NextResponse.redirect(url.toString());
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 600 // 10 minutes — long enough to complete consent, short enough to not linger
  });
  return response;
}
