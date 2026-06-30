// Shopify resource ids cross our boundary in two shapes: GIDs
// (gid://shopify/ProductVariant/123) from the Admin GraphQL API, and plain
// numeric ids (123) that Rekart's mapping table + order webhook resolve by. These
// two helpers are the single place we convert between them.

/**
 * Strip a Shopify GID down to its trailing numeric id. Idempotent: a value that
 * is already plain (no "/") is returned unchanged. Works for any GID type
 * (ProductVariant, Product, Order, …).
 */
export function parseGidId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

/**
 * Build a Shopify GID for the given resource type from a plain id. Idempotent: a
 * value that is already a GID is returned unchanged.
 */
export function toGid(type: string, id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/${type}/${id}`;
}
