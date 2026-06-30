// Merchant account linking — appears after onboarding when the shop has no
// Rekart account linked yet (rekartMerchantId is null). The merchant signs in
// with their Rekart credentials; we proxy the login through the action so the
// username/password never touch the browser, then store the JWT + client_id on
// the ShopOnboarding row and send them to the dashboard.

import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  data,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getOnboarding } from "../onboarding.server";
import { loginToRekart, registerShopWithRekart, backendUrl } from "../rekart.server";
import { encrypt } from "../crypto.server";
import db from "../db.server";
import { SkeletonSection } from "../skeleton";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const onboarding = await getOnboarding(session.shop);

  // Already linked → nothing to do here; back to the dashboard (preserving the
  // embedded params so the redirect stays in the embedded auth path).
  if (onboarding?.rekartMerchantId) {
    const url = new URL(request.url);
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return {
    backendConfigured: Boolean(backendUrl()),
    // Used to hide the dev-only "Backend URL not configured" banner in prod.
    isProduction: process.env.NODE_ENV === "production",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    return { error: "Enter both your Rekart username and password." };
  }

  const result = await loginToRekart(username, password);
  if (!result.ok) {
    return { error: result.error };
  }

  // Cross-tenant protection: prevent merchant from linking to a different Rekart account
  const existingOnboarding = await db.shopOnboarding.findUnique({
    where: { shop: session.shop },
    select: { rekartMerchantId: true },
  });

  if (
    existingOnboarding?.rekartMerchantId &&
    existingOnboarding.rekartMerchantId !== result.clientId
  ) {
    return data(
      {
        error:
          "These credentials belong to a different Rekart account. " +
          "Please use your original Rekart credentials to reconnect.",
      },
      { status: 403 },
    );
  }

  // Register the shop ↔ Rekart client_id mapping BEFORE persisting, so a
  // cross-tenant conflict (409 → LINKED_TO_DIFFERENT_ACCOUNT) blocks the merchant
  // before we store a connection Rekart rejects. A transient FAILED is logged but
  // does not block — the merchant still reaches the dashboard.
  // Guard the numeric coercion: a non-numeric client_id would become NaN and
  // serialize to null in the registration payload. Skip registration in that case
  // (we still store the string id below) rather than send a bogus null.
  const clientIdNum = Number(result.clientId);
  const registration = Number.isFinite(clientIdNum)
    ? await registerShopWithRekart(session.shop, clientIdNum)
    : ({ error: "FAILED" } as const);
  if (!Number.isFinite(clientIdNum)) {
    console.error("[connect-rekart] non-numeric client_id; skipped registration");
  }
  if (!("success" in registration)) {
    if (registration.error === "LINKED_TO_DIFFERENT_ACCOUNT") {
      return data(
        {
          error:
            "This store is already linked to a different Rekart account. " +
            "Please contact support.",
        },
        { status: 403 },
      );
    }
    console.error(
      `[connect-rekart] shop registration not confirmed: ${registration.error}`,
    );
  }

  // Upsert (not update): if the onboarding row is somehow absent, update() would
  // throw Prisma P2025. Mirrors the updateMany used elsewhere by tolerating a
  // missing row.
  const connectionData = {
    rekartMerchantId: result.clientId,
    // Encrypt the access token at rest; decrypted only when calling Rekart.
    rekartAccessToken: encrypt(result.accessToken),
    // Store expiry (ISO 8601 from the login response) for expiry handling.
    rekartTokenExpiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
    connected: true,
    // Fresh token — clear any prior "expired/invalid" flag.
    tokenInvalid: false,
  };
  await db.shopOnboarding.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop, ...connectionData },
    update: connectionData,
  });

  // Linked — go to the dashboard, keeping the embedded params.
  const url = new URL(request.url);
  return redirect(`/app?${url.searchParams.toString()}`);
};

export default function ConnectRekart() {
  const { backendConfigured, isProduction } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const isSubmitting = navigation.state === "submitting";

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Mirror the embedded-params-preserving submit used elsewhere: posting the
    // form element keeps the current URL's search params on the request.
    submit(event.currentTarget, { method: "post" });
  };

  return (
    <s-page heading="Connect your Rekart account">
      <s-section heading="Sign in to Rekart">
        <s-paragraph>
          Link this store to your Rekart account to start syncing deliveries.
          Use the same username and password you use for the Rekart dashboard.
        </s-paragraph>

        {actionData?.error && (
          <s-banner tone="critical" heading="Couldn't connect">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        )}

        {!backendConfigured && !isProduction && (
          <s-banner tone="warning" heading="Backend URL not configured">
            <s-paragraph>
              Set <code>REKART_BACKEND_URL</code> so the app can sign in to
              Rekart.
            </s-paragraph>
          </s-banner>
        )}

        <form method="post" onSubmit={handleSubmit}>
          <s-stack direction="block" gap="large">
            <s-text-field
              name="username"
              label="Username"
              details="Your Rekart phone number or email"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              autocomplete="username"
              required
            ></s-text-field>

            <s-password-field
              name="password"
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            ></s-password-field>

            <s-stack direction="inline" gap="base">
              <s-button
                type="submit"
                variant="primary"
                {...(isSubmitting ? { loading: true } : {})}
              >
                Connect account
              </s-button>
            </s-stack>
          </s-stack>
        </form>
      </s-section>

      <s-section slot="aside" heading="Why connect?">
        <s-paragraph>
          Connecting links your Shopify store to your Rekart merchant account so
          delivery status updates flow back onto your Shopify orders
          automatically.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function HydrateFallback() {
  return (
    <s-page heading="Connect Rekart">
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
