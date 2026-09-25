import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for integration credentials. Ciphertext format: base64(iv[12] | tag[16] | data).
 * The key id is stored next to the ciphertext (`credentials_key_id`) so keys can rotate later.
 */
export const CURRENT_KEY_ID = "v1";

const KEY_ENV: Record<string, string> = { v1: "INTEGRATION_ENCRYPTION_KEY" };

function key(keyId: string): Buffer {
  const envName = KEY_ENV[keyId];
  if (!envName) throw new Error(`unknown credentials key id ${keyId}`);
  const raw = process.env[envName];
  const buf = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (buf.length !== 32) throw new Error(`${envName} must be 32 bytes, base64-encoded`);
  return buf;
}

export function encryptSecret(plaintext: string): { ciphertext: string; keyId: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(CURRENT_KEY_ID), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64"),
    keyId: CURRENT_KEY_ID,
  };
}

export function decryptSecret(ciphertext: string, keyId: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < 29) throw new Error("credentials ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key(keyId), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
