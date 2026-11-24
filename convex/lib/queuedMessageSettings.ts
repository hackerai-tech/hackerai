import { v } from "convex/values";

/** See QueuedMessageSettings in lib/chat/queued-message.ts. */
export const queuedMessageSettingsValidator = v.object({
  agentPermissionMode: v.union(
    v.literal("full_access"),
    v.literal("auto_review"),
    v.literal("ask_approval"),
  ),
  sandboxPreference: v.optional(v.string()),
  selectedModel: v.optional(v.string()),
});
