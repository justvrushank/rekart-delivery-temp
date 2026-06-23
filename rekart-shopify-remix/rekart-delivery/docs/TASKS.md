# TASKS.md
# Rekart Shopify App — Complete Task List

**Last updated:** 2026-06-17
**Repo:** https://github.com/Rekart-io/rekart-delivery
**Last code commit:** `d70a100` on master (a Phase 3 Remix-side order-sync scaffold was prototyped after this and **removed** — orchestration belongs in the Rekart Laravel backend per D002/D021)

---

## ✅ Completed Tasks

### Infrastructure & Setup

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| T001 | Register Shopify app in Partner Dashboard | P0 | ✅ Done | Client ID: `954401100dd738ee168c9ebb21ae2e89` |
| T002 | Create dev store | P0 | ✅ Done | `rekart-dev-kysqlw9f.myshopify.com` |
| T003 | Initialize GitHub repo and push initial code | P0 | ✅ Done | Was `justvrushank/rekart-delivery`, transferred to `Rekart-io/rekart-delivery` |
| T004 | Update git remote to Rekart-io org URL | P1 | ✅ Done | `git remote set-url origin https://github.com/Rekart-io/rekart-delivery.git` |
| T005 | Fix tunnel/ngrok login loop (2-day debug) | P0 | ✅ Done | Root cause: stale Partner Dashboard URL. Fix: preserve embedded params on ALL redirects |
| T006 | Migrate database from SQLite to MySQL | P0 | ✅ Done | Migration `20260616130926_init_mysql`. utf8mb4_unicode_ci. `@db.Text` on long fields |
| T007 | Rotate exposed SHOPIFY_API_SECRET | P0 | ✅ Done | Old secret is INVALID. New secret in `.env` only |
| T008 | Submit Protected Customer Data access request | P0 | ✅ Done | 16/16 questions complete. Draft → reviewed at App Store submission |
| T009 | Confirm Subscription APIs approval | P0 | ✅ Done | `read_customer_payment_methods` and `write_own_subscription_contracts` approved |
| T010 | Delete dead scaffold `rekart-shopify-backend/` | P1 | ✅ Done | Commit `746cd7f`. Replaced by `rekart-backend/` reference spec |
| T011 | Restore FastAPI reference backend to `rekart-backend/` | P1 | ✅ Done | Commit `8c5e455`. 20 pytest tests passing |
| T012 | Add privacy policy and support URLs to Settings screen | P1 | ✅ Done | `https://rekart.io/privacy-policy` and `https://rekart.io/support` |

### Phase 1 — Core Infrastructure

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| T013 | Build OAuth install flow with `authenticate.admin` + `afterAuth` hook | P0 | ✅ Done | |
| T014 | Fix embedded param preservation on ALL server-side redirects | P0 | ✅ Done | Critical fix. Pattern: `throw redirect(`/app/path?${url.searchParams.toString()}`)` |
| T015 | Define Prisma schema: Session, ShopOnboarding, FulfillmentPush, FulfillmentLink | P0 | ✅ Done | |
| T016 | Build `webhooks.app.uninstalled.tsx` | P0 | ✅ Done | Deletes session, clears `rekartAccessToken`, `rekartMerchantId` |
| T017 | Build `webhooks.app.scopes_update.tsx` | P0 | ✅ Done | Updates session scopes |
| T018 | Build GDPR webhooks × 3 (data_request, customers_redact, shop_redact) | P0 | ✅ Done | All return 200 within 5s |
| T019 | Remove EPERM: `predev = "npx prisma generate"` from `shopify.web.toml` | P1 | ✅ Done | Was causing Windows file lock errors |

