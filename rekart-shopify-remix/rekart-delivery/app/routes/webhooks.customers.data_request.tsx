import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordAndForwardGdpr } from "../gdpr.server";

// GDPR: a store owner / customer requests the data you hold about a customer.
// The customer data lives in the Rekart backend, so forward the request there.
// Recorded durably first so a failed forward is retried by the sweep.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Respond to Shopify immediately; record + forward in the background so a slow
  // or unreachable backend can never push us past Shopify's webhook timeout.
  // recordAndForwardGdpr persists the request durably first, so the retry sweep
  // still re-delivers a forward that fails or never runs.
  void recordAndForwardGdpr(shop, "CUSTOMERS_DATA_REQUEST", payload).catch(
    (err) => console.error("[gdpr] customers_data_request forward threw:", err),
  );
  return new Response(null, { status: 200 });
};
