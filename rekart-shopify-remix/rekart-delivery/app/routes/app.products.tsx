// Phase 4 — Product mapping. Shows each Shopify product variant alongside an
// auto-matched Rekart product (or a picker), and lets the merchant confirm or
// override the mapping. Confirmed mappings are upserted into ShopifyProductLink.

import { useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  data,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
  useRouteError,
  useSearchParams,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { authenticate } from "../shopify.server";
import { getOnboarding } from "../onboarding.server";
import {
  fetchRekartCatalog,
  pushProductMappings,
  type ProductMappingItem,
  type RekartProduct,
} from "../rekart.server";
import {
  matchProducts,
  type ProductMatch,
  type ShopifyProductInput,
} from "../product-matching.server";
import db from "../db.server";
import { parseGidId, toGid } from "../gid";
import { SkeletonSection } from "../skeleton";

const PRODUCTS_QUERY = `#graphql
  query MappingProducts {
    products(first: 250) {
      edges {
        node {
          id
          title
          variants(first: 100) {
            edges { node { id sku } }
          }
        }
      }
    }
  }
`;

interface ProductsQueryResult {
  data?: {
    products: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          variants: { edges: Array<{ node: { id: string; sku: string | null } }> };
        };
      }>;
    };
  };
}

// Writes the chosen rekart_product_id onto each mapped Shopify variant as a
// metafield (rekart.product_id), in one batched call.
const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface MetafieldsSetResult {
  data?: {
    metafieldsSet?: {
      userErrors?: Array<{
        field?: string[] | null;
        message: string;
        code?: string | null;
      }>;
    };
  };
}

// Defines the rekart.product_id variant metafield with storefront read access.
// Without a definition that grants storefront/checkout access, a bare metafield
// is invisible to the Storefront API and to checkout UI extensions — so the
// rekart-checkout extension's useAppMetafields() cannot read it. Run once
// (idempotent: a pre-existing definition returns the TAKEN error code, which we
// treat as success).
const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation EnsureRekartProductIdDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface MetafieldDefinitionCreateResult {
  data?: {
    metafieldDefinitionCreate?: {
      userErrors?: Array<{
        field?: string[] | null;
        message: string;
        code?: string | null;
      }>;
    };
  };
}

