import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";

const proxyProtocolValidator = v.union(v.literal("http"), v.literal("socks5"));

const encryptedProxyConfigValidator = v.object({
  enabled: v.boolean(),
  protocol: proxyProtocolValidator,
  encryptedConfig: v.string(),
  updatedAt: v.number(),
});

async function getProxyConfigByUserId(ctx: MutationCtx, userId: string) {
  return ctx.db
    .query("user_proxy_configs")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .first();
}

export const getEncryptedForUser = internalQuery({
  args: { userId: v.string() },
  returns: v.union(v.null(), encryptedProxyConfigValidator),
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("user_proxy_configs")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();

    if (!config) return null;

    return {
      enabled: config.enabled,
      protocol: config.protocol,
      encryptedConfig: config.encrypted_config,
      updatedAt: config.updated_at,
    };
  },
});

export const upsertEncryptedForUser = internalMutation({
  args: {
    userId: v.string(),
    enabled: v.boolean(),
    protocol: proxyProtocolValidator,
    encryptedConfig: v.string(),
    updatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await getProxyConfigByUserId(ctx, args.userId);
    const value = {
      enabled: args.enabled,
      protocol: args.protocol,
      encrypted_config: args.encryptedConfig,
      updated_at: args.updatedAt,
    };

    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("user_proxy_configs", {
        user_id: args.userId,
        ...value,
      });
    }

    return null;
  },
});

export const deleteForUser = internalMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await getProxyConfigByUserId(ctx, args.userId);
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});
