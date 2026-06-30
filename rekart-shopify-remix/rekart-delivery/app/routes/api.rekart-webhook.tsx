import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { verifyRekartToken } from "../rekart.server";
import { unauthenticated } from "../shopify.server";
import { handleFulfillmentPush } from "../fulfillment.server";
import { REKART_STATUSES } from "../fulfillment-status";
import { toGid } from "../gid";

// Each line item in the new delivery/fulfillment payload (Pappu's items[] shape).
const WebhookItemSchema = z.object({
  product_id: z.string().optional(),
  external_product_id: z.string().optional(),
  status: z.string().min(1),
  // quantity = actually delivered by the driver; original_quantity = originally ordered.
  quantity: z.number().optional(),
  original_quantity: z.number().optional(),
});

const WebhookSchema = z.object({
  topic: z.string().min(1),
  provider: z.string().optional(),
  shop_domain: z.string().min(1),
  external_order_id: z.string().optional(),
  rekart_delivery_id: z.string().optional(),
  // Legacy flat shape: a single order-level status (fallback when items[] is absent).
  status: z.string().optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  // New shape: per-item statuses + delivered/ordered quantities (drives both the
  // order-level status and the quantity decreases).
  items: z.array(WebhookItemSchema).optional(),
});

// A delivery payload can carry multiple items with differing statuses, but this app
// posts ONE order-level Shopify fulfillment event — so we collapse to a single
// status: the "most severe" (a failure/cancel must not be masked by a success).
// When all items share a status, this returns that same status (== first item's).
const STATUS_SEVERITY: Record<string, number> = {
  cancelled: 7,
  failed: 6,
  return_collected: 5,
  delivered: 4,
  shipped: 3,
  ready_to_ship: 2,
  packed: 1,
  confirmed: 0,
};

function mostSevereStatus(statuses: string[]): string | undefined {
  if (statuses.length === 0) return undefined;
  return statuses.reduce((worst, s) =>
    (STATUS_SEVERITY[s] ?? -1) > (STATUS_SEVERITY[worst] ?? -1) ? s : worst,
  );
}

type UserError = { field?: string[] | null; message: string };
function userErrorsToString(errors: UserError[]): string {
  return errors.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join("; ");
}

/**
 * Apply quantity DECREASES to an existing Shopify order in ONE order-edit session:
 * orderEditBegin → orderEditSetQuantity for each decreased line item (matched by
 * Shopify variant GID, first match wins) → orderEditCommit. Per-item problems
 * (variant not on the order, set-quantity userError) are logged and skipped; the
 * session is committed only if at least one decrease was staged. Requires the
 * write_order_edits scope. Never throws — returns { ok, error, applied } so the
 * caller can proceed to the status push regardless.
 */
