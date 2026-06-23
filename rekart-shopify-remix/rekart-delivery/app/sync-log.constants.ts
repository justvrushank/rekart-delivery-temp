// Client-safe constants for the Sync Log screen.
//
// Kept OUT of sync-log.server.ts so the route component can import them without
// dragging server-only code (db.server / prisma / shopify.server) into the
// client bundle — sync-log.server.ts is stripped from the client build, which
// would otherwise leave these values undefined at runtime.

export const PUSH_STATUSES = ["pending", "succeeded", "failed", "dead"] as const;

export type PushStatus = (typeof PUSH_STATUSES)[number];