// Removes the rekart.product_id metafield from variants that have been unmapped.
const METAFIELDS_DELETE_MUTATION = `#graphql
  mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        ownerId
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface MetafieldsDeleteResult {
  data?: {
    metafieldsDelete?: {
      userErrors?: Array<{ field?: string[] | null; message: string }>;
    };
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const onboarding = await getOnboarding(shop);
  const rekartConnected = Boolean(onboarding?.rekartMerchantId);

  const existingMappings = await db.shopifyProductLink.findMany({
    where: { shopId: shop },
  });

  // The Rekart catalog fetch and the Shopify products query are independent, so
  // run them concurrently (the catalog call can take ~2.5s). Only hit Rekart when
  // an account is linked; otherwise fall back to a "not fetched" result. Track
  // whether the catalog call itself failed (vs. simply returned zero products) so
  // the UI can show the right empty state.
  const [catalog, resp] = await Promise.all([
    onboarding?.rekartMerchantId
      ? fetchRekartCatalog(shop, onboarding.rekartCacheId)
      : Promise.resolve({ error: "FAILED" } as const),
    admin.graphql(PRODUCTS_QUERY),
  ]);

  let rekartProducts: RekartProduct[] = [];
  let catalogError = false;
  if (onboarding?.rekartMerchantId) {
    if ("error" in catalog) {
      catalogError = true;
    } else {
      rekartProducts = catalog.products;
      // Persist catalog-derived shop metadata (currency/timezone/territory) plus
      // the returned cache_id (only when it changed, so later calls short-circuit)
      // in one update.
      await db.shopOnboarding.update({
        where: { shop },
        data: {
          rekartCurrency: catalog.currency ?? null,
          rekartCurrencySymbol: catalog.currencySymbol ?? null,
          rekartTimezone: catalog.timezone ?? null,
          rekartTerritoryId: catalog.territoryId ?? null,
          // Persist merchant subscription pattern toggles (served to the storefront
          // widget via the app proxy at /apps/rekart/plans).
          ...(catalog.settings
            ? {
                allowAlternateDay: catalog.settings.allow_alternate_day ?? true,
                allowWeekly: catalog.settings.allow_weekly ?? true,
                allowNthDay: catalog.settings.allow_nth_day ?? true,
              }
            : {}),
          ...(catalog.cacheId && catalog.cacheId !== onboarding.rekartCacheId
            ? { rekartCacheId: catalog.cacheId }
            : {}),
        },
      });
    }
  }

  // Flatten Shopify products to one row per variant.
  const json = (await resp.json()) as ProductsQueryResult;
  const shopifyProducts: ShopifyProductInput[] = (
    json.data?.products.edges ?? []
  ).flatMap((p) =>
    p.node.variants.edges.map((v) => ({
      variantId: parseGidId(v.node.id),
      productId: parseGidId(p.node.id),
      productTitle: p.node.title,
      sku: v.node.sku ?? null,
    })),
  );

  const autoMatches = matchProducts(shopifyProducts, rekartProducts);

  return {
    shopifyProducts,
    rekartProducts,
    existingMappings,
    autoMatches,
    rekartConnected,
    catalogError,
  };
};

const MappingSchema = z.array(
  z.object({
    shopifyVariantId: z.string().min(1),
    shopifyProductId: z.string().min(1),
    shopifyProductTitle: z.string().min(1),
    shopifySkuCode: z.string().optional(),
    rekartProductId: z.number().int().positive(),
    matchedAuto: z.boolean(),
  }),
);

// Variants that were previously mapped and are now set to "— Not mapped —":
// delete their ShopifyProductLink row + Shopify metafield, and forward them to
// Rekart as action "unmapped". We carry the Shopify product context (id, title,
// sku) so the unmapped row in the Rekart payload is as rich as a mapped one.
const UnmappedSchema = z.array(
  z.object({
    shopifyVariantId: z.string().min(1),
    shopifyProductId: z.string().min(1),
    shopifyProductTitle: z.string().min(1),
    shopifySkuCode: z.string().optional(),
  }),
);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get("mappings") ?? "[]"));
  } catch {
    return data(
      {
        savedCount: 0,
        removedCount: 0,
        error: "Invalid mapping data.",
        details: null,
        metafieldWarning: null as string | null,
        duplicates: [] as number[],
        mappingConflictWarning: null as string | null,
      },
      { status: 400 },
    );
  }

  const result = MappingSchema.safeParse(parsed);
  if (!result.success) {
    return data(
      {
        savedCount: 0,
        removedCount: 0,
        error: "Invalid mapping payload",
        details: result.error.issues,
        metafieldWarning: null as string | null,
        duplicates: [] as number[],
        mappingConflictWarning: null as string | null,
      },
      { status: 400 },
    );
  }

  // One-to-one rule: a Rekart product may be mapped to at most one Shopify
  // variant. Reject the whole save if any rekartProductId appears more than once
  // (mirrors the client-side guard; also catches a bypassed/forged submit).
  const seenRekartIds = new Set<number>();
  const duplicateRekartIds: number[] = [];
  for (const m of result.data) {
    if (seenRekartIds.has(m.rekartProductId)) {
      if (!duplicateRekartIds.includes(m.rekartProductId)) {
        duplicateRekartIds.push(m.rekartProductId);
      }
    } else {
      seenRekartIds.add(m.rekartProductId);
    }
  }
  if (duplicateRekartIds.length > 0) {
    return data(
      {
        savedCount: 0,
        removedCount: 0,
        error: "DUPLICATE_REKART_PRODUCT",
        details: null,
        metafieldWarning: null as string | null,
        duplicates: duplicateRekartIds,
        mappingConflictWarning: null as string | null,
      },
      { status: 400 },
    );
  }

  // Variants the merchant unmapped (previously saved, now "— Not mapped —").
  let unmapped: z.infer<typeof UnmappedSchema> = [];
  try {
    const unmappedResult = UnmappedSchema.safeParse(
      JSON.parse(String(formData.get("unmapped") ?? "[]")),
    );
    if (unmappedResult.success) unmapped = unmappedResult.data;
  } catch {
    // Malformed unmapped payload → treat as no unmaps (don't block the save).
  }

  // Upsert every confirmed mapping in ONE round trip instead of awaiting in a
  // loop. Store the plain numeric variant id (strip the GID prefix) so it matches
  // what the order webhook looks up. Idempotent if already numeric.
  await db.$transaction(
    result.data.map((m) => {
      const variantId = parseGidId(m.shopifyVariantId);
      return db.shopifyProductLink.upsert({
        where: {
          shopId_shopifyVariantId: {
            shopId: session.shop,
            shopifyVariantId: variantId,
          },
        },
        create: {
          shopId: session.shop,
          shopifyVariantId: variantId,
          shopifyProductTitle: m.shopifyProductTitle,
          shopifySku: m.shopifySkuCode ?? null,
          rekartProductId: m.rekartProductId,
          matchedAuto: m.matchedAuto,
        },
        update: {
          shopifyProductTitle: m.shopifyProductTitle,
          shopifySku: m.shopifySkuCode ?? null,
          rekartProductId: m.rekartProductId,
          matchedAuto: m.matchedAuto,
        },
      });
    }),
  );
  const savedCount = result.data.length;

  // Mirror the chosen Rekart product id onto each mapped Shopify variant as a
  // metafield (rekart.product_id), in ONE batched metafieldsSet call. Best-effort:
  // the mappings are already saved above, so a metafield failure must not block —
  // we surface a warning instead.
  let metafieldWarning: string | null = null;
  const metafields = result.data.map((m) => ({
    ownerId: toGid("ProductVariant", parseGidId(m.shopifyVariantId)),
    namespace: "rekart",
    key: "product_id",
    type: "number_integer",
    value: String(m.rekartProductId),
  }));

  // Ensure the rekart.product_id variant metafield definition exists with
  // storefront read access BEFORE writing values, so the checkout extension can
  // read them. Idempotent and best-effort: a pre-existing definition returns the
  // TAKEN code (expected, not an error); any other failure is collected as a
  // warning but never blocks — the mappings are already saved.
  const metafieldErrors: string[] = [];
  try {
    const defResp = await admin.graphql(METAFIELD_DEFINITION_CREATE_MUTATION, {
      variables: {
        definition: {
          namespace: "rekart",
          key: "product_id",
          name: "Rekart product id",
          ownerType: "PRODUCTVARIANT",
          type: "number_integer",
          access: { storefront: "PUBLIC_READ" },
        },
      },
    });
    const defJson = (await defResp.json()) as MetafieldDefinitionCreateResult;
    const defErrors =
      defJson.data?.metafieldDefinitionCreate?.userErrors ?? [];
    // TAKEN = the definition already exists, which is the idempotent success
    // case. Surface anything else as a warning.
    const realErrors = defErrors.filter((e) => e.code !== "TAKEN");
    if (realErrors.length > 0) {
      metafieldErrors.push(...realErrors.map((e) => e.message));
    }
  } catch (error) {
    metafieldErrors.push(
      error instanceof Error
        ? error.message
        : "metafieldDefinitionCreate request failed",
    );
  }

  // metafieldsSet accepts at most 25 metafields per call, so write in chunks of
  // 25 (sequentially). Best-effort: collect every chunk's errors and surface one
  // warning at the end — the mappings are already saved, so this never blocks.
  const CHUNK_SIZE = 25;
  for (let i = 0; i < metafields.length; i += CHUNK_SIZE) {
    const chunk = metafields.slice(i, i + CHUNK_SIZE);
    try {
      const resp = await admin.graphql(METAFIELDS_SET_MUTATION, {
        variables: { metafields: chunk },
      });
      const json = (await resp.json()) as MetafieldsSetResult;
      const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
      if (userErrors.length > 0) {
        metafieldErrors.push(...userErrors.map((e) => e.message));
      }
    } catch (error) {
      metafieldErrors.push(
        error instanceof Error ? error.message : "metafieldsSet request failed",
      );
    }
  }

  // Push the confirmed mappings to the Rekart backend so it can resolve order
  // line items to Rekart products directly from the variant id. Fully
  // non-blocking: the mappings are already saved locally, so a backend failure
  // is logged (pushProductMappings also logs internally) but never surfaced to
  // the merchant. Variant ids are sent in the plain numeric form used by the DB
  // and the order webhook.
  // Push only the variants linked to a Rekart product. Per Rekart's contract,
  // unmapped variants are NOT sent — the local row + metafield deletion below is
  // all that's needed for those. Each row strips the GID prefix to the plain
  // numeric variant id the order webhook resolves by.
  // TODO: wire up create flow — when a variant needs a brand-new Rekart product,
  // push a { shopifyVariantId, product: {...} } row instead of rekartProductId.
  const pushMappings: ProductMappingItem[] = result.data.map((m) => ({
    shopifyVariantId: parseGidId(m.shopifyVariantId),
    rekartProductId: m.rekartProductId,
  }));

  let mappingConflictWarning: string | null = null;
  if (pushMappings.length > 0) {
    const pushResult = await pushProductMappings(session.shop, pushMappings);
    if ("error" in pushResult) {
      console.error(
        `[products] pushProductMappings to Rekart failed for ${session.shop}`,
      );
    } else if (pushResult.conflicts.length > 0) {
      // Rekart accepted the request but rejected some rows because the Rekart
      // product is already mapped to a different variant on its side. The local
      // save already succeeded, so warn (don't block).
      console.error(
        `[products] Rekart reported mapping conflicts for ${session.shop}:`,
        JSON.stringify(pushResult.conflicts),
      );
      mappingConflictWarning =
        "Some mappings could not be saved on Rekart's side — a Rekart product was already mapped to a different variant. Please review your mappings.";
    }
  }

  // Unmapped variants: delete the local row, then delete the variant's
  // rekart.product_id metafield (chunked, 25/call) so it doesn't linger.
  let removedCount = 0;
  if (unmapped.length > 0) {
    const ids = unmapped.map((u) => parseGidId(u.shopifyVariantId));
    const deleted = await db.shopifyProductLink.deleteMany({
      where: { shopId: session.shop, shopifyVariantId: { in: ids } },
    });
    removedCount = deleted.count;

    const identifiers = ids.map((id) => ({
      ownerId: toGid("ProductVariant", id),
      namespace: "rekart",
      key: "product_id",
    }));
    for (let i = 0; i < identifiers.length; i += CHUNK_SIZE) {
      const chunk = identifiers.slice(i, i + CHUNK_SIZE);
      try {
        const resp = await admin.graphql(METAFIELDS_DELETE_MUTATION, {
          variables: { metafields: chunk },
        });
        const json = (await resp.json()) as MetafieldsDeleteResult;
        const userErrors = json.data?.metafieldsDelete?.userErrors ?? [];
        if (userErrors.length > 0) {
          metafieldErrors.push(...userErrors.map((e) => e.message));
        }
      } catch (error) {
        metafieldErrors.push(
          error instanceof Error
            ? error.message
            : "metafieldsDelete request failed",
        );
      }
    }
  }

  if (metafieldErrors.length > 0) {
    console.error("[products] metafield errors:", JSON.stringify(metafieldErrors));
    metafieldWarning =
      "Mappings saved, but some Rekart product metafields could not be updated in Shopify.";
  }

  return data(
    {
      savedCount,
      removedCount,
      error: null,
      details: null,
      metafieldWarning,
      duplicates: [] as number[],
      mappingConflictWarning,
    },
    { status: 200 },
  );
};

const CONFIDENCE_BADGE: Record<
  ProductMatch["matchConfidence"],
  { label: string; tone: "success" | "warning" | "neutral" }
> = {
  exact_name: { label: "Exact", tone: "success" },
  exact_sku: { label: "SKU", tone: "success" },
  fuzzy: { label: "Fuzzy", tone: "warning" },
  none: { label: "Unmatched", tone: "neutral" },
};

export default function Products() {
  const {
    rekartProducts,
    existingMappings,
    autoMatches,
    rekartConnected,
    catalogError,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [searchParams] = useSearchParams();

  const isSaving = navigation.state === "submitting";

  // Saved mappings take precedence over the auto-match suggestion.
  const savedByVariant = useMemo(() => {
    const map = new Map<string, (typeof existingMappings)[number]>();
    for (const m of existingMappings) map.set(m.shopifyVariantId, m);
    return map;
  }, [existingMappings]);

  // Selected Rekart product id per variant ("" = not mapped). Split into:
  //  - baseSelected: derived from loader data (saved mapping, then auto-match).
  //    Recomputes when the loader revalidates ("Refresh catalog"), so newly
  //    auto-matched variants surface instead of staying stuck at mount-time "".
  //  - overrides: the merchant's in-progress edits, which survive a refresh.
  // The effective `selected` is base with overrides layered on top.
  const baseSelected = useMemo(() => {
    const initial: Record<string, string> = {};
    for (const row of autoMatches) {
      const saved = savedByVariant.get(row.shopifyVariantId);
      initial[row.shopifyVariantId] = saved
        ? String(saved.rekartProductId)
        : row.rekartProductId != null
          ? String(row.rekartProductId)
          : "";
    }
    return initial;
  }, [autoMatches, savedByVariant]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const selected = useMemo(
    () => ({ ...baseSelected, ...overrides }),
    [baseSelected, overrides],
  );
  // Which matched rows have been switched into "edit" mode (show the picker).
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  // Inline client-side validation error (e.g. duplicate Rekart product). Cleared
  // on the next valid save attempt.
  const [clientError, setClientError] = useState<string | null>(null);

  const rekartNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of rekartProducts) map.set(p.productId, p.name);
    return map;
  }, [rekartProducts]);

  const handleSave = () => {
    const mappings = autoMatches
      .map((row) => {
        const value = selected[row.shopifyVariantId];
        if (!value) return null; // skip unmapped rows
        const rekartProductId = Number(value);
        // Skip non-numeric selections (e.g. a "null"/"undefined" option value):
        // Number(value) would be NaN, serialize to JSON null, and fail validation.
        if (!Number.isInteger(rekartProductId) || rekartProductId <= 0) return null;
        const saved = savedByVariant.get(row.shopifyVariantId);
        // Auto only when the kept selection equals the original auto suggestion.
        const matchedAuto =
          !saved &&
          row.matchedAuto &&
          String(row.rekartProductId) === value;
        return {
          shopifyVariantId: row.shopifyVariantId,
          shopifyProductId: row.shopifyProductId,
          shopifyProductTitle: row.shopifyProductTitle,
          // omit when null so it satisfies the optional string schema
          shopifySkuCode: row.shopifySkuCode ?? undefined,
          rekartProductId,
          matchedAuto,
        };
      })
      .filter(Boolean);

    // One-to-one rule: a Rekart product may be mapped to only one Shopify
    // variant. Block the submit and show an inline error if any rekartProductId
    // was selected for more than one variant.
    const rekartIdCounts = new Map<number, number>();
    for (const m of mappings) {
      if (!m) continue; // filter(Boolean) doesn't narrow the type
      rekartIdCounts.set(
        m.rekartProductId,
        (rekartIdCounts.get(m.rekartProductId) ?? 0) + 1,
      );
    }
    const hasDuplicate = Array.from(rekartIdCounts.values()).some((n) => n > 1);
    if (hasDuplicate) {
      setClientError(
        "Each Rekart product can only be mapped to one Shopify variant. Please check your mappings.",
      );
      return;
    }
    setClientError(null);

    // Variants that had a saved mapping but are now "— Not mapped —": send them
    // so the action deletes the row + its metafield.
    const unmapped = autoMatches
      .filter((row) => {
        const value = selected[row.shopifyVariantId] ?? "";
        return value === "" && savedByVariant.has(row.shopifyVariantId);
      })
      .map((row) => ({
        shopifyVariantId: row.shopifyVariantId,
        shopifyProductId: row.shopifyProductId,
        shopifyProductTitle: row.shopifyProductTitle,
        shopifySkuCode: row.shopifySkuCode ?? undefined,
      }));

    const data = new FormData();
    data.set("mappings", JSON.stringify(mappings));
    data.set("unmapped", JSON.stringify(unmapped));
    submit(data, { method: "post" });
  };

  const renderPicker = (variantId: string) => (
    <s-select
      label="Rekart product"
      labelAccessibilityVisibility="exclusive"
      value={selected[variantId] ?? ""}
      onChange={(e) => {
        // Capture the value synchronously. Reading e.currentTarget lazily inside
        // the setState updater crashes ("Cannot read properties of null") because
        // React clears currentTarget after the handler returns. "" = Not mapped.
        const value = e.currentTarget?.value ?? "";
        setOverrides((prev) => ({ ...prev, [variantId]: value }));
      }}
    >
      <s-option value="">— Not mapped —</s-option>
      {rekartProducts.map((p) => (
        <s-option key={p.productId} value={String(p.productId)}>
          {p.name}
        </s-option>
      ))}
    </s-select>
  );

  if (!rekartConnected) {
    return (
      <s-page heading="Product Mapping">
        <s-section heading="Connect your Rekart account first">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Link your Rekart account to load your product catalog and map your
              Shopify products to it.
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
        </s-section>
      </s-page>
    );
  }

  // The catalog call failed (network error / endpoint down) — distinct from a
  // catalog that simply has no products.
  if (catalogError) {
    return (
      <s-page heading="Product Mapping">
        <s-section heading="Could not load your Rekart catalog">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              We were unable to connect to Rekart. Please try refreshing the page.
              If the problem persists, contact support.
            </s-paragraph>
            <s-button variant="primary" onClick={() => revalidate()}>
              Try again
            </s-button>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  // Catalog loaded fine but the merchant has no Rekart products yet.
  if (rekartProducts.length === 0) {
    return (
      <s-page heading="Product Mapping">
        <s-section heading="No Rekart products found">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Please add your products in your Rekart dashboard first, then return
              here to map them to your Shopify products.
            </s-paragraph>
            {/* s-button with href/target renders a real anchor (valid HTML);
                previously an <a> wrapped an <s-button>, which is invalid. */}
            <s-button
              variant="primary"
              href="https://app.rekart.io"
              target="_blank"
            >
              Open Rekart Dashboard ↗
            </s-button>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Product Mapping">
      {actionData && (actionData.savedCount > 0 || actionData.removedCount > 0) ? (
        <s-banner tone="success" heading="Mappings updated">
          <s-paragraph>
            {actionData.savedCount === 1
              ? "1 product link saved"
              : `${actionData.savedCount} product links saved`}
            {actionData.removedCount > 0
              ? `, ${actionData.removedCount} removed`
              : ""}
            .
          </s-paragraph>
        </s-banner>
      ) : null}

      {actionData?.metafieldWarning ? (
        <s-banner tone="warning" heading="Some metafields were not written">
          <s-paragraph>{actionData.metafieldWarning}</s-paragraph>
        </s-banner>
      ) : null}

      {clientError ? (
        <s-banner tone="critical" heading="Duplicate Rekart product">
          <s-paragraph>{clientError}</s-paragraph>
        </s-banner>
      ) : null}

      {actionData?.error === "DUPLICATE_REKART_PRODUCT" ? (
        <s-banner tone="critical" heading="Duplicate Rekart product">
          <s-paragraph>
            Each Rekart product can only be mapped to one Shopify variant. Please
            check your mappings.
          </s-paragraph>
        </s-banner>
      ) : null}

      {actionData?.mappingConflictWarning ? (
        <s-banner tone="warning" heading="Some mappings were not saved on Rekart">
          <s-paragraph>{actionData.mappingConflictWarning}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Map your products">
          <s-stack direction="block" gap="base">
            {/* One subtle helper line for the whole table (not per row), next to
                a Refresh button so a just-added Rekart product can be pulled in
                without a full page reload. */}
            <s-stack direction="inline" gap="base" alignItems="center">
              <a
                href="https://app.rekart.io"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: "0.75rem", color: "#6d7175" }}
              >
                Can't find a Rekart product to map to? Add products in your Rekart
                Dashboard ↗
              </a>
              <s-button onClick={() => revalidate()}>Refresh catalog</s-button>
            </s-stack>
            <s-text color="subdued">
              Added a new product in Rekart? Refresh to see it here.
            </s-text>
            <s-table>
              <s-table-header-row>
                <s-table-header>Shopify Product</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Rekart Product</s-table-header>
                <s-table-header>Match Type</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {autoMatches.map((row) => {
                  const vid = row.shopifyVariantId;
                  const value = selected[vid] ?? "";
                  const isMapped = value !== "";
                  const isEditing = Boolean(editing[vid]);
                  const saved = savedByVariant.get(vid);
                  const badge = saved
                    ? { label: "Saved", tone: "success" as const }
                    : CONFIDENCE_BADGE[row.matchConfidence];

                  return (
                    <s-table-row key={vid}>
                      <s-table-cell>{row.shopifyProductTitle}</s-table-cell>
                      <s-table-cell>{row.shopifySkuCode ?? "—"}</s-table-cell>
                      <s-table-cell>
                        {isMapped && !isEditing ? (
                          <s-text>
                            {rekartNameById.get(Number(value)) ?? "—"}
                          </s-text>
                        ) : (
                          renderPicker(vid)
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={badge.tone}>{badge.label}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        {isMapped && !isEditing ? (
                          <s-button
                            variant="tertiary"
                            onClick={() =>
                              setEditing((prev) => ({ ...prev, [vid]: true }))
                            }
                          >
                            Change
                          </s-button>
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>

            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={handleSave}
                {...(isSaving ? { loading: true } : {})}
              >
                Save product links
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
    </s-page>
  );
}

export function HydrateFallback() {
  return (
    <s-page heading="Product Mapping">
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