### Phase 2 — Onboarding

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| T020 | Build Yes/No fork as first onboarding screen | P0 | ✅ Done | "Do you already use Rekart?" → `existingRekartUser` field in schema |
| T021 | Build qualification form (5 fields: category, country, volume, subscribers, delivery ops) | P1 | ✅ Done | Schema fields: `businessCategory`, `country`, `orderVolume`, `subscriberCount`, `deliveryOps` |
| T022 | Build pending setup screen for new merchants | P1 | ✅ Done | "You're on the list! Team will reach out in 24h." Shows onboarding summary |
| T023 | Build Rekart account connect screen (username + password) | P0 | ✅ Done | `app/routes/app.connect-rekart.tsx` |
| T024 | Integrate `POST /api/auth/login` — confirmed working | P0 | ✅ Done | Tested with `9000000001`/`1234` on `dev3.rekart.io` |
| T025 | Build dashboard 3-way gate: onboarding → connect → dashboard | P0 | ✅ Done | `app._index.tsx` loader |
| T026 | Build Settings screen with "Disconnect Rekart account" vs "Stop syncing" | P1 | ✅ Done | Two distinct actions with different behaviors |
| T027 | Add `rekartMerchantId` + `rekartAccessToken` + `rekartTokenExpiresAt` to schema | P0 | ✅ Done | All stored per-shop in `ShopOnboarding` (`rekartMerchantId` is `String?`) |
| T028 | Add slot picker to Settings screen | P0 | ✅ Done | Calls `slot/list`, shows "Morning (04:30 AM)" format, saves `defaultSlotId` |
| T029 | Add dashboard warning banner when `defaultSlotId` is null | P0 | ✅ Done | Links to Settings screen |
| T030 | Add `rekartOAuthState` field to `ShopOnboarding` for OAuth CSRF nonce | P1 | ✅ Done | Schema ready for when OAuth 2.0 is implemented |

### Phase 4 — Product Mapping (Scaffold)

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| T031 | Add `ShopifyProductLink` model to Prisma schema | P1 | ✅ Done | `@@unique([shopId, shopifyVariantId])`, `id String @default(cuid())`, column `shopifySku` |
| T032 | Build auto-match algorithm: exact name → exact SKU → fuzzy (Levenshtein ≤ 3) → none | P1 | ✅ Done | `app/product-matching.server.ts`. Inline Levenshtein, no library |
| T033 | Add scale guard to fuzzy matching (skip if >500 variants or >100 Rekart products) | P1 | ✅ Done | Prevents Node event loop block |
| T034 | Build product mapping screen scaffold | P1 | ✅ Done | `app/routes/app.products.tsx`. Shopify GraphQL product fetch, auto-match display |
| T035 | Add Zod validation on product mapping save action | P1 | ✅ Done | `MappingSchema`; payload field is `shopifySkuCode`, persisted to column `shopifySku` |

### Phase 5 — Fulfillment Push

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| T036 | Build `POST /api/fulfillment-push` endpoint | P0 | ✅ Done | `X-API-Key` auth, Zod validated |
| T037 | Build Shopify GraphQL fulfillment service | P0 | ✅ Done | `fulfillmentCreate` + `fulfillmentEventCreate` |
| T038 | Build delivery status → Shopify action mapping | P0 | ✅ Done | 5 statuses: scheduled/out_for_delivery/delivered/failed/return_collected |
| T039 | Build `FulfillmentLink` cache (no duplicate fulfillments per order) | P0 | ✅ Done | `@@unique([shop, shopifyOrderId])`, stores `shopifyFulfillmentId` |
| T040 | Build retry queue (6 attempts, exponential backoff, `dead` terminal) | P0 | ✅ Done | |
| T041 | Build `POST /api/fulfillment-retry-sweep` (authenticated, sweeps FulfillmentPush + GDPR) | P0 | ✅ Done | |

