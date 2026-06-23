// One-time migration: normalize every stored Rekart access token to AES-256-GCM.
//
// Token formats found in the wild:
//   0 colons  -> plaintext Passport token (pre-encryption)        -> encrypt(GCM)
//   1 colon   -> old AES-256-CBC `ivHex:cipherHex`                -> CBC-decrypt, re-encrypt(GCM)
//   2 colons  -> current AES-256-GCM `ivHex:authTagHex:cipherHex` -> skip
//
// Run with:        npx ts-node scripts/migrate-tokens.ts
// Preview only:     npx ts-node scripts/migrate-tokens.ts --dry-run
// Requires ENCRYPTION_KEY and DATABASE_URL to be set (same values the app uses).
//
// Idempotent by construction: rows already in GCM format (2 colons) are skipped,
// so re-running it (after a partial run or otherwise) only touches rows not yet
// migrated and never double-encrypts.

import { createDecipheriv } from "node:crypto";

import db from "../app/db.server";
import { encrypt } from "../app/crypto.server";

// When set, report what WOULD change without writing to the database.
const DRY_RUN = process.argv.includes("--dry-run");
const TAG = DRY_RUN ? " [DRY RUN]" : "";

// Decrypt a legacy AES-256-CBC value (`ivHex:cipherHex`) with the current key.
function cbcDecrypt(ivHex: string, cipherHex: string): string {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) throw new Error("ENCRYPTION_KEY is not set");
  const key = Buffer.from(hex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", key, Buffer.from(ivHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

async function main() {
  const rows = await db.shopOnboarding.findMany({
    where: { rekartAccessToken: { not: null } },
  });

  let skipped = 0;
  let migrated = 0;
  let failed = 0;

  for (const row of rows) {
    const token = row.rekartAccessToken as string;
    const colons = (token.match(/:/g) ?? []).length;

    try {
      if (colons === 2) {
        console.log(`${row.shop}: skipped (already GCM)${TAG}`);
        skipped += 1;
        continue;
      }

      let plaintext: string;
      let action: string;
      if (colons === 0) {
        plaintext = token; // plaintext Passport token
        action = "migrated-from-plaintext";
      } else if (colons === 1) {
        const [ivHex, cipherHex] = token.split(":");
        plaintext = cbcDecrypt(ivHex, cipherHex);
        action = "migrated-from-cbc";
      } else {
        console.log(`${row.shop}: failed (unexpected ${colons} colons)${TAG}`);
        failed += 1;
        continue;
      }

      if (!DRY_RUN) {
        await db.shopOnboarding.update({
          where: { shop: row.shop },
          data: { rekartAccessToken: encrypt(plaintext) },
        });
      }
      console.log(`${row.shop}: ${action}${TAG}`);
      migrated += 1;
    } catch (error) {
      console.log(
        `${row.shop}: failed - ${error instanceof Error ? error.message : String(error)}${TAG}`,
      );
      failed += 1;
    }
  }

  console.log(
    `\nDone. ${migrated} migrated, ${skipped} skipped, ${failed} failed (of ${rows.length}).${TAG}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
