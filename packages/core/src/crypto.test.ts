import { describe, expect, it, beforeAll } from "vitest";
import { encryptSecret, decryptSecret, generateEncryptionKey, timingSafeEqualString } from "./crypto.js";
import { __resetEnvCacheForTests } from "./env.js";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = generateEncryptionKey();
  process.env.APP_BASE_URL ??= "http://localhost:3000";
  process.env.DASHBOARD_SHARED_SECRET ??= "test-secret";
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-key";
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/postgres";
  process.env.META_APP_ID ??= "123";
  process.env.META_APP_SECRET ??= "secret";
  process.env.META_GRAPH_VERSION ??= "v23.0";
  process.env.META_API_BASE ??= "https://graph.facebook.com";
  process.env.META_IG_USER_ID ??= "999";
  process.env.META_OAUTH_REDIRECT_URI ??= "http://localhost:3000/api/meta/oauth/callback";
  process.env.META_WEBHOOK_VERIFY_TOKEN ??= "verify-me";
  process.env.BRIDGE_SHARED_SECRET ??= "bridge-secret";
  __resetEnvCacheForTests();
});

describe("crypto", () => {
  it("round-trips a secret through encrypt/decrypt", () => {
    const plaintext = "IGQVJ...some-long-lived-token...";
    const payload = encryptSecret(plaintext);
    expect(payload.ciphertext).not.toEqual(plaintext);
    const decrypted = decryptSecret(payload);
    expect(decrypted).toEqual(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.iv).not.toEqual(b.iv);
  });

  it("fails to decrypt with a tampered auth tag", () => {
    const payload = encryptSecret("tamper-test");
    const tampered = { ...payload, authTag: encryptSecret("other").authTag };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("generates a valid 64-char hex key", () => {
    const key = generateEncryptionKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("timingSafeEqualString compares correctly", () => {
    expect(timingSafeEqualString("abc123", "abc123")).toBe(true);
    expect(timingSafeEqualString("abc123", "abc124")).toBe(false);
    expect(timingSafeEqualString("short", "muchlonger")).toBe(false);
  });
});
