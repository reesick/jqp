import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS, createSessionToken, verifySessionToken } from "./edge-safe.js";

const SECRET = "a-long-random-shared-secret-for-tests-0123456789";

describe("session tokens", () => {
  it("accepts a freshly issued token", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken(token, SECRET)).toBe(true);
  });

  it("rejects an expired token", async () => {
    const issued = Date.now() - SESSION_TTL_MS - 1000;
    const token = await createSessionToken(SECRET, issued);
    expect(await verifySessionToken(token, SECRET)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken("some-other-secret");
    expect(await verifySessionToken(token, SECRET)).toBe(false);
  });

  it("rejects a token whose expiry was extended after signing", async () => {
    const token = await createSessionToken(SECRET);
    const [v, exp, sig] = token.split(".");
    const forged = `${v}.${Number(exp) + 10 * SESSION_TTL_MS}.${sig}`;
    expect(await verifySessionToken(forged, SECRET)).toBe(false);
  });

  it("rejects the legacy sha256(secret) cookie and malformed input", async () => {
    expect(await verifySessionToken("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", SECRET)).toBe(false);
    expect(await verifySessionToken("v1.notanumber.abc", SECRET)).toBe(false);
    expect(await verifySessionToken("v1.1.2.3", SECRET)).toBe(false);
    expect(await verifySessionToken(undefined, SECRET)).toBe(false);
    expect(await verifySessionToken("", SECRET)).toBe(false);
  });

  it("rejects everything when no secret is configured", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken(token, "")).toBe(false);
  });
});
