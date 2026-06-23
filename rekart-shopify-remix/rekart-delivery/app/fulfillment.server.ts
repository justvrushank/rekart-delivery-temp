// Milestone 3 — Outbound delivery-status sync (Rekart -> Shopify).
//
// Rekart POSTs a delivery status to /api/fulfillment-push; this module maps it to
// a Shopify fulfillment operation and performs it via the shop's OFFLINE session
// (unauthenticated.admin) — Rekart is a server-to-server caller, not an embedded
// Shopify session, so authenticate.admin does not apply here.
//
// Every push is persisted as a FulfillmentPush row, which doubles as the audit
// log (Milestone 4 Sync Log) and the retry queue.

import { unauthenticated } from "./shopify.server";
import db from "./db.server";
import {
  type RekartStatus,
  type ShopifyFulfillmentEventStatus,
  mapStatus,
  describeAction,
} from "./fulfillment-status";

const MAX_ATTEMPTS = 6;

export interface TrackingInfo {
  number?: string | null;
  url?: string | null;
  company?: string | null;
}

export interface PushInput {
  shop: string;
  shopifyOrderId: string; // numeric id or full GID
  status: RekartStatus;
  tracking?: TrackingInfo;
  occurredAt?: string | null;
  rekartDeliveryId?: string | null;
}

export interface PushResult {
  ok: boolean;
  fulfillmentId?: string;
  error?: string;
}

// Minimal structural type for the admin GraphQL client so we don't depend on the
// library's exported types (and so tests can inject a fake).
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<any> }>;
}

function toOrderGid(orderId: string): string {
  return orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function userErrorsToString(userErrors: Array<{ field?: string[] | null; message: string }>): string {
  return userErrors.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join("; ");
}

function trackingInfoInput(tracking?: TrackingInfo) {
  if (!tracking || (!tracking.number && !tracking.url)) return undefined;
  return {
    number: tracking.number ?? undefined,
    url: tracking.url ?? undefined,
    company: tracking.company ?? "Rekart",
  };
}

// ─── Shopify operations ──────────────────────────────────────────────────────

async function createFulfillment(admin: AdminGraphqlClient, input: PushInput): Promise<PushResult> {
  const orderGid = toOrderGid(input.shopifyOrderId);

  const foResp = await admin.graphql(
    `#graphql
    query OrderFulfillmentOrders($id: ID!) {
      order(id: $id) {
        id
        fulfillmentOrders(first: 10) { nodes { id status } }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const foJson = await foResp.json();
  const order = foJson?.data?.order;
  if (!order) return { ok: false, error: `order not found: ${orderGid}` };

  const fulfillable = (order.fulfillmentOrders?.nodes ?? []).filter(
    (fo: any) => fo.status === "OPEN" || fo.status === "IN_PROGRESS",
  );
  if (fulfillable.length === 0) {
    return { ok: false, error: "no open fulfillment orders to fulfill" };
  }

  const trackingInfo = trackingInfoInput(input.tracking);
  const resp = await admin.graphql(
    `#graphql
    mutation CreateFulfillment($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: fulfillable.map((fo: any) => ({ fulfillmentOrderId: fo.id })),
          notifyCustomer: false,
          ...(trackingInfo ? { trackingInfo } : {}),
        },
      },
    },
  );
  const json = await resp.json();
  const payload = json?.data?.fulfillmentCreateV2;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) return { ok: false, error: userErrorsToString(userErrors) };

  const fulfillmentId: string | undefined = payload?.fulfillment?.id;
  if (!fulfillmentId) return { ok: false, error: "fulfillmentCreateV2 returned no fulfillment id" };

  await db.fulfillmentLink.upsert({
    where: { shop_shopifyOrderId: { shop: input.shop, shopifyOrderId: input.shopifyOrderId } },
    create: { shop: input.shop, shopifyOrderId: input.shopifyOrderId, shopifyFulfillmentId: fulfillmentId },
    update: { shopifyFulfillmentId: fulfillmentId },
  });
  return { ok: true, fulfillmentId };
}

