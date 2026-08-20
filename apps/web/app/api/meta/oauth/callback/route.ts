import { NextRequest, NextResponse } from "next/server";
import { rootLogger } from "@jqp/core";
import { timingSafeEqualString } from "@jqp/core/edge-safe";
import { exchangeCodeForToken, exchangeForLongLivedToken, resolveInstagramAccount } from "@jqp/meta";
import { upsertIgAccount } from "@jqp/publisher";
import { OAUTH_STATE_COOKIE } from "../start/route";

/** Clears the one-shot state cookie on every exit path, success or failure. */
function redirectClearingState(url: URL) {
  const response = NextResponse.redirect(url);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const errorParam = request.nextUrl.searchParams.get("error");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  const settings = (params: Record<string, string>) => {
    const url = new URL("/settings", request.url);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  };

  if (errorParam || !code) {
    return redirectClearingState(settings({ oauth_error: errorParam ?? "missing_code" }));
  }

  // CSRF check — see the comment in ../start/route.ts for the concrete attack
  // this prevents. Constant-time compare so the value can't be probed byte by byte.
  if (!state || !expectedState || !timingSafeEqualString(state, expectedState)) {
    rootLogger.warn("oauth_state_mismatch", { hasState: Boolean(state), hasCookie: Boolean(expectedState) });
    return redirectClearingState(settings({ oauth_error: "state_mismatch" }));
  }

  try {
    const shortLived = await exchangeCodeForToken(code);
    const longLived = await exchangeForLongLivedToken(shortLived.access_token);
    const profile = await resolveInstagramAccount(longLived.access_token);

    await upsertIgAccount({
      igUserId: profile.igUserId,
      username: profile.username,
      accessToken: longLived.access_token,
      expiresInSeconds: longLived.expires_in
    });

    return redirectClearingState(settings({ connected: profile.username ?? profile.igUserId }));
  } catch (err) {
    // The detail goes to the logs, not into a URL. A query param lands in
    // browser history, referrer headers and any proxy access log along the way,
    // and upstream Meta errors can carry request internals.
    rootLogger.error("oauth_callback_failed", { error: err instanceof Error ? err.message : String(err) });
    return redirectClearingState(settings({ oauth_error: "exchange_failed" }));
  }
}
