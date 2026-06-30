import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordGdpr, forwardGdprRow } from "../gdpr.server";

// GDPR: erase a specific customer's data. Customer data lives in the Rekart
// backend, so forward the redaction request for the backend to action.
// Recorded durably first so a failed forward is retried by the sweep.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Record the request durably FIRST (synchronous) so it survives even if the
  // process exits immediately after responding; only the outbound forward is
  // backgrounded. A failed/never-run forward leaves the row pending for the sweep.
  const row = await recordGdpr(shop, "CUSTOMERS_REDACT", payload);
  void forwardGdprRow(row).catch((err) =>
    console.error("[gdpr] customers_redact forward threw:", err),
  );
  return new Response(null, { status: 200 });
};
