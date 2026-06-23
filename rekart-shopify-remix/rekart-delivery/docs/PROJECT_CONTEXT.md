# PROJECT_CONTEXT.md
# Rekart Shopify App — Complete Project Handoff

(Corrected against the codebase 2026-06-17.)

---

## User Overview

**Name:** Vrushank Kavimandan
**Email:** vrushank.kavimandan@abmiro.in
**Role:** Shopify App Developer at Abmiro (building for Rekart)
**Location:** Pune, Maharashtra, India
**Working directory:** `C:\Users\sandi\REKARTxSHOPIFY\rekart-shopify-remix\rekart-delivery`
**GitHub:** justvrushank (personal); repo lives at Rekart-io org

---

## Current Role And Responsibilities

Vrushank is the sole Shopify app developer building **Rekart Delivery**, a public
Shopify App Store connector bridging Shopify merchants to the Rekart local
delivery SaaS. He coordinates with:

- **Pappu** — Rekart backend dev (Laravel 11). Builds Rekart-side API endpoints.
- **Rohan Mahajan** — Rekart tech (integration advice).
- **Mithil Shah** (mithil.shah@abmiro.com) — Product Owner. Business decisions, $19 fee.
- **DevOps** — Rekart Tech. Provisions MySQL 8.0+ and Redis.
- **Design team** — supplies app icon 512×512 PNG.

---

## Project: Rekart Delivery — Shopify App Store Connector

### Objective
A free Shopify app connecting merchants to Rekart's local delivery platform
(dairy, water, tiffin, meal kits). Auto-sync orders/customers into Rekart, push
delivery status back to Shopify timelines, and capture new merchants as sales leads.

### Business Context
- Rekart is a multi-tenant subscription-delivery SaaS in India.
- The Shopify app is a **free lead-gen funnel** — installs convert to paying Rekart clients.
- Billing is external (no in-app billing).
- Target: dairy/milk/water/tiffin/meal-kit/produce delivery businesses; Pune, Mumbai, Bengaluru.

### Requirements
**Functional:** install → onboard → link Rekart account → orders sync; `orders/create` → Rekart delivery job < 60s; rider delivers → Shopify timeline < 20min; 3 GDPR webhooks return 200; new merchants captured as leads; existing merchants connect via credentials; default delivery slot configurable.

**Non-functional:** free public listing; Polaris/App Bridge compliant (no `window.location` for internal nav); session tokens (not cookies); AES-256-GCM token storage; GDPR durable queue; MySQL for production.

### Constraints
- Rekart has **no outbound webhooks** → polling only for delivery status.
- Rekart has **no SKU model** → name matching only.
- One product per Rekart subscription (multi-item cart = multiple subs).
- Rekart customers keyed by `(client_id, phone)` → no-phone customers can't sync.
- Rekart uses POST for reads.
- `orders/create` requires Protected Customer Data approval.
- $19 fee not yet paid (waiting on end-to-end test).

### Technical Stack

**Remix App (deployed connector):**
- React Router v7 (Remix), TypeScript
- Shopify Polaris **web components** (`s-*` tags — NOT React Polaris)
- App Bridge (embedded app framework)
- Prisma ORM + MySQL (migrated from SQLite)
- **`@shopify/shopify-app-react-router`** for OAuth/session/webhook handling
- AES-256-GCM token encryption
- Zod for runtime validation
- Vitest (**21/21** passing)

**FastAPI Reference Backend (`rekart-backend/` in repo):**
- Python, FastAPI, SQLAlchemy, Celery, MySQL, Redis
- **Reference spec for Rekart's Laravel team to port** — NOT deployed
- 20 pytest tests passing; Alembic migrations

**Rekart Backend (existing, external):**
- Laravel 11, MySQL (AWS RDS), Laravel Passport tokens, no outbound webhooks
- Staging `https://dev3.rekart.io` / Production `https://app.rekart.io`

### Architecture

