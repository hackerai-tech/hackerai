import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

/**
 * Per-user OrcaRouter credential. Only the Next.js server (service key) reads
 * or writes it; the key is AES-GCM ciphertext and plaintext never reaches
 * Convex or the browser. `generation` increases on every save so a late 401
 * from an older key cannot mark a freshly reconnected credential as broken.
 */

const sourceValidator = v.union(v.literal("api_key"), v.literal("pkce"));
const statusValidator = v.union(v.literal("active"), v.literal("needs_reauth"));

export const getForBackend = query({
  args: { serviceKey: v.string(), userId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      encrypted_key: v.string(),
      key_hint: v.string(),
      source: sourceValidator,
      status: statusValidator,
      generation: v.number(),
      updated_at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("orcarouter_credentials")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();
    if (!row) return null;
    return {
      encrypted_key: row.encrypted_key,
      key_hint: row.key_hint,
      source: row.source,
      status: row.status,
      generation: row.generation,
      updated_at: row.updated_at,
    };
  },
});

export const saveForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    encryptedKey: v.string(),
    keyHint: v.string(),
    source: sourceValidator,
  },
  returns: v.object({ generation: v.number() }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const existing = await ctx.db
      .query("orcarouter_credentials")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();
    const now = Date.now();
    const generation = (existing?.generation ?? 0) + 1;
    const fields = {
      encrypted_key: args.encryptedKey,
      key_hint: args.keyHint,
      source: args.source,
      status: "active" as const,
      generation,
      updated_at: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("orcarouter_credentials", {
        user_id: args.userId,
        ...fields,
      });
    }
    return { generation };
  },
});

export const clearForBackend = mutation({
  args: { serviceKey: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = await ctx.db
      .query("orcarouter_credentials")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
    return null;
  },
});

/**
 * OrcaRouter keys are durable grants with no refresh flow: a 401 means the
 * user revoked or deleted the key. Mark only the exact generation that was
 * rejected; the stored ciphertext is kept until the user reconnects or clears.
 */
export const markNeedsReauthForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    generation: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("orcarouter_credentials")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();
    if (!row || row.generation !== args.generation) return false;
    if (row.status !== "needs_reauth") {
      await ctx.db.patch(row._id, {
        status: "needs_reauth",
        updated_at: Date.now(),
      });
    }
    return true;
  },
});
