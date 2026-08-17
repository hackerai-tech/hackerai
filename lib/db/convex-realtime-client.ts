import { ConvexClient } from "convex/browser";
import { getConvexUrl } from "./convex-client";

/**
 * Create a short-lived reactive client for Node server waits. Keeping this in
 * a separate module avoids pulling Convex's WebSocket runtime into functions
 * analyzed for the Convex V8 backend.
 */
export function createConvexRealtimeClient(): ConvexClient {
  return new ConvexClient(getConvexUrl(), {
    logger: false,
    unsavedChangesWarning: false,
  });
}
