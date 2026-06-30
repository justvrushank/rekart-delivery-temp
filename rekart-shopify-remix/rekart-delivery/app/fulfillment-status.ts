// Milestone 3 — Rekart delivery state -> Shopify fulfillment action mapping.
// This is the single source of truth for how an inbound Rekart status becomes a
// Shopify fulfillment operation. Pure + framework-free so it is trivially testable.

export const REKART_STATUSES = [
  "confirmed",
  "packed",
  "ready_to_ship",
  "shipped",
  "delivered",
  "cancelled",
  "failed",
  "return_collected",
] as const;

export type RekartStatus = (typeof REKART_STATUSES)[number];

// The Shopify FulfillmentEvent status values we emit.
export type ShopifyFulfillmentEventStatus =
  | "IN_TRANSIT"
  | "DELIVERED"
  | "FAILURE"
  | "ATTEMPTED_DELIVERY";

export type FulfillmentAction =
  | { kind: "create_fulfillment"; label: string }
  | { kind: "event"; eventStatus: ShopifyFulfillmentEventStatus; label: string }
  | { kind: "note"; label: string }
  | { kind: "cancel_order"; label: string };

const STATUS_MAP: Record<RekartStatus, FulfillmentAction> = {
  // Create the Shopify fulfillment (moves the order to "Fulfilled" / open shipment).
  confirmed: { kind: "create_fulfillment", label: "Order confirmed" },
  packed: { kind: "create_fulfillment", label: "Order packed" },
  // Shipment progress events on the created fulfillment.
  ready_to_ship: { kind: "event", eventStatus: "IN_TRANSIT", label: "Ready to ship" },
  shipped: { kind: "event", eventStatus: "IN_TRANSIT", label: "Shipped" },
  delivered: { kind: "event", eventStatus: "DELIVERED", label: "Delivered" },
  // cancelled → hard cancel on Shopify via orderCancel mutation.
  // Intentional: when Rekart cancels a delivery, the Shopify order is also cancelled.
  // Do NOT change to FAILURE event — that would leave the order open on Shopify.
  cancelled: { kind: "cancel_order", label: "Order cancelled" },
  failed: { kind: "event", eventStatus: "FAILURE", label: "Delivery failed" },
  return_collected: { kind: "event", eventStatus: "ATTEMPTED_DELIVERY", label: "Return collected" },
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
    case "cancel_order":
      return "cancel_order";
  }
}
