# ARCHITECTURE.md
# Rekart Shopify Connector — Technical Architecture

**Version:** v0.3 (corrected against code 2026-06-17)
**Repo:** https://github.com/Rekart-io/rekart-delivery
**Working directory:** `C:\Users\sandi\REKARTxSHOPIFY\rekart-shopify-remix\rekart-delivery`

> Corrections in this revision (verified against the codebase): Shopify package is
> `@shopify/shopify-app-react-router` (not `-remix`); API version is **2025-10**
> (not 2026-04); `ShopOnboarding.rekartMerchantId` is `String?`; onboarding columns
> are `orderVolume`/`deliveryOps`; `ShopifyProductLink.id` is `String @cuid` with
> column `shopifySku`; the fulfillment id column is `shopifyFulfillmentId` (not
> `fulfillmentGid`); data webhooks are registered in `shopify.server.ts`, not the
> TOML.

---

## System Overview

```
SHOPIFY PLATFORM
  Merchant store (storefront + checkout)
  Partner Dashboard (app registration, secrets, webhook subscriptions)
  Shopify Admin (embedded app iframe)
        |
        v
WEBHOOK ROUTING (critical — see D002)
  orders/create      --> Rekart Backend   (direct, registered in shopify.server.ts)
  customers/create   --> Rekart Backend   (direct)
  customers/update   --> Rekart Backend   (direct)
  app/uninstalled    --> Remix App  --> forwards to Rekart
  app/scopes_update  --> Remix App  (only)
  GDPR x 3           --> Remix App  --> durable queue --> forwards to Rekart
        |
        v
REMIX APP (embedded Shopify UI + lifecycle/GDPR handler + fulfillment-push receiver)
        | Bearer-token API calls (per-merchant)
        v
REKART BACKEND (Laravel 11)  dev3.rekart.io (staging) / app.rekart.io (prod)
        | delivery status (polled every 15 min — no outbound webhooks)
        v
Poll delivery/info  -->  POST /api/fulfillment-push (Remix)  -->  Shopify GraphQL
                                                                 -->  order timeline updated
```

---

## Components

### 1. Remix App (Primary Deployed Service)

**Purpose:** Embedded Shopify admin UI + lifecycle/GDPR webhook handler + fulfillment-push receiver.

**Location:** `rekart-delivery/` (repo root)

**Framework:** React Router v7 (Remix), TypeScript
**UI:** Shopify Polaris **web components** (`s-*` tags — NOT React Polaris)
**Auth:** `@shopify/shopify-app-react-router@^1.1.0` (session tokens, HMAC verification)
**DB ORM:** Prisma
**DB:** PostgreSQL 16 (existing WhatsApp-server instance)
**Runtime:** Node.js (Shopify CLI in dev, server process in production)