async function applyQuantityDecreases(args: {
  shop: string;
  orderId: string;
  decreases: Array<{ variantId: string; quantity: number }>;
}): Promise<{ ok: boolean; error?: string; applied: number }> {
  if (args.decreases.length === 0) return { ok: true, applied: 0 };
  const orderGid = toGid("Order", args.orderId);
  try {
    const { admin } = await unauthenticated.admin(args.shop);

    // 1. Begin ONE edit session; pull the calculated line items so we can map each
    //    Shopify variant id to its CalculatedLineItem id.
    const beginResp = await admin.graphql(
      `#graphql
      mutation OrderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            lineItems(first: 100) { nodes { id quantity variant { id } } }
          }
          userErrors { field message }
        }
      }`,
      { variables: { id: orderGid } },
    );
    const begin = (await beginResp.json())?.data?.orderEditBegin;
    if (begin?.userErrors?.length) {
      return { ok: false, error: userErrorsToString(begin.userErrors), applied: 0 };
    }
    const calculatedOrder = begin?.calculatedOrder;
    if (!calculatedOrder?.id) {
      return { ok: false, error: `order not editable or not found: ${orderGid}`, applied: 0 };
    }
    const nodes: any[] = calculatedOrder.lineItems?.nodes ?? [];

    // 2. Stage a set-quantity for each decrease (restock removed units to inventory).
    let applied = 0;
    for (const dec of args.decreases) {
      const variantGid = toGid("ProductVariant", dec.variantId);
      const lineItem = nodes.find((li) => li.variant?.id === variantGid);
      if (!lineItem) {
        console.error(`[rekart] delivery.update: variant ${variantGid} not on order ${orderGid}; skipping`);
        continue;
      }
      const setResp = await admin.graphql(
        `#graphql
        mutation OrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
          orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: true) {
            calculatedLineItem { id quantity }
            userErrors { field message }
          }
        }`,
        { variables: { id: calculatedOrder.id, lineItemId: lineItem.id, quantity: dec.quantity } },
      );
      const set = (await setResp.json())?.data?.orderEditSetQuantity;
      if (set?.userErrors?.length) {
        console.error(`[rekart] delivery.update: setQuantity failed for ${variantGid}: ${userErrorsToString(set.userErrors)}`);
        continue;
      }
      applied += 1;
    }

    if (applied === 0) {
      // Nothing staged (variants not found / all set-quantity calls failed) — don't
      // commit an empty edit session.
      return { ok: false, error: "no quantity decreases could be applied", applied: 0 };
    }

    // 3. Commit the staged decreases.
    const commitResp = await admin.graphql(
      `#graphql
      mutation OrderEditCommit($id: ID!) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Quantity adjusted by Rekart (delivered < ordered)") {
          order { id }
          userErrors { field message }
        }
      }`,
      { variables: { id: calculatedOrder.id } },
    );
    const commit = (await commitResp.json())?.data?.orderEditCommit;
    if (commit?.userErrors?.length) {
      return { ok: false, error: userErrorsToString(commit.userErrors), applied };
    }

    return { ok: true, applied };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), applied: 0 };
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const authorized = await verifyRekartToken(request);
  if (!authorized) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof WebhookSchema>;
  try {
    const json = await request.json();
    body = WebhookSchema.parse(json);
  } catch {
    return Response.json({ error: "Invalid payload" }, { status: 422 });
  }

  switch (body.topic) {
    case "delivery.update": {
      if (!body.external_order_id) {
        return Response.json({ error: "external_order_id required" }, { status: 422 });
      }
      const items = body.items ?? [];

      // --- 1) Quantity decreases (best-effort; logged but never blocks the status push) ---
      // Decrease = delivered (quantity) < ordered (original_quantity). Increases and
      // equals are skipped (Rekart settles increases via wallet on its side). We only
      // open an order-edit session when there's at least one decrease.
      const decreases: Array<{ variantId: string; quantity: number }> = [];
      for (const i of items) {
        if (
          i.external_product_id &&
          i.original_quantity != null &&
          i.quantity != null &&
          i.quantity < i.original_quantity
        ) {
          decreases.push({ variantId: i.external_product_id, quantity: i.quantity });
        }
      }
      if (decreases.length > 0) {
        const edit = await applyQuantityDecreases({
          shop: body.shop_domain,
          orderId: body.external_order_id,
          decreases,
        });
        if (edit.ok) {
          console.log("[rekart] delivery.update: applied quantity decreases", {
            orderId: body.external_order_id,
            applied: edit.applied,
          });
        } else {
          // Non-fatal: log and continue to the status push.
          console.error(
            "[rekart] delivery.update: quantity edit failed (continuing to status push):",
            edit.error,
          );
        }
      }

      // --- 2) Order-level fulfillment status (most-severe across items[]) ---
      const orderStatus =
        items.length > 0 ? mostSevereStatus(items.map((i) => i.status)) : body.status;
      if (!orderStatus) {
        return Response.json(
          { error: "status required (flat `status` or non-empty `items[]`)" },
          { status: 422 },
        );
      }
      if (!REKART_STATUSES.includes(orderStatus as typeof REKART_STATUSES[number])) {
        return Response.json({ error: `Invalid status: ${orderStatus}` }, { status: 422 });
      }
      const result = await handleFulfillmentPush({
        shop: body.shop_domain,
        shopifyOrderId: body.external_order_id,
        rekartDeliveryId: body.rekart_delivery_id ?? null,
        status: orderStatus as typeof REKART_STATUSES[number],
        occurredAt: body.occurred_at ?? null,
      });
      return Response.json({ received: true, ok: result.ok, error: result.error ?? null });
    }

    // Superseded by delivery.update, which carries both per-item statuses AND the
    // delivered/ordered quantities. Topics still accepted (200) but not processed.
    case "fulfillment.update":
    case "quantity.update": {
      return Response.json(
        { received: true, ok: true, skipped: "use_delivery_update" },
        { status: 200 },
      );
    }

    default: {
      return Response.json({ received: true, ok: false, error: `Unknown topic: ${body.topic}` }, { status: 422 });
    }
  }
};
