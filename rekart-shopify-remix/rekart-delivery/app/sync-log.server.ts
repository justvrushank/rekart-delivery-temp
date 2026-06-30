// Milestone 4 — read model + manual retry for the Sync Log screen, backed by the
// FulfillmentPush rows written by the Milestone 3 outbound status sync.

import db from "./db.server";
import {
  pushFulfillmentStatus,
  applyResult,
  type PushResult,
} from "./fulfillment.server";
import { rowToInput } from "./fulfillment-retry.server";
import { isRekartStatus } from "./fulfillment-status";
import { PUSH_STATUSES } from "./sync-log.constants";

export interface SyncLogFilters {
  status?: string; // one of PUSH_STATUSES
  type?: string; // a RekartStatus
}

/** Sanitize raw URL search params into known filter values (ignore anything else). */
export function parseFilters(searchParams: URLSearchParams): SyncLogFilters {
  const status = searchParams.get("status") ?? undefined;
  const type = searchParams.get("type") ?? undefined;
  return {
    status: status && (PUSH_STATUSES as readonly string[]).includes(status) ? status : undefined,
    type: type && isRekartStatus(type) ? type : undefined,
  };
}

export async function getRecentPushes(shop: string, filters: SyncLogFilters = {}, limit = 50) {
  return db.fulfillmentPush.findMany({
    where: {
      shop,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.type ? { rekartStatus: filters.type } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Manually re-attempt a single push now (Sync Log "Retry" button). Shop-scoped. */
export async function retryPushNow(shop: string, pushId: string): Promise<PushResult> {
  const row = await db.fulfillmentPush.findFirst({ where: { id: pushId, shop } });
  if (!row) return { ok: false, error: "push not found" };

  // Reuse the shared mapper so the "" → null delivery-id normalization stays in
  // one place (it previously drifted: this path passed "" verbatim).
  const result = await pushFulfillmentStatus(rowToInput(row));
  await applyResult(row.id, row.attempts + 1, result);
  return result;
}
