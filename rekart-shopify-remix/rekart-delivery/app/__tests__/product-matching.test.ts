import { describe, it, expect } from "vitest";

import {
  levenshtein,
  matchProducts,
  type RekartProductInput,
  type ShopifyProductInput,
} from "../product-matching.server";

const rekart: RekartProductInput[] = [
  { productId: 331, name: "Full Cream Milk 1L", sku: "MILK-1L" },
  { productId: 332, name: "Toned Milk 500ml", sku: "MILK-500" },
  { productId: 333, name: "Spring Water 1L", sku: "WATER-1L" },
];

function shopify(
  variantId: string,
  productTitle: string,
  sku: string | null = null,
): ShopifyProductInput {
  return { variantId, productTitle, sku };
}

describe("levenshtein", () => {
  it("is 0 for identical strings", () => {
    expect(levenshtein("milk", "milk")).toBe(0);
  });
  it("counts single edits", () => {
    expect(levenshtein("milk", "milks")).toBe(1); // insertion
    expect(levenshtein("milk", "mil")).toBe(1); // deletion
    expect(levenshtein("milk", "mial")).toBe(2); // substitutions/swaps
  });
  it("handles empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
});

describe("matchProducts", () => {
  it("matches on exact name (case-insensitive, trimmed)", () => {
    const [m] = matchProducts(
      [shopify("v1", "  full cream milk 1l  ")],
      rekart,
    );
    expect(m.matchConfidence).toBe("exact_name");
    expect(m.rekartProductId).toBe(331);
    expect(m.matchedAuto).toBe(true);
  });

  it("falls back to exact SKU match when names differ", () => {
    const [m] = matchProducts(
      [shopify("v2", "Our Special Water", "WATER-1L")],
      rekart,
    );
    expect(m.matchConfidence).toBe("exact_sku");
    expect(m.rekartProductId).toBe(333);
    expect(m.matchedAuto).toBe(true);
  });

  it("prefers exact name over SKU", () => {
    // Name matches product 331, but SKU points at 333 — name wins.
    const [m] = matchProducts(
      [shopify("v3", "Full Cream Milk 1L", "WATER-1L")],
      rekart,
    );
    expect(m.matchConfidence).toBe("exact_name");
    expect(m.rekartProductId).toBe(331);
  });

  it("fuzzy-matches close names within distance 3", () => {
    // "Full Cream Milk 1Ltr" vs "Full Cream Milk 1L" → distance 2 (add "tr").
    const [m] = matchProducts(
      [shopify("v4", "Full Cream Milk 1Ltr")],
      rekart,
    );
    expect(m.matchConfidence).toBe("fuzzy");
    expect(m.rekartProductId).toBe(331);
    expect(m.matchedAuto).toBe(true);
  });

  it("returns no match when nothing is close enough", () => {
    const [m] = matchProducts(
      [shopify("v5", "Organic Free Range Eggs (dozen)", "EGGS-12")],
      rekart,
    );
    expect(m.matchConfidence).toBe("none");
    expect(m.rekartProductId).toBeNull();
    expect(m.rekartProductName).toBeNull();
    expect(m.matchedAuto).toBe(false);
  });

  it("does not SKU-match when the Shopify variant has no SKU", () => {
    // Same name as nothing; null SKU must not match a Rekart product with a SKU.
    const [m] = matchProducts([shopify("v6", "Totally Unrelated", null)], rekart);
    expect(m.matchConfidence).toBe("none");
  });

  it("skips fuzzy matching when there are more than 500 Shopify variants", () => {
    // 501 variants total → over FUZZY_VARIANT_LIMIT, so fuzzy is disabled.
    const filler = Array.from({ length: 500 }, (_, i) =>
      shopify(`f${i}`, `Filler Product ${i}`),
    );
    // A name that would fuzzy-match "Full Cream Milk 1L" (distance 2) if enabled.
    const fuzzyCandidate = shopify("vf", "Full Cream Milk 1Ltr");
    const results = matchProducts([...filler, fuzzyCandidate], rekart);
    const candidate = results.find((r) => r.shopifyVariantId === "vf");
    expect(candidate?.matchConfidence).toBe("none");
    expect(candidate?.rekartProductId).toBeNull();
  });

  it("still applies exact name matching when fuzzy is skipped", () => {
    const filler = Array.from({ length: 500 }, (_, i) =>
      shopify(`f${i}`, `Filler Product ${i}`),
    );
    const exact = shopify("ve", "Spring Water 1L"); // exact name of product 333
    const results = matchProducts([...filler, exact], rekart);
    const match = results.find((r) => r.shopifyVariantId === "ve");
    expect(match?.matchConfidence).toBe("exact_name");
    expect(match?.rekartProductId).toBe(333);
  });

  it("maps every input to exactly one result, preserving order", () => {
    const results = matchProducts(
      [shopify("v1", "Spring Water 1L"), shopify("v2", "Toned Milk 500ml")],
      rekart,
    );
    expect(results).toHaveLength(2);
    expect(results[0].shopifyVariantId).toBe("v1");
    expect(results[1].shopifyVariantId).toBe("v2");
  });
});
