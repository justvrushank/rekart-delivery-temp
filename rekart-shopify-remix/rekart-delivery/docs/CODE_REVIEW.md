# Code Review — Full App Findings & Recommended Fixes

**Date:** 2026-06-25
**Scope:** Whole codebase — Remix/TypeScript app (`app/`, the deployed service), the FastAPI reference backend (`rekart-backend/`), the checkout extension, and the Prisma schema.
**Method:** Multi-angle recall review (correctness, security, cross-file/contract, language pitfalls, reuse/simplification/efficiency, altitude, conventions) + a gap sweep. Each finding below was verified against the actual code.

**Key framing:** `rekart-backend/` (FastAPI) is, per `docs/ARCHITECTURE.md`, a **non-deployed reference spec**. The deployed Remix app calls the external **Laravel** backend (`REKART_BACKEND_URL=dev3.rekart.io`). Findings that assumed the Remix app talks to the in-repo FastAPI service (endpoint/field "mismatches") are therefore **false positives for production** and were excluded (see the end). FastAPI-only issues are marked **Conditional** — they only bite if Rekart deploys the reference backend as-is.

Severity legend: 🔴 blocker · 🟠 high · 🟡 medium · ⚪ low.

---

## A. Correctness — deployed Remix app

### 1. 🔴 Prisma datasource is `provider = "sqlite"` with zero `@db.Text` annotations
`prisma/schema.prisma:13`. Production is MySQL (`.env.example`, `docs/ARCHITECTURE.md` D005). On MySQL, un-annotated `String` columns default to `VARCHAR(191)`. `rekartAccessToken` is an AES-256-GCM ciphertext (its own comment at `:58` says *"well over MySQL's default VARCHAR(191); needs TEXT"*); `GdprRequest.payload` (full webhook PII body), `FulfillmentPush.lastError`/`trackingUrl`, `shopifyProductTitle`, `rekartProductName` all overflow → insert failures: merchants can't link Rekart, GDPR rows fail to persist. SQLite migrations also won't match MySQL. The file's own TODO (`:12`) flags the revert.

**Fix:** Restore the MySQL provider and re-add `@db.Text` to every long field, then regenerate the migration offline.
```prisma
datasource db {
  provider = "mysql"          // was "sqlite"
  url      = env("DATABASE_URL")
}
```
Add `@db.Text` to: `ShopOnboarding.rekartAccessToken`, `GdprRequest.payload`, `FulfillmentPush.lastError`, `FulfillmentPush.trackingUrl`, `ShopifyProductLink.shopifyProductTitle`, `ShopifyProductLink.rekartProductName`, `ShopifyOrderSync.lastError`. Regenerate via `prisma migrate diff ... --script` (never `migrate dev` without live MySQL). Add a CI grep that fails the build if `provider = "sqlite"` reappears.

### 2. 🟠 `/api/fulfillment-push` requires fields the contract marks optional
`app/routes/api.fulfillment-push.tsx:18-19`. `rekart_delivery_id` and `occurred_at` use `z.string().min(1)` (required), but `docs/rekart-to-shopify-contract.md` lists both as optional ("no"). A contract-compliant Rekart push omitting either gets `422`, and the delivery status never lands on the Shopify order.

**Fix:** Make them optional; validate `occurred_at` as a real ISO timestamp at the boundary.
```ts
rekart_delivery_id: z.string().min(1).optional(),
occurred_at: z.string().datetime({ offset: true }).optional(),
```
`PushInput` already accepts nullable `occurredAt`/`rekartDeliveryId`, so no downstream change is needed.

### 3. 🟠 Malformed `occurred_at` throws and breaks the "always 200" guarantee
`app/fulfillment.server.ts:340` (+ route at `api.fulfillment-push.tsx:62`). `occurred_at` is only validated as non-empty, then `new Date(input.occurredAt)` on an unparseable value yields `Invalid Date`, which Prisma rejects by throwing. The route awaits `handleFulfillmentPush` with no try/catch → `500` instead of the intended `200 {ok:false}`, so Rekart retries the webhook indefinitely.

**Fix:** Never construct an invalid Date, and add a route backstop.
```ts
function parseOccurredAt(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
```
Use `parseOccurredAt(input.occurredAt)` in both upsert branches. In the route, wrap the handler in try/catch and return **500** on a thrown handler (so Rekart retries a genuinely-unrecorded push) rather than silently dropping it.

### 4. 🟠 Retry sweep has no row claim/lock → concurrent double-processing
`app/fulfillment-retry.server.ts:51`. `processDuePushes` does `findMany` then loops with no claim. With the in-process worker on >1 instance, or cron overlapping the worker, two sweeps select the same due rows and re-post **non-idempotent** Shopify fulfillment events → duplicate `DELIVERED`/`IN_TRANSIT` events; rows churn to `dead`.

