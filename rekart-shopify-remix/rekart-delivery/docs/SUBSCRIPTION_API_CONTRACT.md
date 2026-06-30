# Subscription API Contract — Rekart × Shopify
**Version:** 0.1  
**Date:** June 2026  
**Author:** Abmiro (Vrushank)  
**Status:** Draft — pending Pappu's review and confirmation

---

## Overview

This document defines all API endpoints the Rekart Laravel backend must expose for the Shopify app to support:
1. Creating subscriptions from Shopify orders
2. Customer subscription management (pause, resume, cancel, modify, skip)
3. Merchant subscription overview in Shopify admin
4. Real-time subscription status updates back to Shopify
5. Customer wallet management (balance, top-up, transaction history)
6. Delivery history per customer

---

## Endpoint Hosts

| Endpoint Type | Host | Example |
|---|---|---|
| Rekart backend endpoints (sections 1-7, 9, 10) | Rekart Laravel backend | `https://dev3.rekart.io` (staging) / `https://app.rekart.io` (prod) |
| Shopify app endpoints (section 8) | Remix app | `https://staging.shopify.rekart.io` (staging) / `https://shopify.rekart.io` (prod) |

These are two different servers. Do not confuse them.

---

## Authentication

All endpoints use the shared static API key:
```
X-API-Key: <REKART_STATIC_API_KEY>
```

Same key used for existing product-mapping and fulfillment-push endpoints.

---

## Base URLs
| Environment | URL |
|---|---|
| Staging | https://dev3.rekart.io |
| Production | https://app.rekart.io |

---

## 1. Create Subscription

**Called when:** Customer places a Shopify order with `rekart_purchase_type: "subscribe"` in line item properties.

```
POST /api/integrations/shopify/subscription/create
X-API-Key: <REKART_STATIC_API_KEY>
```

**Request:**
```json
{
  "shop_domain": "trulydesi.myshopify.com",
  "external_order_id": "6988011929918",
  "shopify_customer_id": "9667673555262",
  "customer": {
    "first_name": "Vrushank",
    "last_name": "Kavimandan",
    "email": "vrushank@example.com",
    "phone": "+919876543210"
  },
  "address": {
    "address1": "I-803, Vasant Vihar Towers, Baner",
    "address2": "Near Pune University",
    "city": "Pune",
    "province": "Maharashtra",
    "zip": "411045",
    "country": "India",
    "country_code": "IN",
    "latitude": 18.5204,
    "longitude": 73.8567
  },
  "subscription": {
    "rekart_product_id": 4710,
    "shopify_variant_id": "53725726507326",
    "plan_id": 5,
    "plan_name": "Prepaid Plan",
    "pattern": "daily",
    "pattern_data": {
      "type": "daily",
      "mon": 1, "tue": 1, "wed": 1,
      "thu": 1, "fri": 1, "sat": 1, "sun": 1
    },
    "quantity_per_delivery": 1,
    "start_date": "2026-06-27",
    "instructions": ["keep_in_bag", "hand_delivery"]
  }
}
```

**Response (success):**
```json
{
  "success": true,
  "subscription_id": 78432,
  "customer_id": 351463,
  "address_id": 99021,
  "status": "active",
  "next_delivery_date": "2026-06-27"
}
```

**Response (error):**
```json
{
  "success": false,
  "error": "PRODUCT_NOT_FOUND",
  "message": "Product 4710 not found in catalog"
}
```

**Pattern data format by pattern type:**

| Pattern | pattern_data |
|---|---|
| daily | `{"type":"daily","mon":1,"tue":1,"wed":1,"thu":1,"fri":1,"sat":1,"sun":1}` |
| alternate | `{"type":"alternate","first":1,"second":0}` |
| weekly | `{"type":"weekly","days":{"mon":1,"wed":1,"fri":1},"qty_per_day":{"mon":2,"wed":1,"fri":1}}` |
| nth_day | `{"type":"nth_day","interval":3}` |

---

## 2. List Customer Subscriptions

**Called when:** Customer opens "My Subscriptions" in Shopify customer account.

```
GET /api/integrations/shopify/subscription/list
X-API-Key: <REKART_STATIC_API_KEY>
```

**Query params:**
```
shop_domain=trulydesi.myshopify.com
shopify_customer_id=9667673555262
```

