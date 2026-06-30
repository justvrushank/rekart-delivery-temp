// Milestone 4 — Settings screen: store info, Rekart connection, business
// details (edit), support + privacy links, and a disconnect action.

import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useState } from "react";
import { data, Form, redirect, useActionData, useLoaderData, useNavigate, useNavigation, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getOnboarding } from "../onboarding.server";
import { fetchRekartCatalog, forwardToBackend, backendUrl, type RekartSlot } from "../rekart.server";
import db from "../db.server";
import { SkeletonSection } from "../skeleton";

const SUPPORT_URL = process.env.REKART_SUPPORT_URL || "https://rekart.io/support";
const PRIVACY_URL =
  process.env.REKART_PRIVACY_URL || "https://rekart.io/privacy-policy";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const onboarding = await getOnboarding(session.shop);

  // Fetch slots from the Rekart catalog once an account is linked, passing the
  // stored cache_id; persist the returned cache_id when it changes.
  let slots: RekartSlot[] = [];
  if (onboarding?.rekartMerchantId) {
    const catalog = await fetchRekartCatalog(session.shop, onboarding.rekartCacheId);
    if (!("error" in catalog)) {
      slots = catalog.slots;
      if (catalog.cacheId && catalog.cacheId !== onboarding.rekartCacheId) {
        await db.shopOnboarding.update({
          where: { shop: session.shop },
          data: { rekartCacheId: catalog.cacheId },
        });
      }
    }
  }

  return {
    shop: session.shop,
    onboarding,
    slots,
    defaultSlotId: onboarding?.defaultSlotId ?? null,
    backendConfigured: Boolean(backendUrl()),
    // Used to hide the dev-only "Backend URL not configured" banner in prod.
    isProduction: process.env.NODE_ENV === "production",
    supportUrl: SUPPORT_URL,
    privacyUrl: PRIVACY_URL,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "unlink-account") {
    // Unlink just the Rekart *account* (not the whole store): clear the linked
    // merchant id + access token so the merchant can sign in with a different
    // account. Onboarding answers are kept. Send them back to the connect screen,
    // preserving the embedded params so the redirect stays in the embedded path.
    await db.shopOnboarding.updateMany({
      where: { shop: session.shop },
      data: { rekartMerchantId: null, rekartAccessToken: null, connected: false },
    });
    const url = new URL(request.url);
    return redirect(`/app/connect-rekart?${url.searchParams.toString()}`);
  }

  if (intent === "save-slot") {
    // Persist the default delivery slot every synced order will use.
    const raw = formData.get("slotId");
    const slotId = Number(raw);
    if (!raw || !Number.isInteger(slotId) || slotId <= 0) {
      return data(
        {
          disconnected: false,
          slotSaved: false,
          error: "Select a valid delivery slot.",
        },
        { status: 422 },
      );
    }
    // Verify the slot actually exists in the merchant's Rekart catalog before
    // saving — guards against stale/forged ids. Pass the stored cache_id so the
    // backend can short-circuit. Distinguish "couldn't reach Rekart to verify"
    // (503, try again) from a genuinely invalid slot (422) — failing closed on a
    // transient blip would reject a valid slot.
    const onboarding = await getOnboarding(session.shop);
    const catalog = await fetchRekartCatalog(session.shop, onboarding?.rekartCacheId);
    if ("error" in catalog) {
      return data(
        {
          disconnected: false,
          slotSaved: false,
          error: "Couldn't reach Rekart to verify the slot. Please try again.",
        },
        { status: 503 },
      );
    }
    if (!catalog.slots.some((s) => s.slot_id === slotId)) {
      return data(
        { disconnected: false, slotSaved: false, error: "Invalid slot selected." },
        { status: 422 },
      );
    }
    await db.shopOnboarding.updateMany({
      where: { shop: session.shop },
      data: { defaultSlotId: slotId },
    });
    return { disconnected: false, slotSaved: true, error: null as string | null };
  }

  if (intent === "disconnect") {
    // Stop syncing without uninstalling the app: clear the local connection flag
    // and tell the backend to mark the shop inactive.
    await db.shopOnboarding.updateMany({
      where: { shop: session.shop },
      data: { connected: false },
    });
    await forwardToBackend("/webhooks/shopify/app/uninstalled", { shop: session.shop });
    return { disconnected: true, slotSaved: false, error: null as string | null };
  }
  return { disconnected: false, slotSaved: false, error: "unknown action" };
};

function DetailRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <s-stack direction="inline" gap="base">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value ?? "—"}</s-text>
    </s-stack>
  );
}