**Fix:** Atomically claim each row before pushing (Prisma/MySQL has no `SKIP LOCKED` helper, so use an optimistic claim that pushes `nextAttemptAt` forward and processes only rows you won):
```ts
const candidates = await db.fulfillmentPush.findMany({
  where: { status: "pending", nextAttemptAt: { lte: new Date() } },
  orderBy: { nextAttemptAt: "asc" }, take: limit, select: { id: true },
});
const claimUntil = new Date(Date.now() + 5 * 60_000);
const due = [];
for (const { id } of candidates) {
  const claimed = await db.fulfillmentPush.updateMany({
    where: { id, status: "pending", nextAttemptAt: { lte: new Date() } },
    data: { nextAttemptAt: claimUntil },
  });
  if (claimed.count === 1) due.push(await db.fulfillmentPush.findUniqueOrThrow({ where: { id } }));
}
```
Interim mitigation: document that the cron sweep and `ENABLE_FULFILLMENT_RETRY_WORKER` are mutually exclusive, and never run the worker on more than one instance.

### 5. 🟠 Re-delivery resets `status` but not `attempts`
`app/fulfillment.server.ts:342-353`. The upsert `update` branch sets `status:"pending"` and clears `nextAttemptAt`/`lastError`, but leaves `attempts`; `applyResult(row.id, row.attempts + 1, …)` then immediately re-marks a previously-exhausted (`dead`) transition `dead`. A legitimately re-delivered status that once hit `MAX_ATTEMPTS` never gets a fresh retry budget.

**Fix:** Reset the counter in the `update` branch.
```ts
update: { status: "pending", attempts: 0, lastError: null, nextAttemptAt: null, /* ...inputs */ }
```

### 6. 🟡 `cancelled` hard-cancels the Shopify order, contradicting the docs
`app/fulfillment-status.ts:36`. `cancelled` maps to `orderCancel` (no refund/restock), but `docs/ARCHITECTURE.md` ("Delivery Status Mapping") says `cancelled → FAILURE event`, and `cancelled` isn't in the documented status enum — yet `api.fulfillment-push` accepts it via `z.enum(REKART_STATUSES)`. If Rekart sends it, the app cancels the merchant's order outright.

**Fix (product decision — confirm first):** Default to matching the docs:
```ts
cancelled: { kind: "event", eventStatus: "FAILURE", label: "Delivery cancelled" },
```
If a hard cancel is genuinely intended, add `cancelled` to `docs/rekart-to-shopify-contract.md` and decide `refund`/`restock` deliberately instead of hard-coding `false`.

### 7. 🟡 Product-mapping `selected` state never re-syncs after revalidation
`app/routes/app.products.tsx:559`. `selected` is seeded once by a lazy `useState(() => …)` initializer with no `useEffect`. The just-shipped **"Refresh catalog"** button (`:798`) revalidates the loader — new products appear in the dropdown, but `selected` keeps mount-time values, so a newly auto-matched variant still shows "— Not mapped —".

**Fix:** Split loader-derived base selection from user overrides so refresh surfaces new auto-matches while in-progress edits survive.
```ts
const baseSelected = useMemo(() => {
  const initial: Record<string, string> = {};
  for (const row of autoMatches) {
    const saved = savedByVariant.get(row.shopifyVariantId);
    initial[row.shopifyVariantId] = saved ? String(saved.rekartProductId)
      : row.rekartProductId != null ? String(row.rekartProductId) : "";
  }
  return initial;
}, [autoMatches, savedByVariant]);

const [overrides, setOverrides] = useState<Record<string, string>>({});
const selected = useMemo(() => ({ ...baseSelected, ...overrides }), [baseSelected, overrides]);
// renderPicker onChange → setOverrides(prev => ({ ...prev, [variantId]: value }))
```

### 8. 🟡 Slot save fails closed on a transient backend blip
`app/routes/app.settings.tsx:90-96`. `fetchRekartCatalog(session.shop)` returns `{error}` on any backend failure → `slots = []` → `slots.some(...)` is false → `422 "Invalid slot selected."` for a valid slot, and nothing is saved. (It also ignores the stored `cache_id`.)

**Fix:** Distinguish "couldn't verify" from "invalid", and pass the cache id.
```ts
const onboarding = await getOnboarding(session.shop);            // add in the action
const catalog = await fetchRekartCatalog(session.shop, onboarding?.rekartCacheId);
if ("error" in catalog) {
  return data({ disconnected: false, slotSaved: false,
    error: "Couldn't reach Rekart to verify the slot. Please try again." }, { status: 503 });
}
if (!catalog.slots.some((s) => s.slot_id === slotId)) {
  return data({ disconnected: false, slotSaved: false, error: "Invalid slot selected." }, { status: 422 });
}
```

