import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    // Guard the cast: Shopify normally sends `current`, but if it's ever absent
    // the bare `payload.current as string[]` would make `.toString()` throw and
    // 500 the webhook (which then retries forever).
    const current = Array.isArray(payload?.current) ? (payload.current as string[]) : [];
    if (session) {
        await db.session.update({   
            where: {
                id: session.id
            },
            data: {
                scope: current.toString(),
            },
        });
    }
    return new Response();
};
