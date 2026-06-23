// Durable GDPR queue. Every GDPR webhook writes a GdprRequest row BEFORE
// forwarding to the Rekart backend; the row stays "pending" until a forward
// succeeds. The retry sweep re-delivers any pending rows, so a temporary
// backend outage never drops a compliance request.

import db from "./db.server";
import { forwardToBackend } from "./rekart.server";

// Stable topic key -> Rekart backend path. The key is what we persist, so it
// must not change once rows exist.
export const GDPR_PATHS = {
  CUSTOMERS_DATA_REQUEST: "/webhooks/shopify/gdpr/customers_data_request",
  CUSTOMERS_REDACT: "/webhooks/shopify/gdpr/customers_redact",
  SHOP_REDACT: "/webhooks/shopify/gdpr/shop_redact",
} as const;

export type GdprTopic = keyof typeof GDPR_PATHS;

// After this many failed forwards a GDPR row is marked "failed" and stops being
// retried by the sweep (prevents an unreachable endpoint from looping forever).
const MAX_RETRIES = 10;

/**
 * Record a GDPR request durably, then attempt to forward it. Returns whether
 * the forward succeeded. On failure the row is left "pending" for the sweep.
 */
export async function recordAndForwardGdpr(
  shop: string,
  topic: GdprTopic,
  payload: unknown,
): Promise<boolean> {
  const row = await db.gdprRequest.create({
    data: { shop, topic, payload: JSON.stringify(payload ?? null) },
  });

  const ok = await forwardToBackend(GDPR_PATHS[topic], { shop, payload });
  if (ok) {
    await db.gdprRequest.update({
      where: { id: row.id },
      data: { status: "forwarded", retriedAt: new Date() },
    });
  }
  return ok;
}

/**
 * Re-deliver every pending GDPR request. Called from the retry sweep. On success
 * the row is marked "forwarded"; on failure retryCount is bumped and the row
 * stays pending for the next sweep.
 */
export async function processPendingGdpr(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  const pending = await db.gdprRequest.findMany({
    where: { status: "pending", retryCount: { lt: MAX_RETRIES } },
  });
  let succeeded = 0;
  let failed = 0;

  for (const row of pending) {
    const path = GDPR_PATHS[row.topic as GdprTopic];
    if (!path) continue; // unknown topic — skip rather than loop forever

    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null;
    }

    const ok = await forwardToBackend(path, { shop: row.shop, payload });
    if (ok) {
      await db.gdprRequest.update({
        where: { id: row.id },
        data: { status: "forwarded", retriedAt: new Date() },
      });
      succeeded += 1;
    } else {
      // Give up after MAX_RETRIES so an unreachable backend can't loop forever.
      const reachedCap = row.retryCount + 1 >= MAX_RETRIES;
      await db.gdprRequest.update({
        where: { id: row.id },
        data: {
          retriedAt: new Date(),
          retryCount: { increment: 1 },
          ...(reachedCap ? { status: "failed" } : {}),
        },
      });
      failed += 1;
    }
  }

  return { processed: pending.length, succeeded, failed };
}
