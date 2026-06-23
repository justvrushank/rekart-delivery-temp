# DECISIONS.md
# Rekart Shopify App — Decision Log

All significant architectural, technical, and product decisions, in chronological order.
(Corrected against the codebase 2026-06-17.)

---

## D001 — FastAPI + Remix Split Architecture

**Date:** June 11, 2026

**Decision:** Originally, a Remix embedded app for UI/lifecycle webhooks plus a FastAPI service for high-volume data webhooks.

**Why:** FastAPI suited async Celery + high-throughput ingestion; Remix required for embedded admin UI + App Bridge.

**Current Status:** Revised. `rekart-backend/` is now a **reference spec for the Rekart Laravel team to port**, not a deployed service. The Remix app is the only deployed connector. FastAPI code kept as spec + 20 pytest tests.

---

## D002 — Webhook Routing: High-Volume Directly to Rekart Backend

**Date:** June 11-12, 2026

**Decision:** `orders/create`, `customers/create`, `customers/update` are registered with `callbackUrl` pointing DIRECTLY at `${REKART_BACKEND_URL}/webhooks/shopify/...`. Shopify delivers straight to Rekart, bypassing Remix.

**Why:** High-frequency data webhooks; routing through Remix adds latency and a bottleneck. Rekart verifies HMAC independently.

**Tradeoffs:** Pro: Rekart scales independently; Remix stateless for these paths. Con: `SHOPIFY_API_SECRET` must be shared with Rekart; Rekart maintains its own verification.

**Current Status:** CONFIRMED in `app/shopify.server.ts` (`hooks.afterAuth` + `webhooks` config; the three `callbackUrl`s). The order-sync **orchestration** therefore lives in Rekart's backend (task T097), NOT in Remix — see D021.

---

## D003 — Embedded Auth: Session Token Not Cookies

**Date:** June 11, 2026

**Decision:** Use `@shopify/shopify-app-react-router`'s `authenticate.admin(request)` (session tokens), not third-party cookies (removed by Shopify Jan 2025).

**Current Status:** ✅ All embedded routes call `authenticate.admin(request)`.

---

## D004 — Embedded Param Preservation on Redirects (Critical Fix)

**Date:** June 11-12, 2026 (after a 2-day login loop)

**Decision:** All server-side redirects preserve `shop`, `host`, `embedded`, `id_token`.

**Fix:**
```typescript
const url = new URL(request.url);
throw redirect(`/app/onboarding?${url.searchParams.toString()}`);
```

**Current Status:** ✅ Applied consistently. Documented as a setup note.

---

## D005 — Database: SQLite for Dev, MySQL for Production

**Date:** June 11 → June 16, 2026

**Decision:** Migrate SQLite → MySQL (AWS RDS).

**Migration details:** Fresh `20260616130926_init_mysql` via `prisma migrate diff --from-empty`. `@db.Text` on long fields (`rekartAccessToken`, `GdprRequest.payload`, `FulfillmentPush.lastError`, `trackingUrl`, `shopifyProductTitle`, `rekartProductName`). `utf8mb4_unicode_ci`. Apply with `prisma migrate deploy` (NOT `migrate dev` — hangs without a live DB).

**Current Status:** ✅ Schema migrated. Awaiting DevOps for the connection string.

---

## D006 — Token Encryption: AES-256-CBC → AES-256-GCM

**Date:** June 15-16, 2026

**Decision:** Encrypt the Rekart Passport token at rest with AES-256-GCM. Format `ivHex:authTagHex:cipherHex`; `setAuthTag()` before `decipher.update()`.

**Why GCM:** Authenticated encryption detects tampering; CBC-without-HMAC is vulnerable to bit-flip/padding-oracle.

**Migration:** `scripts/migrate-tokens.ts` (0 colons=plaintext→GCM, 1=CBC→GCM, 2=already GCM→skip), `--dry-run` flag.

**Current Status:** ✅ In `app/crypto.server.ts`. Crypto round-trip + tamper-rejection vitest tests passing.

---

## D007 — Token Storage: NOT in Shopify Session

**Date:** June 16, 2026

**Decision:** The Rekart token lives ONLY in `ShopOnboarding.rekartAccessToken` (MySQL), encrypted, decrypted server-side only, never in the Shopify `Session` table, never in the browser.

**Current Status:** ✅ Implemented.

---

## D008 — Delivery Status Sync: Polling Only (No Outbound Webhooks)

**Date:** June 15-16, 2026

**Decision:** 15-minute polling of `delivery/info` (Rekart has no outbound webhook system).

**Tradeoffs:** Pro: no Rekart changes needed, resilient. Con: up to 15-min delay, periodic API load.

**Current Status:** `POST /api/fulfillment-push` built (Remix). Polling job is spec in `rekart-backend/`. Where it runs (Rekart backend vs scheduled hit to the Remix sweep endpoint) is open. Waiting on `delivery/info` path (Q6).

