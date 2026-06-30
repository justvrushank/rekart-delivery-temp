# Rekart → Shopify Outbound Status Contract (Milestone 3)

Endpoints the **Rekart backend** calls on the **Remix app** to push delivery
progress onto Shopify orders. These live in the Remix app (not FastAPI) because
the Remix app holds each shop's Shopify **offline session** and is what calls the
Shopify Admin API (`unauthenticated.admin(shop)`).

Base URL: the Remix app's public URL (the same host as the embedded app).
Auth: shared secret `X-API-Key` (equal to `REKART_STATIC_API_KEY` on both
sides). Constant-time compared; missing/mismatched → `401`.

---

## `POST /api/fulfillment-push`

Push one delivery status onto a Shopify order. Idempotent per
`(shop, shopify_order_id, status)` — re-delivering the same transition updates the
existing record rather than duplicating it.

Request:

```
POST /api/fulfillment-push
X-API-Key: <shared secret>
Content-Type: application/json
```

```json
{
  "shop_domain": "rekart-dev.myshopify.com",
  "external_order_id": "5544332211000",
  "status": "shipped",
  "tracking": { "number": "RK123", "url": "https://track.rekart/RK123", "company": "Rekart" },
  "occurred_at": "2026-06-12T09:30:00Z",
  "rekart_delivery_id": "djb_01HZX"
}
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| `shop_domain` | yes | `.myshopify.com` domain with a stored offline session. |
| `external_order_id` | yes | Numeric id or full `gid://shopify/Order/...`. |
| `status` | yes | One of the Rekart states below. |
| `tracking` | no | `{ number, url, company }`; `company` defaults to `Rekart`. |
| `occurred_at` | no | ISO-8601; recorded for the log. |
| `rekart_delivery_id` | no | Rekart's id, stored for traceability. |

### Status mapping (Rekart → Shopify)

| Rekart `status` | Shopify action | Result |
| --------------- | -------------- | ------ |
| `confirmed` | `fulfillmentCreateV2` on the order's open fulfillment orders | Fulfillment created (order Fulfilled) |
| `packed` | `fulfillmentCreateV2` (idempotent once already fulfilled) | Order packed |
| `ready_to_ship` | `fulfillmentEventCreate` `IN_TRANSIT` | "Ready to ship" on the shipment |
| `shipped` | `fulfillmentEventCreate` `IN_TRANSIT` | "Shipped" on the shipment |
| `delivered` | `fulfillmentEventCreate` `DELIVERED` | "Delivered" |
| `cancelled` | `orderCancel` (no refund, no restock) | Order cancelled |
| `failed` | `fulfillmentEventCreate` `FAILURE` | "Delivery failed" |
| `return_collected` | `fulfillmentEventCreate` `ATTEMPTED_DELIVERY` | "Return collected" |

Event statuses require a fulfillment to exist first; send `confirmed` (or
`packed`) before the shipment events. If an event arrives first, the push fails
softly and is retried (it will succeed once the fulfillment exists).

Response `200` (always, unless auth/validation fails):

```json
{ "received": true, "ok": true, "pushId": "ck...", "mappedAction": "event:IN_TRANSIT" }
```

On a Shopify-side failure the response is still `200` with
`{ "ok": false, "error": "...", "willRetry": true }` and the push is queued for
retry. Error responses: `401` (bad token), `400` (bad JSON), `405` (non-POST),
`422` (missing/invalid `shop`/`shopify_order_id`/`status`).

### Retry semantics

Failed pushes are stored `pending` with exponential backoff (`60·2^(n-1)`s, capped
at 1h) and retried up to 6 times, then marked `dead`. Drive retries with either:

- **Cron** → `POST /api/fulfillment-retry-sweep` (`X-API-Key`), returns
  `{ received, processed, succeeded, failed }`. Safe to call frequently.
- **In-process worker** → set `ENABLE_FULFILLMENT_RETRY_WORKER=true`
  (interval `FULFILLMENT_RETRY_INTERVAL_MS`, default 60000) for a long-lived Node
  server / local dev.

Every push (initial + each retry) is a `FulfillmentPush` row — the audit log
surfaced in the app's Sync Log screen (Milestone 4).

---

## `POST /api/fulfillment-retry-sweep`

Processes all due retries. Auth: `X-API-Key`. Body: none.

```json
{ "received": true, "processed": 3, "succeeded": 2, "failed": 1 }
```