### 9. 🟡 Unguarded query inside the dashboard `Promise.all` can crash the page
`app/routes/app._index.tsx:73`. `fetchShopStats` and `healRekartConnection` can't throw by design, but `db.fulfillmentPush.findFirst` (`:75`) is unguarded; a transient DB error rejects the whole `Promise.all` → error boundary instead of the dashboard.

**Fix:** Isolate the query.
```ts
db.fulfillmentPush.findFirst({ where: { shop: session.shop, status: "dead" }, orderBy: { updatedAt: "desc" } })
  .catch((e) => { console.error("[dashboard] dead-push lookup failed:", e); return null; }),
```

### 10. 🟡 "Stop syncing" reuses the uninstall webhook path
`app/routes/app.settings.tsx:112`. The reversible "Stop syncing" pause forwards to `/webhooks/shopify/app/uninstalled`; the backend can't tell a pause from a real uninstall, and the uninstall handler also clears `access_token` — so reconnecting after a pause can find backend integration state wiped.

**Fix:** Give the pause its own signal that marks the shop inactive without clearing the token.
```ts
await forwardToBackend("/webhooks/shopify/app/deactivate", { shop: session.shop, reason: "merchant_pause" });
```
Backend handler: set `is_active = False` only; leave `access_token` intact. The real uninstall webhook keeps clearing the token.

### 11. ⚪ A DB failure after a successful push re-posts a non-idempotent event
`app/fulfillment-retry.server.ts:64` (acknowledged in the in-file NOTE). If `pushFulfillmentStatus` succeeds but `applyResult` throws, the row stays `pending` and the next sweep re-posts the same `DELIVERED`/`IN_TRANSIT` event.

**Fix:** Make event re-pushes idempotent, mirroring the existing `ORDER_ALREADY_CANCELLED` handling in `cancelOrder` — treat Shopify's duplicate-event error as success in `createEvent`:
```ts
if (userErrors.length) {
  if (userErrors.some((e) => /already|duplicate/i.test(e.message))) return { ok: true, fulfillmentId };
  return { ok: false, error: userErrorsToString(userErrors) };
}
```
Confirm Shopify's exact duplicate-event code and match on the code rather than a regex. Combined with #5, this closes the duplicate window.

### 12. ⚪ Sync Log `"failed"` filter never matches any row
`app/sync-log.constants.ts:8` / `app/sync-log.server.ts:24`. `applyResult` only writes `pending|succeeded|dead`, but `"failed"` is exposed as a filter, so filtering by it always returns zero rows.

**Fix:** Align the filter vocabulary to the writer and relabel in the UI.
```ts
// sync-log.constants.ts
export const PUSH_STATUSES = ["pending", "succeeded", "dead"] as const;
```
Render the `dead` option with the user-facing label "Failed" in `app.sync-log.tsx` (no query change needed).

### 13. ⚪ `app/scopes_update` webhook can 500 on a missing `current`
`app/routes/webhooks.app.scopes_update.tsx:9`. `payload.current as string[]` then `current.toString()` throws if Shopify ever omits `current`; the action has no try/catch, so the webhook 500s and retries.

**Fix:** Guard the cast.
```ts
const current = Array.isArray(payload?.current) ? (payload.current as string[]) : [];
// ... scope: current.join(",")
```

### 14. ⚪ `connect-rekart` uses `update` (throws on missing row) and unguarded `Number(clientId)`
`app/routes/app.connect-rekart.tsx:109` uses `db.shopOnboarding.update`, which throws Prisma `P2025` if the onboarding row is absent (inconsistent with the `updateMany` used in `app.settings.tsx`). At `:91`, `Number(result.clientId)` becomes `NaN` (serialized as `null`) for a non-numeric id.

**Fix:** Use `upsert` (or `updateMany`) and guard the coercion.
```ts
const clientIdNum = Number(result.clientId);
if (!Number.isFinite(clientIdNum)) { console.error("[connect-rekart] non-numeric client_id"); /* skip registration, still store the string id */ }
```

---

## B. Conditional — FastAPI reference backend (only if deployed as-is)

### 15. 🟠 Security config defaults to "development" (fail-open)
`rekart-backend/app/main.py:46` + `config.py:18`. CORS `allow_origins`, `/docs` exposure, and `create_all` all gate on `app_env`, which **defaults to `"development"`**. A prod deploy that forgets `APP_ENV` serves wildcard CORS + public Swagger + auto-DDL.

**Fix:** Default to production and require explicit opt-in for dev conveniences.
```python
app_env: str = "production"   # was "development"
```
Optionally read an explicit `CORS_ALLOWED_ORIGINS` list rather than deriving from one URL.

### 16. 🟠 Shopify Admin `access_token` stored in plaintext
`rekart-backend/app/models/shop.py:27`. Stored as `String(255)`, inconsistent with the Remix side's AES-256-GCM encryption; any DB/backup/log read leaks live Admin tokens.

