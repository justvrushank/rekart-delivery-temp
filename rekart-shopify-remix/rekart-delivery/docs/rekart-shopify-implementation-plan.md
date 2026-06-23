# Rekart Shopify Connector — Final Implementation Plan

**Version:** v0.2
**Date:** 2026-06-16
**Status:** 🟡 In Progress
**Repo:** github.com/Rekart-io/rekart-delivery

---

## Project Objective

Build and publish a public Shopify app ("Rekart Delivery") that connects Shopify merchants to the Rekart local delivery platform. The app syncs orders and customers from Shopify into Rekart, pushes delivery status back to Shopify order timelines, and qualifies new merchants as sales leads.

---

## Definition of Done

- ✅ App live and publicly listed on the Shopify App Store
- ✅ Merchant installs app, connects Rekart account, Shopify order appears in Rekart within 60 seconds
- ✅ Rider marks delivery complete → Shopify order timeline updates within 20 minutes
- ✅ All 3 GDPR webhooks return 200 and trigger data operations in Rekart
- ✅ Multi-tenant data isolation: shop_domain → client_id mapping is strictly enforced
- ✅ Cross-tenant credential mismatch is detected and rejected

---

## Critical Architecture Decisions (Final)

### 1. Webhook Routing

**Shopify fires webhooks directly to Rekart backend** for high-volume data events. Remix app is NOT in the middle for these:

```
orders/create       → ${REKART_BACKEND_URL}/webhooks/shopify/orders/create
customers/create    → ${REKART_BACKEND_URL}/webhooks/shopify/customers/create
customers/update    → ${REKART_BACKEND_URL}/webhooks/shopify/customers/update
```

**Remix app handles lifecycle + compliance webhooks:**
```
app/uninstalled     → Remix → clears credentials → forwards to Rekart
app/scopes_update   → Remix only
GDPR × 3            → Remix → durable queue → forwards to Rekart
```

### 2. HMAC Verification (Critical for Pappu)

**One `SHOPIFY_API_SECRET` for the entire app** — same value regardless of how many merchants install it.

- Shopify signs every webhook using this secret (HMAC-SHA256 of raw body)
- The secret never travels over the network — only the HMAC hash does
- Rekart backend verifies the hash using their copy of the secret
- Secret is shared with Pappu out-of-band (WhatsApp/Signal), stored in Rekart's secrets manager (NOT `.env`)

```
Verification flow:
Shopify fires: POST /webhooks/shopify/orders/create
  Header: X-Shopify-Hmac-Sha256: <hash>
  Header: X-Shopify-Shop-Domain: truly-desi.myshopify.com
  Body: { order data }

Rekart backend:
  expected = base64(SHA256(raw_body + SHOPIFY_API_SECRET))
  if expected == header → genuine → process
  if not → reject 401
```

### 3. Multi-Tenant Isolation (Critical)

Rekart is multi-tenant. Each Shopify webhook identifies the merchant via `X-Shopify-Shop-Domain` header. Rekart backend must maintain a `shopify_shops` table:

```
shopify_shops:
| shop_domain                  | client_id | shopify_access_token |
|------------------------------|-----------|----------------------|
| truly-desi.myshopify.com     | 140       | shpat_aaaaaa         |
| fresh-dairy.myshopify.com    | 141       | shpat_bbbbbb         |
```

**On every webhook:**
1. Verify HMAC using single `SHOPIFY_API_SECRET`
2. Read `X-Shopify-Shop-Domain`
3. Look up `client_id` from `shopify_shops` table
4. Process order/customer under that `client_id`

### 4. Cross-Tenant Security

When a merchant connects their Rekart account via the Shopify app, enforce that `shop_domain → client_id` is a fixed 1:1 mapping:

**On our side (Remix app) — ✅ Built in `app/routes/app.connect-rekart.tsx`:**
```typescript
// If merchant already linked, verify same client_id
const existingOnboarding = await db.shopOnboarding.findUnique({
  where: { shop: session.shop },
  select: { rekartMerchantId: true },
});

if (existingOnboarding?.rekartMerchantId &&
    existingOnboarding.rekartMerchantId !== result.clientId) {
  return data({
    error: "These credentials belong to a different Rekart account. " +
           "Please use your original Rekart credentials to reconnect."
  }, { status: 403 });
}
```

