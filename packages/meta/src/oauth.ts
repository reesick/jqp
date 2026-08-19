import { loadEnv } from "@jqp/core";
import { graphRequest, resolveApiBase } from "./client.js";

export interface ShortLivedTokenResponse {
  access_token: string;
  user_id: string; // the Instagram-scoped professional account ID — this becomes ig_accounts.ig_user_id
  permissions?: string[];
}

export interface LongLivedTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number; // seconds, ~60 days for a long-lived token
}

/**
 * Instagram API with Instagram Login flow (not Facebook Login for
 * Business — see docs/SETUP.md and vendor/openreply/docs/setup.md's
 * Step 4, which is explicit that picking the Facebook Login use case
 * breaks this OAuth flow). One Meta app serves both this publisher
 * and OpenReply, so both must use the same login product.
 *
 * Step 1: exchange the short-lived `code` from the OAuth redirect for
 * a short-lived access token. Per Meta's current docs this is a POST
 * with form-encoded body (not query params) against api.instagram.com,
 * distinct from every other Graph API call this package makes.
 */
export async function exchangeCodeForToken(code: string): Promise<ShortLivedTokenResponse> {
  const env = loadEnv();
  const base = env.MOCK_META ? resolveApiBase() : "https://api.instagram.com";

  const form = new URLSearchParams({
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: env.META_OAUTH_REDIRECT_URI,
    code
  });

  const response = await fetch(`${base}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const body = (await response.json()) as ShortLivedTokenResponse & { error_message?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`Failed to exchange OAuth code: ${JSON.stringify(body)}`);
  }
  return body;
}

/** Step 2: exchange a short-lived token for a long-lived one (~60 days), via graph.instagram.com. */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<LongLivedTokenResponse> {
  const env = loadEnv();
  const base = env.MOCK_META ? resolveApiBase() : "https://graph.instagram.com";
  const url = new URL(`${base}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", env.META_APP_SECRET);
  url.searchParams.set("access_token", shortLivedToken);

  const response = await fetch(url.toString());
  const body = (await response.json()) as LongLivedTokenResponse & { error?: unknown };
  if (!response.ok || !body.access_token) {
    throw new Error(`Failed to exchange for long-lived token: ${JSON.stringify(body)}`);
  }
  return body;
}

/** Refreshes a long-lived token before it expires (must be called before expiry — an already-expired token cannot be refreshed and requires reconnecting the account). */
export async function refreshLongLivedToken(currentLongLivedToken: string): Promise<LongLivedTokenResponse> {
  const env = loadEnv();
  const base = env.MOCK_META ? resolveApiBase() : "https://graph.instagram.com";
  const url = new URL(`${base}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", currentLongLivedToken);

  const response = await fetch(url.toString());
  const body = (await response.json()) as LongLivedTokenResponse & { error?: unknown };
  if (!response.ok || !body.access_token) {
    throw new Error(`Failed to refresh long-lived token: ${JSON.stringify(body)}`);
  }
  return body;
}

export interface IgAccountLookup {
  igUserId: string;
  username?: string;
}

/** Resolves the connected account's own profile — no Facebook Page involved in the Instagram Login flow, unlike the older Facebook-Login-for-Business model. */
export async function resolveInstagramAccount(accessToken: string): Promise<IgAccountLookup> {
  const result = await graphRequest<{ user_id?: string; username?: string }>("/me", {
    accessToken,
    params: { fields: "user_id,username" }
  });

  if (!result.user_id) {
    throw new Error("Could not resolve Instagram account: /me returned no user_id");
  }

  return { igUserId: result.user_id, username: result.username };
}