**Response:**
```json
{
  "subscriptions": [
    {
      "subscription_id": 78432,
      "product_id": 4710,
      "product_name": "Cow Milk 500ml",
      "product_image": "https://...",
      "plan_id": 5,
      "plan_name": "Prepaid Plan",
      "status": "active",
      "pattern": "daily",
      "pattern_display": "Daily",
      "quantity_per_delivery": 1,
      "unit": "litre",
      "price_per_unit": 43,
      "currency": "INR",
      "currency_symbol": "₹",
      "start_date": "2026-06-27",
      "next_delivery_date": "2026-06-27",
      "end_date": "2026-09-27",
      "total_deliveries": 92,
      "completed_deliveries": 5,
      "instructions": ["keep_in_bag"]
    }
  ],
  "total": 1
}
```

---

## 3. Pause Subscription

**Called when:** Customer clicks "Pause" in Shopify customer account.

```
POST /api/integrations/shopify/subscription/pause
X-API-Key: <REKART_STATIC_API_KEY>
```

**Request:**
```json
{
  "shop_domain": "trulydesi.myshopify.com",
  "shopify_customer_id": "9667673555262",
  "subscription_id": 78432,
  "pause_until": "2026-07-15"
}
```

**Response:**
```json
{
  "success": true,
  "subscription_id": 78432,
  "status": "paused",
  "paused_until": "2026-07-15",
  "resume_date": "2026-07-15"
}
```

---

## 4. Resume Subscription

**Called when:** Customer clicks "Resume" in Shopify customer account.

```
POST /api/integrations/shopify/subscription/resume
X-API-Key: <REKART_STATIC_API_KEY>
```

**Request:**
```json
{
  "shop_domain": "trulydesi.myshopify.com",
  "shopify_customer_id": "9667673555262",
  "subscription_id": 78432,
  "resume_date": "2026-07-15"
}
```

**Response:**
```json
{
  "success": true,
  "subscription_id": 78432,
  "status": "active",
  "next_delivery_date": "2026-07-15"
}
```

---

## 5. Cancel Subscription

**Called when:** Customer clicks "Cancel" in Shopify customer account.

```
POST /api/integrations/shopify/subscription/cancel
X-API-Key: <REKART_STATIC_API_KEY>
```

**Request:**
```json
{
  "shop_domain": "trulydesi.myshopify.com",
  "shopify_customer_id": "9667673555262",
  "subscription_id": 78432,
  "reason": "no_longer_needed",
  "cancelled_at": "2026-06-26T10:00:00+05:30"
}
```

**Response:**
```json
{
  "success": true,
  "subscription_id": 78432,
  "status": "cancelled",
  "cancelled_at": "2026-06-26T10:00:00+05:30"
}
```

---

## 6. Update Subscription

**Called when:** Customer changes quantity, pattern, or delivery instructions.

```
POST /api/integrations/shopify/subscription/update
X-API-Key: <REKART_STATIC_API_KEY>
```

**Request:**
```json
{
  "shop_domain": "trulydesi.myshopify.com",
  "shopify_customer_id": "9667673555262",
  "subscription_id": 78432,
  "updates": {
    "quantity_per_delivery": 2,
    "pattern": "alternate",
    "pattern_data": { "type": "alternate", "first": 1, "second": 0 },
    "instructions": ["hand_delivery"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "subscription_id": 78432,
  "updated_fields": ["quantity_per_delivery", "pattern"]
}
```

---

## 7. Skip Next Delivery

**Called when:** Customer wants to skip tomorrow's delivery.

```
POST /api/integrations/shopify/subscription/skip
X-API-Key: <REKART_STATIC_API_KEY>
```

**Request:**
```json
{
  "shop_domain": "trulydesi.myshopify.com",
  "shopify_customer_id": "9667673555262",
  "subscription_id": 78432,
  "skip_date": "2026-06-27"
}
```

**Response:**
```json
{
  "success": true,
  "subscription_id": 78432,
  "skipped_date": "2026-06-27",
  "next_delivery_date": "2026-06-28"
}
```

---

## 8. Subscription Status Push (Rekart → Shopify)

⚠️ **Note: This requires new app-side work — not yet built.**

When Rekart updates a subscription status from their side, they should call our fulfillment push endpoint with new subscription-specific statuses. These statuses do not currently exist in our endpoint and will need to be added.

**Proposed endpoint (requires app changes):**
```
POST https://<SHOPIFY_APP_URL>/api/fulfillment-push
X-API-Key: <REKART_STATIC_API_KEY>
```

Note: `<SHOPIFY_APP_URL>` is the Remix app URL (e.g. `https://shopify.rekart.io`) — NOT the Rekart Laravel backend URL.

