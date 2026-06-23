# Rekart Delivery — Shopify App

Embedded Shopify app that connects a merchant's store to the **Rekart** local
delivery platform: it syncs orders/customers into Rekart and pushes delivery
status back onto Shopify orders.

## Architecture

```
Shopify (merchant store)
  │  orders/create, customers/create, customers/update  (per-shop HTTP webhooks)
  ▼
Rekart backend (existing FastAPI, dev3.rekart.io / app.rekart.io)
  ▲  delivery status updates
  │  POST /api/fulfillment-push  (X-API-Key)
  ▼
Rekart Delivery (this repo — Remix app, rekart-delivery/)
  │  fulfillmentCreateV2 / fulfillmentEventCreate / metafieldsSet
  ▼
Shopify Admin API  (order timeline: Out for delivery / Delivered / …)
```

There is **one** app in this repo: the Remix embedded app in
[`rekart-delivery/`](rekart-delivery/). It owns OAuth/install, the embedded UI,
the app-lifecycle + GDPR webhooks, and the outbound fulfillment-push endpoints.
The **data** webhooks (orders/customers) are registered per-shop at install and
delivered straight to the existing Rekart FastAPI backend — there is no separate
FastAPI service in this repo.

> Built on `@shopify/shopify-app-react-router` with Polaris **web components**
> (`s-page`, `s-section`, …) and App Bridge. Session + onboarding + fulfillment
> state persist in **MySQL** via Prisma (set `DATABASE_URL`).

## What's built

- ✅ Embedded OAuth/install via token exchange (`/auth/*`)
- ✅ Onboarding (ICP qualification) → Rekart account linking (`/app/connect-rekart`)
- ✅ Dashboard, Sync Log (last 50 + filters + manual retry), Settings
- ✅ App-lifecycle webhooks: `app/uninstalled` (clears session + Rekart
  credentials), `app/scopes_update`
- ✅ All 3 mandatory GDPR webhooks (`customers/data_request`, `customers/redact`,
  `shop/redact`) — HMAC-verified, forwarded to the Rekart backend
- ✅ Data webhooks (orders/create, customers/create, customers/update) registered
  per-shop, delivered directly to the Rekart backend
- ✅ Outbound status sync (Milestone 3): `POST /api/fulfillment-push` +
  `POST /api/fulfillment-retry-sweep` (X-API-Key), retry queue with backoff

## Setup

**Requires a MySQL database** (8.0+). Create a schema and point `DATABASE_URL`
at it; there is no local file DB anymore.

```bash
cd rekart-delivery
npm install
# Configure environment (see rekart-delivery/.env.example for the full list):
#   SHOPIFY_API_KEY / SHOPIFY_API_SECRET   (from the Partner Dashboard app)
#   SHOPIFY_APP_URL                         (your deployed/tunnel URL)
#   DATABASE_URL=mysql://user:password@host:3306/rekart_shopify
#   ENCRYPTION_KEY                          (openssl rand -hex 32)
#   REKART_BACKEND_URL=https://dev3.rekart.io   (bare host; the app adds /api)
#   REKART_STATIC_API_KEY                   (shared X-API-Key secret)
npx prisma migrate deploy   # apply migrations to your MySQL database
npx prisma generate
shopify app dev             # opens a Cloudflare tunnel + installs on a dev store
```

> The committed migration in `prisma/migrations/` is MySQL-specific. When DevOps
> provides the production connection string, run `prisma migrate deploy` to apply
> it. To evolve the schema locally, use `prisma migrate dev` against a real MySQL
> instance.

`shopify app dev` keeps `shopify.app.toml`'s `application_url` / `redirect_urls`
in sync with the tunnel automatically (`automatically_update_urls_on_dev`).

## Contracts

- [`rekart-delivery/docs/fastapi-contract.md`](rekart-delivery/docs/fastapi-contract.md)
  — inbound webhooks/stats the Rekart backend exposes
- [`rekart-delivery/docs/rekart-to-shopify-contract.md`](rekart-delivery/docs/rekart-to-shopify-contract.md)
  — outbound fulfillment-push endpoints this app exposes

## Still needed before App Store submission

- [ ] Real production `application_url` + `redirect_urls` in `shopify.app.toml`
- [ ] Privacy policy + support URLs set in the Partner Dashboard listing
      (`https://rekart.io/privacy-policy`, `https://rekart.io/support`)
- [ ] Live verification: <3s embedded load, no console errors, end-to-end
      fulfillment-push against a real dev-store order
