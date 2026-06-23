# Rekart Delivery — FastAPI Backend Contract

This document defines every HTTP endpoint the Rekart FastAPI backend must expose
to work with the Rekart Delivery Shopify app (the Remix/React-Router app in this
repo). It is the source of truth for the backend implementation.

## Overview

There are **two callers** and therefore **two authentication schemes**:

| Group | Caller | Auth | Endpoints |
| ----- | ------ | ---- | --------- |
| **A. Shopify-delivered webhooks** | Shopify, directly | Shopify HMAC (`X-Shopify-Hmac-Sha256`) | `orders/create`, `customers/create`, `customers/update` |
| **B. Remix-forwarded events** | This Shopify app (server-side) | Shared secret (`X-API-Key`) | GDPR ×3, app uninstalled |
| **C. Dashboard API** | This Shopify app (loader) | Shared secret (`X-API-Key`) | shop sync stats |

> **Why two schemes:** The high-volume data webhooks are registered with Shopify
> to be delivered *straight to FastAPI* (the Remix app never sees them), so they
> arrive with Shopify's own HMAC signature. The compliance/lifecycle events are
> received by the Remix app first (so it can verify them and clean up local
> state) and then forwarded to FastAPI over a trusted channel authenticated with
> a shared token.

All endpoints use `https`. The base URL is the value of `REKART_BACKEND_URL`
configured in the Shopify app's environment (no trailing slash; the app strips
one if present).

API version for Shopify payloads: **2025-10** (`October25`). Payloads below are
representative — treat Shopify's fields as a superset that may grow; parse
defensively and ignore unknown fields.

---

## Authentication

### Scheme 1 — Shopify HMAC (Group A only)

Shopify signs every webhook with a base64-encoded HMAC-SHA256 of the **raw
request body**, keyed by the app's **client secret** (the same value the app
uses as `SHOPIFY_API_SECRET`). The signature is sent in the
`X-Shopify-Hmac-Sha256` header.

Verification **must** run against the raw, unparsed body bytes — not a
re-serialized JSON object.

```python
import base64
import hashlib
import hmac
import os

SHOPIFY_API_SECRET = os.environ["SHOPIFY_API_SECRET"].encode("utf-8")

def verify_shopify_hmac(raw_body: bytes, header_hmac: str | None) -> bool:
    if not header_hmac:
        return False
    digest = hmac.new(SHOPIFY_API_SECRET, raw_body, hashlib.sha256).digest()
    computed = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(computed, header_hmac)
```

FastAPI dependency that reads the raw body and rejects bad signatures with
`401`:

```python
from fastapi import Header, HTTPException, Request

async def require_shopify_hmac(
    request: Request,
    x_shopify_hmac_sha256: str | None = Header(default=None),
) -> bytes:
    raw = await request.body()
    if not verify_shopify_hmac(raw, x_shopify_hmac_sha256):
        raise HTTPException(status_code=401, detail="Invalid HMAC")
    return raw
```

Other Shopify headers present on Group A requests (use for routing/idempotency,
do not trust for auth):

| Header | Example |
| ------ | ------- |
| `X-Shopify-Topic` | `orders/create` |
| `X-Shopify-Shop-Domain` | `rekart-dev.myshopify.com` |
| `X-Shopify-Webhook-Id` | `b54557e4-bc8e-4f1f-9c2a-0e2a4b9d1f33` |
| `X-Shopify-API-Version` | `2025-10` |
| `X-Shopify-Triggered-At` | `2026-06-11T09:30:00.000Z` |
| `X-Shopify-Event-Id` | `123456789` |

**Idempotency:** Shopify may deliver a webhook more than once. De-duplicate on
`X-Shopify-Webhook-Id`.

### Scheme 2 — Shared token (Groups B & C)

The Remix app sends a static secret in the `X-API-Key` header on every
forwarded webhook and every dashboard API call. It equals the
`REKART_STATIC_API_KEY` env var on both sides.

- Header name: `X-API-Key`
- Header value: the shared secret string, sent verbatim
- Compare in constant time; reject mismatches/absences with `401`.