**On Rekart's side (open — Pappu):**
- Once `shop_domain` is mapped to `client_id`, reject any attempt to remap it to a different `client_id`
- This prevents Truly Desi from accidentally (or maliciously) routing their orders to Fresh Dairy's account

### 5. Authentication Per Request Type

| Request Type | Auth Method | Key |
|---|---|---|
| Shopify → Rekart webhook | HMAC verification | `SHOPIFY_API_SECRET` (shared, verified locally) |
| Remix app → Shopify Admin API | Session token | Per-merchant `shpat_xxx` token |
| Remix app → Rekart panel endpoints | Bearer token | Per-merchant encrypted `rekartAccessToken` |
| Rekart → Remix fulfillment push | Static API key | `REKART_STATIC_API_KEY` (header: `X-API-Key`) |
| Remix → Rekart stats/GDPR | Static API key | `REKART_STATIC_API_KEY` (header: `X-API-Key`) |

### 6. Token Storage (Final)

The Rekart Passport Bearer token obtained after merchant login is:
- **Never stored in Shopify session** (Shopify session = Shopify auth only)
- **Never sent to the browser** (stays server-side only)
- **Stored encrypted** in `ShopOnboarding.rekartAccessToken` using AES-256-GCM
- **Decrypted server-side only** when making Rekart panel API calls
- **Scoped per shop** in `ShopOnboarding` table (one row per `shop_domain`)

### 7. Delivery Status Sync

Rekart has **no outbound webhooks**. Polling is the only option:
- A scheduled job polls `delivery/info` every 15 minutes
- Status changes trigger `POST /api/fulfillment-push` on Remix app
- Remix calls Shopify GraphQL `fulfillmentEventCreate`

