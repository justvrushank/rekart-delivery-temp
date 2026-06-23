// Holding screen for NEW merchants (existingRekartUser === false) who finished
// onboarding but don't have a Rekart account yet. The Rekart sales team reviews
// their profile and reaches out to provision an account.

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getOnboarding } from "../onboarding.server";
import {
  DELIVERY_OPS,
  ORDER_VOLUMES,
  SUBSCRIBER_COUNTS,
} from "../onboarding-options";

const REKART_URL = "https://rekart.io";
const SUPPORT_URL = "https://rekart.io/support";
// Rekart's WhatsApp support line. Configurable via env; falls back to a
// placeholder so the link is obviously a TODO if the env var is unset.
// TODO: confirm Rekart's real WhatsApp number before production.
const WHATSAPP_URL =
  process.env.REKART_WHATSAPP_URL || "https://wa.me/91XXXXXXXXXX";

// Map stored option codes back to their human-readable labels for display.
function labelFor(
  options: readonly { value: string; label: string }[],
  value: string | null | undefined,
): string {
  if (!value) return "—";
  return options.find((o) => o.value === value)?.label ?? value;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const onboarding = await getOnboarding(session.shop);
  const url = new URL(request.url);

  // Not onboarded yet → send back to onboarding. Already linked → dashboard.
  // Preserve embedded params on every redirect.
  if (!onboarding?.completed) {
    throw redirect(`/app/onboarding?${url.searchParams.toString()}`);
  }
  if (onboarding.rekartMerchantId) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // An existing Rekart client who chose "Yes" but never finished linking should
  // go to the connect screen, not this new-merchant holding page.
  if (onboarding.existingRekartUser === true && !onboarding.rekartMerchantId) {
    throw redirect(`/app/connect-rekart?${url.searchParams.toString()}`);
  }

  return { onboarding, whatsappUrl: WHATSAPP_URL };
};

function DetailRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <s-stack direction="inline" gap="base">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value ?? "—"}</s-text>
    </s-stack>
  );
}

export default function PendingSetup() {
  const { onboarding, whatsappUrl } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const onboardingHref = `/app/onboarding?${searchParams.toString()}`;

  return (
    <s-page heading="We've received your application">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small">
            <s-badge tone="info">Pending review</s-badge>
          </s-stack>
          <s-paragraph>
            Thanks for installing Rekart Delivery. Our team will review your
            profile and reach out to set up your account.
          </s-paragraph>
          <s-paragraph>
            Our team typically responds within 1 business day.
          </s-paragraph>
          {/* Internal nav: s-link is intercepted by App Bridge and keeps the
              embedded params. */}
          <s-link href={onboardingHref}>Edit your details</s-link>
        </s-stack>
      </s-section>

      <s-section heading="Your details">
        <s-stack direction="block" gap="small">
          <DetailRow label="Category" value={onboarding.businessCategory} />
          <DetailRow label="Country" value={onboarding.country} />
          <DetailRow
            label="Order volume"
            value={labelFor(ORDER_VOLUMES, onboarding.orderVolume)}
          />
          <DetailRow
            label="Subscribers"
            value={labelFor(SUBSCRIBER_COUNTS, onboarding.subscriberCount)}
          />
          <DetailRow
            label="Delivery operations"
            value={labelFor(DELIVERY_OPS, onboarding.deliveryOps)}
          />
        </s-stack>
      </s-section>

      <s-section heading="While you wait">
        <s-stack direction="inline" gap="base">
          {/* s-button with href/target renders a real anchor that opens
              top-level — no <a> wrapping an <s-button> (invalid HTML). */}
          <s-button variant="primary" href={whatsappUrl} target="_blank">
            Chat with us on WhatsApp
          </s-button>
          <s-button href={REKART_URL} target="_blank">
            Visit rekart.io
          </s-button>
          <s-button href={SUPPORT_URL} target="_blank">
            Contact us
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
