import {
  reactExtension,
  useApplyCartLinesChange,
  useAppMetafields,
  useCartLines,
} from "@shopify/ui-extensions-react/checkout";
import { useEffect } from "react";

// Static target: mounts once, automatically (no merchant placement required).
// The extension has no visible UI — it just writes the `rekart_product_id`
// line item property in the background.
export default reactExtension("purchase.checkout.actions.render-before", () => (
  <Extension />
));

const PROPERTY_KEY = "rekart_product_id";

// `useAppMetafields()` reports the resource id as the raw numeric id, while a
// cart line's merchandise id is a full GID (gid://shopify/ProductVariant/123).
// Normalize both to the trailing numeric segment so they can be matched.
function numericId(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

function Extension() {
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();

  // Only the `rekart.product_id` variant metafield is exposed here (see the
  // metafields block in shopify.extension.toml).
  const appMetafields = useAppMetafields({
    type: "variant",
    namespace: "rekart",
    key: "product_id",
  });

  useEffect(() => {
    // Map: variant numeric id -> rekart product id.
    const productIdByVariant = new Map<string, string>();
    for (const entry of appMetafields) {
      if (entry.target.type !== "variant") continue;
      const value = entry.metafield.value;
      if (value == null || value === "") continue;
      productIdByVariant.set(numericId(entry.target.id), String(value));
    }

    // Nothing mapped — leave checkout untouched.
    if (productIdByVariant.size === 0) return;

    for (const line of cartLines) {
      if (line.merchandise.type !== "variant") continue;

      const rekartProductId = productIdByVariant.get(
        numericId(line.merchandise.id),
      );
      // No metafield for this variant — skip silently, never block checkout.
      if (!rekartProductId) continue;

      // Already set to the right value — avoid a redundant update loop.
      const alreadySet = line.attributes?.some(
        (attr) => attr.key === PROPERTY_KEY && attr.value === rekartProductId,
      );
      if (alreadySet) continue;

      // Fire and forget. If the change can't be applied, it fails quietly and
      // does not interrupt the buyer's checkout.
      void applyCartLinesChange({
        type: "updateCartLine",
        id: line.id,
        attributes: [{ key: PROPERTY_KEY, value: rekartProductId }],
      });
    }
  }, [cartLines, appMetafields, applyCartLinesChange]);

  // No visible UI.
  return null;
}