**Webhook routing (CRITICAL — D002):**
```
orders/create     -> DIRECTLY to ${REKART_BACKEND_URL}/webhooks/shopify/orders/create
customers/create  -> DIRECTLY to ${REKART_BACKEND_URL}/webhooks/shopify/customers/create
customers/update  -> DIRECTLY to ${REKART_BACKEND_URL}/webhooks/shopify/customers/update
app/uninstalled   -> Remix -> clears credentials -> forwards to Rekart
app/scopes_update -> Remix only
GDPR x 3          -> Remix -> durable queue (GdprRequest) -> forwards to Rekart
```
Data webhooks are registered in `app/shopify.server.ts` (`hooks.afterAuth`), NOT in `shopify.app.toml`. Lifecycle + GDPR are in the TOML.

**Order sync flow (to be built in Rekart's Laravel backend — D002/D021, task T097):**
```
orders/create -> Rekart backend (HMAC verified, look up client_id from shopify_shops)
  Step 1: panel/customer/create     -> rekart_user_id
  Step 2: user/{id}/address/add     -> address_id
  Step 3: panel/order/create        (external_source, external_order_id, slot_id, address_id, items[])
  Step 4: store shopify_order_id -> rekart_order_id
Poll delivery/info every 15 min -> status change -> POST /api/fulfillment-push (Remix) -> Shopify GraphQL
```
> A Remix-side scaffold of this flow was prototyped and **deleted** (D021). Phase 3 lives in Rekart's backend.

**Authentication layers:**
| Request Type | Auth | Key |
|---|---|---|
| Shopify → Rekart webhook | HMAC-SHA256 of raw body | `SHOPIFY_API_SECRET` (one, app-level) |
| Remix → Shopify Admin API | Session token (per-merchant) | `shpat_xxx` (in `Session`) |
| Remix → Rekart panel endpoints | Bearer token | per-merchant `rekartAccessToken` (encrypted) |
| Rekart → Remix fulfillment push | Static API key | `REKART_STATIC_API_KEY` (`X-API-Key`) |

**Multi-tenancy:** each merchant = one Rekart `client_id`. Rekart maintains `shopify_shops` (`shop_domain → client_id`). `SHOPIFY_API_SECRET` is ONE value for the app.

**Cross-tenant security:** if `rekartMerchantId` is set and a relink returns a different `client_id` → **403**. Built in `app/routes/app.connect-rekart.tsx`. (`rekartMerchantId` is `String?`.)

**Token storage:** Rekart token NEVER in Shopify session; encrypted (AES-256-GCM) in `ShopOnboarding.rekartAccessToken`; never sent to browser.

### Shopify APIs Used
- GraphQL Admin API **2025-10** (`ApiVersion.October25`) — `fulfillmentCreate`, `fulfillmentEventCreate`
- `authenticate.admin(request)` in all embedded loaders/actions
- `authenticate.webhook(request)` in webhook routes

### Rekart APIs (confirmed working)
- `POST /api/auth/login` ✅ — body `{ username, password, referer:"admin", appType:"ShopifyApp", appVersion:"1.0.0", platform:"browser" }`; returns `user.token.access_token`, `user.client.client_id`, `user.token.expires_at`
- `POST /api/panel/slot/list`, `/product/list`, `/plan/list`, `/subscription/create` — exist (shapes unconfirmed)

### Rekart APIs (needed from Pappu — ALL UNRESOLVED)
`panel/order/create` fields (Q1) · `user/{user}/address/add` path + zone_id (Q2) · `panel/customer/create` upsert (Q3) · zone_id resolution (Q4) · OAuth 2.0 URL (Q5) · `delivery/info` + status enum (Q6) · `slot/list` body fields (Q7) · `shopify_shops` table + register endpoint (Q8).

### Internal endpoints (Remix)
- `POST /api/fulfillment-push` — `X-API-Key`, Zod validated
- `POST /api/fulfillment-retry-sweep` — `X-API-Key`, retries dead pushes + GDPR

### Decisions (see DECISIONS.md for full log)
1. Data webhooks DIRECT to Rekart (D002).
2. Polling only for delivery status (D008).
3. Password login interim → OAuth 2.0 planned (D012).
4. SQLite → MySQL; `prisma migrate deploy` (not `migrate dev`) (D005).
5. AES-256-GCM token encryption (D006).
6. Name-only product matching (D009).
7. `useNavigate()` for in-content nav; `s-app-nav` keeps `href` (D010).
8. `rekart-backend/` is reference spec only (D016).
9. `rekartAccessToken` not in Shopify session (D007).
10. One `SHOPIFY_API_SECRET` for all merchants (D014).
11. Cross-tenant 403 on client_id mismatch (D013).
12. Merchant picks default slot in Settings (D015).
13. Phase 3 schema pre-built (D018).
14. **Phase 3 order sync lives in Rekart backend; Remix scaffold deleted (D021).**

### Work Completed

**Phase 0 — Setup ✅**
Client ID `954401100dd738ee168c9ebb21ae2e89`; dev store `rekart-dev-kysqlw9f.myshopify.com`; Protected Customer Data 16/16; Subscription APIs approved; API secret rotated; repo at `Rekart-io/rekart-delivery`.

**Phase 1 — Core Infrastructure ✅**
OAuth install + `afterAuth`; embedded-param preservation; Prisma schema (Session, ShopOnboarding, FulfillmentPush, FulfillmentLink, GdprRequest, ShopifyProductLink, + pre-built ShopifyOrderSync, ShopifyCustomerSync); uninstall/scopes_update/GDPR×3 handlers; GDPR durable queue + sweep; AES-256-GCM; migrate-tokens script; MySQL migration.

**Phase 2 — Onboarding 🟡 (95%)**
Yes/No fork; connect-rekart (password login); pending-setup; qualification form (`businessCategory`, `country`, `orderVolume`, `subscriberCount`, `deliveryOps`); cross-tenant 403; encrypted token + `rekartMerchantId` + `rekartTokenExpiresAt`; 24h expiry warning; 401 `tokenInvalid` banner; slot picker; 3-way gate; Settings (disconnect vs stop-syncing). Pending: OAuth 2.0 (Q5), provisioning decision (Mithil).

**Phase 3 — Order & Customer Sync 🔴 NOT STARTED**
Schema pre-built (ShopifyOrderSync, ShopifyCustomerSync). Orchestration belongs to Rekart's Laravel backend (D002/D021, T097). A Remix-side scaffold was prototyped and deleted. Blocked on Pappu (Q1-Q4, Q6, Q7, Q8).

**Phase 4 — Product Mapping 🟡 Scaffold**
`ShopifyProductLink`; auto-match (exact name → fuzzy ≤ 3; SKU branch dead); scale guard; mapping screen; Zod on save. Blocked: live `panel/product/list` shape.

**Phase 5 — Fulfillment Push ✅**
`POST /api/fulfillment-push` (X-API-Key, Zod); `fulfillmentCreate`/`fulfillmentEventCreate`; status mapping; `FulfillmentLink` cache; retry (6 attempts, backoff, `dead`); sync-error banner.

**Phase 6 — Dashboard & Sync Log ✅**
Stats (2500ms timeout + fallback); banner priority tokenInvalid → tokenExpiringSoon → needsSlot → syncError; Sync Log filter + retry; empty states/skeletons; parallel loader.

**Security hardening (review rounds 1-3):** GCM; GDPR index + MAX_RETRIES; pending-setup routing fix; Zod on products; fuzzy scale guard; tokenInvalid + 401; rekartTokenExpiresAt; `Session @@index([shop])`; Phase 3 schema pre-build; `--dry-run`; crypto tests; `s-button`→`useNavigate`; slot validation; cross-tenant 403.

**Docs in repo (`docs/`):** `rekart-shopify-api-contract.md`, `rekart-shopify-implementation-plan.md`, `fastapi-contract.md`, `TASKS.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `PROJECT_CONTEXT.md`.

### Current Status

**Last code commit:** `d70a100` on master (handoff docs committed on top).
**Repo:** `https://github.com/Rekart-io/rekart-delivery`

**Test status:** vitest **21/21** ✅ · pytest **20/20** ✅ · `tsc --noEmit` clean ✅ · `react-router build` clean ✅

| Phase | Status |
|-------|--------|
| 0 Setup | ✅ |
| 1 Core Infrastructure | ✅ |
| 2 Onboarding | 🟡 95% (OAuth pending) |
| 3 Order & Customer Sync | 🔴 Blocked on Pappu (Rekart-backend work) |
| 4 Product Mapping | 🟡 Scaffold |
| 5 Fulfillment Push | ✅ |
| 6 Dashboard & Sync Log | ✅ |
| 7 QA & App Store Prep | 🔴 After Phase 3 |
| 8 Launch | 🔴 After Phase 7 |

### Open Questions

**For Pappu (blocking Phase 3):** Q1 `panel/order/create` fields · Q2 `address/add` path + zone_id · Q3 `customer/create` upsert + phone-null · Q4 zone_id resolution · Q5 OAuth 2.0 URL/creds · Q6 `delivery/info` + status enum · Q7 `slot/list` body fields · Q8 `shopify_shops` table + register endpoint · (also: webhook registration to replace polling?)

**For Mithil:** provisioning (auto vs lead) · production domain · app icon · GDPR data-delivery process.

**For DevOps:** MySQL connection string · Redis connection string.

### Next Steps

**When Pappu answers Q1-Q4 + Q6-Q8:** build order + customer sync **in Rekart's backend** (T097-T099); build polling job; end-to-end test.
**When Pappu answers Q5 (OAuth):** replace password form with OAuth redirect; add `app.rekart-callback.tsx`; swap `loginToRekart` → `exchangeRekartCode`.
**When DevOps provides MySQL:** `prisma migrate deploy`; `migrate-tokens.ts --dry-run` then run.
**Final (do last):** pay $19, fill Partner Dashboard, 6 screenshots @ 1280×800, icon, listing copy, set production `application_url`, submit.

---

## Cross-Project Knowledge

### Environment Variables

**`rekart-delivery/.env`:**
```
SHOPIFY_API_KEY=954401100dd738ee168c9ebb21ae2e89
SHOPIFY_API_SECRET=<rotated secret>
SCOPES=read_orders,read_customers,write_orders
SHOPIFY_APP_URL=                       # blank in dev (CLI manages)
REKART_BACKEND_URL=https://dev3.rekart.io
REKART_STATIC_API_KEY=<shared with Pappu>
ENCRYPTION_KEY=<openssl rand -hex 32>  # REQUIRED before login works
DATABASE_URL=mysql://user:password@host:3306/rekart_shopify
```

**`rekart-delivery/rekart-backend/.env`:**
```
SHOPIFY_API_SECRET=<same>
REKART_BACKEND_URL=https://dev3.rekart.io
REKART_STATIC_API_KEY=<same>
DATABASE_URL=mysql+aiomysql://...
REDIS_URL=redis://...
APP_ENV=development
```

### Developer Setup Notes (Critical)
1. Migrations generated offline via `prisma migrate diff`; apply with `npx prisma migrate deploy`. NEVER `prisma migrate dev` (hangs without a live DB).
2. `ENCRYPTION_KEY` must be set before merchant login — `connect-rekart` throws if missing.
3. `s-app-nav` links in `app.tsx` keep `href` (App Bridge nav menu requires it). Do NOT convert to `useNavigate`.
4. `fetchSyncStats` returns `null` for an unreachable backend (so dashboard shows "Unreachable"); 401 returns `{ tokenInvalid: true }`.
5. `minutesToTime` is in `app/slot-time.ts` (client/test-safe), re-exported from `rekart.server.ts` (importing `rekart.server` in tests pulls in Prisma).
6. Actions use React Router's `data()` helper (not `Response.json`) for status codes while preserving `useActionData` typing.
7. API version is **2025-10** everywhere (`shopify.app.toml`, `ApiVersion.October25`); the FastAPI reference backfill still says `2024-01` (debt T137).

### Prisma Schema Summary (verified)
- `Session` — managed by `@shopify/shopify-app-react-router`, `@@index([shop])`
- `ShopOnboarding` — `rekartMerchantId String?`, `rekartAccessToken @db.Text` (GCM), `rekartTokenExpiresAt`, `defaultSlotId Int?`, `tokenInvalid`, `rekartOAuthState`, `existingRekartUser`, `connected`; onboarding cols `orderVolume`/`deliveryOps`
- `FulfillmentPush` — outbound status, retry queue, `shopifyFulfillmentId`, `dead` terminal
- `FulfillmentLink` — `shopifyFulfillmentId` per order, `@@unique([shop, shopifyOrderId])`
- `GdprRequest` — durable queue, `@@index([shop, status])`, MAX_RETRIES=10
- `ShopifyProductLink` — `id String @cuid`, column `shopifySku`, `@@unique([shopId, shopifyVariantId])`
- `ShopifyOrderSync` / `ShopifyCustomerSync` — Phase 3 pre-build (unused until Phase 3)

**TEXT columns:** `rekartAccessToken`, `GdprRequest.payload`, `FulfillmentPush.lastError`, `trackingUrl`, `shopifyProductTitle`, `rekartProductName`. **Charset:** utf8mb4_unicode_ci.

### Rekart Platform Key Facts
Multi-tenant (`client_id`); `Slot.delivery_time` minutes-from-midnight; `Order` has `external_source`/`external_order_id`; subscriptions need `product_id`/`slot_id`/`plan_id`/`address_id`/`pattern_data`; customer keyed by `(client_id, phone)`; one product per subscription; no SKU model; timezone trap (send UTC ISO-8601); panel routes derive tenant from token; Passport opaque token, `refresh_token:null`; `expires_at` stored as `rekartTokenExpiresAt`.

### Market Research (Shipday + EasyRoutes done; Zapiet pending)
Add: activity feed, setup checklist, order-level Sync Log, rider-app link, one-question-per-screen qualification; ask Pappu about webhook registration to replace polling.

---

## Important Context For Future Conversations
1. **DO NOT save to Notion** unless explicitly asked.
2. The `SHOPIFY_API_SECRET` was rotated — the old value is invalid; never reference it.
3. Repo is at `Rekart-io/rekart-delivery`.
4. Screenshots reserved for the last step (after Phase 3 tested).
5. `rekart-shopify-backend/` was deleted; the real FastAPI spec is at `rekart-backend/`.
6. The app installs/onboards/connects (tested `9000000001`/`1234` on `dev3.rekart.io`) and shows the dashboard.
7. Three consulting review rounds complete.
8. **Pappu is the critical path** — Phase 3 cannot start until Q1-Q8 are answered.
9. Market research in progress (Zapiet pending).
10. Working directory: `C:\Users\sandi\REKARTxSHOPIFY\rekart-shopify-remix\rekart-delivery`; `cd` there first.
11. Privacy `https://rekart.io/privacy-policy` and Support `https://rekart.io/support` are linked in Settings.
12. The user's name is Vrushank.
13. $19 App Store fee NOT yet paid (waiting on end-to-end test).
14. Stack note: package is `@shopify/shopify-app-react-router` and API version is `2025-10` (earlier handoff drafts said `-remix` / `2026-04` — both were wrong).

---

## Long-Term Goals
1. **Phase 1 (current):** App Store listing with one-time order sync + delivery status polling.
2. **Phase 2 (planned):** Subscription sync via `write_own_subscription_contracts` (approved).
3. **Phase 3 (future):** Catalog sync, day-wise menus, bidirectional subscription changes (WhatsApp ↔ Shopify).