**Key directories:**
```
rekart-delivery/
├── app/
│   ├── routes/
│   │   ├── app._index.tsx                 # Dashboard (3-way gate, banners)
│   │   ├── app.onboarding.tsx             # Yes/No fork + qualification form
│   │   ├── app.connect-rekart.tsx         # Rekart account linking (+ cross-tenant 403)
│   │   ├── app.pending-setup.tsx          # New merchant lead capture
│   │   ├── app.products.tsx               # Product mapping screen
│   │   ├── app.settings.tsx               # Settings + slot picker
│   │   ├── app.sync-log.tsx               # Sync Log with retry
│   │   ├── app.tsx                        # App shell (s-app-nav)
│   │   ├── api.fulfillment-push.tsx       # Rekart calls this (X-API-Key)
│   │   ├── api.fulfillment-retry-sweep.tsx# Cron/retry (pushes + GDPR)
│   │   ├── webhooks.app.uninstalled.tsx
│   │   ├── webhooks.app.scopes_update.tsx
│   │   ├── webhooks.customers.data_request.tsx
│   │   ├── webhooks.customers.redact.tsx
│   │   └── webhooks.shop.redact.tsx
│   ├── crypto.server.ts            # AES-256-GCM encrypt/decrypt
│   ├── db.server.ts                # Prisma client singleton
│   ├── gdpr.server.ts              # GDPR durable queue
│   ├── fulfillment.server.ts       # Shopify GraphQL fulfillment calls
│   ├── fulfillment-retry.server.ts # Retry logic
│   ├── fulfillment-status.ts       # Status enum + mapping
│   ├── onboarding.server.ts        # Onboarding DB helpers
│   ├── onboarding-options.ts       # Qualification form options
│   ├── product-matching.server.ts  # Auto-match algorithm
│   ├── rekart.server.ts            # All Rekart API calls
│   ├── slot-time.ts                # minutesToTime (client-safe)
│   └── sync-log.constants.ts       # Sync log filter options
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│       └── 20260625000000_init_postgresql/   # single PostgreSQL baseline
├── scripts/
│   └── migrate-tokens.ts           # CBC/plaintext -> GCM migration (--dry-run)
├── docs/
│   ├── rekart-shopify-api-contract.md
│   ├── rekart-shopify-implementation-plan.md
│   ├── fastapi-contract.md
│   ├── TASKS.md
│   ├── ARCHITECTURE.md
│   ├── DECISIONS.md
│   └── PROJECT_CONTEXT.md
├── shopify.app.toml                # Shopify CLI config, lifecycle + GDPR webhooks
├── vite.config.ts
└── package.json
```

> There is **no** `webhooks.orders.create.tsx` route. A Remix-side order-sync
> scaffold was prototyped and removed (D021); order ingestion is Rekart's
> backend per D002.

---

### 2. FastAPI Reference Backend (`rekart-backend/`)

**Purpose:** Reference implementation spec for Rekart's Laravel team to port. **NOT a deployed service.**

**Location:** `rekart-delivery/rekart-backend/`

**Framework:** Python, FastAPI, SQLAlchemy, Celery, Redis
**DB:** MySQL (aiomysql driver)
**Tests:** 20 pytest tests passing

```
rekart-backend/
├── app/
│   ├── config.py            # Settings (SHOPIFY_API_SECRET, REKART_STATIC_API_KEY, ...)
│   ├── main.py
│   ├── db/session.py
│   ├── models/shop.py
│   ├── routers/{shops.py, webhooks.py}
│   ├── services/shopify_auth.py  # HMAC verification
│   └── tasks.py             # Celery: sync_order, sync_customer, backfill_shop
├── migrations/versions/
├── tests/                   # 20 pytest tests
├── requirements.txt
├── pytest.ini
└── alembic.ini
```

> Known reference-spec debt: `tasks.py` backfill uses Shopify API `2024-01`; it
> should match the app's `2025-10` (T137).

---

### 3. Rekart Backend (External — Laravel 11)

Existing Rekart delivery platform. Receives order/customer data, creates delivery
jobs, manages riders/routes/subscriptions. **Not owned by this project.**

**Staging:** `https://dev3.rekart.io` · **Production:** `https://app.rekart.io`
**Auth:** Laravel Passport (opaque Bearer tokens, not JWT)
**DB:** MySQL (AWS RDS, multi-tenant, `client_id` scopes all data)

---

## Services

| Service | Type | Owner | Status |
|---------|------|-------|--------|
| Remix App | Embedded Shopify App | Vrushank | ✅ Built, not deployed to prod |
| FastAPI Reference Backend | Reference spec only | Vrushank (spec) / Rekart team (impl) | ✅ Spec complete (20 pytest) |
| Rekart Laravel Backend | External SaaS | Pappu / Rohan | Existing, needs extensions |
| PostgreSQL | Managed DB | DevOps | 🟢 Existing WhatsApp-server instance |
| Redis | Task queue | DevOps | 🔴 Not provisioned |

---

## Databases

### Remix App Database (PostgreSQL)

