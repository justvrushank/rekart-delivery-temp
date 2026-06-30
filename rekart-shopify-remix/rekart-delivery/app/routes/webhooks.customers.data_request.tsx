import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordGdpr, forwardGdprRow } from "../gdpr.server";

// GDPR: a store owner / customer requests the data you hold about a customer.
// The customer data lives in the Rekart backend, so forward the request there.
// Recorded durably first so a failed forward is retried by the sweep.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Record the request durably FIRST (synchronous) so it survives even if the
  // process exits immediately after responding; only the outbound forward is
  // backgrounded. A failed/never-run forward leaves the row pending for the sweep.
  const row = await recordGdpr(shop, "CUSTOMERS_DATA_REQUEST", payload);
  void forwardGdprRow(row).catch((err) =>
    console.error("[gdpr] customers_data_request forward threw:", err),
  );
  return new Response(null, { status: 200 });
};
