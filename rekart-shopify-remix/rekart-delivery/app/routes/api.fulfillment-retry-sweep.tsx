// Milestone 3 — POST /api/fulfillment-retry-sweep
//
// Drives the retry queue from an external scheduler (cron, Shopify-independent).
// Auth: X-API-Key. Returns how many due pushes were processed. Safe to call
// frequently — it only picks up rows whose nextAttemptAt is in the past.

import type { ActionFunctionArgs } from "react-router";

import { verifyRekartToken } from "../rekart.server";
import { processDuePushes } from "../fulfillment-retry.server";
import { processPendingGdpr } from "../gdpr.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  if (!verifyRekartToken(request)) {
    return Response.json({ error: "invalid token" }, { status: 401 });
  }
  // Drive both retry queues from the same authenticated sweep: failed
  // fulfillment pushes and any pending GDPR forwards.
  const pushes = await processDuePushes();
  const gdpr = await processPendingGdpr();
  return Response.json({ received: true, ...pushes, gdpr }, { status: 200 });
};

export const loader = () =>
  Response.json({ error: "method not allowed; POST only" }, { status: 405 });
