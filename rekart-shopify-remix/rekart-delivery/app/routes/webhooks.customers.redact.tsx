import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordAndForwardGdpr } from "../gdpr.server";

// GDPR: erase a specific customer's data. Customer data lives in the Rekart
// backend, so forward the redaction request for the backend to action.
// Recorded durably first so a failed forward is retried by the sweep.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Respond to Shopify immediately; record + forward in the background so a slow
  // or unreachable backend can never push us past Shopify's webhook timeout.
  // recordAndForwardGdpr persists the request durably first, so the retry sweep
  // still re-delivers a forward that fails or never runs.
  void recordAndForwardGdpr(shop, "CUSTOMERS_REDACT", payload).catch((err) =>
    console.error("[gdpr] customers_redact forward threw:", err),
  );
  return new Response(null, { status: 200 });
};
