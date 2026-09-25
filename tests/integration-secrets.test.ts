import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/modules/integrations/secrets";

const original = process.env.INTEGRATION_ENCRYPTION_KEY;
afterEach(() => {
  process.env.INTEGRATION_ENCRYPTION_KEY = original;
});

describe("integration credential encryption", () => {
  it("round-trips with a fresh IV each time", () => {
    const a = encryptSecret("shpat_secret");
    const b = encryptSecret("shpat_secret");
    expect(a.keyId).toBe("v1");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext).not.toContain("shpat_secret");
    expect(decryptSecret(a.ciphertext, a.keyId)).toBe("shpat_secret");
  });

  it("rejects a tampered ciphertext (auth tag)", () => {
    const { ciphertext, keyId } = encryptSecret("shpat_secret");
    const buf = Buffer.from(ciphertext, "base64");
    buf[buf.length - 1]! ^= 1;
    expect(() => decryptSecret(buf.toString("base64"), keyId)).toThrow();
  });

  it("rejects decryption with a different key", () => {
    const { ciphertext, keyId } = encryptSecret("shpat_secret");
    process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(ciphertext, keyId)).toThrow();
  });

  it("refuses unknown key ids and malformed keys", () => {
    const { ciphertext } = encryptSecret("x");
    expect(() => decryptSecret(ciphertext, "v9")).toThrow(/unknown/);
    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});
