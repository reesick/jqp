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
