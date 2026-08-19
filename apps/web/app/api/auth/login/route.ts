import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@jqp/core";
import { sha256Hex, timingSafeEqualString } from "@jqp/core/edge-safe";

const COOKIE_NAME = "jqp_session";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const secret = String(form.get("secret") ?? "");
  const next = String(form.get("next") ?? "/posts");
  const env = loadEnv();

  const ok = secret.length > 0 && timingSafeEqualString(await sha256Hex(secret), await sha256Hex(env.DASHBOARD_SHARED_SECRET));

  if (!ok) {
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "1");
    if (next) url.searchParams.set("next", next);
    return NextResponse.redirect(url, { status: 303 });
  }

  // Store a hash of the secret, not the secret itself — a leaked cookie
  // can't be replayed as DASHBOARD_SHARED_SECRET anywhere else, only as
  // this specific session (see apps/web/middleware.ts for the check).
  const response = NextResponse.redirect(new URL(next || "/posts", request.url), { status: 303 });
  response.cookies.set(COOKIE_NAME, await sha256Hex(env.DASHBOARD_SHARED_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
  return response;
}
