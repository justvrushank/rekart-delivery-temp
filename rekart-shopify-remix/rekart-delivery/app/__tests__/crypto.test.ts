import { describe, it, expect } from "vitest";

// Set a deterministic 32-byte (64 hex char) key before exercising the helpers.
// getKey() reads process.env lazily at call time, so this applies to every call.
process.env.ENCRYPTION_KEY = "a".repeat(64);

import { encrypt, decrypt } from "../crypto.server";

describe("crypto (AES-256-GCM)", () => {
  it("round-trips encrypt -> decrypt", () => {
    const token = "shpat_testtoken";
    const ciphertext = encrypt(token);
    expect(ciphertext).not.toBe(token);
    expect(ciphertext.split(":")).toHaveLength(3);
    expect(decrypt(ciphertext)).toBe(token);
  });

  it("rejects tampered ciphertext (auth tag mismatch)", () => {
    const ciphertext = encrypt("shpat_testtoken");
    // Flip the last two hex chars so the auth tag no longer matches.
    const flip = (c: string) => (c === "a" ? "b" : "a");
    const tampered =
      ciphertext.slice(0, -2) +
      flip(ciphertext.slice(-2, -1)) +
      flip(ciphertext.slice(-1));
    expect(tampered).not.toBe(ciphertext);
    expect(() => decrypt(tampered)).toThrow();
  });
});
