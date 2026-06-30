// Helpers for talking to the Rekart FastAPI backend from the Remix app.
//
// The Remix app owns OAuth, onboarding and the embedded UI; the FastAPI service
// owns order/customer data. These helpers let the Remix side forward compliance
// events to the backend and pull sync stats for the dashboard.

import { createHmac, timingSafeEqual } from "node:crypto";

// Read at call time (NOT frozen at module load) so a changed REKART_BACKEND_URL
// is picked up on the next request after a server restart, instead of being
// stuck on the value present when this module was first imported. Returns the
// bare host with any trailing slash stripped, or undefined when unset.
export function backendUrl(): string | undefined {
  return process.env.REKART_BACKEND_URL?.replace(/\/$/, "");
}

// Login lives on the main Rekart backend even while REKART_BACKEND_URL points
// elsewhere (e.g. an ngrok tunnel for the integration endpoints during testing).
const RAW_LOGIN_URL = process.env.REKART_LOGIN_URL;
const REKART_LOGIN_URL = RAW_LOGIN_URL?.replace(/\/$/, "");

// Shared secret used to authenticate Remix <-> Rekart calls (both directions:
// the Remix app signs outbound calls to FastAPI, and Rekart signs inbound calls
// to the Remix /api/fulfillment-* endpoints). Read at call time so a rotated key
// is picked up after a restart rather than frozen at module load.
function staticApiKey(): string | undefined {
  return process.env.REKART_STATIC_API_KEY;
}

// HMAC the provided and expected tokens to fixed-length 32-byte digests before
// comparing. timingSafeEqual requires equal-length inputs, so comparing the raw
// strings needs an early `a.length !== b.length` check — and that check is a
// timing/length oracle that leaks the secret's length. Hashing both sides first
// makes the inputs always 32 bytes (no length check, no leak) and keeps the
// compare constant-time. The HMAC key is a fixed constant: we only need a
// length-hiding, collision-resistant transform here, not key secrecy.
// Not a security key — used only to produce a fixed-length digest for
// constant-time comparison. The actual secret being compared is the HMAC input.
const HASH_NORMALISATION_KEY = Buffer.alloc(32);
function hmacBuf(val: string): Buffer {
  return createHmac("sha256", HASH_NORMALISATION_KEY).update(val).digest();
}

/**
 * Verify the X-API-Key shared secret on an inbound request from Rekart
 * (Milestone 3). Constant-time compare; returns false when the token is unset,
 * missing, or mismatched. A missing server-side token always rejects so a
 * misconfigured deploy never accepts unauthenticated calls.
 */
export function verifyRekartToken(request: Request): boolean {
  const expected = staticApiKey();
  if (!expected) return false;
  const provided = request.headers.get("X-API-Key");
  if (!provided) return false;
  return timingSafeEqual(hmacBuf(provided), hmacBuf(expected));
}

// Hard cap on how long any backend call may block a page load or webhook. The
// dashboard must render in < 3s even when the Rekart backend is slow/unreachable,
// so loaders never await the backend longer than this (then fall back gracefully).
const BACKEND_TIMEOUT_MS = 2500;

function backendHeaders(): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = staticApiKey();
  if (key) {
    headers["X-API-Key"] = key;
  }
  return headers;
}

/**
 * Best-effort POST to the Rekart backend. Never throws: webhook handlers must
 * still return 200 to Shopify even if the backend is temporarily unreachable.
 * Returns true on a 2xx response, false otherwise.
 */
