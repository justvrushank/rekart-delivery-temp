// Milestone 3 — retry queue for failed outbound status pushes.
//
// FulfillmentPush rows with status="pending" and nextAttemptAt <= now are due for
// another attempt. This can be driven two ways (pick per deployment):
//   1. External cron -> POST /api/fulfillment-retry-sweep (deploy-agnostic).
//   2. In-process interval, enabled with ENABLE_FULFILLMENT_RETRY_WORKER=true
//      (good for a single long-lived Node server / local dev).

import db from "./db.server";
import {
  pushFulfillmentStatus,
  applyResult,
  type PushInput,
} from "./fulfillment.server";
import type { RekartStatus } from "./fulfillment-status";

export interface SweepResult {
  processed: number;
  succeeded: number;
  failed: number;
}

export function rowToInput(row: {
  shop: string;
  shopifyOrderId: string;
  rekartStatus: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingCompany: string | null;
  occurredAt: Date | null;
  rekartDeliveryId: string | null;
}): PushInput {
  return {
    shop: row.shop,
    shopifyOrderId: row.shopifyOrderId,
    status: row.rekartStatus as RekartStatus,
    tracking: {
      number: row.trackingNumber,
      url: row.trackingUrl,
      company: row.trackingCompany,
    },
    occurredAt: row.occurredAt ? row.occurredAt.toISOString() : null,
    // Normalise the "" sentinel (stored when no delivery id was provided, so the
    // compound-unique upsert can dedupe) back to null for the outbound payload.
    rekartDeliveryId: row.rekartDeliveryId || null,
  };
}

/**
 * Process all pushes that are due for retry, oldest first.
 *
 * NOTE: the cron sweep (POST /api/fulfillment-retry-sweep) and the in-process
 * worker (ENABLE_FULFILLMENT_RETRY_WORKER) are mutually exclusive — never run
 * both, and never run the worker on more than one instance. The optimistic claim
 * below guards against concurrent sweeps double-processing the same row, but the
 * intended deployment is a single sweeper.
 */
export async function processDuePushes(limit = 25): Promise<SweepResult> {
  // Atomically claim each candidate before processing: MySQL/Prisma has no
  // SKIP LOCKED helper, so push nextAttemptAt forward and only process rows the
  // updateMany actually won. This stops two overlapping sweeps from both
  // re-posting the same (non-idempotent) Shopify fulfillment event.
  const now = new Date();
  const candidates = await db.fulfillmentPush.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true },
  });
  const claimUntil = new Date(Date.now() + 5 * 60_000);
  const due = [];
  for (const { id } of candidates) {
    const claimed = await db.fulfillmentPush.updateMany({
      where: { id, status: "pending", nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: claimUntil },
    });
    if (claimed.count === 1) {
      due.push(await db.fulfillmentPush.findUniqueOrThrow({ where: { id } }));
    }
  }

  let succeeded = 0;
  let failed = 0;
  for (const row of due) {
    // Isolate each row: one throwing push/applyResult must not abort the whole
    // sweep and strand the remaining due rows. Count it as a failure and move on.
    try {
      const result = await pushFulfillmentStatus(rowToInput(row));
      await applyResult(row.id, row.attempts + 1, result);
      if (result.ok) succeeded += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[rekart] sweep: row ${row.id} threw:`, err);
    }
    // NOTE: if applyResult throws after a successful push, the row stays pending
    // and will be re-pushed next sweep. Shopify events are not idempotent —
    // monitor for duplicate event:DELIVERED errors in lastError.
  }
  return { processed: due.length, succeeded, failed };
}

// ─── Opt-in in-process worker ────────────────────────────────────────────────

const WORKER_INTERVAL_MS = Number(process.env.FULFILLMENT_RETRY_INTERVAL_MS) || 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __rekartRetryWorkerStarted: boolean | undefined;
}

function startRetryWorker() {
  if (globalThis.__rekartRetryWorkerStarted) return;
  globalThis.__rekartRetryWorkerStarted = true;
  const timer = setInterval(() => {
    processDuePushes().catch((err) =>
      console.error("[rekart] retry sweep failed:", err),
    );
  }, WORKER_INTERVAL_MS);
  // Don't keep the event loop alive solely for the sweep.
  if (typeof timer.unref === "function") timer.unref();
  console.log(
    `[rekart] fulfillment retry worker started (every ${WORKER_INTERVAL_MS}ms)`,
  );
}

if (process.env.ENABLE_FULFILLMENT_RETRY_WORKER === "true") {
  startRetryWorker();
}
