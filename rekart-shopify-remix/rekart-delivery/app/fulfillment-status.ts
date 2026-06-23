// Milestone 3 — Rekart delivery state -> Shopify fulfillment action mapping.
// This is the single source of truth for how an inbound Rekart status becomes a
// Shopify fulfillment operation. Pure + framework-free so it is trivially testable.

export const REKART_STATUSES = [
  "delivery_scheduled",
  "out_for_delivery",
  "delivered",
  "failed",
  "return_collected",
] as const;

export type RekartStatus = (typeof REKART_STATUSES)[number];

// The Shopify FulfillmentEvent status values we emit.
export type ShopifyFulfillmentEventStatus = "IN_TRANSIT" | "DELIVERED" | "FAILURE";

export type FulfillmentAction =
  | { kind: "create_fulfillment"; label: string }
  | { kind: "event"; eventStatus: ShopifyFulfillmentEventStatus; label: string }
  | { kind: "note"; label: string };

const STATUS_MAP: Record<RekartStatus, FulfillmentAction> = {
  // Create the Shopify fulfillment (moves the order to "Fulfilled" / open shipment).
  delivery_scheduled: { kind: "create_fulfillment", label: "Fulfillment created" },
  // Shipment progress events on the created fulfillment.
  out_for_delivery: { kind: "event", eventStatus: "IN_TRANSIT", label: "Out for delivery" },
  delivered: { kind: "event", eventStatus: "DELIVERED", label: "Delivered" },
  failed: { kind: "event", eventStatus: "FAILURE", label: "Delivery issue" },
  // Shopify has no public timeline-comment API, so a return is recorded as an
  // order metafield (visible under the order's metafields / via apps).
  return_collected: { kind: "note", label: "Return logged" },
};

export function isRekartStatus(value: unknown): value is RekartStatus {
  return typeof value === "string" && (REKART_STATUSES as readonly string[]).includes(value);
}

export function mapStatus(status: RekartStatus): FulfillmentAction {
  return STATUS_MAP[status];
}

/** Compact, storable description of the action (FulfillmentPush.mappedAction). */
export function describeAction(action: FulfillmentAction): string {
  switch (action.kind) {
    case "create_fulfillment":
      return "create_fulfillment";
    case "event":
      return `event:${action.eventStatus}`;
    case "note":
      return "note";
  }
}
