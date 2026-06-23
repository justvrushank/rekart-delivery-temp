#!/usr/bin/env node
// Milestone 3 verification — fire a real outbound status push at the running
// Remix app, the way Rekart would, then check the Shopify order timeline.
//
// Usage:
//   node scripts/verify-fulfillment-push.mjs \
//     --shop=rekart-dev-kysqlw9f.myshopify.com \
//     --order=5544332211000 \
//     --status=delivery_scheduled \
//     [--url=http://localhost:3000] [--token=<X-API-Key>] \
//     [--tracking=RK123]
//
// Token defaults to process.env.REKART_STATIC_API_KEY. Run delivery_scheduled
// first (creates the fulfillment), then out_for_delivery / delivered / failed.

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);

const url = (args.url || "http://localhost:3000").replace(/\/$/, "");
const token = args.token || process.env.REKART_STATIC_API_KEY;
const { shop, order, status, tracking } = args;

if (!shop || !order || !status) {
  console.error("Missing required --shop, --order and --status.");
  process.exit(2);
}
if (!token) {
  console.error("No token: pass --token or set REKART_STATIC_API_KEY.");
  process.exit(2);
}

const body = {
  shop,
  shopify_order_id: order,
  status,
  occurred_at: new Date().toISOString(),
  rekart_delivery_id: `verify_${Date.now()}`,
  ...(tracking
    ? { tracking: { number: tracking, url: `https://track.rekart/${tracking}`, company: "Rekart" } }
    : {}),
};

const res = await fetch(`${url}/api/fulfillment-push`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-API-Key": token },
  body: JSON.stringify(body),
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);
try {
  const json = JSON.parse(text);
  if (json.ok) {
    console.log(`\n✅ Pushed "${status}" (${json.mappedAction}). Check the order timeline in Shopify admin.`);
  } else {
    console.log(`\n⚠️  Push recorded but Shopify call failed: ${json.error}\n   (queued for retry: ${json.willRetry})`);
  }
} catch {
  /* non-JSON body already printed above */
}
process.exit(res.ok ? 0 : 1);