**Provider:** PostgreSQL 16 (existing WhatsApp-server instance) · **ORM:** Prisma · **Encoding:** UTF8
**Migration strategy:** Offline diff (`prisma migrate diff`), apply with `prisma migrate deploy`.

> **Local dev vs. production — two schema files.** Prisma forbids `env()` in the
> datasource `provider`, so the repo keeps two schemas: **`prisma/schema.prisma`**
> is canonical (`provider = "postgresql"`, migrations in `prisma/migrations/`) and
> drives Docker + production via `prisma migrate deploy`; **`prisma/schema.sqlite.prisma`**
> is a local-dev mirror (`provider = "sqlite"`). No `@db.Text` is needed: PostgreSQL
> maps Prisma `String` to unbounded `TEXT` by default. Local dev: `DATABASE_URL=file:./dev.db`
> in `.env` + `npm run setup:local` (`npm run dev` regenerates the sqlite client via
> `predev`). Production/Docker: PostgreSQL 16 via the canonical schema. **The two files
> must be kept in sync.** See `docs/DOCKER.md`.

#### Schema (verified against `prisma/schema.prisma`)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Session {
  id                  String    @id
  shop                String
  state               String
  isOnline            Boolean   @default(false)
  scope               String?
  expires             DateTime?
  accessToken         String
  userId              BigInt?
  firstName           String?
  lastName            String?
  email               String?
  accountOwner        Boolean   @default(false)
  locale              String?
  collaborator        Boolean?  @default(false)
  emailVerified       Boolean?  @default(false)
  refreshToken        String?
  refreshTokenExpires DateTime?

  @@index([shop])
}

model ShopOnboarding {
  shop                 String    @id
  businessCategory     String?
  country              String?
  orderVolume          String?
  subscriberCount      String?
  deliveryOps          String?
  existingRekartUser   Boolean?  // Yes/No fork
  completed            Boolean   @default(false)
  connected            Boolean   @default(false)
  rekartMerchantId     String?   // Rekart client_id (string)
  rekartAccessToken    String?   // AES-256-GCM encrypted (TEXT in PostgreSQL)
  tokenInvalid         Boolean   @default(false)
  defaultSlotId        Int?
  rekartTokenExpiresAt DateTime?
  rekartOAuthState     String?   // CSRF nonce for OAuth 2.0
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
}

model FulfillmentPush {
  id                   String    @id @default(cuid())
  shop                 String
  shopifyOrderId       String
  rekartStatus         String
  rekartDeliveryId     String?
  mappedAction         String
  status               String    @default("pending") // pending|succeeded|failed|dead
  attempts             Int       @default(0)
  lastError            String?
  shopifyFulfillmentId String?
  trackingNumber       String?
  trackingUrl          String?
  trackingCompany      String?
  occurredAt           DateTime?
  nextAttemptAt        DateTime?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt

  @@unique([shop, shopifyOrderId, rekartStatus])
  @@index([status, nextAttemptAt])
  @@index([shop, createdAt])
}

model FulfillmentLink {
  id                   String   @id @default(cuid())
  shop                 String
  shopifyOrderId       String
  shopifyFulfillmentId String
  createdAt            DateTime @default(now())

  @@unique([shop, shopifyOrderId])
}

model GdprRequest {
  id         Int       @id @default(autoincrement())
  shop       String
  topic      String
  payload    String    // raw Shopify webhook body (contains PII); TEXT in PostgreSQL
  status     String    @default("pending") // pending|forwarded|failed
  createdAt  DateTime  @default(now())
  retriedAt  DateTime?
  retryCount Int       @default(0)

  @@index([shop, status])
}

model ShopifyProductLink {
  id                  String   @id @default(cuid())
  shopId              String
  shopifyVariantId    String
  shopifyProductTitle String
  shopifySku          String?
  rekartProductId     Int
  rekartProductName   String?
  matchedAuto         Boolean  @default(false)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@unique([shopId, shopifyVariantId])
  @@index([shopId])
}

