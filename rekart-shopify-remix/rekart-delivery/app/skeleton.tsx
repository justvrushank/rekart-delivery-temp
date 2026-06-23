// Lightweight skeleton placeholder for route `HydrateFallback` exports, shown
// while a route's loader data is still resolving.
//
// NOTE: the installed Polaris web components (@shopify/polaris-types) do not
// ship an <s-skeleton-section> element, so we approximate one here with stacked
// subdued, rounded bars inside an <s-section>. `lines` controls how many
// placeholder bars render. If a future Polaris version adds a real skeleton
// component, swap this implementation for it.
export function SkeletonSection({ lines = 3 }: { lines?: number }) {
  return (
    <s-section>
      <s-stack direction="block" gap="base">
        {Array.from({ length: lines }, (_, i) => (
          <s-box
            key={i}
            background="subdued"
            borderRadius="base"
            padding="base"
          />
        ))}
      </s-stack>
    </s-section>
  );
}