**Proposed payload:**
```json
{
  "provider": "shopify",
  "shop_domain": "trulydesi.myshopify.com",
  "external_order_id": "6988011929918",
  "rekart_delivery_id": "17140614",
  "subscription_id": 78432,
  "status": "subscription_paused"
}
```

**Proposed new status values (not yet accepted — needs app update):**
| Status | What will happen on Shopify |
|---|---|
| `subscription_created` | Tag order with "rekart-subscription-active" |
| `subscription_paused` | Tag order with "rekart-subscription-paused" |
| `subscription_resumed` | Tag order with "rekart-subscription-active" |
| `subscription_cancelled` | Tag order with "rekart-subscription-cancelled" |

**App-side work needed:**
- Add subscription statuses to `REKART_STATUSES`
- Accept `subscription_id` field in push schema
- Implement order tagging via Shopify Admin GraphQL

---

## 9. Merchant Subscription List (for Shopify Admin)

**Called when:** Merchant opens subscription management in Shopify admin app.

```
GET /api/integrations/shopify/subscriptions
X-API-Key: <REKART_STATIC_API_KEY>
```

**Query params:**
```
shop_domain=trulydesi.myshopify.com
status=active
page=1
per_page=20
```

**Response:**
```json
{
  "subscriptions": [...],
  "total": 150,
  "page": 1,
  "per_page": 20
}
```

---

## 10. Wallet Balance

**Called when:** Customer opens "My Account" in Shopify customer account.

```
GET /api/integrations/shopify/wallet/balance
X-API-Key: <REKART_STATIC_API_KEY>
```

**Query params:**
```
shop_domain=trulydesi.myshopify.com
shopify_customer_id=9667673555262
```

**Response:**
```json
{
  "balance": 342.50,
  "currency": "INR",
  "currency_symbol": "₹",
  "estimated_days_remaining": 8,
  "low_balance_threshold": 100,
  "is_low_balance": false
}
```

---

## 11. Wallet Transactions

**Called when:** Customer views transaction history.

```
GET /api/integrations/shopify/wallet/transactions
X-API-Key: <REKART_STATIC_API_KEY>
```

**Query params:**
```
shop_domain=trulydesi.myshopify.com
shopify_customer_id=9667673555262
page=1
per_page=20
```

**Response:**
```json
{
  "transactions": [
    {
      "id": 12345,
      "type": "credit",
      "amount": 500.00,
      "description": "Wallet top-up via Shopify",
      "date": "2026-06-26T10:00:00+05:30",
      "balance_after": 842.50
    },
    {
      "id": 12344,
      "type": "debit",
      "amount": 43.00,
      "description": "Cow Milk 500ml — Daily delivery",
      "date": "2026-06-26T06:00:00+05:30",
      "balance_after": 342.50,
      "delivery_id": 17140614,
      "invoice_url": "https://rekart.io/invoices/12344"
    }
  ],
  "total": 45,
  "page": 1,
  "per_page": 20
}
```

---

## 12. Wallet Top-Up

**Called when:** Customer completes a wallet top-up order on Shopify.

This is called by our app's `orders/create` handler when it detects a wallet top-up order (identified by a special product tag or SKU).

```
POST /api/integrations/shopify/wallet/topup
X-API-Key: <REKART_STATIC_API_KEY>
```

**Request:**
```json
{
  "shop_domain": "trulydesi.myshopify.com",
  "shopify_customer_id": "9667673555262",
  "shopify_order_id": "6988011929918",
  "amount": 500.00,
  "currency": "INR",
  "payment_method": "razorpay",
  "transaction_id": "pay_ABC123"
}
```

**Response:**
```json
{
  "success": true,
  "wallet_balance": 842.50,
  "transaction_id": 12345,
  "credited_amount": 500.00
}
```

---

## 13. Delivery History (Customer)

**Called when:** Customer views their delivery history in Shopify customer account.

```
GET /api/integrations/shopify/deliveries
X-API-Key: <REKART_STATIC_API_KEY>
```

**Query params:**
```
shop_domain=trulydesi.myshopify.com
shopify_customer_id=9667673555262
page=1
per_page=20
subscription_id=78432
```

**Response:**
```json
{
  "deliveries": [
    {
      "delivery_id": 17140614,
      "subscription_id": 78432,
      "product_name": "Cow Milk 500ml",
      "product_image": "https://...",
      "quantity": 1,
      "unit": "litre",
      "amount_charged": 43.00,
      "status": "delivered",
      "delivery_date": "2026-06-26",
      "delivered_at": "2026-06-26T06:30:00+05:30",
      "invoice_url": "https://rekart.io/invoices/17140614"
    }
  ],
  "total": 92,
  "page": 1,
  "per_page": 20
}
```