export default function Settings() {
  const { shop, onboarding, slots, defaultSlotId, backendConfigured, isProduction, supportUrl, privacyUrl } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isDisconnecting =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "disconnect";
  const isUnlinking =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "unlink-account";
  const isSavingSlot =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "save-slot";
  const connected = Boolean(onboarding?.connected);
  const rekartMerchantId = onboarding?.rekartMerchantId ?? null;

  const activeSlots = slots.filter((s) => s.is_active);
  const [slotId, setSlotId] = useState<string>(
    defaultSlotId != null ? String(defaultSlotId) : "",
  );

  return (
    <s-page heading="Settings">
      {actionData?.disconnected && (
        <s-banner tone="success" heading="Syncing stopped">
          <s-paragraph>
            This store will no longer sync orders or deliveries to Rekart. To
            fully remove the app, uninstall it from your Shopify admin.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Store">
        <s-stack direction="block" gap="base">
          <DetailRow label="Store" value={shop} />
          <s-stack direction="inline" gap="base">
            <s-text color="subdued">Rekart connection</s-text>
            {connected ? (
              <s-badge tone="success">Connected</s-badge>
            ) : (
              <s-badge tone="warning">Not connected</s-badge>
            )}
          </s-stack>
          {!backendConfigured && !isProduction && (
            <s-banner tone="warning" heading="Backend URL not configured">
              <s-paragraph>
                Set <code>REKART_BACKEND_URL</code> so the app can sync with the
                Rekart service.
              </s-paragraph>
            </s-banner>
          )}
        </s-stack>
      </s-section>

      {actionData?.slotSaved && (
        <s-banner tone="success" heading="Delivery slot saved">
          <s-paragraph>Default delivery slot saved.</s-paragraph>
        </s-banner>
      )}

      <s-section heading="Delivery settings">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Configure how Shopify orders are handled when they sync to Rekart.
          </s-paragraph>

          {!rekartMerchantId ? (
            <s-banner tone="warning" heading="Connect your Rekart account first">
              <s-paragraph>
                Connect your Rekart account first to configure delivery settings.
              </s-paragraph>
            </s-banner>
          ) : activeSlots.length === 0 ? (
            <s-banner tone="warning" heading="Couldn't load delivery slots">
              <s-paragraph>
                Could not load delivery slots from Rekart. Check your connection
                and try again.
              </s-paragraph>
            </s-banner>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="save-slot" />
              <s-stack direction="block" gap="base">
                <s-select
                  name="slotId"
                  label="Default delivery slot"
                  details="All Shopify orders will be assigned to this slot in Rekart."
                  value={slotId}
                  onChange={(e) => setSlotId(e.currentTarget.value)}
                  error={actionData?.error ?? undefined}
                >
                  <s-option value="">Select a slot</s-option>
                  {activeSlots.map((slot) => (
                    <s-option key={slot.slot_id} value={String(slot.slot_id)}>
                      {slot.text}
                    </s-option>
                  ))}
                </s-select>
                <s-button
                  type="submit"
                  variant="primary"
                  {...(isSavingSlot ? { loading: true } : {})}
                >
                  Set as default slot
                </s-button>
              </s-stack>
            </Form>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Rekart account">
        <s-stack direction="block" gap="base">
          {rekartMerchantId ? (
            <>
              <DetailRow label="Connected account" value={rekartMerchantId} />
              <s-paragraph>
                <s-text color="subdued">
                  Disconnecting your Rekart account signs this store out of Rekart
                  so you can sign in with a different account. Your store stays
                  installed and your setup details are kept.
                </s-text>
              </s-paragraph>
              {/* Confirm before disconnecting: opening the modal via the native
                  command/commandFor invoker. The actual disconnect form only
                  lives inside the modal, so it can't submit without confirming. */}
              <s-button
                variant="secondary"
                command="--show"
                commandFor="disconnect-account-modal"
              >
                Disconnect Rekart account
              </s-button>
              <s-modal
                id="disconnect-account-modal"
                heading="Disconnect Rekart account?"
              >
                <s-stack direction="block" gap="base">
                  <s-paragraph>
                    This will sign your store out of Rekart. Orders will stop
                    syncing until you reconnect.
                  </s-paragraph>
                  <s-stack direction="inline" gap="base">
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="unlink-account"
                      />
                      <s-button
                        type="submit"
                        variant="primary"
                        tone="critical"
                        {...(isUnlinking ? { loading: true } : {})}
                      >
                        Disconnect
                      </s-button>
                    </Form>
                    <s-button
                      variant="tertiary"
                      command="--hide"
                      commandFor="disconnect-account-modal"
                    >
                      Cancel
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-modal>
            </>
          ) : (
            <s-stack direction="block" gap="small">
              <s-paragraph>
                No Rekart account is linked to this store yet.
              </s-paragraph>
              <s-button
                variant="primary"
                onClick={() =>
                  navigate(`/app/connect-rekart?${searchParams.toString()}`)
                }
              >
                Connect Rekart account
              </s-button>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Business details">
        <s-stack direction="block" gap="small">
          <DetailRow label="Category" value={onboarding?.businessCategory} />
          <DetailRow label="Country" value={onboarding?.country} />
          <DetailRow label="Order volume" value={onboarding?.orderVolume} />
          <DetailRow label="Subscribers" value={onboarding?.subscriberCount} />
          <DetailRow label="Delivery operations" value={onboarding?.deliveryOps} />
          <s-button
            variant="tertiary"
            onClick={() => navigate(`/app/onboarding?${searchParams.toString()}`)}
          >
            Edit setup
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Help &amp; legal">
        <s-stack direction="block" gap="small">
          {/* Plain anchors (not s-link): external URLs must open top-level, not
              be intercepted by App Bridge's in-app navigation. */}
          <a href={supportUrl} target="_blank" rel="noopener noreferrer">
            Contact support
          </a>
          <a href={privacyUrl} target="_blank" rel="noopener noreferrer">
            Privacy policy
          </a>
        </s-stack>
      </s-section>

      <s-section heading="Stop syncing">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            Stops all order and delivery syncing between this Shopify store and
            Rekart. Does not uninstall the app.
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="disconnect" />
            <s-button
              type="submit"
              variant="primary"
              {...(isDisconnecting ? { loading: true } : {})}
            >
              Stop syncing
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function HydrateFallback() {
  return (
    <s-page heading="Settings">
      <SkeletonSection lines={3} />
      <SkeletonSection lines={3} />
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
