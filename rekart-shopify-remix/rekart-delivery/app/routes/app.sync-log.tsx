// Milestone 4 — Sync Log screen: the last 50 outbound delivery-status pushes
// (FulfillmentPush rows from Milestone 3), filterable by type/status, with a
// manual retry per row.

import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useRouteError,
  useSearchParams,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getRecentPushes, parseFilters, retryPushNow } from "../sync-log.server";
import { PUSH_STATUSES } from "../sync-log.constants";
import { REKART_STATUSES } from "../fulfillment-status";
import { SkeletonSection } from "../skeleton";

// Map Rekart's internal error codes to merchant-friendly copy. Unknown codes
// fall back to a generic, support-oriented message.
const ERROR_LABELS: Record<string, string> = {
  SLOT_NOT_FOUND: "No delivery slot configured",
  PRODUCT_NOT_MAPPED: "Product not linked to Rekart",
  AUTH_FAILED: "Rekart connection expired",
  MISSING_PHONE: "Customer phone number missing",
  NO_DEFAULT_SLOT: "No delivery slot configured",
};

function friendlyError(code: string): string {
  return ERROR_LABELS[code] ?? "Something went wrong — contact support";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filters = parseFilters(url.searchParams);
  const pushes = await getRecentPushes(session.shop, filters, 50);
  return { pushes, filters };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (String(formData.get("intent")) === "retry") {
    const pushId = String(formData.get("pushId") ?? "");
    const result = await retryPushNow(session.shop, pushId);
    return { retried: pushId, ok: result.ok, error: result.error ?? null };
  }
  return { retried: null as string | null, ok: false, error: "unknown action" };
};

const STATUS_TONE: Record<string, "success" | "warning" | "critical" | "neutral"> = {
  succeeded: "success",
  pending: "warning",
  failed: "warning",
  dead: "critical",
};

function shortOrderId(id: string): string {
  const m = id.match(/(\d+)$/);
  return m ? `#${m[1]}` : id;
}

export default function SyncLog() {
  const { pushes, filters } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const retryingId =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "retry"
      ? String(navigation.formData?.get("pushId"))
      : null;

  const submit = useSubmit();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Merge filter values into the CURRENT search params so the embedded context
  // (shop/host/embedded/id_token) survives. A bare GET form submit replaces the
  // whole query string, which drops those params and bounces the iframe to the
  // login screen (same root cause as the onboarding redirect bug).
  const applyFilters = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams(searchParams);
    for (const key of ["status", "type"] as const) {
      const value = data.get(key);
      if (value) next.set(key, String(value));
      else next.delete(key);
    }
    submit(next, { method: "get" });
  };

  // Reset clears the filters but keeps the embedded params in the URL.
  const resetParams = new URLSearchParams(searchParams);
  resetParams.delete("status");
  resetParams.delete("type");
  const resetHref = resetParams.toString()
    ? `/app/sync-log?${resetParams.toString()}`
    : "/app/sync-log";

  return (
    <s-page heading="Delivery History">
      {actionData?.retried && (
        <s-banner
          tone={actionData.ok ? "success" : "critical"}
          heading={actionData.ok ? "Retry succeeded" : "Retry failed"}
        >
          <s-paragraph>{actionData.ok ? "The status was pushed to Shopify." : friendlyError(actionData.error ?? "")}</s-paragraph>
        </s-banner>
      )}

      <s-section heading="Filters">
        <form onSubmit={applyFilters}>
          <s-stack direction="inline" gap="base">
            <s-select name="status" label="Status" value={filters.status ?? ""}>
              <s-option value="">All statuses</s-option>
              {PUSH_STATUSES.map((s) => (
                <s-option key={s} value={s}>
                  {s}
                </s-option>
              ))}
            </s-select>
            <s-select name="type" label="Type" value={filters.type ?? ""}>
              <s-option value="">All types</s-option>
              {REKART_STATUSES.map((t) => (
                <s-option key={t} value={t}>
                  {t}
                </s-option>
              ))}
            </s-select>
            <s-button type="submit" variant="tertiary">
              Apply
            </s-button>
            <s-button
              type="button"
              variant="tertiary"
              onClick={() => navigate(resetHref)}
            >
              Reset
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading={`Recent events (${pushes.length})`}>
        {pushes.length === 0 ? (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-heading>No delivery history yet</s-heading>
              <s-paragraph>
                Orders will appear here once they're synced to Rekart.
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-stack direction="block" gap="small">
            {pushes.map((p) => (
              <s-box
                key={p.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base">
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="small">
                      <s-text>{shortOrderId(p.shopifyOrderId)}</s-text>
                      <s-text color="subdued">{p.rekartStatus}</s-text>
                      <s-badge tone={STATUS_TONE[p.status] ?? ("neutral" as const)}>
                        {p.status}
                      </s-badge>
                    </s-stack>
                    <s-text color="subdued">
                      {p.mappedAction} · attempt {p.attempts} ·{" "}
                      {new Date(p.createdAt as unknown as string).toLocaleString()}
                    </s-text>
                    {p.lastError && (
                      <s-stack direction="inline" gap="small">
                        <s-badge tone="critical">error</s-badge>
                        <s-text color="subdued">{friendlyError(p.lastError)}</s-text>
                      </s-stack>
                    )}
                  </s-stack>
                  {p.status !== "succeeded" && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="retry" />
                      <input type="hidden" name="pushId" value={p.id} />
                      <s-button
                        type="submit"
                        variant="tertiary"
                        {...(retryingId === p.id ? { loading: true } : {})}
                      >
                        Retry
                      </s-button>
                    </Form>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export function HydrateFallback() {
  return (
    <s-page heading="Delivery History">
      <SkeletonSection lines={2} />
      <SkeletonSection lines={5} />
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