---

## D009 — Product Mapping: Name Matching Only (No SKU)

**Date:** June 15-16, 2026

**Decision:** Auto-match by name only (exact name → fuzzy Levenshtein ≤ 3). SKU branch exists but never fires (Rekart has no SKU model). Scale guard: skip fuzzy if >500 variants OR >100 Rekart products.

**Current Status:** ✅ `app/product-matching.server.ts`. Covered by vitest. Dead `exact_sku` branch noted as debt (T142).

---

## D010 — Internal Navigation: useNavigate() Not s-button href

**Date:** June 16, 2026

**Decision:** In-content `s-button`/`s-link` internal nav uses `onClick={() => navigate(...)}`, not `href`. **Exception:** `s-app-nav` links in `app.tsx` keep `href` (App Bridge nav menu requires it).

**Current Status:** ✅ In-content nav converted; exception documented.

---

## D011 — GDPR: Durable Queue Before Forwarding

**Date:** June 15-16, 2026

**Decision:** Write a `GdprRequest` row (`status=pending`) before forwarding to Rekart. Failures stay pending and are retried by the sweep (MAX_RETRIES=10, terminal `failed`, `@@index([shop, status])`).

**Current Status:** ✅ `app/gdpr.server.ts`; sweep in `api.fulfillment-retry-sweep.tsx`. Debt: `payload` stores PII plaintext (T138).

---

## D012 — Account Linking: Password Login (Interim) → OAuth 2.0 (Planned)

**Date:** June 15-16, 2026

**Decision:** Interim embedded username/password form (`POST /api/auth/login`, password never stored — only the encrypted token). Planned OAuth 2.0 authorization-code flow.

**Minimal diff to switch:** replace form with redirect button; add `app.rekart-callback.tsx`; replace `loginToRekart(u,p)` with `exchangeRekartCode(code)`; use `ShopOnboarding.rekartOAuthState` (already in schema).

**Current Status:** Password login built + tested. OAuth waiting on Pappu (Q5).

---

## D013 — Cross-Tenant Protection: 403 on client_id Mismatch

**Date:** June 16, 2026

**Decision:** If a store already linked to one Rekart `client_id` tries to relink with credentials returning a different `client_id`, return 403 and block.

**Implementation (`app/routes/app.connect-rekart.tsx`, before DB write):**
```typescript
const existingOnboarding = await db.shopOnboarding.findUnique({
  where: { shop: session.shop },
  select: { rekartMerchantId: true },
});
if (existingOnboarding?.rekartMerchantId &&
    existingOnboarding.rekartMerchantId !== result.clientId) {
  return data({ error: "These credentials belong to a different Rekart account." }, { status: 403 });
}
```
(`rekartMerchantId` is `String?`; `result.clientId` is a string.)

**Current Status:** ✅ Built (Shopify side). Rekart-side `shopify_shops` 1:1 enforcement pending (Q8/T140).

---

## D014 — SHOPIFY_API_SECRET: One Secret for All Merchants

**Date:** June 16, 2026

**Decision:** ONE app-level `SHOPIFY_API_SECRET` for all merchants. Per-merchant values are `shpat_xxx` (Session), `rekartAccessToken`, `rekartMerchantId`. Shared with Pappu via WhatsApp only; rotated once.

**Current Status:** ✅ Documented. Rotated once.

---

## D015 — Slot Configuration: Merchant Picks Default in Settings

**Date:** June 16, 2026

**Decision:** Merchant configures a default Rekart `slot_id` in Settings; every Shopify order uses it. `ShopOnboarding.defaultSlotId`. Settings calls `POST /api/panel/slot/list`, shows "Morning (04:30 AM)"; dashboard warns if null; save-slot validates the submitted id against the merchant's real slots.

**Current Status:** ✅ Built. `fetchRekartSlots()` in `rekart.server.ts`; `minutesToTime()` in `app/slot-time.ts`. Waiting on live test (Q7).

---

## D016 — rekart-backend/: Reference Spec, Not Deployed Service

**Date:** June 15-16, 2026

**Decision:** `rekart-backend/` FastAPI code is a reference spec for Rekart's Laravel team, not a deployed service. Accidentally deleted (`746cd7f`), restored (`8c5e455`).

**Provides:** webhook handler structure, 20 pytest tests, Alembic migrations for `shopify_shops`, Celery task patterns, HMAC example.

**Current Status:** Restored. Documented as "NOT deployed." Debt: backfill API version `2024-01` should match app `2025-10` (T137).

---

## D017 — Onboarding: Yes/No Fork as First Screen

**Date:** June 16, 2026

**Decision:** First screen asks "Do you already use Rekart?" Yes → connect account; No → qualification form → pending-setup. `ShopOnboarding.existingRekartUser`. Guard: `existingRekartUser=true` + no `rekartMerchantId` routes to connect, not pending-setup.

