// Milestone 3 — POST /api/fulfillment-push
//
// Called by the Rekart backend (server-to-server) to push a delivery status
// onto a Shopify order. Auth: X-API-Key shared secret. The push is logged
// and attempted inline; on failure it is left queued for the retry sweep, and we
// still return 200 quickly so Rekart is never blocked on Shopify latency.

import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { verifyRekartToken } from "../rekart.server";
import { REKART_STATUSES } from "../fulfillment-status";
import { handleFulfillmentPush, type TrackingInfo } from "../fulfillment.server";

const PushSchema = z.object({
  shop_domain: z.string().min(1),
  external_order_id: z.string().min(1),
  // Optional per the Rekart -> Shopify contract; absent ids/timestamps are normal.
  rekart_delivery_id: z.string().min(1).optional(),
  status: z.enum(REKART_STATUSES),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  tracking: z
    .object({
      number: z.string().optional(),
      company: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  if (!verifyRekartToken(request)) {
    return Response.json({ error: "invalid token" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = PushSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "validation failed", details: parsed.error.issues },
      { status: 422 },
    );
  }
  const body = parsed.data;

  const tracking: TrackingInfo | undefined = body.tracking
    ? {
        number: body.tracking.number ?? null,
        url: body.tracking.url ?? null,
        company: body.tracking.company ?? null,
      }
    : undefined;

  let result;
  try {
    result = await handleFulfillmentPush({
      shop: body.shop_domain,
      shopifyOrderId: body.external_order_id,
      status: body.status,
      tracking,
      occurredAt: body.occurred_at,
      rekartDeliveryId: body.rekart_delivery_id,
    });
  } catch (err) {
    // The handler is meant to never throw (failures are queued + return ok:false).
    // If it does, the push was NOT durably recorded, so return 500 to make Rekart
    // retry — silently dropping it (200) would lose the status update.
    console.error("[fulfillment-push] handler threw:", err);
    return Response.json(
      { received: false, ok: false, error: "internal error" },
      { status: 500 },
    );
  }

  // Always 200: the push is durably recorded and will be retried if it failed.
  return Response.json(result, { status: 200 });
};

// A stray GET (e.g. health probe) should not 404-loop; make intent explicit.
export const loader = () =>
  Response.json({ error: "method not allowed; POST only" }, { status: 405 });
