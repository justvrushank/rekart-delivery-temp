import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useState, type ReactNode } from "react";
import { redirect, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getOnboarding } from "../onboarding.server";
import {
  backendUrl,
  fetchShopStats,
  registerShopWithRekart,
  fetchRekartCatalog,
} from "../rekart.server";
import db from "../db.server";
import { SkeletonSection } from "../skeleton";

// Self-heal a half-finished connection: linked but no cache_id means the catalog
// was never fetched, which implies registration never completed either. Silently
// re-attempt registration and, on success, prime the catalog cache + persist the
// cache_id. Best-effort — never throws into the loader, never blocks the dashboard.
async function healRekartConnection(
  shop: string,
  clientId: string,
): Promise<void> {
  try {
    const registration = await registerShopWithRekart(shop, Number(clientId));
    if (!("success" in registration)) return; // FAILED / conflict → retry next load
    const catalog = await fetchRekartCatalog(shop);
    if (!("error" in catalog) && catalog.cacheId) {
      await db.shopOnboarding.update({
        where: { shop },
        data: { rekartCacheId: catalog.cacheId },
      });
    }
  } catch {
    // swallow — the dashboard must render regardless
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const onboarding = await getOnboarding(session.shop);
  // Gate the dashboard behind onboarding completion. Preserve the incoming
  // embedded params (shop/host/embedded/id_token) on the redirect — a bare
  // `redirect("/app/onboarding")` drops them, so the follow-up request fails
  // authenticate.admin's shop/host validation and bounces to /auth/login,
  // which renders the login form inside the admin iframe.
  if (!onboarding?.completed) {
    const url = new URL(request.url);
    throw redirect(`/app/onboarding?${url.searchParams.toString()}`);
  }

  // Onboarding is done but no Rekart account is linked yet. Where we send them
  // depends on the Yes/No fork: existing clients link an account; new merchants
  // go to the pending-setup holding screen. Preserve the embedded params for the
  // same reason as the onboarding gate above.
  if (!onboarding.rekartMerchantId) {
    const url = new URL(request.url);
    const target =
      onboarding.existingRekartUser === false
        ? "/app/pending-setup"
        : "/app/connect-rekart";
    throw redirect(`${target}?${url.searchParams.toString()}`);
  }

  // Run the independent reads concurrently: the backend stats call, the
  // last-dead-push lookup, and (if needed) a best-effort connection self-heal.
  // rekartMerchantId is guaranteed non-null past the gate above; a null cache_id
  // means registration/catalog never completed, so re-attempt them silently.
  const [rawStats, lastDeadPush] = await Promise.all([
    fetchShopStats(session.shop),
    db.fulfillmentPush
      .findFirst({
        where: { shop: session.shop, status: "dead" },
        orderBy: { updatedAt: "desc" },
      })
      .catch((e) => {
        console.error("[dashboard] dead-push lookup failed:", e);
        return null;
      }),
    onboarding.rekartMerchantId != null && onboarding.rekartCacheId == null
      ? healRekartConnection(session.shop, onboarding.rekartMerchantId)
      : Promise.resolve(),
  ]);

  // Normalize stats for the UI; null when the call failed so the dashboard can
  // fall back to empty stats rather than crash.
  const stats =
    "error" in rawStats
      ? null
      : {
          ordersImported: rawStats.orders_imported ?? 0,
          failed: rawStats.webhooks?.failed ?? 0,
          lastProcessedAt: rawStats.last_processed_at ?? null,
          status: rawStats.status ?? null,
        };

  // tokenInvalid is driven by the persisted flag + token expiry. The stats call
  // now uses the shared X-API-Key (no per-merchant 401 to reconcile); reconnect
  // clears the flag in connect-rekart.
  let tokenInvalid = onboarding.tokenInvalid;

  // Token-expiry handling. If we know when the token expires: past → treat as
  // invalid (persist so other screens agree); within 24h → flag "expiring soon".
  let tokenExpiringSoon = false;
  if (onboarding.rekartTokenExpiresAt) {
    const now = Date.now();
    const expiresAtMs = new Date(onboarding.rekartTokenExpiresAt).getTime();
    if (expiresAtMs <= now) {
      if (!tokenInvalid) {
        await db.shopOnboarding.update({
          where: { shop: session.shop },
          data: { tokenInvalid: true },
        });
        tokenInvalid = true;
      }
    } else if (expiresAtMs - now <= 24 * 60 * 60 * 1000) {
      tokenExpiringSoon = true;
    }
  }

  // The most recent permanently-failed ("dead") fulfillment push (fetched above)
  // tells the merchant a delivery status update never made it onto an order.
  const lastSyncError = lastDeadPush
    ? {
        summary: (lastDeadPush.lastError ?? "Unknown error").slice(0, 160),
      }
    : null;

  return {
    shop: session.shop,
    onboarding,
    stats,
    lastSyncError,
    tokenInvalid,
    tokenExpiringSoon,
    backendConfigured: Boolean(backendUrl()),
  };
};

export function HydrateFallback() {
  return (
    <s-page heading="Rekart Delivery">
      <SkeletonSection lines={3} />
      <SkeletonSection lines={4} />
    </s-page>
  );
}

function StatCard({
  label,
  value,
  footer,
}: {
  label: string;
  value: string;
  footer?: ReactNode;
}) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="small">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {footer}
      </s-stack>
    </s-box>
  );
}

