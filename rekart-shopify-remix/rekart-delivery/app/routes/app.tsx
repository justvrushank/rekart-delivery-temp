import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { getOnboarding } from "../onboarding.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const onboarding = await getOnboarding(session.shop);

  // Once onboarding is finished AND a Rekart account is linked, the Setup and
  // Account status screens are no longer part of the merchant's day-to-day flow,
  // so hide those nav links.
  const onboardingComplete =
    onboarding?.completed === true && onboarding?.rekartMerchantId != null;

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", onboardingComplete };
};

export default function App() {
  const { apiKey, onboardingComplete } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/sync-log">Delivery History</s-link>
        {!onboardingComplete && (
          <s-link href="/app/onboarding">Setup</s-link>
        )}
        {!onboardingComplete && (
          <s-link href="/app/pending-setup">Account status</s-link>
        )}
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
