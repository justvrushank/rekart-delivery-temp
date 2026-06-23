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

function rowToInput(row: {
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
    rekartDeliveryId: row.rekartDeliveryId,
  };
}

/** Process all pushes that are due for retry, oldest first. */
export async function processDuePushes(limit = 25): Promise<SweepResult> {
  const due = await db.fulfillmentPush.findMany({
    where: { status: "pending", nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });

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
