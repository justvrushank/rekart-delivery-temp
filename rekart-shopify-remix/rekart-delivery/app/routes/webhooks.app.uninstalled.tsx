import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { forwardToBackend } from "../rekart.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Keep the onboarding answers so a reinstall is smooth, but mark the shop as
  // disconnected and clear the Rekart account credentials — we must not retain a
  // live access token (or the linked merchant id) after uninstall.
  await db.shopOnboarding.updateMany({
    where: { shop },
    data: {
      connected: false,
      rekartAccessToken: null,
      rekartMerchantId: null,
    },
  });
  await forwardToBackend("/webhooks/shopify/app/uninstalled", { shop });

  return new Response();
};