---

## 14. Wallet Top-Up Product (Shopify side)

We will create a special product in Shopify called "Rekart Wallet Top-Up" with variants for different amounts:

| Variant | Price | SKU |
|---|---|---|
| ₹500 | ₹500 | REKART-WALLET-500 |
| ₹1,000 | ₹1,000 | REKART-WALLET-1000 |
| ₹2,000 | ₹2,000 | REKART-WALLET-2000 |
| ₹5,000 | ₹5,000 | REKART-WALLET-5000 |

Our `orders/create` webhook handler detects this product by SKU prefix `REKART-WALLET-` and calls endpoint 12 (Wallet Top-Up) instead of the normal order flow.

**Questions for Pappu:**
- Should custom amounts be supported?
- What is the minimum top-up amount?
- What is the maximum top-up amount?

---

## 15. Catalog Updates Required

Pappu to add to `GET /api/integrations/shopify/catalog`:

```json
{
  "settings": {
    "allow_alternate_day": true,
    "allow_weekly": true,
    "allow_nth_day": false
  },
  "plans": [
    {
      "plan_id": 5,
      "name": "Prepaid Plan",
      "plan_type": "prepaid",
      "units": 30,
      "discount_percentage": 4,
      "price_per_unit": 43,
      "original_price": 45,
      "validity_days": 30
    }
  ]
}
```

---

## Open Questions for Pappu

1. Do endpoints 2-7 already exist in the Laravel backend or need to be built?
2. Is `shopify_customer_id` enough to look up the Rekart customer or do we need email too?
3. For endpoint 1 (create subscription) — do you create the customer and address internally, or do we need to send a separate customer create call first?
4. What are the valid `reason` values for subscription cancellation?
5. For weekly pattern — does Rekart support different quantities per day (e.g. 2 litres on Monday, 1 litre on Wednesday)?
6. For nth_day pattern — what is the exact `pattern_data` format you expect?
7. Can a customer have multiple active subscriptions for the same product?
8. What is the maximum `pause_until` duration?
9. Do you send a webhook/push when Rekart automatically resumes a paused subscription?
10. For §8 (status push back to Shopify) — should we extend the existing `/api/fulfillment-push` endpoint with new subscription statuses, or create a separate `/api/subscription-push` endpoint?
11. What is the exact format of `rekart_delivery_id` — string or integer? Please use string consistently.
12. For §8 — at what point does Rekart call the status push? Immediately on status change, or batched?
13. Wallet — does `GET /api/integrations/shopify/wallet/balance` already exist?
14. Wallet transactions — does `/wallet/transactions` exist?
15. Wallet top-up — does `/wallet/topup` exist? What fields does it expect?
16. Delivery history — does `/deliveries` exist for customer-level queries?
17. For wallet top-up via Shopify — should we use a special product with fixed variants (₹500/₹1000/₹2000/₹5000) or let customers enter a custom amount?
18. What is the minimum and maximum wallet top-up amount?
19. When wallet balance is low — does Rekart send a push notification/webhook to us so we can notify the customer in Shopify?
20. For pack purchases (e.g. High Protein Milk ₹7,500) — does Shopify payment automatically credit the wallet or does Pappu need a separate signal?

---

## Implementation Priority

| Endpoint | Priority | Needed For |
|---|---|---|
| 1. Create Subscription | P0 | Theme extension checkout flow |
| 15. Catalog settings + plans | P0 | Theme extension UI |
| 2. List Subscriptions | P1 | Customer account portal |
| 3. Pause | P1 | Customer account portal |
| 4. Resume | P1 | Customer account portal |
| 5. Cancel | P1 | Customer account portal |
| 6. Update | P1 | Customer account portal |
| 7. Skip Delivery | P2 | Nice to have |
| 8. Status Push | P2 | Shopify order tagging |
| 9. Merchant List | P2 | Admin subscription management |
| 10. Wallet Balance | P1 | Customer Account Extension |
| 11. Wallet Transactions | P1 | Customer Account Extension |
| 12. Wallet Top-Up | P1 | Wallet recharge via Shopify |
| 13. Delivery History | P1 | Customer Account Extension |
| 14. Wallet Top-Up Product | P1 | Shopify side — we create this |
