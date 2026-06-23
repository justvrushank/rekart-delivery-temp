// GET /api/variant-product?shop=<domain>&variant_id=<id>
//
// Called by the Rekart (Laravel) backend, server-to-server, to resolve a Shopify
// variant id to its mapped Rekart product id. Public API route — auth is the
// X-API-Key shared secret (NOT a Shopify admin session), so it must never call
// authenticate.admin.

import type { LoaderFunctionArgs } from "react-router";

import { verifyRekartToken } from "../rekart.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Constant-time X-API-Key compare (same shared secret as /api/fulfillment-push).
  if (!verifyRekartToken(request)) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const variantId = url.searchParams.get("variant_id");
  if (!shop || !variantId) {
    return Response.json({ error: "MISSING_PARAMS" }, { status: 400 });
  }

  const link = await db.shopifyProductLink.findUnique({
    where: { shopId_shopifyVariantId: { shopId: shop, shopifyVariantId: variantId } },
  });

  if (!link) {
    return Response.json(
      { error: "NOT_MAPPED", variant_id: variantId },
      { status: 404 },
    );
  }

  return Response.json(
    {
      variant_id: variantId,
      rekart_product_id: link.rekartProductId,
      shop,
    },
    { status: 200 },
  );
};