export async function forwardToBackend(
  path: string,
  body: unknown,
): Promise<boolean> {
  const base = backendUrl();
  if (!base) {
    console.warn(
      `[rekart] REKART_BACKEND_URL not set; skipping forward to ${path}`,
    );
    return false;
  }

  try {
    // base is the bare host; the API lives under /api (same convention as
    // fetchShopStats and loginToRekart). `path` starts with "/".
    const res = await fetch(`${base}/api${path}`, {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[rekart] forward to ${path} failed: ${res.status} ${res.statusText}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[rekart] forward to ${path} threw:`, error);
    return false;
  }
}

// Auth/login can be slower than a stats read (password hashing, etc.), so it
// gets its own, more generous timeout than the dashboard's hard cap.
const LOGIN_TIMEOUT_MS = 10000;

export type RekartLoginResult =
  | { ok: true; accessToken: string; clientId: string; expiresAt: string | null }
  | { ok: false; error: string };

/**
 * Pull the user-facing error message out of a Rekart 4xx response. The backend
 * returns `{ message, errors: { field: [..] } }`; prefer the top-level `message`,
 * fall back to the first field error. Returns null if nothing usable is found.
 */
async function readBackendMessage(res: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const data = body as {
    message?: unknown;
    errors?: Record<string, unknown>;
  };
  if (typeof data?.message === "string" && data.message.trim()) {
    return data.message.trim();
  }
  const firstError = data?.errors && Object.values(data.errors)[0];
  if (Array.isArray(firstError) && typeof firstError[0] === "string") {
    return firstError[0];
  }
  if (typeof firstError === "string") return firstError;
  return null;
}

/**
 * Authenticate a merchant against the Rekart backend (Milestone: account
 * linking). Server-only: credentials are posted from the Remix action so they
 * never touch the browser. Returns the JWT access token and the client_id
 * (stored as rekart_merchant_id) on success, or a user-facing error message.
 */
export async function loginToRekart(
  username: string,
  password: string,
): Promise<RekartLoginResult> {
  if (!REKART_LOGIN_URL) {
    return { ok: false, error: "Rekart backend is not configured. Contact support." };
  }

  // Login uses REKART_LOGIN_URL (the main backend), which can differ from
  // REKART_BACKEND_URL while the integration endpoints are pointed elsewhere.
  // It's the bare host; the API lives under /api.
  const loginUrl = `${REKART_LOGIN_URL}/api/auth/login`;

  let res: Response;
  try {
    res = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        referer: "admin",
        appType: "ShopifyApp",
        appVersion: "1.0.0",
        platform: "browser",
      }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[rekart] loginToRekart fetch threw:", error);
    return {
      ok: false,
      error: "Couldn't reach Rekart. Check your connection and try again.",
    };
  }

  // On a 4xx the backend returns a JSON body with a user-facing `message`
  // (e.g. "We could not find any account with the entered number…"). Surface it
  // so merchants see the real reason instead of a generic error.
  if (res.status >= 400 && res.status < 500) {
    const message = await readBackendMessage(res);
    return { ok: false, error: message ?? "Invalid username or password." };
  }
  if (!res.ok) {
    console.error(`[rekart] loginToRekart failed: ${res.status} ${res.statusText}`);
    return { ok: false, error: "Login failed. Please try again." };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (error) {
    console.error("[rekart] loginToRekart: bad JSON:", error);
    return { ok: false, error: "Unexpected response from Rekart. Please try again." };
  }

  const user = (payload as {
    user?: {
      token?: { access_token?: string; expires_at?: string };
      client?: { client_id?: unknown };
    };
  })?.user;
  const accessToken = user?.token?.access_token;
  const expiresAt =
    typeof user?.token?.expires_at === "string" ? user.token.expires_at : null;
  const clientId =
    user?.client?.client_id == null ? null : String(user.client.client_id);

  if (!accessToken || !clientId) {
    console.error("[rekart] loginToRekart: missing access_token or client_id in response");
    return { ok: false, error: "Login succeeded but Rekart returned no account id. Contact support." };
  }

  return { ok: true, accessToken, clientId, expiresAt };
}

export interface RekartProduct {
  productId: number;
  name: string;
  sku: string | null;
  // Shopify's product id as known on the Rekart side, when present. Useful for
  // auto-matching a Shopify product straight to its Rekart counterpart.
  externalProductId?: string | null;
}

export interface RekartSlot {
  slot_id: number;
  text: string; // human-readable, already includes the time, e.g. "Morning (06:00)"
  delivery_time: string; // catalog returns a string like "06:00"
  is_active: boolean;
}

// Re-exported for server-side callers; defined in the pure (client-safe) module
// so route components and tests can import it without pulling in Prisma.
export { minutesToTime } from "./slot-time";

// ── Rekart × Shopify integration API (confirmed contract) ────────────────────
// All three calls authenticate with the shared X-API-Key (backendHeaders()),
// not a per-merchant bearer token.

export type RegisterShopResult =
  | { success: true }
  | { error: "LINKED_TO_DIFFERENT_ACCOUNT" }
  | { error: "FAILED" };

/**
 * Register the shop ↔ Rekart client_id mapping.
 * POST /api/integrations/shopify/connections/register
 * 200 = registered (or refreshed for the same tenant) → success. A 409 means the
 * store is already linked to a DIFFERENT Rekart client_id (cross-tenant conflict)
 * — surfaced as LINKED_TO_DIFFERENT_ACCOUNT so the caller can block the merchant.
 */
export async function registerShopWithRekart(
  shop: string,
  clientId: number,
): Promise<RegisterShopResult> {
  const base = backendUrl();
  if (!base) return { error: "FAILED" };

  try {
    const res = await fetch(
      `${base}/api/integrations/shopify/connections/register`,
      {
        method: "POST",
        headers: backendHeaders(),
        body: JSON.stringify({
          shop_domain: shop,
          client_id: clientId,
          webhook_url: `${(process.env.SHOPIFY_APP_URL ?? '').replace(/\/$/, '')}/api/rekart-webhook`,
        }),
        signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
      },
    );
    if (res.status === 409) return { error: "LINKED_TO_DIFFERENT_ACCOUNT" };
    if (!res.ok) {
      console.error(
        `[rekart] registerShopWithRekart failed: ${res.status} ${res.statusText}`,
      );
      return { error: "FAILED" };
    }
    return { success: true };
  } catch (error) {
    console.error("[rekart] registerShopWithRekart threw:", error);
    return { error: "FAILED" };
  }
}

// A per-row result Rekart returns for a mapping it could not accept because the
// Rekart product is already mapped to a different Shopify variant on its side.
export interface ProductMappingConflict {
  shopify_variant_id: string;
  rekart_product_id: number;
  status: string;
}

/**
 * Pull conflict rows out of the product-mapping response. Rekart returns a
 * per-row result list; rows it rejected carry status "conflict". Accepts a bare
 * array or a { results | mappings | data: [...] } envelope, and tolerates a
 * missing/non-JSON body (→ no conflicts).
 */
async function readMappingConflicts(
  res: Response,
): Promise<ProductMappingConflict[]> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  const envelope = body as Record<string, unknown> | null;
  const rows: unknown = Array.isArray(body)
    ? body
    : (envelope?.results ?? envelope?.mappings ?? envelope?.data);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (r): r is Record<string, unknown> =>
        typeof r === "object" &&
        r !== null &&
        (r as { status?: unknown }).status === "conflict",
    )
    .map((r) => ({
      shopify_variant_id: String(r.shopify_variant_id ?? ""),
      rekart_product_id: Number(r.rekart_product_id ?? 0),
      status: "conflict",
    }));
}

// Details for creating a brand-new Rekart product from a Shopify variant. Mirrors
// the fields Rekart's product-create accepts; only name + price are required.
export interface RekartProductDetails {
  name: string;
  price: number;
  originalprice?: number;
  onetime_rate?: number;
  unit?: string;
  brand?: string;
  description?: string;
  category_id?: number;
  category_name?: string;
  is_active?: boolean;
  allow_subscribe?: boolean;
  allow_onetime?: boolean;
  multiply_factor?: number;
}

// One row in the mapping payload — either a variant linked to an existing Rekart
// product, or a variant for which Rekart should create a new product. Unmapped
// variants are not represented here: the caller omits them entirely.
export type ProductMappingItem =
  | { shopifyVariantId: string; rekartProductId: number }
  | { shopifyVariantId: string; product: RekartProductDetails };

/**
 * Push the confirmed Shopify variant ↔ Rekart product mappings to the backend so
 * it can resolve each order line item to a Rekart product directly from the
 * variant id (no checkout line-item property required).
 * POST /api/integrations/shopify/product-mapping
 * Each row is either { shopify_variant_id, rekart_product_id } (link to an
 * existing product) or { shopify_variant_id, product: {...} } (create a new one).
 * Unmapped variants are excluded by the caller and never sent.
 * Best-effort: returns { success: true, conflicts } on 200 (conflicts is the
 * list of rows Rekart rejected, possibly empty), { error: "FAILED" } otherwise.
 */
export async function pushProductMappings(
  shop: string,
  mappings: ProductMappingItem[],
): Promise<
  { success: true; conflicts: ProductMappingConflict[] } | { error: string }
> {
  const base = backendUrl();
  if (!base) return { error: "FAILED" };

  try {
    const res = await fetch(
      `${base}/api/integrations/shopify/product-mapping`,
      {
        method: "POST",
        headers: backendHeaders(),
        body: JSON.stringify({
          shop_domain: shop,
          mappings: mappings.map((m) => ({
            shopify_variant_id: m.shopifyVariantId,
            ...("rekartProductId" in m
              ? { rekart_product_id: m.rekartProductId }
              : { product: m.product }),
          })),
        }),
        signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      console.error(
        `[rekart] pushProductMappings failed: ${res.status} ${res.statusText}`,
      );
      return { error: "FAILED" };
    }
    return { success: true, conflicts: await readMappingConflicts(res) };
  } catch (error) {
    console.error("[rekart] pushProductMappings threw:", error);
    return { error: "FAILED" };
  }
}

export interface RekartZone {
  zone_id: number;
  name: string;
}

// A Rekart subscription plan as returned by the catalog API. Kept in the backend's
// snake_case shape because it is forwarded verbatim to the storefront widget (via
// the app proxy), which reads these field names directly.
export interface RekartPlan {
  plan_id: number;
  name: string;
  plan_type?: string;
  units?: number;
  discount_percentage?: number;
  price_per_unit?: number;
  price?: number;
  original_price?: number;
  validity_days?: number;
}

// Merchant-level subscription pattern toggles from the catalog API.
export interface RekartCatalogSettings {
  allow_alternate_day?: boolean;
  allow_weekly?: boolean;
  allow_nth_day?: boolean;
}

export type RekartCatalogResult =
  | {
      products: RekartProduct[];
      slots: RekartSlot[];
      zones: RekartZone[];
      plans: RekartPlan[];
      cacheId: string | null;
      currency?: string;
      currencySymbol?: string;
      timezone?: string;
      territoryId?: number;
      settings: RekartCatalogSettings | null;
    }
  | { error: "FAILED" };

/**
 * Fetch the merchant's Rekart catalog (products + slots + zones) in one call.
 * GET /api/integrations/shopify/catalog?shop_domain={shop}[&cache_id=...]
 * Pass the stored cache_id so the backend can short-circuit; persist + reuse the
 * returned cache_id.
 */
export async function fetchRekartCatalog(
  shop: string,
  cacheId?: string | null,
): Promise<RekartCatalogResult> {
  const root = backendUrl();
  if (!root) return { error: "FAILED" };

  const base = `${root}/api/integrations/shopify/catalog?shop_domain=${encodeURIComponent(shop)}`;
  const url = cacheId ? `${base}&cache_id=${encodeURIComponent(cacheId)}` : base;

  try {
    const res = await fetch(url, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[rekart] fetchRekartCatalog failed: ${res.status} ${res.statusText}`,
      );
      return { error: "FAILED" };
    }
    const data = (await res.json()) as {
      products?: Array<{
        product_id: number | string | null;
        name: string;
        sku?: string | null;
        external_product_id?: string | null;
      }>;
      slots?: RekartSlot[];
      zones?: RekartZone[];
      plans?: RekartPlan[];
      cache_id?: string | null;
      currency?: string;
      currency_symbol?: string;
      timezone?: string;
      territory_id?: number;
      settings?: RekartCatalogSettings;
    };
    return {
      // Drop products with a non-numeric product_id: they'd render as broken
      // picker options ("null"/"NaN") and poison the mapping save payload.
      products: (data.products ?? [])
        .map((p) => ({
          productId: Number(p.product_id),
          name: p.name,
          sku: p.sku ?? null,
          externalProductId: p.external_product_id ?? null,
        }))
        .filter((p) => Number.isInteger(p.productId) && p.productId > 0),
      slots: data.slots ?? [],
      zones: data.zones ?? [],
      plans: data.plans ?? [],
      cacheId: data.cache_id ?? null,
      currency: data.currency,
      currencySymbol: data.currency_symbol,
      timezone: data.timezone,
      territoryId: data.territory_id,
      settings: data.settings ?? null,
    };
  } catch (error) {
    console.error("[rekart] fetchRekartCatalog threw:", error);
    return { error: "FAILED" };
  }
}

export interface RekartShopStats {
  orders_imported: number;
  webhooks: { failed?: number } | null;
  last_processed_at: string | null;
  status: string;
}

/**
 * Fetch sync stats for the dashboard.
 * GET /api/integrations/shopify/stats?shop_domain={shop}
 * Returns { error: "FAILED" } on any non-2xx / unreachable so the dashboard can
 * fall back to empty stats rather than crash.
 */
export async function fetchShopStats(
  shop: string,
): Promise<RekartShopStats | { error: "FAILED" }> {
  const base = backendUrl();
  if (!base) return { error: "FAILED" };

  try {
    const res = await fetch(
      `${base}/api/integrations/shopify/stats?shop_domain=${encodeURIComponent(shop)}`,
      { headers: backendHeaders(), signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS) },
    );
    if (!res.ok) {
      console.error(
        `[rekart] fetchShopStats failed: ${res.status} ${res.statusText}`,
      );
      return { error: "FAILED" };
    }
    return (await res.json()) as RekartShopStats;
  } catch (error) {
    console.error("[rekart] fetchShopStats threw:", error);
    return { error: "FAILED" };
  }
}