### Phase 6 — Dashboard & Sync Log

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| T042 | Build dashboard stats cards with 2500ms timeout + graceful fallback | P0 | ✅ Done | |
| T043 | Build connection status banner (Connected / Unreachable / Not configured) | P0 | ✅ Done | |
| T044 | Build Sync Log screen with filter by status/type + retry button | P1 | ✅ Done | |
| T045 | Add empty states and loading skeletons to all screens | P1 | ✅ Done | |
| T046 | Add sync error banner (last FulfillmentPush `dead`) | P1 | ✅ Done | |
| T047 | Parallelize dashboard loader (Promise.all for fetchSyncStats + findFirst) | P2 | ✅ Done | ~200ms improvement |

### Security Hardening

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| T048 | Implement AES-256-CBC encryption for `rekartAccessToken` | P0 | ✅ Done (superseded) | Replaced by T049 |
| T049 | Migrate AES-256-CBC → AES-256-GCM encryption | P0 | ✅ Done | `ivHex:authTagHex:cipherHex`. `setAuthTag()` before `decipher.update()` |
| T050 | Build token migration script `scripts/migrate-tokens.ts` | P0 | ✅ Done | Handles 0/1/2-colon cases. `--dry-run` flag added |
| T051 | Add `GdprRequest` Prisma model + durable queue before forwarding | P0 | ✅ Done | Write before forward, retry up to MAX_RETRIES=10 |
| T052 | Add `@@index([shop, status])` to `GdprRequest` + MAX_RETRIES=10 cap | P1 | ✅ Done | Terminal `failed` status at cap |
| T053 | Add Zod validation on `api.fulfillment-push.tsx` | P0 | ✅ Done | Status enum, required string fields, optional tracking object |
| T054 | Add `tokenInvalid` boolean to `ShopOnboarding` + 401 detection | P0 | ✅ Done | `fetchSyncStats` returns `{ tokenInvalid: true }` on 401 |
| T055 | Add `rekartTokenExpiresAt` + 24h warning banner | P1 | ✅ Done | Stored on login, checked in dashboard loader |
| T056 | Fix pending-setup routing gap (existing user lands on wrong screen) | P1 | ✅ Done | Redirect to `connect-rekart` if `existingRekartUser=true` + no `rekartMerchantId` |
| T057 | Add `Session @@index([shop])` to prevent full table scan | P1 | ✅ Done | In `phase3_schema_prep` migration |
| T058 | Replace `s-button href` internal nav with `useNavigate()` | P0 | ✅ Done | App Review requirement. Exception: `s-app-nav` keeps `href` |
| T059 | Add cross-tenant client_id protection (403 on mismatch) | P0 | ✅ Done | In `app.connect-rekart.tsx` action before DB write |
| T060 | Validate slotId against merchant's actual slots in save-slot action | P1 | ✅ Done | Calls `fetchRekartSlots` to verify submitted ID is real |
| T061 | Add crypto round-trip vitest tests | P1 | ✅ Done | GCM encrypt→decrypt, tamper rejection |

### Documentation

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| T062 | Create API contract v0.2 (`docs/rekart-shopify-api-contract.md`) | P1 | ✅ Done | 16 endpoints documented |
| T063 | Create implementation plan v0.2 (`docs/rekart-shopify-implementation-plan.md`) | P1 | ✅ Done | 8 phases, corrected from v0.1 |
| T064 | Create FastAPI contract (`docs/fastapi-contract.md`) | P1 | ✅ Done | |
| T065 | Redact real API key from curl examples in API contract | P0 | ✅ Done | Replaced with `rks_your_api_key_here` |
| T066 | Correct implementation plan: cross-tenant claim, schema, architecture note | P1 | ✅ Done | Commit `d70a100` |
| T066b | Commit handoff docs (TASKS, ARCHITECTURE, DECISIONS, PROJECT_CONTEXT) to `docs/`, corrected against code | P1 | ✅ Done | This set. Fixed 7 factual errors found in audit |

