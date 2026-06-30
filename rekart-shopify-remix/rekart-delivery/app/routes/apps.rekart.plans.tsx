// App Proxy endpoint — GET /apps/rekart/plans
//
// Served to the storefront subscription widget (extensions/rekart-subscriptions)
// via Shopify's App Proxy (configured in shopify.app.toml). Returns the merchant's
// Rekart subscription plans + slots + currency + which delivery patterns are
// enabled. Auth is the App Proxy HMAC signature (authenticate.public.appProxy),
// NOT a Shopify admin session — Shopify signs the proxied storefront request.
//
// Route path mirrors the proxy sub-path: the widget fetches `/apps/rekart/plans`,
// which Shopify forwards here. (A route at `apps.rekart.tsx` would only match
// `/apps/rekart`, so this lives at `apps.rekart.plans.tsx`.)

import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { fetchRekartCatalog } from "../rekart.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  // appProxy returns no session when the shop has no stored offline session.
  if (!session) {
    return Response.json({ error: "No session for shop" }, { status: 401 });
  }
  const shop = session.shop;

  const onboarding = await db.shopOnboarding.findUnique({ where: { shop } });
  const catalog = await fetchRekartCatalog(shop, onboarding?.rekartCacheId ?? null);

  if ("error" in catalog) {
    return Response.json({ error: "Could not fetch plans" }, { status: 503 });
  }

  return Response.json({
    plans: catalog.plans ?? [],
    slots: catalog.slots ?? [],
    currency: onboarding?.rekartCurrency ?? "INR",
    currencySymbol: onboarding?.rekartCurrencySymbol ?? "₹",
    settings: {
      allowAlternateDay: onboarding?.allowAlternateDay ?? true,
      allowWeekly: onboarding?.allowWeekly ?? true,
      allowNthDay: onboarding?.allowNthDay ?? true,
    },
  });
};