```python
import os
import hmac
from fastapi import Header, HTTPException

REKART_STATIC_API_KEY = os.environ["REKART_STATIC_API_KEY"]

async def require_static_api_key(
    x_api_key: str | None = Header(default=None),
) -> None:
    if not x_api_key or not hmac.compare_digest(
        x_api_key, REKART_STATIC_API_KEY
    ):
        raise HTTPException(status_code=401, detail="Invalid token")
```

> If `REKART_STATIC_API_KEY` is unset on the app side, the app omits the header.
> Treat a missing header as unauthorized in production.

### Response & timeout expectations

- **Group A (Shopify):** Respond `200` within Shopify's webhook timeout
  (~5 seconds). Do heavy work asynchronously. A non-2xx causes Shopify to retry
  with backoff and eventually disable the subscription.
- **Group B (forwarded):** Respond `2xx` quickly. The app treats the call as
  best-effort and **never blocks the Shopify 200** on it, but a `2xx` lets the
  app log success. Non-2xx is logged and not retried by the app.
- **Group C (stats):** Respond `200` within ~5 seconds. On any non-200 or
  timeout the dashboard renders a graceful "unreachable" fallback.

---

## Group A — Shopify-delivered data webhooks

Registered per-shop at install time by the app (`hooks.afterAuth`). Bodies are
**standard Shopify webhook payloads** (the full resource object). Auth: Scheme 1.

### `POST /webhooks/shopify/orders/create`

Fired when an order is created. Use to create a Rekart delivery job.

Request headers: see Scheme 1. Body (truncated to commonly used fields):

```json
{
  "id": 5544332211000,
  "admin_graphql_api_id": "gid://shopify/Order/5544332211000",
  "name": "#1001",
  "order_number": 1001,
  "created_at": "2026-06-11T09:30:00-04:00",
  "currency": "INR",
  "total_price": "499.00",
  "financial_status": "paid",
  "fulfillment_status": null,
  "confirmed": true,
  "email": "buyer@example.com",
  "phone": "+919876543210",
  "customer": {
    "id": 6677889900,
    "first_name": "Asha",
    "last_name": "Rao",
    "email": "buyer@example.com"
  },
  "shipping_address": {
    "first_name": "Asha",
    "last_name": "Rao",
    "address1": "12 MG Road",
    "address2": "Apt 4B",
    "city": "Bengaluru",
    "province": "Karnataka",
    "country": "India",
    "country_code": "IN",
    "zip": "560001",
    "phone": "+919876543210",
    "latitude": 12.9716,
    "longitude": 77.5946
  },
  "line_items": [
    {
      "id": 111222333,
      "title": "Organic Cold Brew 1L",
      "quantity": 2,
      "sku": "CB-1L",
      "price": "249.50",
      "grams": 1000
    }
  ]
}
```

Expected response: `200` with any small body (ignored). Recommended:

```json
{ "received": true, "delivery_job_id": "djb_01HZX..." }
```

### `POST /webhooks/shopify/customers/create`

Fired when a customer is created. Body is a Shopify customer object:

```json
{
  "id": 6677889900,
  "admin_graphql_api_id": "gid://shopify/Customer/6677889900",
  "created_at": "2026-06-11T09:25:00-04:00",
  "updated_at": "2026-06-11T09:25:00-04:00",
  "first_name": "Asha",
  "last_name": "Rao",
  "email": "buyer@example.com",
  "phone": "+919876543210",
  "verified_email": true,
  "state": "enabled",
  "tags": "",
  "default_address": {
    "address1": "12 MG Road",
    "city": "Bengaluru",
    "province": "Karnataka",
    "country": "India",
    "country_code": "IN",
    "zip": "560001"
  }
}
```

Expected response: `200`.

### `POST /webhooks/shopify/customers/update`

Same body shape as `customers/create` (the updated customer object). Upsert on
`id`. Expected response: `200`.

---

## Group B — Remix-forwarded events

Received by the Remix app first (Shopify HMAC verified there), then forwarded to
FastAPI. Auth: Scheme 2 (`X-API-Key`). `Content-Type: application/json`.

The GDPR endpoints wrap the original Shopify payload under a `payload` key and
add the `shop` domain at the top level.

### `POST /webhooks/shopify/gdpr/customers_data_request`

A merchant/customer requests the data you hold about a customer. Compile it and
deliver out-of-band (Shopify does not transport the data for you).

