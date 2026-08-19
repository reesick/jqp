import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, exchangeForLongLivedToken, resolveInstagramAccount } from "@jqp/meta";
import { upsertIgAccount } from "@jqp/publisher";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const errorParam = request.nextUrl.searchParams.get("error");

  if (errorParam || !code) {
    const url = new URL("/settings", request.url);
    url.searchParams.set("oauth_error", errorParam ?? "missing_code");
    return NextResponse.redirect(url);
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

    const url = new URL("/settings", request.url);
    url.searchParams.set("connected", profile.username ?? profile.igUserId);
    return NextResponse.redirect(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const url = new URL("/settings", request.url);
    url.searchParams.set("oauth_error", message);
    return NextResponse.redirect(url);
  }
}
