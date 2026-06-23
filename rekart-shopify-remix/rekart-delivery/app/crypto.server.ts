// Symmetric encryption for secrets at rest (e.g. the Rekart access token stored
// in ShopOnboarding). AES-256-GCM (authenticated) with a random IV per value.
// The key comes from ENCRYPTION_KEY (64 hex chars = 32 bytes). Server-only.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
// NIST SP 800-38D specifies 96-bit (12-byte) IVs for GCM.
// WARNING: lowering the IV length makes any value previously encrypted with the
// old 16-byte IV undecryptable (decrypt() will throw on the auth tag). This is
// acceptable here only because we are pre-production with test data — any
// existing encrypted secrets in the DB must be re-issued/re-encrypted.
const IV_LENGTH = 12;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32`.",
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must be 32 bytes (64 hex chars). " +
        `Got ${key.length} bytes.`,
    );
  }
  return key;
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM. Output format is
 * `<ivHex>:<authTagHex>:<cipherHex>` so the IV and the authentication tag travel
 * with the ciphertext and each call is non-deterministic.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a value produced by encrypt(). Expects exactly three colon-separated
 * parts (iv, authTag, cipher). GCM verifies the auth tag and throws if it does
 * not match — that error is intentionally not suppressed. Callers reading
 * optional secrets should guard with try/catch and treat a failure as "no
 * usable secret".
 */
export function decrypt(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error(
      "Malformed ciphertext: expected `<ivHex>:<authTagHex>:<cipherHex>`.",
    );
  }
  const [ivHex, authTagHex, dataHex] = parts;
  const decipher = createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivHex, "hex"),
  );
  // Must be set before update()/final(); final() throws on tag mismatch.
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