```json
{
  "shop": "rekart-dev.myshopify.com",
  "payload": {
    "shop_id": 901234567,
    "shop_domain": "rekart-dev.myshopify.com",
    "orders_requested": [5544332211000],
    "customer": {
      "id": 6677889900,
      "email": "buyer@example.com",
      "phone": "+919876543210"
    },
    "data_request": { "id": 9988776655 }
  }
}
```

Expected response: `200`.

### `POST /webhooks/shopify/gdpr/customers_redact`

Erase a specific customer's data.

```json
{
  "shop": "rekart-dev.myshopify.com",
  "payload": {
    "shop_id": 901234567,
    "shop_domain": "rekart-dev.myshopify.com",
    "customer": {
      "id": 6677889900,
      "email": "buyer@example.com",
      "phone": "+919876543210"
    },
    "orders_to_redact": [5544332211000]
  }
}
```

Expected response: `200`. Action: delete/anonymize all stored data for that
customer.

### `POST /webhooks/shopify/gdpr/shop_redact`

Sent ~48h after a shop uninstalls. Erase all data for the shop.

```json
{
  "shop": "rekart-dev.myshopify.com",
  "payload": {
    "shop_id": 901234567,
    "shop_domain": "rekart-dev.myshopify.com"
  }
}
```

Expected response: `200`. Action: purge everything tied to `shop_domain`.

### `POST /webhooks/shopify/app/uninstalled`

Sent by the app immediately when it receives the `app/uninstalled` webhook.
Note: this body has **no `payload` key** — only `shop`.

```json
{
  "shop": "rekart-dev.myshopify.com"
}
```

Expected response: `200`. Action: mark the shop disconnected, stop syncing,
revoke any cached token. (Full data deletion happens later via `shop_redact`.)

---

## Group C — Dashboard sync stats

Called by the embedded dashboard loader on every page load. Auth: Scheme 2
(`X-API-Key`). Read-only.

### `GET /api/shops/{shop}/stats`

`{shop}` is the URL-encoded `.myshopify.com` domain, e.g.
`rekart-dev.myshopify.com`.

Request:

```
GET /api/shops/rekart-dev.myshopify.com/stats
X-API-Key: <shared secret>
```

Response `200` — **exact shape required** (the dashboard reads these keys):

```json
{
  "ordersSynced": 128,
  "customersSynced": 542,
  "lastSyncedAt": "2026-06-11T09:31:42Z",
  "connected": true
}
```

Field contract:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `ordersSynced` | integer | Total orders ingested for this shop. |
| `customersSynced` | integer | Total customers ingested for this shop. |
| `lastSyncedAt` | string \| null | ISO-8601 timestamp of last ingest, or `null` if never. |
| `connected` | boolean | Whether the backend considers this shop linked & healthy. Drives the dashboard connection badge. |

- Unknown shop: return `200` with zeros and `"connected": false` (preferred), or
  `404` (the dashboard treats any non-200 as "unreachable").
- Any 5xx / timeout: dashboard shows the "Can't reach the Rekart backend"
  banner and stale-safe placeholders.

---

## Environment variables (backend side)

| Var | Purpose |
| --- | ------- |
| `SHOPIFY_API_SECRET` | App client secret; key for verifying Group A HMAC. Must match the app's value. |
| `REKART_STATIC_API_KEY` | Shared secret for Groups B & C; must match the app's `REKART_STATIC_API_KEY`. |

## Endpoint quick reference

| Method | Path | Auth | Caller |
| ------ | ---- | ---- | ------ |
| POST | `/webhooks/shopify/orders/create` | Shopify HMAC | Shopify |
| POST | `/webhooks/shopify/customers/create` | Shopify HMAC | Shopify |
| POST | `/webhooks/shopify/customers/update` | Shopify HMAC | Shopify |
| POST | `/webhooks/shopify/gdpr/customers_data_request` | `X-API-Key` | App |
| POST | `/webhooks/shopify/gdpr/customers_redact` | `X-API-Key` | App |
| POST | `/webhooks/shopify/gdpr/shop_redact` | `X-API-Key` | App |
| POST | `/webhooks/shopify/app/uninstalled` | `X-API-Key` | App |
| GET | `/api/shops/{shop}/stats` | `X-API-Key` | App |