### Phase 3 Schema Pre-build

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| T067 | Add `ShopifyOrderSync` model to Prisma schema | P1 | ✅ Done | `@@unique([shop, shopifyOrderId])`, `@@index([status, nextAttemptAt])` |
| T068 | Add `ShopifyCustomerSync` model to Prisma schema | P1 | ✅ Done | Includes `rekartAddressId` for address step |
| T069 | Apply `phase3_schema_prep` migration | P1 | ✅ Done | Session index + new models + rekartOAuthState |

> **Note on the Phase 3 order-sync scaffold:** A Remix-side `syncShopifyOrderToRekart` orchestrator + `webhooks.orders.create.tsx` route + tests were prototyped, then **deleted** (see D021). The orchestration is intentionally the Rekart Laravel backend's responsibility per D002 (task T097). Only the *schema* (T067–T069) was kept as pre-build.

---

## 🟡 In Progress

| # | Task | Priority | Dependencies | Status | Notes |
|---|------|----------|--------------|--------|-------|
| T070 | Market research: Shipday app analysis | P2 | None | 🟡 Complete | Key finding: webhook registration would replace 15-min polling |
| T071 | Market research: EasyRoutes app analysis | P2 | None | 🟡 Complete | Key finding: activity feed + persistent setup guide needed |
| T072 | Market research: Zapiet app analysis | P2 | None | 🔴 Not started | Install Zapiet on dev store. Focus: account connect flow, Settings screen |
| T073 | Generate project handoff package (PROJECT_CONTEXT.md, DECISIONS.md, ARCHITECTURE.md, TASKS.md) | P1 | None | ✅ Done | Committed to `docs/`, corrected against code |

---

## 🔴 Blocked Tasks

### Blocked on Pappu (Rekart Backend Dev)

| # | Task | Priority | Blocked By | Notes |
|---|------|----------|------------|-------|
| T074 | Confirm `panel/order/create` accepts `external_source`, `external_order_id`, `items[]` | P0 | Q1 from Pappu | Cannot write Phase 3 order sync until confirmed |
| T075 | Confirm `user/{user}/address` — exact path, required fields, `zone_id` requirement | P0 | Q2 from Pappu | Required for address creation step in order sync |
| T076 | Confirm `panel/customer/create` upsert on `(client_id, phone)`, phone=null handling | P0 | Q3 from Pappu | Required for customer sync |
| T077 | Confirm `zone_id` resolution — pincode→zone lookup or skip | P0 | Q4 from Pappu | Required for address creation |
| T078 | Get OAuth 2.0 URL + params + `client_id` + `client_secret` from Pappu | P0 | Q5 from Pappu | Pappu confirmed URL is ready but never shared details |
| T079 | Confirm `delivery/info` endpoint path and `DeliveryItem.status` enum | P0 | Q6 from Pappu | Required for polling job |
| T080 | Confirm `panel/slot/list` requires `appType`/`appVersion`/`platform` in POST body | P1 | Q7 from Pappu | Current `fetchRekartSlots` sends bare POST — may fail silently |
| T081 | Confirm `shopify_shops` table exists + get registration endpoint | P0 | Q8 from Pappu | Required for multi-tenant webhook routing in Rekart backend |
| T082 | Build Phase 3 order sync (4-step flow) — **in Rekart Laravel backend** | P0 | T074, T075, T076, T077, T079 | Step 1: customer create, Step 2: address add, Step 3: order create, Step 4: store mapping. NOT STARTED (Remix scaffold deleted per D002/D021) |
| T083 | Build Phase 3 customer sync (customers/create, customers/update handlers) — **Rekart backend** | P0 | T075, T076 | Handle missing phone edge case |
| T084 | Build delivery status polling job (every 15 min) | P0 | T079 | In `rekart-backend/app/tasks.py` reference or Rekart backend |
| T085 | Build OAuth 2.0 account linking flow (Remix side) | P0 | T078 | Replace `app.connect-rekart.tsx` form with OAuth redirect + callback route |
| T086 | Test `panel/slot/list` against live `dev3.rekart.io` | P1 | Q7 from Pappu | Confirm `fetchRekartSlots` works in production |
| T087 | Ask Pappu about webhook registration (like Shipday) to replace 15-min polling | P2 | Market research | Would give real-time delivery status updates |