model ShopifyOrderSync {
  id             String    @id @default(cuid())
  shop           String
  shopifyOrderId String
  rekartOrderId  String?
  status         String    @default("pending") // pending|synced|failed|dead
  attempts       Int       @default(0)
  lastError      String?
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

> `ShopifyOrderSync`/`ShopifyCustomerSync` exist as **pre-built schema** (D018);
> no code reads/writes them yet (Phase 3 not started, see D021).

**Migrations (apply with `prisma migrate deploy`):**
1. `20260625000000_init_postgresql` — single PostgreSQL baseline covering all
   models (the prior incremental MySQL migrations were collapsed into this baseline
   when the provider switched from MySQL to PostgreSQL).

---

### Rekart Backend Database (External MySQL)

Multi-tenant; all data scoped by `client_id`. Key tables: `clients`, `users`,
`orders` (`external_source`, `external_order_id`), `deliveries`, `delivery_items`
(`status`), `slots` (`delivery_time` minutes-from-midnight), `subscriptions`, and
`shopify_shops` (NEEDED — may not exist yet; `shop_domain → client_id`).

---

## APIs

### Shopify APIs Used

**GraphQL Admin API (version 2025-10 — the app's `ApiVersion.October25`):**
`fulfillmentCreate` (first status update per order) and `fulfillmentEventCreate`
(subsequent updates), in `app/fulfillment.server.ts`.

**Webhook registration (actual):**
- **Lifecycle + GDPR** are declared in `shopify.app.toml`:
  ```toml
  [webhooks]
  api_version = "2025-10"

    [[webhooks.subscriptions]]
    uri = "/webhooks/app/uninstalled"
    topics = [ "app/uninstalled" ]

    [[webhooks.subscriptions]]
    uri = "/webhooks/app/scopes_update"
    topics = [ "app/scopes_update" ]

    [[webhooks.subscriptions]]
    uri = "/webhooks/customers/data_request"
    compliance_topics = [ "customers/data_request" ]

    [[webhooks.subscriptions]]
    uri = "/webhooks/customers/redact"
    compliance_topics = [ "customers/redact" ]

    [[webhooks.subscriptions]]
    uri = "/webhooks/shop/redact"
    compliance_topics = [ "shop/redact" ]
  ```
- **Data webhooks** (`orders/create`, `customers/create`, `customers/update`) are
  NOT in the TOML. They are registered per-shop at install in
  `app/shopify.server.ts` (`hooks.afterAuth` → `registerWebhooks`) with
  `callbackUrl = ${REKART_BACKEND_URL}/webhooks/shopify/...` so Shopify delivers
  them straight to Rekart (D002).

### Rekart APIs

**Confirmed working:** `POST /api/auth/login` — returns
`user.client.client_id`, `user.token.access_token`, `user.token.expires_at`.
Request body: `{ username, password, referer:"admin", appType:"ShopifyApp", appVersion:"1.0.0", platform:"browser" }`.

**Exists, shape unconfirmed:** `POST /api/panel/slot/list`, `POST /api/panel/product/list`, `POST /api/panel/plan/list` (Phase 2), `POST /api/panel/subscription/create` (Phase 2).

**Needed from Pappu (all unresolved):**

| Endpoint | Purpose | Q |
|----------|---------|---|
| `POST /api/panel/order/create` | Create delivery job | Q1: `external_source`, `external_order_id`, `items[]`? |
| `POST user/{user}/address/add` | Create customer address | Q2: exact path, fields, zone_id? |
| `POST /api/panel/customer/create` | Create/upsert customer | Q3: upsert on `(client_id, phone)`? phone null? |
| pincode → zone lookup | Address zone resolution | Q4 |
| `GET /api/oauth/authorize`, `POST /api/oauth/token` | OAuth 2.0 | Q5 |
| `POST /api/delivery/info` | Poll delivery status | Q6 |
| `POST /api/shopify/shops/register` | shop→client_id mapping | Q8 |

### Internal API Endpoints (Remix App)

- **`POST /api/fulfillment-push`** — `X-API-Key` auth, Zod validated, creates Shopify fulfillment, retry queue (6 attempts, backoff, `dead`).
- **`POST /api/fulfillment-retry-sweep`** — `X-API-Key` auth, retries failed `FulfillmentPush` and pending `GdprRequest` rows.

---

## Authentication

### Layer 1 — Shopify → Remix App (Session Tokens)
`authenticate.admin(request)` in every loader/action. Session tokens are short-lived; the per-merchant Shopify token (`shpat_xxx`) lives in `Session.accessToken`. No third-party cookies. In-content nav uses `useNavigate()` (App Bridge); **exception:** `s-app-nav` links keep `href` (the nav menu requires it).

### Layer 2 — Shopify → Rekart Backend (HMAC)
ONE app-level `SHOPIFY_API_SECRET`; verify base64(HMAC-SHA256(raw_body)) against `X-Shopify-Hmac-Sha256` over RAW bytes. `X-Shopify-Shop-Domain` → look up `client_id`.

### Layer 3 — Remix App → Rekart Backend (Bearer Token)
Login → encrypt token AES-256-GCM → store in `ShopOnboarding.rekartAccessToken` → decrypt server-side per call → `Authorization: Bearer`. Passport opaque token, no refresh; `expires_at` → `rekartTokenExpiresAt`; 24h pre-expiry warning; 401/expiry → `tokenInvalid` banner. On reconnect: cross-tenant check — if stored `rekartMerchantId` differs from the new login's `client_id` → **403**.

### Layer 4 — Rekart Backend → Remix App (Static API Key)
`X-API-Key: REKART_STATIC_API_KEY`, constant-time compared in `verifyRekartToken`.

### Layer 5 — OAuth 2.0 (Planned, waiting on Pappu Q5)
Authorization-code redirect to Rekart, `state` nonce in `ShopOnboarding.rekartOAuthState`, callback exchanges code for token; same DB write as password login.

---

## Deployment

**Dev:** `shopify app dev` in `rekart-delivery/`; Cloudflare tunnel HTTPS (URL changes each restart).

**Production (planned):**
```bash
export DATABASE_URL="postgresql://user:password@host:5432/rekart_shopify"
npx prisma migrate deploy
npx ts-node scripts/migrate-tokens.ts --dry-run   # preview
npx ts-node scripts/migrate-tokens.ts             # migrate tokens to GCM
```
FastAPI reference backend is only deployed if Rekart chooses to run it as-is.

---

## Data Models (Logical)

### Shopify → Rekart Order Mapping
```
order.id               -> external_order_id
"shopify"              -> external_source
order.line_items       -> items[] (product_id via ShopifyProductLink, quantity, rate)
shipping_address       -> address_id (created via address/add)
ShopOnboarding.rekartMerchantId -> client_id (tenant)
ShopOnboarding.defaultSlotId    -> slot_id
"online" / "paid"      -> payment_type / payment_status
```

### Delivery Status Mapping
```
confirmed / packed -> fulfillmentCreate (open)
ready_to_ship      -> fulfillmentEventCreate IN_TRANSIT
shipped            -> fulfillmentEventCreate IN_TRANSIT
delivered          -> fulfillmentEventCreate DELIVERED
cancelled          -> orderCancel (hard cancel, no refund/restock)
failed             -> fulfillmentEventCreate FAILURE
return_collected   -> fulfillmentEventCreate ATTEMPTED_DELIVERY
```

### Multi-Tenant Isolation
`shopify_shops` (Rekart side, to build): `shop_domain → client_id`, 1:1, immutable.
On webhook: `X-Shopify-Shop-Domain` → `client_id` → scope all calls. Shopify-side
cross-tenant guard built (403 on mismatch, D013); Rekart-side enforcement pending.

---

## Environment Variables

**`rekart-delivery/.env`:**
```bash
SHOPIFY_API_KEY=954401100dd738ee168c9ebb21ae2e89
SHOPIFY_API_SECRET=<rotated secret — Partner Dashboard>
SCOPES=read_orders,read_customers,write_orders
SHOPIFY_APP_URL=                      # blank in dev (CLI manages it)
REKART_BACKEND_URL=https://dev3.rekart.io   # bare host, no /api
REKART_STATIC_API_KEY=<shared with Pappu>
ENCRYPTION_KEY=<openssl rand -hex 32> # REQUIRED — connect-rekart throws if missing
DATABASE_URL=postgresql://user:password@host:5432/rekart_shopify  # from DevOps
```

**`rekart-delivery/rekart-backend/.env`:**
```bash
SHOPIFY_API_SECRET=<same as above>
REKART_BACKEND_URL=https://dev3.rekart.io
REKART_STATIC_API_KEY=<same shared key>
DATABASE_URL=postgresql+asyncpg://user:password@host:5432/rekart_db
REDIS_URL=redis://localhost:6379/0
APP_ENV=development
```

---

## Configuration — `shopify.app.toml` key settings

```toml
name = "Rekart Delivery"
client_id = "954401100dd738ee168c9ebb21ae2e89"
application_url = "https://example.com"   # placeholder until production domain
embedded = true

[access_scopes]
scopes = "read_orders,read_customers,write_orders"

[webhooks]
api_version = "2025-10"
```

All migrations generated offline via `prisma migrate diff`; apply with
`prisma migrate deploy`. **Never run `prisma migrate dev` without a live PostgreSQL —
it hangs.**

---

## Technical Assumptions

1. Shopify app DB switched from MySQL to PostgreSQL — reuses the existing WhatsApp-server PostgreSQL instance (Rekart's own Laravel DB remains MySQL; the two are independent).
2. Rekart panel API uses **POST for reads** (`slot/list`, `product/list`, `plan/list`).
3. `panel/order/create` has `external_source`/`external_order_id` in the model; whether the API accepts them is unconfirmed (Q1).
4. Rekart customers keyed by `(client_id, phone)` → no-phone customers can't sync (`MISSING_PHONE`).
5. One product per Rekart subscription (Phase 2).
6. Rekart timezone trap — always send ISO-8601 UTC.
7. `SHOPIFY_API_SECRET` is static; rotation invalidates in-flight webhook HMACs.
8. Cloudflare tunnel URL changes each `shopify app dev` restart.
9. Token is long-lived (~1 year `expires_at`), no refresh token.
10. Rekart has no SKU model — name matching only; the `exact_sku` branch never fires.

---

## Technical Debt

### High
- PostgreSQL: reuse existing WhatsApp-server instance (DevOps to confirm credentials/DB).
- `delivery/info` path unknown (Q6) — blocks polling job.
- `panel/order/create` shape unconfirmed (Q1) — blocks Phase 3.
- OAuth 2.0 not built — interim password login in place (`rekartOAuthState` field ready).
- Backfill API version in `tasks.py` is `2024-01`; should match app `2025-10` (T137).

### Medium
- Shopify-side cross-tenant guard only; Rekart-side 1:1 enforcement pending (T140).
- `GdprRequest.payload` stores PII in plaintext TEXT — encrypt or 90-day purge (T138).
- `fetchRekartSlots` may need `appType`/`appVersion`/`platform` in body (Q7).
- `minutesToTime(1440)` edge case (T141) — only matters if a slot uses 1440.
- No end-to-end integration test (unit tests only).

### Low
- Dead `exact_sku` matching branch (T142).
- Sync Log shows push events only, not order-level detail.
- No activity feed / demo data / setup checklist on dashboard.
- `ENCRYPTION_KEY` validated on first login, not at boot (T139).

---

## Test & Build Status

- vitest: **21/21** (crypto, slot-time, product-matching, fulfillment-status)
- pytest (`rekart-backend/`): **20/20**
- `tsc --noEmit`: clean
- `react-router build`: clean
