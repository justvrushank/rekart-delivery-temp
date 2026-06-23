import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getOnboarding, saveOnboarding } from "../onboarding.server";
import db from "../db.server";
import {
  BUSINESS_CATEGORIES,
  DELIVERY_OPS,
  ORDER_VOLUMES,
  SUBSCRIBER_COUNTS,
  validateOnboarding,
} from "../onboarding-options";

const COUNTRIES = [
  "India",
  "United States",
  "United Kingdom",
  "Canada",
  "Australia",
  "United Arab Emirates",
  "Singapore",
  "Other",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const onboarding = await getOnboarding(session.shop);
  return { onboarding };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  // Yes/No fork: parse the existing-Rekart-user choice. "true"/"false" → boolean;
  // anything else (unanswered) → null.
  const rawExisting = formData.get("existingRekartUser");
  const existingRekartUser =
    rawExisting === "true" ? true : rawExisting === "false" ? false : null;

  const fields = {
    businessCategory: String(formData.get("businessCategory") ?? ""),
    country: String(formData.get("country") ?? ""),
    orderVolume: String(formData.get("orderVolume") ?? ""),
    subscriberCount: String(formData.get("subscriberCount") ?? ""),
    deliveryOps: String(formData.get("deliveryOps") ?? ""),
  };

  // No choice made yet.
  if (existingRekartUser === null) {
    return {
      errors: {
        existingRekartUser: "Please tell us whether you already use Rekart.",
      } as Record<string, string>,
      values: { ...fields, existingRekartUser: null as boolean | null },
    };
  }

  // Preserve embedded params on every redirect (see app._index.tsx note).
  const url = new URL(request.url);

  // Existing Rekart client: skip the qualification form, mark onboarding complete
  // (so the dashboard gate doesn't bounce them back here), and send them to the
  // dedicated connect screen to sign in — the single Rekart login flow.
  if (existingRekartUser === true) {
    await db.shopOnboarding.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, existingRekartUser: true, completed: true },
      update: { existingRekartUser: true, completed: true },
    });
    return redirect(`/app/connect-rekart?${url.searchParams.toString()}`);
  }

  // New merchant: validate + save the qualification answers; the gate then routes
  // them to pending-setup.
  const errors = validateOnboarding(fields);
  if (Object.keys(errors).length > 0) {
    return { errors, values: { ...fields, existingRekartUser } };
  }
  await saveOnboarding(session.shop, { existingRekartUser, ...fields });
  return redirect(`/app?${url.searchParams.toString()}`);
};