export default function Dashboard() {
  const { shop, onboarding, stats, lastSyncError, tokenInvalid, tokenExpiringSoon, backendConfigured } =
    useLoaderData<typeof loader>();

  const [syncErrorDismissed, setSyncErrorDismissed] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Preserve embedded params (shop/host/embedded/id_token) on in-app navigations.
  const params = searchParams.toString();
  const connectRekartHref = `/app/connect-rekart?${params}`;
  const settingsHref = `/app/settings?${params}`;
  const syncLogHref = `/app/sync-log?${params}`;

  // Linked but no default slot → order sync will fail with SLOT_NOT_FOUND.
  const needsSlot = Boolean(onboarding.rekartMerchantId) && onboarding.defaultSlotId == null;

  // Connection is healthy when the backend is configured, reachable, and reports
  // this shop's status as active (stats API returns active | disabled | uninstalled).
  const connected = Boolean(backendConfigured && stats?.status === "active");
  const reachable = stats !== null;

  const numberFmt = (n: number | undefined) =>
    typeof n === "number" ? n.toLocaleString() : "—";

  const lastSynced = formatLastSynced(stats?.lastProcessedAt ?? null);

  return (
    <s-page heading="Rekart Delivery">
      {tokenInvalid && (
        <s-banner
          tone="critical"
          heading="Rekart connection expired"
        >
          <s-paragraph>
            Your Rekart account connection has expired. Reconnect to resume order
            syncing.
          </s-paragraph>
          <s-button onClick={() => navigate(connectRekartHref)} variant="primary">
            Reconnect Rekart account
          </s-button>
        </s-banner>
      )}

      {tokenExpiringSoon && (
        <s-banner tone="warning" heading="Rekart connection expires soon">
          <s-paragraph>
            Your Rekart connection expires soon. Reconnect now to avoid
            interruption to order syncing.
          </s-paragraph>
          <s-button onClick={() => navigate(connectRekartHref)} variant="primary">
            Reconnect Rekart account
          </s-button>
        </s-banner>
      )}

      {needsSlot && (
        <s-banner tone="warning" heading="No default delivery slot">
          <s-paragraph>
            No default delivery slot configured. Shopify orders cannot sync until
            you set one.
          </s-paragraph>
          <s-button onClick={() => navigate(settingsHref)} variant="primary">
            Configure delivery slot
          </s-button>
        </s-banner>
      )}

      {lastSyncError && !syncErrorDismissed && (
        <s-banner
          tone="critical"
          heading="Delivery status update failed"
          dismissible
          onDismiss={() => setSyncErrorDismissed(true)}
        >
          <s-paragraph>
            Last delivery status update failed — {lastSyncError.summary}. Check
            Sync Log for details.
          </s-paragraph>
          <s-button variant="tertiary" onClick={() => navigate(syncLogHref)}>
            Open Sync Log
          </s-button>
        </s-banner>
      )}

      <s-section heading="Connection status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text>Rekart backend:</s-text>
            {connected ? (
              <s-badge tone="success">Connected</s-badge>
            ) : reachable ? (
              <s-badge tone="warning">Not connected</s-badge>
            ) : (
              <s-badge tone="critical">Unreachable</s-badge>
            )}
          </s-stack>

          <s-text color="subdued">Store: {shop}</s-text>

          {!backendConfigured && (
            <s-banner tone="warning" heading="Backend URL not configured">
              <s-paragraph>
                Set <code>REKART_BACKEND_URL</code> in your environment so the
                app can register data webhooks and read sync stats from the
                Rekart FastAPI service.
              </s-paragraph>
            </s-banner>
          )}

          {backendConfigured && !reachable && (
            <s-banner tone="critical" heading="Can't reach the Rekart backend">
              <s-paragraph>
                The Rekart service didn't respond. Sync stats below may be out
                of date. We'll keep retrying automatically.
              </s-paragraph>
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Sync stats">
        <s-grid
          gridTemplateColumns="1fr 1fr 1fr"
          gap="base"
        >
          <StatCard label="Orders synced to Rekart" value={numberFmt(stats?.ordersImported)} />
          <StatCard
            label="Sync errors"
            value={numberFmt(stats?.failed)}
            footer={
              stats && stats.failed > 0 ? (
                <s-link href={syncLogHref}>View delivery history</s-link>
              ) : undefined
            }
          />
          <StatCard label="Last updated" value={lastSynced} />
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Your business">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            <s-text color="subdued">Category: </s-text>
            <s-text>{onboarding.businessCategory ?? "—"}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">Country: </s-text>
            <s-text>{onboarding.country ?? "—"}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">Order volume: </s-text>
            <s-text>{onboarding.orderVolume ?? "—"}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text color="subdued">Subscribers: </s-text>
            <s-text>{onboarding.subscriberCount ?? "—"}</s-text>
          </s-paragraph>
          <s-button
            variant="tertiary"
            onClick={() => navigate(`/app/onboarding?${params}`)}
          >
            Edit details
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function formatLastSynced(lastProcessedAt: string | null): string {
  if (!lastProcessedAt) return "Never";
  const date = new Date(lastProcessedAt);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