async function resolveFulfillmentId(admin: AdminGraphqlClient, input: PushInput): Promise<string | null> {
  const link = await db.fulfillmentLink.findUnique({
    where: { shop_shopifyOrderId: { shop: input.shop, shopifyOrderId: input.shopifyOrderId } },
  });
  if (link) return link.shopifyFulfillmentId;

  // Fall back to querying the order's existing fulfillments (e.g. created outside
  // this app, or if the link row was lost), and cache the result.
  const orderGid = toOrderGid(input.shopifyOrderId);
  const resp = await admin.graphql(
    `#graphql
    query OrderFulfillments($id: ID!) {
      order(id: $id) { fulfillments(first: 10) { id status } }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await resp.json();
  const fulfillments: any[] = json?.data?.order?.fulfillments ?? [];
  const chosen =
    fulfillments.find((f) => f.status === "SUCCESS" || f.status === "OPEN" || f.status === "IN_PROGRESS") ??
    fulfillments[0];
  if (chosen?.id) {
    await db.fulfillmentLink.upsert({
      where: { shop_shopifyOrderId: { shop: input.shop, shopifyOrderId: input.shopifyOrderId } },
      create: { shop: input.shop, shopifyOrderId: input.shopifyOrderId, shopifyFulfillmentId: chosen.id },
      update: { shopifyFulfillmentId: chosen.id },
    });
    return chosen.id;
  }
  return null;
}

async function createEvent(
  admin: AdminGraphqlClient,
  input: PushInput,
  eventStatus: ShopifyFulfillmentEventStatus,
): Promise<PushResult> {
  const fulfillmentId = await resolveFulfillmentId(admin, input);
  if (!fulfillmentId) {
    // No fulfillment yet — likely an out-of-order event before delivery_scheduled.
    // Returning an error keeps the row pending so a retry can succeed once the
    // fulfillment exists.
    return { ok: false, error: "no fulfillment found for order; cannot post event yet" };
  }
  const resp = await admin.graphql(
    `#graphql
    mutation CreateFulfillmentEvent($event: FulfillmentEventInput!) {
      fulfillmentEventCreate(fulfillmentEvent: $event) {
        fulfillmentEvent { id status }
        userErrors { field message }
      }
    }`,
    { variables: { event: { fulfillmentId, status: eventStatus } } },
  );
  const json = await resp.json();
  const payload = json?.data?.fulfillmentEventCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) return { ok: false, error: userErrorsToString(userErrors) };
  return { ok: true, fulfillmentId };
}

async function recordReturnNote(admin: AdminGraphqlClient, input: PushInput, label: string): Promise<PushResult> {
  const orderGid = toOrderGid(input.shopifyOrderId);
  const parts = [label];
  if (input.occurredAt) parts.push(`at ${input.occurredAt}`);
  if (input.tracking?.number) parts.push(`(${input.tracking.number})`);
  const value = parts.join(" ");

  const resp = await admin.graphql(
    `#graphql
    mutation SetReturnMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: orderGid,
            namespace: "rekart",
            key: "return_status",
            type: "single_line_text_field",
            value,
          },
        ],
      },
    },
  );
  const json = await resp.json();
  const payload = json?.data?.metafieldsSet;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) return { ok: false, error: userErrorsToString(userErrors) };
  return { ok: true };
}

/** Perform the Shopify-side operation for one push. Never throws. */
export async function pushFulfillmentStatus(input: PushInput): Promise<PushResult> {
  const action = mapStatus(input.status);
  try {
    const { admin } = (await unauthenticated.admin(input.shop)) as unknown as { admin: AdminGraphqlClient };
    switch (action.kind) {
      case "create_fulfillment":
        return await createFulfillment(admin, input);
      case "event":
        return await createEvent(admin, input, action.eventStatus);
      case "note":
        return await recordReturnNote(admin, input, action.label);
    }
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

// ─── Persistence + orchestration ─────────────────────────────────────────────

/** Exponential backoff (seconds) for the Nth attempt, capped at 1h. */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

/** Apply a push result to the FulfillmentPush row: succeed, schedule retry, or mark dead. */
export async function applyResult(pushId: string, attempts: number, result: PushResult) {
  if (result.ok) {
    await db.fulfillmentPush.update({
      where: { id: pushId },
      data: {
        status: "succeeded",
        attempts,
        lastError: null,
        nextAttemptAt: null,
        ...(result.fulfillmentId ? { shopifyFulfillmentId: result.fulfillmentId } : {}),
      },
    });
    return;
  }
  const dead = attempts >= MAX_ATTEMPTS;
  await db.fulfillmentPush.update({
    where: { id: pushId },
    data: {
      status: dead ? "dead" : "pending",
      attempts,
      lastError: result.error?.slice(0, 1000) ?? "unknown error",
      nextAttemptAt: dead ? null : new Date(Date.now() + backoffSeconds(attempts) * 1000),
    },
  });
}

/** Entry point for the /api/fulfillment-push route: log, push inline, schedule retry on failure. */
export async function handleFulfillmentPush(input: PushInput) {
  const action = mapStatus(input.status);
  // Dedupe key now includes rekartDeliveryId. Absent ids are stored as "" (not
  // null): a compound-unique upsert can't pass null, and SQL treats NULLs as
  // distinct — which would let no-delivery-id pushes pile up duplicate rows.
  // Using "" keeps them deduped by transition (the old behavior) while distinct
  // delivery ids still get their own row.
  const row = await db.fulfillmentPush.upsert({
    where: {
      shop_shopifyOrderId_rekartStatus_rekartDeliveryId: {
        shop: input.shop,
        shopifyOrderId: input.shopifyOrderId,
        rekartStatus: input.status,
        rekartDeliveryId: input.rekartDeliveryId ?? "",
      },
    },
    create: {
      shop: input.shop,
      shopifyOrderId: input.shopifyOrderId,
      rekartStatus: input.status,
      rekartDeliveryId: input.rekartDeliveryId ?? "",
      mappedAction: describeAction(action),
      status: "pending",
      attempts: 0,
      trackingNumber: input.tracking?.number ?? null,
      trackingUrl: input.tracking?.url ?? null,
      trackingCompany: input.tracking?.company ?? null,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
    },
    update: {
      // Re-delivery of the same transition: reset to pending and refresh inputs.
      status: "pending",
      rekartDeliveryId: input.rekartDeliveryId ?? "",
      mappedAction: describeAction(action),
      lastError: null,
      nextAttemptAt: null,
      trackingNumber: input.tracking?.number ?? null,
      trackingUrl: input.tracking?.url ?? null,
      trackingCompany: input.tracking?.company ?? null,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
    },
  });

  const result = await pushFulfillmentStatus(input);
  await applyResult(row.id, row.attempts + 1, result);

  return {
    received: true,
    ok: result.ok,
    pushId: row.id,
    mappedAction: describeAction(action),
    ...(result.error ? { error: result.error, willRetry: row.attempts + 1 < MAX_ATTEMPTS } : {}),
  };
}

export { MAX_ATTEMPTS };
