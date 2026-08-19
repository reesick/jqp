import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { loadEnv } from "./env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, standard for GCM

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

function getKey(): Buffer {
  const env = loadEnv();
  return Buffer.from(env.ENCRYPTION_KEY, "hex");
}

/** Encrypts a Meta access token (or any secret string) with AES-256-GCM. Never store the returned pieces anywhere except the *_encrypted / *_iv / *_tag columns they're intended for. */
export function encryptSecret(plaintext: string): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64")
  };
}

export function decryptSecret(payload: EncryptedPayload): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Generates a fresh 32-byte hex key suitable for ENCRYPTION_KEY. Run via: node -e "console.log(require('@jqp/core').generateEncryptionKey())" or the equivalent inline crypto.randomBytes command in .env.example. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}

/** Constant-time string comparison for webhook signatures / shared secrets. Prevents timing attacks that a plain === would be vulnerable to. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
