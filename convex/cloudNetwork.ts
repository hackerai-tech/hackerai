import { isUserDeletionFenced } from "./lib/userDeletionFence";
import { v, ConvexError } from "convex/values";
import {
  query,
  mutation,
  type QueryCtx,
  type MutationCtx,
} from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import {
  networkPolicy,
  networkSettings,
  cloudProxy,
} from "./cloudNetworkValidators";
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
      ? {
          policy: saved.policy,
          revision: saved.revision,
          status: saved.status,
          ...(saved.proxy !== undefined ? { proxy: saved.proxy } : {}),
          ...(saved.proxyManaged ? { proxyManaged: true } : {}),
        }
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
    proxy: v.optional(v.union(v.null(), cloudProxy)),
  },
  returns: v.union(v.null(), networkSettings),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.userId))
      throw new ConvexError("Account deletion is in progress.");
    const saved = await row(ctx, args.userId);
    if (saved?.leaseUntil && saved.leaseUntil > Date.now())
      throw new ConvexError(
        "A network update is already running. Try again shortly.",
      );
    if (
      (args.policy || args.proxy !== undefined) &&
      args.expectedRevision !== (saved?.revision ?? 0)
    )
      throw new ConvexError(
        "Network settings changed. Reload them before saving.",
      );
    if (!saved && !args.policy && args.proxy === undefined) return null;
    const policy = args.policy
      ? normalizeNetworkPolicy(args.policy)
      : (saved?.policy ?? DEFAULT_NETWORK_POLICY);
    const revision =
      (saved?.revision ?? 0) +
      (args.policy || args.proxy !== undefined ? 1 : 0);
    const proxy = args.proxy === undefined ? saved?.proxy : args.proxy;
    const proxyManaged = saved?.proxyManaged || Boolean(proxy);
    const next = {
      ...(proxy !== undefined ? { proxy } : {}),
      ...(proxyManaged ? { proxyManaged: true } : {}),
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
    return {
      policy,
      revision,
      status: next.status,
      ...(proxy !== undefined ? { proxy } : {}),
      ...(proxyManaged ? { proxyManaged: true } : {}),
    };
  },
});
export const finish = mutation({
  args: {
    ...auth,
    token: v.string(),
    success: v.boolean(),
    releaseLease: v.optional(v.boolean()),
    proxyRemoved: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const saved = await row(ctx, args.userId);
    if (!saved || saved.token !== args.token)
      throw new ConvexError(
        "Network update ownership changed. Reload settings.",
      );
    // Failed reads/cancellation before a provider write need no uncertainty fence.
    const releaseLease = args.success || args.releaseLease === true;
    await ctx.db.patch(saved._id, {
      status: args.success ? "ready" : "failed",
      token: releaseLease ? undefined : saved.token,
      leaseUntil: releaseLease ? undefined : saved.leaseUntil,
      // Keep proxy:null as the explicit desired provider state, including for
      // paused workspaces. The Vault cleanup marker can now be cleared.
      ...(args.success && args.proxyRemoved && saved.proxy === null
        ? { proxyManaged: false }
        : {}),
    });
    return null;
  },
});

// Account deletion fences new writers before inspecting/cleaning the secret.
export const proxyCleanupState = query({
  args: auth,
  returns: v.object({
    managed: v.boolean(),
    leaseUntil: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!(await isUserDeletionFenced(ctx.db, args.userId)))
      throw new ConvexError("Account deletion has not started.");
    const saved = await ctx.db
      .query("cloud_network_settings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();
    return {
      managed: Boolean(saved?.proxyManaged),
      ...(saved?.leaseUntil ? { leaseUntil: saved.leaseUntil } : {}),
    };
  },
});
export const finishProxyCleanup = mutation({
  args: auth,
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!(await isUserDeletionFenced(ctx.db, args.userId)))
      throw new ConvexError("Account deletion has not started.");
    const saved = await ctx.db
      .query("cloud_network_settings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();
    if (saved?.leaseUntil && saved.leaseUntil > Date.now())
      throw new ConvexError("Network update is still running.");
    if (saved)
      await ctx.db.patch(saved._id, { proxy: null, proxyManaged: false });
    return null;
  },
});