**Fix:** Encrypt at rest (port `crypto.server.ts` to a Python `AESGCM` helper using the `cryptography` package), store ciphertext, decrypt only when calling Shopify. At minimum, document and gate behind encryption before any real deployment.

### 17. 🟡 Webhook dedup check-then-insert race → 500
`rekart-backend/app/routers/webhooks.py:74`. Two concurrent duplicate deliveries both pass the `SELECT`, both insert, and the second commit raises an unhandled `IntegrityError` (500 to Shopify) instead of an idempotent 200.

**Fix:** Make the insert the idempotency check.
```python
from sqlalchemy.exc import IntegrityError
db.add(WebhookEvent(webhook_id=webhook_id, topic=topic))
try:
    await db.flush()
except IntegrityError:
    await db.rollback()
    return True   # someone else recorded it first → duplicate
```

### 18. ⚪ `/sync-status` emits a UTC timestamp without the `Z` suffix
`rekart-backend/app/routers/shops.py:105` vs `:53`. `/stats` appends `"Z"`, `/sync-status` doesn't, so the same naive-UTC value is emitted inconsistently and a JS client misreads `/sync-status` as local time.

**Fix:** Append `"Z"` to match (`last_log.created_at.isoformat() + "Z"`), or switch the columns to `DateTime(timezone=True)` and emit aware ISO everywhere.

---

## C. Cleanup (quality, not bugs)

### 19. N+1 upserts on mapping save
`app/routes/app.products.tsx:334`. Confirmed mappings are upserted one-by-one in an `await`-in-loop.

**Fix:** Batch into one round trip.
```ts
await db.$transaction(result.data.map((m) => db.shopifyProductLink.upsert({ /* ...perRow(m) */ })));
```

### 20. Loader fetches Rekart catalog and Shopify products sequentially
`app/routes/app.products.tsx:187` then `:202` — independent calls run serially (catalog ~2.5 s + GraphQL).

**Fix:** Overlap them.
```ts
const [catalog, resp] = await Promise.all([
  onboarding?.rekartMerchantId ? fetchRekartCatalog(shop, onboarding.rekartCacheId)
    : Promise.resolve({ products: [], slots: [], zones: [], cacheId: null }),
  admin.graphql(PRODUCTS_QUERY),
]);
```

### 21. Duplicated row→PushInput mapper that has drifted
`app/sync-log.server.ts:46-57 retryPushNow` re-implements `app/fulfillment-retry.server.ts:23-47 rowToInput`, but passes the `""` `rekartDeliveryId` sentinel verbatim instead of normalizing to `null`.

**Fix:** Export `rowToInput` from `fulfillment-retry.server.ts` (or move to `fulfillment.server.ts`) and call it from both — fixes the `""`→`null` drift for free.

### 22. Duplicated GDPR forward logic
`app/gdpr.server.ts:98-126 processPendingGdpr` duplicates the body of `forwardGdprRow`.

**Fix:** Have `processPendingGdpr` call `forwardGdprRow(row)` on the success path and only add the `retryCount`/`failed` bookkeeping on failure.

### 23. Scattered GID handling
`app/routes/app.products.tsx:164 extractVariantId`, `app/fulfillment.server.ts:53 toOrderGid`, and inline `gid://shopify/ProductVariant/...` template literals.

**Fix:** Add a single `app/gid.ts` (`parseGidId`, `toGid(type, id)`) and reuse it everywhere a GID is parsed or built.

---

## Considered and excluded (not bugs)

- **"`/api/integrations/shopify/*` endpoints don't exist" / "stats fields mismatch"** — false positives: those calls target the **Laravel** backend (the real producer), not the in-repo FastAPI reference. The dashboard reads the Laravel shape (`orders_imported`/`status`), which is internally consistent.
- **`@@unique([…, rekartDeliveryId])` differing from the contract's `(shop, order, status)`** — intentional recent change; the `""`-sentinel handling in `fulfillment.server.ts` is deliberate.
- **GDPR/webhook HMAC** — correctly verified (`authenticate.webhook` on all compliance routes; `crypto.server.ts` uses AES-256-GCM with a random IV + auth-tag check; `verifyRekartToken` is constant-time). No issue.
- **`minutesToTime(≥1440)`** — already tracked as known debt (T141).

---

## Suggested fix order

1. Low-risk, high-value: **#1 → #2 → #3 → #5 → #9 → #12** (the shipping blocker + the always-200 contract path) and the guards in **#13/#14**.
2. Needs a judgment call: **#4** (locking strategy), **#6** (cancel semantics), **#7** (edit-preservation UX), **#11** (duplicate-event matcher).
3. Conditional backend (before deploying `rekart-backend/`): **#15 → #16 → #17 → #18**.
4. Cleanup: **#19–#23**.
