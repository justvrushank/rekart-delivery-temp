import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  DeliveryMethod,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Base URL of the Rekart FastAPI backend. The data webhooks below are delivered
// directly to this service. When unset (e.g. local dev without the backend),
// registration is skipped so install/auth still succeeds.
const REKART_BACKEND_URL = process.env.REKART_BACKEND_URL?.replace(/\/$/, "");

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Shop-specific webhooks delivered straight to the Rekart FastAPI backend.
  // App-lifecycle (app/uninstalled, app/scopes_update) and GDPR webhooks are
  // declared in shopify.app.toml and handled by the Remix app instead.
  webhooks: REKART_BACKEND_URL
    ? {
        ORDERS_CREATE: {
          deliveryMethod: DeliveryMethod.Http,
          callbackUrl: `${REKART_BACKEND_URL}/webhooks/shopify/orders/create`,
        },
        ORDERS_UPDATED: {
          deliveryMethod: DeliveryMethod.Http,
          callbackUrl: `${REKART_BACKEND_URL}/webhooks/shopify/orders/updated`,
        },
        ORDERS_CANCELLED: {
          deliveryMethod: DeliveryMethod.Http,
          callbackUrl: `${REKART_BACKEND_URL}/webhooks/shopify/orders/cancelled`,
        },
        CUSTOMERS_CREATE: {
          deliveryMethod: DeliveryMethod.Http,
          callbackUrl: `${REKART_BACKEND_URL}/webhooks/shopify/customers/create`,
        },
        CUSTOMERS_UPDATE: {
          deliveryMethod: DeliveryMethod.Http,
          callbackUrl: `${REKART_BACKEND_URL}/webhooks/shopify/customers/update`,
        },
      }
    : {},
  hooks: {
    afterAuth: async ({ session }) => {
      // Register the FastAPI-bound data webhooks for this shop on install.
      if (REKART_BACKEND_URL) {
        await shopify.registerWebhooks({ session });
      }
      // Mark the shop as connected so the dashboard knows onboarding/install
      // completed. Upsert keeps reinstalls idempotent and preserves any
      // onboarding answers already captured for the shop.
      await prisma.shopOnboarding.upsert({
        where: { shop: session.shop },
        create: { shop: session.shop, connected: true },
        update: { connected: true },
      });
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