### Blocked on Mithil (Product Owner)

| # | Task | Priority | Blocked By | Notes |
|---|------|----------|------------|-------|
| T088 | Decide: new merchant provisioning — auto-create account or capture as lead? | P1 | Mithil decision | Affects `app.pending-setup.tsx` UX and backend provisioning API |
| T089 | Get production domain for `shopify.app.toml` `application_url` | P1 | Mithil decision | Required before App Store submission |
| T090 | Get app icon 512×512 PNG from design team | P1 | Design team | Required for App Store listing |
| T091 | Approve App Store listing copy | P1 | Mithil approval | Draft copy already written |
| T092 | Pay $19 App Store registration fee | P0 | Mithil approval + end-to-end test passing | Do NOT pay until Phase 3 is complete and tested |

### Blocked on DevOps

| # | Task | Priority | Blocked By | Notes |
|---|------|----------|------------|-------|
| T093 | Get MySQL 8.0+ RDS connection string | P0 | DevOps | Required to run `prisma migrate deploy` |
| T094 | Get Redis connection string | P1 | DevOps | Required for Celery task queue if FastAPI polling job deployed |
| T095 | Apply all Prisma migrations to production MySQL | P0 | T093 | Command: `npx prisma migrate deploy` |
| T096 | Run token migration script on production | P0 | T093, T095 | `npx ts-node scripts/migrate-tokens.ts --dry-run` then without `--dry-run` |

---

## 🔮 Future Tasks

### Phase 3 Implementation (When Pappu Answers)

| # | Task | Priority | Dependencies | Notes |
|---|------|----------|--------------|-------|
| T097 | Build `orders/create` webhook handler in Rekart Laravel backend | P0 | T081, T082 | Verify HMAC, look up `client_id` from `shopify_shops`, call `panel/order/create`. **This is where Phase 3 orchestration lives (D002).** |
| T098 | Build `customers/create` webhook handler in Rekart Laravel backend | P0 | T081, T083 | |
| T099 | Build `customers/update` webhook handler in Rekart Laravel backend | P0 | T081, T083 | |
| T100 | Build `GET /api/shops/{shop}/stats` endpoint on Rekart backend | P1 | T097, T098 | For dashboard sync stats. Must respond within 2500ms |
| T101 | Build GDPR endpoints on Rekart backend (data-request, redact, shop-redact) | P0 | None | Required before App Store submission |
| T102 | Build Shopify order backfill job (last 90 days on new install) | P2 | T082 | Update API version in `tasks.py` to match app (`2025-10`) |
| T103 | Handle missing phone edge case in customer sync | P1 | T083 | Log `MISSING_PHONE` sync error, skip customer |
| T104 | End-to-end test: place order → appears in Rekart → rider delivers → Shopify updates | P0 | T082, T084, T097 | Required before paying $19 |

### Phase 7 — QA & App Store Prep (After Phase 3 Complete)

| # | Task | Priority | Dependencies | Notes |
|---|------|----------|--------------|-------|
| T105 | GDPR webhook tests via `shopify webhook trigger` | P0 | T101 | `--topic customers/data_request`, `customers/redact`, `shop/redact` |
| T106 | Reinstall loop test × 3 (uninstall → reinstall) | P0 | Phase 3 complete | Confirm no login loop, no stale session |
| T107 | Lighthouse audit on all 4 screens (must be under 3s) | P0 | Phase 3 complete | |
| T108 | DevTools console audit (zero errors in embedded app) | P0 | Phase 3 complete | |
| T109 | Take 6 App Store screenshots at exactly 1280×800 | P0 | T092, Phase 3 complete | DO LAST. Screens: onboarding fork, qual form, connect Rekart, dashboard, settings with slot picker, sync log |
| T110 | Fill Partner Dashboard listing fields (App URL, redirect URLs, privacy URL, support URL) | P0 | T092 | Requires $19 fee paid first |
| T111 | Enter approved listing copy in Partner Dashboard | P0 | T091, T092 | Draft copy already written |
| T112 | Upload app icon | P0 | T090, T092 | 512×512 PNG |
| T113 | Set production `application_url` in `shopify.app.toml` | P0 | T089 | |
| T114 | Set production `redirect_urls` in `shopify.app.toml` | P0 | T089 | |

