// Client-safe constants for the Sync Log screen.
//
// Kept OUT of sync-log.server.ts so the route component can import them without
// dragging server-only code (db.server / prisma / shopify.server) into the
// client bundle — sync-log.server.ts is stripped from the client build, which
// would otherwise leave these values undefined at runtime.

// Must match the statuses applyResult actually writes (pending | succeeded |
// dead). "failed" was exposed as a filter but never written, so filtering by it
// always returned zero rows; "dead" is rendered as "Failed" in the UI.
export const PUSH_STATUSES = ["pending", "succeeded", "dead"] as const;

export type PushStatus = (typeof PUSH_STATUSES)[number];

// User-facing labels for the status filter (the writer's vocabulary differs from
// what merchants expect to read).
export const PUSH_STATUS_LABELS: Record<PushStatus, string> = {
  pending: "pending",
  succeeded: "succeeded",
  dead: "Failed",
};
