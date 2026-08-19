import { NextResponse } from "next/server";
import { loadEnv } from "@jqp/core";

/**
 * Redirects the operator's browser to Instagram's own consent screen
 * (Instagram Login flow — see packages/meta/src/oauth.ts and
 * docs/SETUP.md for why this is NOT the Facebook Login for Business
 * authorize URL). The scopes requested here must match the
 * permissions actually approved for the Meta app.
 */
export async function GET() {
  const env = loadEnv();
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", env.META_APP_ID);
  url.searchParams.set("redirect_uri", env.META_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments", "instagram_business_manage_messages"].join(",")
  );
  return NextResponse.redirect(url.toString());
}