**Current Status:** ✅ Built (`app.onboarding.tsx`, `app.pending-setup.tsx`).

---

## D018 — Phase 3 Schema: Pre-Build Before Implementation

**Date:** June 16, 2026

**Decision:** Add `ShopifyOrderSync`, `ShopifyCustomerSync`, and `rekartOAuthState` to the schema before Phase 3 implementation (plus `Session @@index([shop])`), in `phase3_schema_prep`.

**Current Status:** ✅ Migration applied. Tables exist but are not yet read/written (Phase 3 not started; see D021).

---

## D019 — Screenshots and App Store Submission: Reserved for Last

**Date:** June 16, 2026

**Decision:** Do NOT take App Store screenshots or submit until Phase 3 is complete and end-to-end tested.

**Current Status:** 🔴 Reserved for the final step.

---

## D020 — Market Research: Install and Study Competitor Apps

**Date:** June 17, 2026

**Decision:** Study Shipday, EasyRoutes, Zapiet before finalizing UX.

**Findings (Shipday + EasyRoutes done; Zapiet pending):** activity feed, setup checklist, order-level Sync Log, rider-app link, one-question-per-screen qualification, webhook registration to replace polling.

**Current Status:** 🟡 In progress (Zapiet pending).

---

## D021 — Phase 3 Order Sync Lives in Rekart Backend, Not Remix (Scaffold Deleted)

**Date:** June 17, 2026

**Decision:** The 4-step order-sync orchestration (customer → address → order → mapping) is built in **Rekart's Laravel backend** (task T097), per D002. A Remix-side scaffold (`syncShopifyOrderToRekart` in `rekart.server.ts`, a `webhooks.orders.create.tsx` route, an `orders/create` TOML subscription, and `order-sync.test.ts`) was prototyped while blocked on Pappu, then **deleted**.

**Context:** During a handoff-doc audit, the scaffold was found to contradict D002 — it created a second, competing delivery path for `orders/create` (one direct-to-Rekart per D002, one through Remix) and put the orchestration in the wrong service. Keeping it would cause confusion about where Phase 3 lives.

**Why delete rather than keep as reference:** The correct location (Rekart backend) is already documented (D002, T097), and the FastAPI reference spec (`rekart-backend/`) already shows the pattern. A second half-built path in the deployed Remix app is a liability, not a reference.

**Alternatives considered:** (a) keep as labeled reference — rejected (confusion + double-registration risk); (b) pivot to Remix-as-order-connector — rejected (a D002 reversal, not a scaffold decision; would need Mithil/Pappu sign-off).

**Current Status:** ✅ Scaffold removed; working tree clean; vitest back to 21/21. Phase 3 = NOT STARTED, orchestration owned by Rekart backend (T097).

---

## Summary Table

| ID | Decision | Date | Status |
|----|----------|------|--------|
| D001 | FastAPI + Remix split → FastAPI is reference spec only | Jun 11-16 | Revised ✅ |
| D002 | High-volume webhooks direct to Rekart backend | Jun 11-12 | Confirmed ✅ |
| D003 | Session token auth (not cookies) | Jun 11 | ✅ |
| D004 | Embedded param preservation on all redirects | Jun 11-12 | ✅ |
| D005 | SQLite → MySQL migration | Jun 11-16 | ✅ (awaiting DevOps) |
| D006 | AES-256-CBC → AES-256-GCM encryption | Jun 15-16 | ✅ |
| D007 | Rekart token NOT in Shopify session | Jun 16 | ✅ |
| D008 | Polling only for delivery status | Jun 15-16 | ✅ (location open) |
| D009 | Name matching only for product mapping | Jun 15-16 | ✅ |
| D010 | useNavigate() not s-button href (s-app-nav excepted) | Jun 16 | ✅ |
| D011 | GDPR durable queue before forwarding | Jun 15-16 | ✅ |
| D012 | Password login interim → OAuth 2.0 planned | Jun 15-16 | 🟡 Interim built |
| D013 | Cross-tenant 403 on client_id mismatch | Jun 16 | ✅ (Shopify side) |
| D014 | One SHOPIFY_API_SECRET for all merchants | Jun 16 | ✅ |
| D015 | Merchant picks default slot in Settings | Jun 16 | ✅ |
| D016 | rekart-backend/ is reference spec, not deployed | Jun 15-16 | ✅ |
| D017 | Yes/No fork as first onboarding screen | Jun 16 | ✅ |
| D018 | Phase 3 schema pre-built | Jun 16 | ✅ |
| D019 | Screenshots/submission reserved for last | Jun 16 | 🔴 Not yet |
| D020 | Market research: study competitor apps | Jun 17 | 🟡 In progress |
| D021 | Phase 3 order sync in Rekart backend; Remix scaffold deleted | Jun 17 | ✅ |
