"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// Admin-only readback of the binary that actually executes Node actions.
export const identity = internalAction({
  args: {},
  returns: v.object({
    nodeVersion: v.string(),
    convexUrl: v.union(v.string(), v.null()),
  }),
  handler: async () => ({
    nodeVersion: process.versions.node,
    convexUrl: process.env.CONVEX_CLOUD_URL ?? null,
  }),
});
