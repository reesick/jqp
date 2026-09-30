/**
 * Edge-runtime-safe utilities — Web Crypto API only, no node:crypto,
 * no dependency on anything in index.ts (whose barrel export pulls in
 * postgres.js, which needs Node's net/tls modules and breaks in
 * Next.js middleware). Import this subpath directly:
 *   import { sha256Hex, timingSafeEqualString } from "@jqp/core/edge-safe";
 */

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish string comparison without node:crypto's timingSafeEqual (edge runtime has no access to it). Same tradeoff as packages/core/src/crypto.ts's Node version: length is compared first, so length itself isn't hidden — acceptable for equal-length hex digests. */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Session lifetime. Kept here so the cookie Max-Age and the token expiry cannot drift apart. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Builds a time-limited session token: `v1.<expiryMs>.<hmac>`.
 *
 * Replaces a static sha256(secret) cookie, which never expired and let a leaked
 * cookie be attacked offline to recover the secret. The HMAC is keyed by the
 * secret, so the token can't be forged without it and can't be reversed to it,
 * and rotating the secret invalidates every outstanding session.
 */
export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const exp = now + SESSION_TTL_MS;
  return `v1.${exp}.${await hmacSha256Hex(secret, `v1.${exp}`)}`;
}

export async function verifySessionToken(token: string | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split(".");
  const [version, expRaw, sig] = parts;
  if (parts.length !== 3 || version !== "v1" || expRaw === undefined || sig === undefined) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now) return false;
  return timingSafeEqualString(sig, await hmacSha256Hex(secret, `v1.${expRaw}`));
}