### Phase 8 — Launch & Post-Launch

| # | Task | Priority | Dependencies | Notes |
|---|------|----------|--------------|-------|
| T115 | Submit app for Shopify App Store review | P0 | T105-T114 all complete | |
| T116 | Deploy Remix app to production | P0 | T089, T093 | Production domain must be confirmed |
| T117 | Deploy FastAPI backend (if Rekart team uses it) | P2 | T093, T094 | May be ported to Laravel instead |
| T118 | Run `prisma migrate deploy` on production MySQL | P0 | T093 | |
| T119 | Run token migration script on production | P0 | T118 | `--dry-run` first |
| T120 | Set up monitoring alerts (webhook failure rate, Celery queue depth) | P1 | T116 | |
| T121 | Write support runbook | P1 | Phase 3 complete | Common errors, retry steps, escalation path |
| T122 | Onboard first real merchant (internal Rekart client as pilot) | P0 | T115 approved | |
| T123 | Monitor first merchant's sync health for 48h | P0 | T122 | |

### OAuth 2.0 Implementation (When Pappu Provides URL)

| # | Task | Priority | Dependencies | Notes |
|---|------|----------|--------------|-------|
| T124 | Replace `app.connect-rekart.tsx` form with "Connect with Rekart" OAuth redirect button | P0 | T078 | ~1h |
| T125 | Build `app/routes/app.rekart-callback.tsx` (receives code, verifies state, exchanges for token) | P0 | T078 | ~1h |
| T126 | Replace `loginToRekart(u,p)` with `exchangeRekartCode(code)` in `rekart.server.ts` | P0 | T078 | ~30min |

### UX Improvements (Post-Launch)

| # | Task | Priority | Dependencies | Notes |
|---|------|----------|--------------|-------|
| T127 | Add activity feed to dashboard (recent sync events) | P2 | Phase 3 complete | EasyRoutes has this |
| T128 | Add persistent setup checklist to dashboard | P2 | Phase 3 complete | Like Shipday/EasyRoutes |
| T129 | Expand Sync Log to show order-level details (not just push events) | P2 | Phase 3 complete | Like Shipday's order list |
| T130 | Surface Rekart rider app link after account connect | P3 | Phase 3 complete | |
| T131 | Add mock/demo data on first dashboard load | P3 | Phase 3 complete | EasyRoutes "Try a demo route" pattern |
| T132 | Split qualification form into one-question-per-screen | P3 | None | Shipday UX pattern |

### Phase 2 — Subscription Sync (Future)

| # | Task | Priority | Dependencies | Notes |
|---|------|----------|--------------|-------|
| T133 | Design Shopify Selling Plan → Rekart subscription `pattern_data` mapping | P2 | Phase 3 complete | |
| T134 | Build subscription sync: Shopify contract → `panel/subscription/create` | P2 | T133, Phase 3 complete | Multi-item cart = multiple Rekart subscriptions |
| T135 | Build bidirectional sync: WhatsApp pause/cancel → Shopify contract update | P3 | T134 | |
| T136 | Build Shopify Selling Plans for merchant product catalog | P2 | T133 | Uses `write_own_subscription_contracts` scope (approved) |

### Technical Debt Items

