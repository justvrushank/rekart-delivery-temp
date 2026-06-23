// Pure product auto-matching: map Shopify product variants to Rekart products.
// No DB or network access here — it takes already-fetched lists and returns
// match suggestions. Match priority: exact name → exact SKU → fuzzy name → none.

export interface ShopifyProductInput {
  variantId: string;
  productTitle: string;
  sku: string | null;
}

export interface RekartProductInput {
  productId: number;
  name: string;
  sku?: string | null;
}

export type MatchConfidence = "exact_name" | "exact_sku" | "fuzzy" | "none";

export interface ProductMatch {
  shopifyVariantId: string;
  shopifyProductTitle: string;
  shopifySkuCode: string | null;
  rekartProductId: number | null;
  rekartProductName: string | null;
  matchedAuto: boolean;
  matchConfidence: MatchConfidence;
}

// Maximum Levenshtein distance for a fuzzy name match to count.
const FUZZY_MAX_DISTANCE = 3;

// Fuzzy matching is O(variants × products × name-length). Above these sizes we
// skip it (exact name/SKU still run) to avoid blocking the event loop.
const FUZZY_VARIANT_LIMIT = 500;
const FUZZY_PRODUCT_LIMIT = 100;

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Levenshtein edit distance between two strings (iterative, two-row).
 * Inlined — no external dependency.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function unmatched(shopify: ShopifyProductInput): ProductMatch {
  return {
    shopifyVariantId: shopify.variantId,
    shopifyProductTitle: shopify.productTitle,
    shopifySkuCode: shopify.sku,
    rekartProductId: null,
    rekartProductName: null,
    matchedAuto: false,
    matchConfidence: "none",
  };
}

function matched(
  shopify: ShopifyProductInput,
  rekart: RekartProductInput,
  confidence: Exclude<MatchConfidence, "none">,
): ProductMatch {
  return {
    shopifyVariantId: shopify.variantId,
    shopifyProductTitle: shopify.productTitle,
    shopifySkuCode: shopify.sku,
    rekartProductId: rekart.productId,
    rekartProductName: rekart.name,
    matchedAuto: true,
    matchConfidence: confidence,
  };
}

/**
 * Suggest a Rekart product for each Shopify variant. Each variant is matched
 * independently; the same Rekart product may be suggested for more than one
 * variant (the merchant confirms/overrides on the mapping screen).
 */
export function matchProducts(
  shopifyProducts: ShopifyProductInput[],
  rekartProducts: RekartProductInput[],
): ProductMatch[] {
  // Disable the fuzzy pass for very large catalogs; exact name/SKU still run.
  const skipFuzzy =
    shopifyProducts.length > FUZZY_VARIANT_LIMIT ||
    rekartProducts.length > FUZZY_PRODUCT_LIMIT;
  if (skipFuzzy) {
    console.warn(
      `[product-matching] Skipping fuzzy match: ${shopifyProducts.length} Shopify variants × ${rekartProducts.length} Rekart products exceeds limit. Only exact matches will be applied.`,
    );
  }

  return shopifyProducts.map((shopify) => {
    const title = normalize(shopify.productTitle);
    const sku = normalize(shopify.sku);

    // 1. Exact name match (case-insensitive, trimmed).
    const byName = rekartProducts.find((r) => normalize(r.name) === title);
    if (byName) return matched(shopify, byName, "exact_name");

    // 2. Exact SKU match — only when both sides have a SKU.
    if (sku) {
      const bySku = rekartProducts.find(
        (r) => normalize(r.sku) !== "" && normalize(r.sku) === sku,
      );
      if (bySku) return matched(shopify, bySku, "exact_sku");
    }

    // 3. Fuzzy name match — closest Rekart name within the distance threshold.
    // Skipped for large catalogs (event-loop protection); only reached when no
    // exact match was found above (confidence is still "none" at this point).
    if (!skipFuzzy) {
      let best: RekartProductInput | null = null;
      let bestDistance = FUZZY_MAX_DISTANCE + 1;
      for (const r of rekartProducts) {
        const distance = levenshtein(normalize(r.name), title);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = r;
        }
      }
      if (best && bestDistance <= FUZZY_MAX_DISTANCE) {
        return matched(shopify, best, "fuzzy");
      }
    }

    // 4. No match.
    return unmatched(shopify);
  });
}