export default function Onboarding() {
  const { onboarding } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";
  const errors = actionData?.errors ?? {};
  // Prefer the values the user just submitted, then any saved answers.
  const source = actionData?.values ?? onboarding;
  const values = {
    businessCategory: source?.businessCategory ?? "",
    country: source?.country ?? "",
    orderVolume: source?.orderVolume ?? "",
    subscriberCount: source?.subscriberCount ?? "",
    deliveryOps: source?.deliveryOps ?? "",
  };

  // Fork state: null until the merchant picks Yes/No. The rest of the form is
  // revealed only after a choice is made.
  const [existing, setExisting] = useState<boolean | null>(
    typeof source?.existingRekartUser === "boolean"
      ? source.existingRekartUser
      : null,
  );

  useEffect(() => {
    if (Object.keys(errors).length > 0) {
      shopify.toast.show("Please complete all required fields", {
        isError: true,
      });
    }
  }, [errors, shopify]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit(event.currentTarget, { method: "post" });
  };

  return (
    <s-page heading="Set up Rekart Delivery">
      <s-section heading="Do you already use Rekart?">
        <s-paragraph>
          This tells us whether to connect your existing Rekart account or set
          you up as a new merchant.
        </s-paragraph>

        {errors.existingRekartUser && (
          <s-banner tone="critical" heading="Please choose an option">
            <s-paragraph>{errors.existingRekartUser}</s-paragraph>
          </s-banner>
        )}

        {/* Single-select choice list drives the fork. The chosen value is
            submitted via the hidden `existingRekartUser` field inside whichever
            fork form is revealed below. */}
        <s-choice-list
          name="existingRekartUserChoice"
          label="Do you already use Rekart?"
          labelAccessibilityVisibility="exclusive"
          values={existing === null ? [] : [String(existing)]}
          onChange={(e) => {
            const target = e.currentTarget as unknown as {
              value?: string;
              values?: string[];
            };
            const picked = target.value ?? target.values?.[0] ?? "";
            setExisting(
              picked === "true" ? true : picked === "false" ? false : null,
            );
          }}
        >
          <s-choice value="true">Yes, I'm an existing Rekart client</s-choice>
          <s-choice value="false">No, I'm new to Rekart</s-choice>
        </s-choice-list>
      </s-section>

      {existing === true && (
        <s-section heading="Connect your Rekart account">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Sign in with your existing Rekart credentials to link this store to
              your Rekart account.
            </s-paragraph>
            <form method="post" onSubmit={handleSubmit}>
              <input type="hidden" name="existingRekartUser" value="true" />
              <s-button
                type="submit"
                variant="primary"
                {...(isSubmitting ? { loading: true } : {})}
              >
                Continue to sign in
              </s-button>
            </form>
          </s-stack>
        </s-section>
      )}

      {existing === false && (
        <s-section heading="Tell us about your business">
          <s-paragraph>
            These details help us qualify your store for the Rekart local
            delivery network and tailor your setup. You can update them later.
          </s-paragraph>

          {Object.keys(errors).filter((k) => k !== "existingRekartUser").length >
            0 && (
            <s-banner tone="critical" heading="Some fields need your attention">
              <s-paragraph>
                Please fill in every field below before continuing.
              </s-paragraph>
            </s-banner>
          )}

          <form method="post" onSubmit={handleSubmit}>
            <input
              type="hidden"
              name="existingRekartUser"
              value={String(existing)}
            />
            <s-stack direction="block" gap="large">
              <s-select
                name="businessCategory"
                label="Business category"
                placeholder="Select a category"
                required
                value={values.businessCategory ?? ""}
                error={errors.businessCategory}
              >
                {BUSINESS_CATEGORIES.map((category) => (
                  <s-option key={category} value={category}>
                    {category}
                  </s-option>
                ))}
              </s-select>

              <s-select
                name="country"
                label="Country"
                placeholder="Select a country"
                required
                value={values.country ?? ""}
                error={errors.country}
              >
                {COUNTRIES.map((country) => (
                  <s-option key={country} value={country}>
                    {country}
                  </s-option>
                ))}
              </s-select>

              <s-select
                name="orderVolume"
                label="Monthly order volume"
                placeholder="Select your order volume"
                required
                value={values.orderVolume ?? ""}
                error={errors.orderVolume}
              >
                {ORDER_VOLUMES.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>

              <s-select
                name="subscriberCount"
                label="Subscriber count"
                placeholder="Select your subscriber count"
                required
                value={values.subscriberCount ?? ""}
                error={errors.subscriberCount}
              >
                {SUBSCRIBER_COUNTS.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>

              <s-select
                name="deliveryOps"
                label="Delivery operations"
                placeholder="How do you handle deliveries today?"
                required
                value={values.deliveryOps ?? ""}
                error={errors.deliveryOps}
              >
                {DELIVERY_OPS.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>

              <s-stack direction="inline" gap="base">
                <s-button
                  type="submit"
                  variant="primary"
                  {...(isSubmitting ? { loading: true } : {})}
                >
                  {onboarding?.completed ? "Save changes" : "Complete setup"}
                </s-button>
              </s-stack>
            </s-stack>
          </form>
        </s-section>
      )}

      <s-section slot="aside" heading="Why we ask">
        <s-paragraph>
          Rekart connects your store to local delivery partners. Knowing your
          category, location and volume lets us match you with the right
          fulfilment options and set realistic delivery SLAs.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
