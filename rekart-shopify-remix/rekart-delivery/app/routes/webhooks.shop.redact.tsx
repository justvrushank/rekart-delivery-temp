import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordAndForwardGdpr } from "../gdpr.server";

// GDPR: 48h after a shop uninstalls, Shopify asks you to erase the shop's data.
// Record the request durably (so a failed forward is retried), clean up the
// local onboarding row, and forward to the backend for the rest.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Erase the shop's local data synchronously (fast, local), then respond to
  // Shopify immediately and forward to the backend in the background so a slow
  // or unreachable backend can never push us past Shopify's webhook timeout.
  // recordAndForwardGdpr persists the request durably first, so the retry sweep
  // still re-delivers a forward that fails or never runs.
  await db.shopOnboarding.deleteMany({ where: { shop } });
  void recordAndForwardGdpr(shop, "SHOP_REDACT", payload).catch((err) =>
    console.error("[gdpr] shop_redact forward threw:", err),
  );
  return new Response(null, { status: 200 });
};
