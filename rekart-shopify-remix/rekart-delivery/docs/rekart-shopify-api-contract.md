# Rekart × Shopify — Internal API Contract Specification

**Version:** v0.2
**Date:** 2026-06-16
**Authors:** _[Vrushank Kavimandan, Rekart Tech Team]_
**Status:** Draft — pending tech team review
**Repo:** github.com/Rekart-io/rekart-delivery
**Based on:** Rekart Platform Capabilities Document (Laravel 11 source analysis)

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Base URLs](#base-urls)
4. [Global Conventions](#global-conventions)
5. [Standard Error Shape](#standard-error-shape)
6. [Endpoints](#endpoints)
7. [Webhook Contract](#webhook-contract)
8. [Polling & Reconciliation](#polling--reconciliation)
9. [Open Items](#open-items)
10. [Changelog](#changelog)

---

## Overview

This document defines every HTTP endpoint exchanged between three services in the Rekart Delivery Shopify integration.

> **v0.2 key corrections from capabilities doc analysis:**
> - Rekart has **no outbound webhooks**. Delivery status sync must use polling or a custom Rekart-side job.
> - Orders map to Rekart `Order` with `external_source="shopify"` + `external_order_id` — not a new entity.
> - Customers map to Rekart `User` (role=customer) keyed by `(client_id, phone)`.
> - Subscriptions require `slot_id`, `plan_id`, `pattern_data` — Rekart-internal concepts merchants must pre-configure.
> - Auth token from `/api/auth/login` is a **Laravel Passport opaque token**, not JWT.
> - Almost all Rekart API endpoints use **POST** even for reads — do not assume REST verb semantics.

### Services

| Service | Role |
|---------|------|
| **Shopify** | Merchant storefront + checkout. Delivers order/customer webhooks. Receives fulfillment status updates. |
| **Remix App** | Embedded Shopify admin UI. Handles OAuth, onboarding, merchant session, GDPR forwarding, fulfillment push to Shopify, and polling reconciliation. |
| **Rekart Backend** | Existing Laravel 11 platform. Receives orders and customers, creates delivery jobs, exposes sync stats, product catalog, slots, and plans. |

### Data flow — one-time order (Phase 1)

```
Customer places order on Shopify
         ↓
Shopify fires orders/create webhook
         ↓
FastAPI connector receives + verifies HMAC
         ↓
Celery task: sync_order
  → Find/create customer via panel/customer/create (keyed by phone + client_id)
  → Create Order via panel/order/create
      external_source = "shopify"
      external_order_id = "<shopify_order_id>"
      product_id = <mapped from shopify_variant_id>
      slot_id = <merchant's configured slot>
      payment_status = "paid"
         ↓
Rekart scheduler materializes Delivery + DeliveryItem
  → Assigns to rider route
         ↓
Rider marks delivered in Rekart mobile app
         ↓
⚠️  No outbound webhook — two options:
    A) Polling: FastAPI polls GET delivery/info every 15 min
    B) Custom: Rekart team adds outbound call to POST /api/fulfillment-push
         ↓
Remix App → Shopify GraphQL fulfillmentCreate / fulfillmentEventCreate
         ↓
Shopify order timeline updated ✅
```

### Data flow — recurring subscription (Phase 2)

```
Merchant pre-configures in Rekart:
  Products → Plans → Slots → Pattern options

Synced to Shopify as Selling Plans
(write_own_subscription_contracts scope)
         ↓
Customer selects "Daily subscription" on Shopify storefront
         ↓
Shopify creates subscription contract
         ↓
Remix App receives subscription webhook
         ↓
Call Rekart panel/subscription/create:
  product_id, slot_id, plan_id, pattern_data, start_date, address_id
         ↓
Rekart scheduler runs daily → Delivery + DeliveryItem per day
         ↓
Customer manages via WhatsApp bot (pause/cancel/modify)
  → Changes sync back to Shopify subscription contract (bidirectional)
```

---

## Authentication

### Scheme A — Shopify HMAC (Shopify → FastAPI connector)

Shopify signs every webhook with HMAC-SHA256 of the **raw request body**, keyed by `SHOPIFY_API_SECRET`. Signature is base64-encoded in `X-Shopify-Hmac-Sha256`.

Must verify against raw unparsed bytes — never re-serialized JSON.

```python
import base64, hashlib, hmac, os

def verify_shopify_hmac(raw_body: bytes, header_hmac: str) -> bool:
    secret = os.environ["SHOPIFY_API_SECRET"].encode("utf-8")
    digest = hmac.new(secret, raw_body, hashlib.sha256).digest()
    computed = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(computed, header_hmac)
```

### Scheme B — Static API Key (Remix App → FastAPI connector → Rekart Backend)

All server-to-server calls use a shared static secret.

- **Header name:** `X-API-Key`
- **Header value:** `REKART_STATIC_API_KEY` (same on both sides)
- Compared in constant time; reject with `401` on mismatch or absence

### Scheme C — Rekart Passport Token (Shopify app → Rekart panel endpoints)

Auth token obtained from `POST /api/auth/login`. This is a **Laravel Passport opaque token** (not JWT) returned in `user.token.access_token`.

- **Header name:** `Authorization`
- **Header value:** `Bearer <access_token>`
- Guarded by `auth:api` middleware on Rekart's end
- Also requires `appType`, `appVersion`, `platform` in request body (intercepted by Rekart's `HttpDefaultPayloadInterceptor`)

### Scheme D — OAuth 2.0 (Merchant account linking — Phase 1 replacement for password login)

Authorization Code Flow. Merchant's browser is redirected to Rekart's authorize URL. Rekart issues a long-lived Passport token after consent.

- Currently: merchant enters username/password in embedded app (interim solution)
- Planned: OAuth 2.0 redirect flow (Pappu confirmed URL is ready — details pending)

---

## Base URLs

| Environment | Rekart Backend | Notes |
|-------------|---------------|-------|
| Staging | `https://dev3.rekart.io` | `/api` prefix on all API routes |
| Production | `https://app.rekart.io` | Same structure |

All panel endpoints: `{base}/api/panel/...`
All customer/app endpoints: `{base}/api/...` + `cid=<client_slug>` param
Auth endpoint: `{base}/api/auth/login`

---

## Global Conventions

- All request/response bodies are `application/json`
- All timestamps are **ISO 8601 UTC**: `2026-06-16T09:30:00Z`
- Monetary amounts are **strings** to avoid float precision loss: `"85.00"`
- All Shopify IDs are **strings** (exceed 32-bit int range)
- All Rekart IDs are **integers** (Laravel auto-increment PKs)
- **POST is used for almost everything** in Rekart — including reads. Do not assume REST verb semantics.
- **Tenant isolation:** every Rekart resource is scoped by `client_id`. IDs are meaningless across tenants. Always confirm you are operating in the correct client context.
- **`cid` param:** customer/app-facing routes resolve tenant from `cid` = client slug. Panel routes derive tenant from authenticated user's `client_id`.
- Idempotency: Shopify may deliver webhooks more than once. Deduplicate on natural keys as specified per endpoint.
  - **Webhook deduplication** is performed in the **`rekart-backend` FastAPI service** on `X-Shopify-Webhook-Id` (a `WebhookEvent` table) — **not** in the Remix app's Prisma DB. Data webhooks (orders/create, customers/create, customers/update) are delivered by Shopify directly to the Rekart backend, so dedup lives where those webhooks land.
- Timeout budget: Rekart must respond to stats/dashboard endpoints within **2500ms**; webhook ingest within **5000ms**.
- **Timezone trap:** Rekart stores datetimes in UTC but some accessors return client-TZ wall-clock values mislabelled as UTC. Always send dates as UTC ISO 8601; treat display-formatted date strings from the API as display-only.

---

## Standard Error Shape

```json
{
  "error": {
    "code": "ORDER_ALREADY_INGESTED",
    "message": "An order with external_order_id 5544332211000 already exists.",
    "details": {
      "external_order_id": "5544332211000",
      "rekart_order_id": 4821
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `error.code` | string | Machine-readable code in SCREAMING_SNAKE_CASE |
| `error.message` | string | Human-readable description safe to log |
| `error.details` | object \| null | Optional structured context |

---

## Endpoints

---

### Authentication

---

### POST /api/auth/login

> Authenticates a Rekart user and returns a Laravel Passport bearer token. Used by the Shopify app to obtain a token for panel-level API calls on behalf of a linked merchant.

**Auth:** None — credentials in body

**Request Headers**

| Header | Value | Required |
|--------|-------|----------|
| `Content-Type` | `application/json` | ✅ |

**Request Body**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `username` | string | ✅ | Phone in E.164 or email | Merchant admin user credential |
| `password` | string | ✅ | | Merchant admin password |
| `referer` | string | ✅ | Fixed: `"admin"` | Required by Rekart interceptor |
| `appType` | string | ✅ | Fixed: `"ShopifyApp"` | Identifies the calling app |
| `appVersion` | string | ✅ | e.g. `"1.0.0"` | App version string |
| `platform` | string | ✅ | Fixed: `"browser"` | Platform identifier |

**Success Response — 200**

| Field | Type | Description |
|-------|------|-------------|
| `user.id` | integer | Rekart user ID |
| `user.client.client_id` | integer | Merchant's `client_id` — store this as `rekartMerchantId` |
| `user.client.slug` | string | Client slug — use as `cid` param on app-facing routes |
| `user.token.access_token` | string | Laravel Passport opaque bearer token |
| `user.token.expires_at` | string (ISO 8601) | Token expiry |
| `user.token.refresh_token` | null | Not implemented — token is long-lived |
| `config` | object | Client configuration (timezone, currency, feature flags) |

**Errors**

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `INVALID_CREDENTIALS` | 422 | Username/password mismatch |
| `ACCOUNT_NOT_FOUND` | 422 | No account found for this phone/email |
| `THROTTLED` | 429 | Rate limit: 30 requests per 60 seconds |

**Status:** ✅ Already exists — confirmed working

**Example**

```bash
curl -X POST https://dev3.rekart.io/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "+919000000001",
    "password": "1234",
    "referer": "admin",
    "appType": "ShopifyApp",
    "appVersion": "1.0.0",
    "platform": "browser"
  }'
```

```json
{
  "user": {
    "id": 350055,
    "client": {
      "client_id": 140,
      "slug": "RbDOgyHZhO3pzk97",
      "name": "Truly Desi Daily",
      "plan_type": "paid",
      "onboarding_status": "completed"
    },
    "token": {
      "token_type": "Bearer",
      "expires_at": "2027-06-15T05:47:36Z",
      "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9...",
      "refresh_token": null
    }
  },
  "config": {
    "timezone": "Asia/Kolkata",
    "currency": "INR",
    "currency_symbol": "₹"
  }
}
```

---

### POST /api/oauth/authorize _(planned)_

> OAuth 2.0 authorization endpoint. Merchant's browser is redirected here to log in to Rekart and consent to the Shopify integration. Replaces the embedded username/password form.

**Status:** ❌ Needs to be built — Pappu confirmed URL is ready, details pending

**Flow:**
```
Shopify app redirects merchant browser to:
https://app.rekart.io/oauth/authorize
  ?client_id=rekart-shopify-app
  &redirect_uri=https://<shopify-app>/app/rekart-callback
  &state=550e8400-e29b-41d4-a716-446655440000
  &shop=merchant.myshopify.com

After merchant logs in and consents, Rekart redirects to:
https://<shopify-app>/app/rekart-callback
  ?code=rec_a1b2c3d4e5f6
  &state=550e8400-e29b-41d4-a716-446655440000
  &client_id=140
```

---

### POST /api/oauth/token _(planned)_

> Exchanges a one-time OAuth code for a Passport bearer token. Called server-to-server after receiving the OAuth callback.

**Auth:** `client_id` + `client_secret` in body

**Request Body**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `code` | string | ✅ | Single-use, 10 min expiry | Code from OAuth callback |
| `client_id` | string | ✅ | | OAuth client ID |
| `client_secret` | string | ✅ | | OAuth client secret |

**Success Response — 200**

| Field | Type | Description |
|-------|------|-------------|
| `access_token` | string | Passport bearer token |
| `client_id` | integer | Rekart `client_id` for this merchant |
| `expires_in` | integer | Lifetime in seconds (recommended: 31536000) |

**Status:** ❌ Needs to be built

---

### Merchant Provisioning

---

### POST /api/merchants/provision _(planned)_

> Creates a new Rekart merchant (Client) account for a first-time App Store install. Called when onboarding indicates the merchant is NOT an existing Rekart client. Account starts `pending_review` — Rekart sales team activates it.

**Auth:** Scheme B — `X-API-Key`

**Request Headers**

| Header | Value | Required |
|--------|-------|----------|
| `Content-Type` | `application/json` | ✅ |
| `X-API-Key` | `<REKART_STATIC_API_KEY>` | ✅ |

**Request Body**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `shop_domain` | string | ✅ | `.myshopify.com` suffix | Shopify store domain |
| `business_name` | string | ✅ | max 255 chars | Business name |
| `email` | string | ✅ | Valid email | Contact email |
| `phone` | string | ✅ | E.164 format | Contact phone |
| `country` | string | ✅ | ISO 3166-1 alpha-2 | e.g. `IN` |
| `city` | string | ❌ | max 100 chars | City |
| `business_category` | string | ✅ | `dairy` \| `water` \| `meal_kit` \| `pet_food` \| `florist` \| `other` | From onboarding |
| `monthly_order_volume` | string | ✅ | `lt_100` \| `100_500` \| `500_2000` \| `2000_10000` \| `gt_10000` | From onboarding |
| `delivery_ops_setup` | string | ✅ | `manual` \| `existing_software` \| `in_house` \| `none` | From onboarding |
| `onboarding_source` | string | ✅ | Fixed: `shopify_app_store` | Origin marker |

**Success Response — 201**

| Field | Type | Description |
|-------|------|-------------|
| `client_id` | integer | New Rekart `client_id` |
| `slug` | string | Client slug for `cid` param |
| `status` | string | `pending_review` |
| `message` | string | Confirmation message for merchant |

**Errors**

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `SHOP_ALREADY_PROVISIONED` | 409 | Merchant with this `shop_domain` already exists |
| `MISSING_FIELDS` | 422 | Required fields absent |

**Idempotency:** **Deduplicate on `shop_domain`. Return `409` if already provisioned.**

**Status:** ❌ Needs to be built

---

### Customer Sync

---

### POST /api/panel/customer/create _(extend existing)_

> Creates or updates a Rekart customer (User with role=customer) from Shopify customer data. Customers are keyed by `(client_id, phone)` within a tenant.

**Auth:** Scheme C — `Authorization: Bearer <access_token>`

**⚠️ This endpoint already exists as `panel/customer/create`. Confirm it handles the fields below and upserts gracefully on duplicate phone.**

**Request Headers**

| Header | Value | Required |
|--------|-------|----------|
| `Content-Type` | `application/json` | ✅ |
| `Authorization` | `Bearer <access_token>` | ✅ |

**Request Body**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `name` | string | ✅ | max 255 chars | Full name |
| `phone` | string | ✅ | E.164 format | Primary key within tenant |
| `email` | string | ❌ | Valid email | |
| `address` | string | ❌ | max 500 chars | Street address |
| `city` | string | ❌ | max 100 chars | |
| `area_id` | integer | ❌ | Must exist in client | Zone/area for route assignment |
| `shopify_customer_id` | string | ✅ | Shopify numeric ID as string | Store for reverse lookup |
| `external_source` | string | ✅ | Fixed: `"shopify"` | Origin marker |

**Success Response — 200**

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Rekart `User.id` (customer ID) |
| `action` | string | `created` \| `updated` |

**Errors**

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `DUPLICATE_PHONE` | 409 | Phone already exists — confirm upsert behaviour |
| `INVALID_PHONE` | 422 | Phone not in E.164 format |
| `AREA_NOT_FOUND` | 404 | `area_id` not found in this client |

**Idempotency:** **Upsert on `(client_id, phone)`. Never create duplicate customer records for the same phone.**

**Status:** ⚠️ Endpoint exists — confirm upsert behaviour and `shopify_customer_id` / `external_source` field support

**Example**

```bash
curl -X POST https://dev3.rekart.io/api/panel/customer/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJ0eXAiOiJKV1Qi..." \
  -d '{
    "name": "Asha Rao",
    "phone": "+919876543210",
    "email": "asha.rao@example.com",
    "shopify_customer_id": "6677889900",
    "external_source": "shopify"
  }'
```

```json
{
  "id": 78432,
  "action": "created"
}
```

---

### Order Sync

---

### POST /api/panel/order/create _(extend existing)_

> Creates a one-time order in Rekart from a Shopify order. Uses the existing `panel/order/create` endpoint extended to accept `external_source` and `external_order_id`. Rekart's `Order` model already has these fields.

**Auth:** Scheme C — `Authorization: Bearer <access_token>`

**⚠️ This endpoint already exists. Confirm it accepts `external_source`, `external_order_id`, and a line-items array mapping to `OrderItem` rows. Extend if needed.**

**Request Headers**

| Header | Value | Required |
|--------|-------|----------|
| `Content-Type` | `application/json` | ✅ |
| `Authorization` | `Bearer <access_token>` | ✅ |

**Request Body**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `external_order_id` | string | ✅ | Shopify order ID as string | Natural dedup key |
| `external_source` | string | ✅ | Fixed: `"shopify"` | Origin marker |
| `customer_id` | integer | ✅ | Must exist in client | Rekart `User.id` |
| `slot_id` | integer | ✅ | Must exist in client | Delivery time slot |
| `address_id` | integer | ✅ | Must belong to customer | Delivery address |
| `delivery_date` | string (ISO 8601 date) | ✅ | `YYYY-MM-DD` format | Requested delivery date |
| `payment_type` | string | ✅ | `cod` \| `online` | Payment method |
| `payment_status` | string | ✅ | `paid` \| `unpaid` | Shopify orders are `paid` |
| `amount` | string | ✅ | Decimal string | Order total |
| `currency` | string | ✅ | ISO 4217 | e.g. `INR` |
| `items` | array | ✅ | min 1 item | Order line items |
| `items[].product_id` | integer | ✅ | Must exist in client | Mapped Rekart product |
| `items[].quantity` | integer | ✅ | min 1 | Quantity |
| `items[].rate` | string | ✅ | Decimal string | Unit price |
| `items[].shopify_variant_id` | string | ✅ | | For reverse lookup |
| `note` | string | ❌ | max 500 chars | Order note |

**Success Response — 201**

| Field | Type | Description |
|-------|------|-------------|
| `order_id` | integer | Rekart `Order.order_id` |
| `deli_id` | integer \| null | Associated `Delivery.deli_id` if immediately scheduled |
| `status` | string | Order status: `pending` \| `confirmed` |

**Errors**

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `ORDER_ALREADY_EXISTS` | 409 | Order with this `external_order_id` already exists |
| `CUSTOMER_NOT_FOUND` | 404 | `customer_id` not found in this client |
| `SLOT_NOT_FOUND` | 404 | `slot_id` not found in this client |
| `PRODUCT_NOT_FOUND` | 404 | A `product_id` in `items` not found in this client |
| `MISSING_FIELDS` | 422 | Required fields absent |

**Idempotency:** **Deduplicate on `external_order_id`. Return `409` on duplicate — do not create a second order.**

**Status:** ⚠️ Endpoint exists — confirm `external_source`/`external_order_id` support and line-items array format

**Example**

```bash
curl -X POST https://dev3.rekart.io/api/panel/order/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJ0eXAiOiJKV1Qi..." \
  -d '{
    "external_order_id": "5544332211000",
    "external_source": "shopify",
    "customer_id": 78432,
    "slot_id": 12,
    "address_id": 99021,
    "delivery_date": "2026-06-17",
    "payment_type": "online",
    "payment_status": "paid",
    "amount": "170.00",
    "currency": "INR",
    "items": [
      {
        "product_id": 331,
        "quantity": 2,
        "rate": "85.00",
        "shopify_variant_id": "43210987654321"
      }
    ]
  }'
```

```json
{
  "order_id": 4821,
  "deli_id": 98320,
  "status": "confirmed"
}
```

---

### Subscription Sync (Phase 2)

---

### POST /api/panel/subscription/create _(extend existing)_

> Creates a recurring subscription in Rekart from a Shopify subscription contract. Requires the merchant to have pre-configured products, slots, and plans in Rekart. Called after a customer subscribes via a Shopify Selling Plan.

**Auth:** Scheme C — `Authorization: Bearer <access_token>`

**⚠️ This endpoint already exists. Confirm it can be called from an external service with a pre-determined `pattern_data`.**

**Request Headers**

| Header | Value | Required |
|--------|-------|----------|
| `Content-Type` | `application/json` | ✅ |
| `Authorization` | `Bearer <access_token>` | ✅ |

**Request Body**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `customer_id` | integer | ✅ | Must exist in client | Rekart `User.id` |
| `product_id` | integer | ✅ | Must exist in client | Rekart product |
| `slot_id` | integer | ✅ | Must exist in client | Delivery slot |
| `address_id` | integer | ✅ | Must belong to customer | Delivery address |
| `plan_id` | integer | ✅ | Must exist in client | Billing plan |
| `rate` | string | ✅ | Decimal string | Per-unit delivery rate |
| `start_date` | string (ISO 8601 date) | ✅ | `YYYY-MM-DD`, future date | Subscription start |
| `pattern_data` | object | ✅ | See pattern types below | Delivery recurrence rule |
| `shopify_contract_id` | string | ✅ | | Shopify subscription contract GID |
| `external_source` | string | ✅ | Fixed: `"shopify"` | Origin marker |

**Pattern data shapes**

```json
// Daily (deliver every day)
{ "type": "daily", "mon": 1, "tue": 1, "wed": 1, "thu": 1, "fri": 1, "sat": 1, "sun": 1 }

// Mon-Fri only
{ "type": "daily", "mon": 1, "tue": 1, "wed": 1, "thu": 1, "fri": 1, "sat": 0, "sun": 0 }

// Alternate days
{ "type": "alternate", "first": 1, "second": 0 }

// Every 3 days
{ "type": "nth_day", "nth_day": [1, 0, 0] }
```

**Success Response — 201**

| Field | Type | Description |
|-------|------|-------------|
| `sub_id` | integer | Rekart `Subscription.sub_id` |
| `status` | string | `pending` (auto-approved if configured) or `approved` |
| `next_delivery` | string (ISO 8601 date) | Computed first delivery date |

**Errors**

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `SUBSCRIPTION_ALREADY_EXISTS` | 409 | Subscription for this `shopify_contract_id` already exists |
| `PRODUCT_NOT_FOUND` | 404 | `product_id` not found in client |
| `SLOT_NOT_FOUND` | 404 | `slot_id` not found in client |
| `PLAN_NOT_FOUND` | 404 | `plan_id` not found in client |
| `WALLET_INSUFFICIENT` | 402 | Prepaid wallet below block limit |
| `INVALID_PATTERN` | 422 | `pattern_data` shape invalid |

**Idempotency:** **Deduplicate on `shopify_contract_id`. Return `409` on duplicate.**

**Status:** ⚠️ Endpoint exists — confirm external call support and `shopify_contract_id`/`external_source` field addition

---

### Dashboard & Stats

---

### GET /api/shops/{shop}/stats _(new)_

> Returns sync statistics for a connected shop. Called by the Remix dashboard on every page load. Must respond within 2500ms.

**Auth:** Scheme B — `X-API-Key`

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `shop` | string | URL-encoded `.myshopify.com` domain |

**Request Headers**

| Header | Value | Required |
|--------|-------|----------|
| `X-API-Key` | `<REKART_STATIC_API_KEY>` | ✅ |

**Success Response — 200**

| Field | Type | Description |
|-------|------|-------------|
| `ordersSynced` | integer | Total orders with `external_source="shopify"` for this client |
| `customersSynced` | integer | Total customers synced from Shopify |
| `lastSyncedAt` | string (ISO 8601) \| null | Timestamp of last successful ingest |
| `connected` | boolean | Whether client account is active |

**Notes:** If shop is unknown, return zeros + `connected: false` (not 404) — dashboard handles gracefully.

**Errors**

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `UNAUTHORIZED` | 401 | Invalid or missing `X-API-Key` |

**Status:** ❌ Needs to be built

**Example**

```bash
curl https://dev3.rekart.io/api/shops/fresh-dairy.myshopify.com/stats \
  -H "X-API-Key: rks_your_api_key_here"
```

```json
{
  "ordersSynced": 128,
  "customersSynced": 542,
  "lastSyncedAt": "2026-06-16T09:31:42Z",
  "connected": true
}
```

---

### Product Catalog & Mapping

---

### GET /api/panel/product/list _(existing — use as-is)_

> Returns the Rekart product catalog for the authenticated merchant. Used to populate the product mapping screen in the Shopify app.

**Auth:** Scheme C — `Authorization: Bearer <access_token>`

**⚠️ This endpoint already exists. Confirm response shape includes `product_id`, `name`, `unit`, `price`, `is_active`.**

**Success Response — 200** _(confirm exact shape with team)_

```json
{
  "products": [
    {
      "product_id": 331,
      "name": "Full Cream Milk 1L",
      "unit": "litre",
      "price": "85.00",
      "type": "simple",
      "is_active": true,
      "allow_subscribe": true,
      "allow_onetime": true
    }
  ]
}
```

**Status:** ⚠️ Endpoint exists — confirm response shape

---

### GET /api/panel/slot/list _(existing — use as-is)_

> Returns delivery slots for the authenticated merchant. Needed for Phase 2 to let merchants map Shopify selling plan frequencies to Rekart slots.

**Auth:** Scheme C — `Authorization: Bearer <access_token>`

**Success Response — 200** _(confirm exact shape with team)_

```json
{
  "slots": [
    {
      "slot_id": 12,
      "text": "Morning",
      "delivery_time": 270,
      "is_active": true,
      "dayoff": { "mon": false, "tue": false, "wed": false, "thu": false, "fri": false, "sat": false, "sun": false }
    }
  ]
}
```

**Status:** ⚠️ Endpoint exists — confirm response shape

---

### GET /api/panel/plan/list _(existing — use as-is)_

> Returns billing plans for the authenticated merchant. Needed for Phase 2 subscription sync.

**Auth:** Scheme C — `Authorization: Bearer <access_token>`

**Success Response — 200** _(confirm exact shape with team)_

```json
{
  "plans": [
    {
      "plan_id": 7,
      "name": "Monthly Prepaid",
      "type": "ongoing",
      "payment_term": "prepaid",
      "auto_renew": true,
      "is_active": true
    }
  ]
}
```

**Status:** ⚠️ Endpoint exists — confirm response shape

---

### POST /api/merchants/{merchant_id}/product-links _(new)_

> Saves Shopify variant → Rekart product mappings. Stored in the Shopify app's own database (not Rekart's). Listed here for completeness — this endpoint lives on the Shopify app side.

**Auth:** Scheme C — `Authorization: Bearer <access_token>` (Shopify app side)

**Request Body**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `mappings` | array | ✅ | min 1 item | Mappings to save |
| `mappings[].shopify_variant_id` | string | ✅ | | Shopify product variant ID |
| `mappings[].shopify_product_title` | string | ✅ | max 255 chars | For display |
| `mappings[].shopify_sku` | string | ❌ | max 100 chars | Shopify SKU |
| `mappings[].rekart_product_id` | integer | ✅ | Must exist in client | Rekart `product_id` |
| `mappings[].matched_auto` | boolean | ✅ | | Auto-matched vs manually selected |

**Status:** ❌ Needs to be built (on Shopify app side, not Rekart backend)

---

### Delivery Status

---

### POST /api/delivery/info _(existing — use for polling)_

> Returns the current status of a Rekart delivery. Used by the polling reconciliation job since Rekart has no outbound webhooks.

**Auth:** Scheme C — `Authorization: Bearer <access_token>`

**⚠️ This endpoint may already exist under a different path. Confirm exact path and response shape with team.**

**Request Body** _(POST convention — not GET)_

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deli_id` | integer | ✅ | Rekart `Delivery.deli_id` |

**Success Response — 200** _(confirm exact shape)_

| Field | Type | Description |
|-------|------|-------------|
| `deli_id` | integer | Delivery ID |
| `status` | string | See delivery item status below |
| `delivery_date` | string (ISO 8601 date) | Scheduled date |
| `delivered_at` | string (ISO 8601) \| null | Actual delivery timestamp |
| `driver_id` | integer \| null | Assigned rider |

**Delivery item status → Shopify fulfillment mapping**

| Rekart DeliveryItem status | Shopify action | Merchant sees |
|---------------------------|----------------|---------------|
| `confirmed` / `packed` | `fulfillmentCreate` open | Fulfillment created |
| `ready_to_ship` / `shipped` | `fulfillmentEventCreate` IN_TRANSIT | In transit |
| `delivered` | `fulfillmentEventCreate` DELIVERED | Delivered |
| `cancelled` | `orderCancel` (no refund/restock) | Order cancelled |
| `failed` | `fulfillmentEventCreate` FAILURE | Delivery failed |
| `return_collected` | `fulfillmentEventCreate` ATTEMPTED_DELIVERY | Return collected |

**Status:** ⚠️ Likely exists — confirm path and response shape

---

### GDPR

All GDPR endpoints are forwarded from the Shopify Remix app after Shopify HMAC verification. Rekart must return `200` within 5 seconds. Data operations may be async (Shopify allows 30 days).

---

### POST /api/gdpr/customers/data-request _(new)_

> Customer has requested all data held about them. Compile and deliver out-of-band within 30 days.

**Auth:** Scheme B — `X-API-Key`

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shop` | string | ✅ | Merchant `.myshopify.com` domain |
| `payload.customer.id` | integer | ✅ | Shopify customer ID |
| `payload.customer.email` | string | ✅ | Customer email |
| `payload.customer.phone` | string | ✅ | Customer phone in E.164 |
| `payload.orders_requested` | array of integer | ✅ | Shopify order IDs |
| `payload.data_request.id` | integer | ✅ | Shopify data request ID |

**Success Response:** `200 OK` → `{ "received": true }`

**Status:** ❌ Needs to be built

---

### POST /api/gdpr/customers/redact _(new)_

> Customer has requested deletion of personal data. Delete/anonymise all PII within 30 days.

**Auth:** Scheme B — `X-API-Key`

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shop` | string | ✅ | Merchant `.myshopify.com` domain |
| `payload.customer.id` | integer | ✅ | Shopify customer ID |
| `payload.customer.email` | string | ✅ | |
| `payload.customer.phone` | string | ✅ | |
| `payload.orders_to_redact` | array of integer | ✅ | Shopify order IDs to redact |

**Success Response:** `200 OK` → `{ "received": true }`

**Status:** ❌ Needs to be built

---

### POST /api/gdpr/shop/redact _(new)_

> Sent ~48h after uninstall. Purge all data for this shop within 30 days.

**Auth:** Scheme B — `X-API-Key`

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shop` | string | ✅ | Merchant `.myshopify.com` domain |
| `payload.shop_id` | integer | ✅ | Shopify shop ID |
| `payload.shop_domain` | string | ✅ | Merchant `.myshopify.com` domain |

**Success Response:** `200 OK` → `{ "received": true }`

**Status:** ❌ Needs to be built

---

## Webhook Contract

### Rekart → Shopify App (Fulfillment Push)

**⚠️ Rekart has no outbound webhook system. Two implementation options:**

**Option A (Recommended for Phase 1) — Polling by Shopify app**
The FastAPI connector polls Rekart's delivery status endpoint every 15 minutes for pending orders. When status changes to delivered/failed, the Remix app calls Shopify's GraphQL API. See [Polling & Reconciliation](#polling--reconciliation) section.

**Option B — Custom outbound job in Rekart**
Rekart team adds a job that fires when a rider marks delivery complete, calling the Shopify app's fulfillment push endpoint. More real-time but requires backend work.

**Fulfillment push endpoint (Shopify app side — already built):**

`POST /api/fulfillment-push` on the Remix app.
**Auth:** Scheme B — `X-API-Key`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shop_domain` | string | ✅ | Merchant `.myshopify.com` domain |
| `external_order_id` | string | ✅ | Shopify order to update |
| `rekart_delivery_id` | integer | ✅ | Rekart `deli_id` |
| `status` | string | ✅ | `confirmed` \| `packed` \| `ready_to_ship` \| `shipped` \| `delivered` \| `cancelled` \| `failed` \| `return_collected` |
| `occurred_at` | string (ISO 8601) | ✅ | When status changed |
| `tracking.number` | string | ❌ | Tracking number |
| `tracking.url` | string | ❌ | Tracking URL |

**Expected response:** `200 OK` → `{ "success": true }`

**Retry policy (if Rekart implements Option B):** exponential backoff — 30s, 2min, 10min, 1h, 6h (5 attempts max).

---

## Polling & Reconciliation

Since Rekart has no outbound webhooks, the FastAPI connector runs a scheduled reconciliation job.

### Polling Job — Every 15 Minutes

```
For each row in shopify_order_sync WHERE status = 'pending':
  1. Call POST /api/delivery/info with deli_id
  2. Map Rekart DeliveryItem status → Shopify fulfillment action
  3. If status changed:
     a. Call POST /api/fulfillment-push on Remix app
     b. Update shopify_order_sync.status = 'synced' or 'failed'
     c. Log to shopify_sync_logs
  4. If deli_id is null (order not yet scheduled):
     a. Call panel/order/get to check if deli_id is now set
     b. Update shopify_order_sync.rekart_delivery_id
```

### Reconciliation Job — Every 30 Minutes

```
For each row in shopify_order_sync WHERE status = 'failed':
  1. Check retry count — skip if > 5
  2. Re-attempt POST /api/fulfillment-push
  3. Update retry count and last_attempted_at
```

### Backfill Job — On New Install

```
On afterAuth (new merchant install):
  1. Call Shopify REST API: GET /admin/api/2026-04/orders.json?created_at_min=<90_days_ago>
  2. For each order, call panel/order/create (idempotent on external_order_id)
  3. Call Shopify REST API: GET /admin/api/2026-04/customers.json
  4. For each customer, call panel/customer/create (idempotent on phone)
```

---

## Open Items

| Item | Decision Needed | Owner | Priority |
|------|-----------------|-------|----------|
| Delivery status sync method | Option A (polling) or Option B (Rekart outbound job)? Polling is simpler; outbound is more real-time | Rekart Tech + Mithil | P0 |
| `panel/order/create` extension | Does it currently accept `external_source`, `external_order_id`, and a line-items array? What is the exact request shape? | Rohan / Pappu | P0 |
| `panel/customer/create` upsert | Does it upsert on `(client_id, phone)` or throw on duplicate phone? Can we add `shopify_customer_id` field? | Rekart Tech | P0 |
| OAuth 2.0 URL | Pappu confirmed URL is ready — need exact URL, accepted params, and callback format | Pappu | P0 |
| Static API key value | What value should `REKART_STATIC_API_KEY` be set to in production? | Rekart Tech | P0 |
| Delivery info endpoint path | Confirm exact path for polling delivery status — is it `delivery/info`, `delivery/get`, or another path? | Rekart Tech | P1 |
| Slot/plan list endpoint paths | Confirm exact paths for `slot/list` and `plan/list` and their response shapes | Rekart Tech | P1 |
| Product mapping strategy | For one-time orders, how does `product_id` get resolved? Does the merchant pre-configure a default slot? | Rekart Tech + Mithil | P1 |
| New merchant provisioning | Should the app auto-provision a Rekart Client or capture as a lead for sales? | Mithil | P1 |
| Production domain | What is the production host for the Shopify app? Needed for `application_url` in `shopify.app.toml` | Mithil | P1 |
| Default slot for Shopify orders | When a one-time order comes in, which `slot_id` should be used? Should merchants configure a default? | Mithil + Rekart Tech | P2 |
| GDPR data delivery process | For `customers/data_request` — what is Rekart's process for compiling and sending data? | Mithil + Legal | P2 |
| Token encryption at rest | Should `rekartAccessToken` be AES-256 encrypted in the Shopify app's Prisma DB? | Vrushank | P2 |
| Phase 2 bidirectional sync | When customer pauses via WhatsApp bot, how does the Shopify subscription contract get updated? | Rekart Tech + Vrushank | P3 |

---

## Changelog

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| v0.1 | 2026-06-16 | Vrushank Kavimandan | Initial draft. 16 endpoints specified. |
| v0.2 | 2026-06-16 | Vrushank Kavimandan | Major revision based on Rekart Platform Capabilities document. Key changes: (1) No outbound webhooks → added polling strategy; (2) Orders map to existing `Order` model with `external_source="shopify"`; (3) Customers map to `User` keyed by `(client_id, phone)`; (4) Subscriptions require `slot_id`/`plan_id`/`pattern_data`; (5) Auth token is Laravel Passport opaque, not JWT; (6) POST convention for all Rekart reads; (7) Added slots and plans endpoints for Phase 2; (8) Corrected `panel/order/create` and `panel/customer/create` as existing endpoints to extend; (9) Added polling reconciliation section; (10) Updated open items with new questions from capabilities analysis. |