| # | Task | Priority | Dependencies | Notes |
|---|------|----------|--------------|-------|
| T137 | Update backfill job API version in `tasks.py` to match app (`2024-01` → `2025-10`) | P1 | None | 15 min fix (note: app is on `2025-10`, not `2026-04`) |
| T138 | Encrypt or delete `GdprRequest.payload` PII after 90 days | P2 | None | Currently stored in plaintext `TEXT` column |
| T139 | Add `ENCRYPTION_KEY` startup validation (throw at boot, not on first login) | P2 | None | Currently throws only when merchant tries to connect |
| T140 | Rekart-side enforcement: `shopify_shops` immutable `shop_domain → client_id` | P1 | T081 | Shopify side built (T059), Rekart side pending |
| T141 | Fix `minutesToTime(1440)` edge case | P3 | None | Returns "12:00 PM" for 1440; only matters if a slot uses 1440 (slots are 0–1439) |
| T142 | Remove or document dead SKU matching code in `product-matching.server.ts` | P3 | None | Rekart has no SKU model → `matchConfidence:'exact_sku'` never fires |

---

## Summary Counts

| Category | Count |
|----------|-------|
| ✅ Completed | 70 tasks (T001–T069, T073) |
| 🟡 In Progress / research | 3 tasks (T070–T072) |
| 🔴 Blocked | 23 tasks (T074–T096) |
| 🔮 Future | 46 tasks (T097–T142) |

**Test status:** vitest **21/21** ✅ · pytest **20/20** ✅ · `tsc --noEmit` clean ✅ · `react-router build` clean ✅

---

## Critical Path

```
Pappu answers Q1-Q8 (T074-T081)
        ↓
Build Phase 3 order + customer sync IN REKART BACKEND (T082-T084, T097-T103)
        ↓
End-to-end test passes (T104)
        ↓
DevOps provisions MySQL + Redis (T093-T096)
        ↓
Mithil pays $19 fee (T092)
        ↓
QA & App Store prep (T105-T114)
        ↓
Submit for review (T115)
        ↓
Shopify reviews (7-30 days)
        ↓
App Store live ✅
```

**Current bottleneck:** Pappu's answers to Q1-Q8. Every day without those answers is a day of schedule slip.

---

## Open Questions Tracker

| Q# | Question | For | Blocks | Status |
|----|----------|-----|--------|--------|
| Q1 | Does `panel/order/create` accept `external_source`, `external_order_id`, `items[]`? | Pappu | T082 | 🔴 Unresolved |
| Q2 | What is `user/{user}/address` path + required fields? Does it need `zone_id`? | Pappu | T083 | 🔴 Unresolved |
| Q3 | Does `panel/customer/create` upsert on `(client_id, phone)` or throw? Phone=null? | Pappu | T083 | 🔴 Unresolved |
| Q4 | Is there a pincode→zone lookup? Or can we create address without `zone_id`? | Pappu | T082 | 🔴 Unresolved |
| Q5 | OAuth 2.0 URL + params + callback format + `client_id` + `client_secret` | Pappu | T124-T126 | 🔴 Unresolved |
| Q6 | `delivery/info` exact path? `DeliveryItem.status` enum values? | Pappu | T084 | 🔴 Unresolved |
| Q7 | Does `panel/slot/list` require `appType`/`appVersion`/`platform` in POST body? | Pappu | T086 | 🔴 Unresolved |
| Q8 | Does `shopify_shops` table exist? What's the shop registration endpoint? | Pappu | T097-T099 | 🔴 Unresolved |
| Q9 | New merchant provisioning: auto-create Rekart account or capture as sales lead? | Mithil | T088 | 🔴 Unresolved |
| Q10 | What is the production domain for the Shopify app? | Mithil | T089, T113 | 🔴 Unresolved |
| Q11 | MySQL 8.0+ RDS connection string | DevOps | T093, T095 | 🔴 Unresolved |
| Q12 | Redis connection string | DevOps | T094 | 🔴 Unresolved |
