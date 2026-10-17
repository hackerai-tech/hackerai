import { v, ConvexError } from "convex/values";
import {
  query,
  mutation,
  type QueryCtx,
  type MutationCtx,
} from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { networkPolicy, networkSettings } from "./cloudNetworkValidators";
import {
  normalizeNetworkPolicy,
  DEFAULT_NETWORK_POLICY,
} from "../lib/cloud-network/policy";
const auth = { serviceKey: v.string(), userId: v.string() };
async function row(ctx: QueryCtx | MutationCtx, userId: string) {
  await assertUserCanAccessChatHistory(ctx, userId);
  return ctx.db
    .query("cloud_network_settings")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .unique();
}
export const get = query({
  args: auth,
  returns: v.union(v.null(), networkSettings),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const saved = await row(ctx, args.userId);
    return saved
      ? { policy: saved.policy, revision: saved.revision, status: saved.status }
      : null;
  },
});

// Serialize external provider writes across web requests and Trigger workers.
// Provider operations have a 45s deadline; this fence outlives that deadline.
export const begin = mutation({
  args: {
    ...auth,
    token: v.string(),
    expectedRevision: v.optional(v.number()),
    policy: v.optional(networkPolicy),
  },
  returns: v.union(v.null(), networkSettings),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const saved = await row(ctx, args.userId);
    if (saved?.leaseUntil && saved.leaseUntil > Date.now())
      throw new ConvexError(
        "A network update is already running. Try again shortly.",
      );
    if (args.policy && args.expectedRevision !== (saved?.revision ?? 0))
      throw new ConvexError(
        "Network settings changed. Reload them before saving.",
      );
    if (!saved && !args.policy) return null;
    const policy = args.policy
      ? normalizeNetworkPolicy(args.policy)
      : (saved?.policy ?? DEFAULT_NETWORK_POLICY);
    const revision = (saved?.revision ?? 0) + (args.policy ? 1 : 0);
    const next = {
      policy,
      revision,
      status: "applying" as const,
      token: args.token,
      leaseUntil: Date.now() + 120_000,
    };
    if (saved) await ctx.db.patch(saved._id, next);
    else
      await ctx.db.insert("cloud_network_settings", {
        user_id: args.userId,
        ...next,
      });
    return { policy, revision, status: next.status };
  },
});
export const finish = mutation({
  args: { ...auth, token: v.string(), success: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const saved = await row(ctx, args.userId);
    if (!saved || saved.token !== args.token)
      throw new ConvexError(
        "Network update ownership changed. Reload settings.",
      );
    await ctx.db.patch(saved._id, {
      status: args.success ? "ready" : "failed",
      token: args.success ? undefined : saved.token,
      leaseUntil: args.success ? undefined : saved.leaseUntil,
    });
    return null;
  },
});