(Where this job runs — Rekart's backend vs a scheduled hit to the Remix sweep endpoint — is an open decision; see Open Items and the Phase 1 architecture note.)

---

## Team & Responsibilities

| Role | Team | Responsibilities |
|------|------|-----------------|
| Shopify App Dev | Vrushank | Remix app, webhooks, UI, App Store submission |
| Rekart Backend Dev | Pappu / Rohan | HMAC verification endpoint, panel/order/create extension, customer/address creation, shopify_shops table, OAuth 2.0, GDPR handlers, stats endpoint, polling/outbound |
| Product Owner | Mithil | Phase gate sign-off, provisioning decisions, $19 fee, production domain |
| DevOps | Rekart Tech | MySQL RDS, Redis, production deployment, secrets manager |

---

## What Pappu Needs to Build (Backend Checklist)

### P0 — Needed Before Phase 3 Can Start

| Task | Details |
|------|---------|
| `shopify_shops` table | `shop_domain → client_id` mapping, 1:1 enforced |
| Register shop endpoint | Called by our app after merchant links account: `POST /api/shopify/shops/register` with `{ shop_domain, client_id, shopify_access_token }` |
| `POST /webhooks/shopify/orders/create` | HMAC verified, reads `X-Shopify-Shop-Domain`, looks up `client_id`, calls `panel/order/create` |
| `POST /webhooks/shopify/customers/create` | Same pattern, calls `panel/customer/create` |
| `POST /webhooks/shopify/customers/update` | Same pattern, upserts customer |
| Confirm `panel/order/create` shape | Does it accept `external_source`, `external_order_id`, `items[]`? |
| Confirm `panel/customer/create` upsert | Does it upsert on `(client_id, phone)` or throw on duplicate? |
| Address creation endpoint | Path, required fields, does it need `zone_id`? Returns `address_id`? |
| Cross-tenant enforcement | Reject remapping `shop_domain` to different `client_id` |

### P1 — Needed for Full Flow

| Task | Details |
|------|---------|
| `GET /api/shops/{shop}/stats` | Returns `{ ordersSynced, customersSynced, lastSyncedAt, connected }` within 2500ms |
| `POST /api/delivery/info` | Returns delivery status for polling job |
| `DeliveryItem.status` enum | What values mean delivered vs failed? |
| GDPR handlers × 3 | data-request, customers/redact, shop/redact |

### P2 — OAuth 2.0 (Replaces Password Login)

| Task | Details |
|------|---------|
| `GET /api/oauth/authorize` | Rekart login page, accepts `client_id`, `redirect_uri`, `state`, `shop` |
| `POST /api/oauth/token` | Exchanges code for Passport token, returns `{ access_token, client_id, expires_in }` |
| OAuth `client_id` + `client_secret` | Credentials for our Shopify app |

---

## Phase Status

| Phase | Name | Status |
|-------|------|--------|
| 0 | Setup & Alignment | ✅ Complete |
| 1 | Core Infrastructure | ✅ Complete |
| 2 | Onboarding Flow | 🟡 95% — OAuth pending |
| 3 | Order & Customer Sync | 🔴 Blocked on Pappu — schema prep complete (ShopifyOrderSync, ShopifyCustomerSync, rekartOAuthState, Session index all migrated via phase3_schema_prep) |
| 4 | Product Mapping | 🟡 Scaffold built |
| 5 | Fulfillment Push | ✅ Complete |
| 6 | Dashboard & Sync Log | ✅ Complete |
| 7 | QA & App Store Prep | 🔴 After Phase 3 |
| 8 | Launch & Post-Launch | 🔴 After Phase 7 |

---

## Phase 0 — Setup & Alignment ✅

All done. Key items:
- Dev store: `rekart-dev-kysqlw9f.myshopify.com`
- App Client ID: `954401100dd738ee168c9ebb21ae2e89`
- API secret rotated (old one was exposed in chat)
- Protected Customer Data: 16/16 questions complete
- Subscription APIs: approved
- Repo: `Rekart-io/rekart-delivery`
- MySQL migration: SQLite → MySQL complete
- `ENCRYPTION_KEY`: generate with `openssl rand -hex 32` → add to `.env`

**Action still needed:**
- DevOps: provision MySQL 8.0+, share connection string
- DevOps: provision Redis
- Run `npx prisma migrate deploy` on production MySQL
- Share `SHOPIFY_API_SECRET` with Pappu out-of-band (WhatsApp, not email)

---

## Developer Setup Notes

- **Migrations are generated offline** via `prisma migrate diff` (no live MySQL is wired in dev). Apply with: `npx prisma migrate deploy`. Do **NOT** use `prisma migrate dev` — it hangs/fails without a live database connection.
- **`ENCRYPTION_KEY` must be set in `.env` before merchant login.** Generate: `openssl rand -hex 32`. The `connect-rekart` action throws immediately if it is missing (encryption of the access token happens inline).
- **`s-app-nav` links in `app.tsx` keep `href` by design.** The App Bridge nav menu requires `href` to build the embedded admin navigation. Do **not** convert them to `useNavigate` or the nav breaks. (In-content buttons elsewhere DO use `useNavigate`.)
- **`fetchSyncStats` returns `null` for an unreachable backend** (not a zeroed shape), so the dashboard can show the "Unreachable" state. A 401 returns `{ tokenInvalid: true }`; a successful read returns `{ tokenInvalid: false }`.
- **`minutesToTime` lives in `app/slot-time.ts`** (pure, client/test-safe) and is re-exported from `rekart.server.ts`. The split exists because importing `rekart.server` in a test/component pulls in Prisma (and fails without `DATABASE_URL`).

---

## Phase 1 — Core Infrastructure ✅

All done:
- OAuth install flow with embedded param preservation
- Prisma schema: Session, ShopOnboarding, FulfillmentPush, FulfillmentLink, GdprRequest, ShopifyProductLink (plus Phase 3 prep: ShopifyOrderSync, ShopifyCustomerSync)
- `app/uninstalled` → clears session + credentials (rekartAccessToken, rekartMerchantId)
- `app/scopes_update` → updates session scopes
- GDPR × 3 → durable queue (GdprRequest table), retry up to 10 times, marks failed at cap
- Token encryption: AES-256-GCM, `ivHex:authTagHex:cipherHex`
- Token migration script: `scripts/migrate-tokens.ts` with `--dry-run` flag

**IMPORTANT:** `rekart-backend/` is a FastAPI **reference spec** for the Rekart Laravel team to port to their existing backend. It is **NOT** a deployed service. The Remix app is the only deployed connector. The polling job described in Phase 5 will live in Rekart's backend or as a scheduled task — this is an open decision (see Open Items).

---

## Phase 2 — Onboarding Flow 🟡

**Complete:**
- Yes/No fork: "Do you already use Rekart?" as first question
- Yes → `connect-rekart` (existing client)
- No → `pending-setup` (new merchant lead capture with qualification form)
- Rekart account link via `POST /api/auth/login` (interim password login)
- Cross-tenant protection: if `rekartMerchantId` already set, verify new login returns same `client_id` — returns 403 if mismatch
- Token stored: encrypted `rekartAccessToken` + `rekartMerchantId` + `rekartTokenExpiresAt`
- Token expiry warning: 24h before expiry banner shown
- Token revocation: 401 from Rekart → `tokenInvalid` banner → reconnect CTA
- Slot picker in Settings: calls `slot/list`, merchant picks default delivery slot
- Dashboard gate: onboarding → connect → dashboard (3-way fork)
- Settings: "Disconnect Rekart account" vs "Stop syncing" as distinct actions

**Pending:**
- OAuth 2.0 flow (waiting on Pappu — Q5)
- New merchant provisioning API (waiting on Mithil decision)

**OAuth 2.0 Implementation (when Pappu provides URL):**

What changes:
1. `app.connect-rekart.tsx` → replace form with "Connect with Rekart" button that redirects to Rekart OAuth URL
2. New route `app.rekart-callback.tsx` → receives code, verifies state nonce, exchanges for token
3. `rekart.server.ts` → replace `loginToRekart(u,p)` with `exchangeRekartCode(code)`
4. `rekartOAuthState String?` already added to ShopOnboarding for CSRF nonce

The DB write block on success is identical — reuse verbatim (including the cross-tenant client_id check).

---

## Phase 3 — Order & Customer Sync 🔴

**The 4-step order sync flow:**

```
Shopify fires orders/create → REKART_BACKEND_URL/webhooks/shopify/orders/create
        ↓
Rekart backend verifies HMAC using SHOPIFY_API_SECRET
        ↓
Rekart reads X-Shopify-Shop-Domain → looks up client_id in shopify_shops table
        ↓
Step 1: Find/create customer
  POST panel/customer/create (name, phone, email)
  Returns: rekart_user_id
        ↓
Step 2: Create delivery address
  POST user/{rekart_user_id}/address/add (street, city, pincode, zone_id?)
  Returns: address_id
        ↓
Step 3: Create order
  POST panel/order/create
  {
    id: rekart_user_id,
    address_id: address_id,
    slot_id: merchant's configured defaultSlotId,
    external_source: "shopify",
    external_order_id: shopify_order_id,
    payment_type: "online",
    payment_status: "paid",
    amount: "170.00",
    items: [{ product_id, quantity, rate }]
  }
  Returns: order_id, deli_id
        ↓
Step 4: Store mapping
  shopify_order_sync: shopify_order_id → rekart_order_id
```

**Edge cases to handle:**
- Shopify customer has no phone number → log `MISSING_PHONE`, skip sync, show in Sync Log
- `panel/customer/create` duplicate phone → upsert, not error (confirm with Pappu)
- `zone_id` required for address → either pincode lookup or skip (confirm with Pappu)
- Duplicate order webhook (Shopify delivers at-least-once) → deduplicate on `external_order_id`
- Cross-tenant: if `shop_domain` not in `shopify_shops` table → reject with 404

**Schema (already migrated via `phase3_schema_prep`):**

```prisma
model ShopifyOrderSync {
  id             String    @id @default(cuid())
  shop           String
  shopifyOrderId String
  rekartOrderId  String?
  status         String    @default("pending")
  attempts       Int       @default(0)
  lastError      String?   @db.Text
  nextAttemptAt  DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@unique([shop, shopifyOrderId])
  @@index([status, nextAttemptAt])
  @@index([shop, createdAt])
}

model ShopifyCustomerSync {
  id                String   @id @default(cuid())
  shop              String
  shopifyCustomerId String
  rekartUserId      String?
  rekartAddressId   String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([shop, shopifyCustomerId])
  @@index([shop])
}
```

**Also on ShopOnboarding (migrated):**
```prisma
rekartOAuthState String?   // CSRF nonce for OAuth 2.0
```

**Session table (migrated):**
```prisma
@@index([shop])  // prevents full table scan on every embedded page load
```

---

## Phase 4 — Product Mapping 🟡

**Built:**
- `ShopifyProductLink` Prisma model
- Auto-match: exact name → exact SKU → fuzzy (Levenshtein ≤ 3) → none
- Scale guard: fuzzy skipped if >500 variants or >100 products
- Product mapping screen with Shopify GraphQL fetch
- Zod validation on mapping save

**Important constraint:**
Rekart has **no SKU model** → SKU matching will never fire. Name matching is the primary auto-match strategy. Document this to merchants.

**Pending:**
- Live Rekart product catalog (`panel/product/list` response shape unconfirmed; code already assumes a `{ products: [...] }` shape)
- Screen shows placeholder until catalog loads from Rekart

---

## Phase 5 — Fulfillment Push ✅

All done:
- `POST /api/fulfillment-push` with `X-API-Key` auth + Zod validation
- Shopify GraphQL `fulfillmentCreate` + `fulfillmentEventCreate`
- Status mapping: `delivery_scheduled / out_for_delivery / delivered / failed / return_collected`
- `FulfillmentLink` cache (no duplicate fulfillments per order)
- Retry queue: 6 attempts, exponential backoff, `dead` terminal state
- `POST /api/fulfillment-retry-sweep` (authenticated, also sweeps GDPR)
- Sync error banner on dashboard when last push is `dead`

**Polling job (to build once `delivery/info` path is confirmed — runs on Rekart's backend or as a scheduled hit to the Remix sweep endpoint):**
```
Every 15 minutes:
For each ShopifyOrderSync WHERE status = 'pending':
  1. POST delivery/info with deli_id
  2. Map DeliveryItem.status → Shopify fulfillment action
  3. If status changed → POST /api/fulfillment-push on Remix
  4. Update ShopifyOrderSync.status
```

---

## Phase 6 — Dashboard & Sync Log ✅

All done:
- Stats from Rekart with 2500ms timeout + graceful fallback
- Banner priority order: tokenInvalid → tokenExpiringSoon → needsSlot → syncError
- Token expiry warning (24h before)
- Token revocation detection (401 → reconnect banner)
- No default slot banner (links to Settings slot picker)
- Sync Log with filter + retry button
- Empty states and loading skeletons

**Note:** Stats endpoint `GET /api/shops/{shop}/stats` still needs Rekart backend to build. Dashboard shows "Unreachable" until then.

---

## Phase 7 — QA & App Store Prep 🔴

**Pre-conditions before starting:**
- [ ] Phase 3 complete and end-to-end tested
- [x] `s-button href` → `useNavigate` fix applied (App Review blocker) ✅
- [x] `Session @@index([shop])` added ✅
- [ ] Phase 3 schema migration deployed

**Review checklist (current status):**

| Item | Status |
|------|--------|
| Privacy policy URL linked | ✅ Done |
| Support URL linked | ✅ Done |
| app/uninstalled clears credentials | ✅ Done |
| app/scopes_update handled | ✅ Done |
| GDPR × 3 return 200 + durable queue | ✅ Done |
| No data retained after uninstall | ✅ Done |
| App Bridge navigation (s-button fix) | ✅ Done — in-content nav uses `useNavigate`. NOTE: `s-app-nav` links in `app.tsx` intentionally keep `href` — App Bridge nav menu requires `href`, do not convert to `useNavigate`. |
| Polaris components only | ✅ Done |
| No console errors | 🔴 Live browser check needed |
| App loads under 3 seconds | 🔴 Lighthouse audit needed |
| All webhooks HMAC-verified | ✅ Done |
| Cross-tenant isolation enforced | 🟡 Our side built (403 on client_id mismatch); full enforcement needs Rekart `shopify_shops` 1:1 (Phase 3) |

**QA tasks:**
- GDPR webhook tests via `shopify webhook trigger --topic customers/data_request`
- Reinstall loop test × 3 (uninstall → reinstall, confirm no login loop)
- Lighthouse audit on all 4 screens
- DevTools console audit (zero errors)
- End-to-end: place order → appears in Rekart → rider delivers → Shopify updates

**App Store listing assets (do last):**
- 6 screenshots at 1280×800 (Onboarding fork, Qual form, Connect Rekart, Dashboard, Settings with slot picker, Sync Log)
- App icon 512×512 PNG (from design team)
- $19 App Store registration fee
- Partner Dashboard listing copy

---

## Phase 8 — Launch & Post-Launch 🔴

- Submit app for Shopify review (Day 27)
- Deploy Remix to production
- Run `npx prisma migrate deploy` on production MySQL
- Run `npx ts-node scripts/migrate-tokens.ts` (with `--dry-run` first)
- Set up monitoring alerts (webhook failure rate, queue depth)
- Write support runbook
- Onboard first real merchant (internal Rekart client as pilot)
- Share `SHOPIFY_API_SECRET` with Pappu via WhatsApp (not email, not GitHub)

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Rekart `panel/order/create` needs significant extension | H | H | Confirm with Pappu before writing Phase 3 code |
| Shopify review rejection | M | H | All 11 checklist items passing + s-button fix |
| No outbound webhooks → 15-min polling SLA | H | M | Document in App Store listing |
| Cross-tenant data leak (wrong credentials) | M | H | Client_id verification on reconnect (✅ built — app.connect-rekart.tsx returns 403 on client_id mismatch) + Rekart 1:1 enforcement (open) |
| Shopify customers without phone | M | H | Skip sync, log error, advise merchants to make phone required at checkout |
| `slot_id` not configured by merchant | H | H | Dashboard warning banner built ✅ |
| Timezone poisoning from Rekart API | H | M | Always send UTC ISO 8601 |
| `SHOPIFY_API_SECRET` exposed | L (rotated once) | H | Never commit to git, store in secrets manager |
| Token revocation (merchant changes password) | M | M | tokenInvalid detection built ✅ |
| OAuth 2.0 delayed | M | M | Password login interim solution works ✅ |

---

## Open Items — All External Dependencies

| Item | Owner | Blocking | Status |
|------|-------|----------|--------|
| `panel/order/create` shape — accepts `external_source` + `items[]`? | Pappu | Phase 3 | 🔴 |
| `user/{user}/address` path + fields + zone_id? | Pappu | Phase 3 | 🔴 |
| `panel/customer/create` upsert on duplicate phone? | Pappu | Phase 3 | 🔴 |
| `shopify_shops` table — does it exist? Register endpoint? | Pappu | Phase 3 | 🔴 |
| `delivery/info` exact path + response shape | Pappu | Phase 5 | 🔴 |
| `DeliveryItem.status` enum values | Pappu | Phase 5 | 🔴 |
| OAuth 2.0 URL + credentials | Pappu | Phase 2 | 🔴 |
| Cross-tenant enforcement on Rekart side | Pappu | Phase 3 | 🔴 |
| Where the polling job runs (Rekart backend vs Remix sweep) | Mithil + Pappu | Phase 5 | 🔴 |
| MySQL RDS connection string | DevOps | Phase 0 | 🔴 |
| Redis connection string | DevOps | Phase 3 | 🔴 |
| Production domain for shopify.app.toml | Mithil | Phase 7 | 🔴 |
| New merchant provisioning: auto vs lead | Mithil | Phase 2 | 🔴 |
| App icon 512×512 PNG | Design team | Phase 7 | 🔴 |
| GDPR data delivery process | Mithil + Legal | Phase 3 | 🔴 |

---

## Credentials & Secrets Summary

| Secret | Value | Who Needs It | How to Share |
|--------|-------|-------------|--------------|
| `SHOPIFY_API_SECRET` | In `.env` (rotated) | Pappu (Rekart backend) | WhatsApp only |
| `REKART_STATIC_API_KEY` | In `.env` | Pappu (already shared) | Already done |
| `ENCRYPTION_KEY` | Generate: `openssl rand -hex 32` | Vrushank only | Never share |
| `DATABASE_URL` | Get from DevOps | Vrushank | DevOps to provide |
| `REKART_BACKEND_URL` | `https://dev3.rekart.io` (staging) | In `.env` | Already set |

---

## Changelog

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| v0.1 | 2026-06-16 | Vrushank | Initial plan |
| v0.2 | 2026-06-16 | Vrushank | Major update: webhook architecture (HMAC, direct-to-Rekart routing), multi-tenant isolation (shopify_shops table, X-Shopify-Shop-Domain), cross-tenant security (client_id verification — now ✅ built, 403 on mismatch), token storage (AES-256-GCM, not in Shopify session), Phase 3 4-step order flow + schema prep migrated, Pappu backend checklist, OAuth 2.0 minimal diff, s-button→useNavigate fix (s-app-nav keeps href), Session index, Developer Setup Notes, rekart-backend reference-spec clarification. Synced to actual codebase after third-round audit. |
