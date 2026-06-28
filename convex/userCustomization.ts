import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { validateServiceKey } from "./lib/utils";

const shouldIncludeNotes = (customization: {
  include_notes?: boolean;
  include_memory_entries?: boolean;
}) =>
  customization.include_notes ?? customization.include_memory_entries ?? true;

const hasLegacyGuardrailsConfig = (customization: unknown) =>
  (customization as { guardrails_config?: unknown }).guardrails_config !==
  undefined;

/**
 * Save or update user customization data
 */
export const saveUserCustomization = mutation({
  args: {
    nickname: v.optional(v.string()),
    occupation: v.optional(v.string()),
    personality: v.optional(v.string()),
    traits: v.optional(v.string()),
    additional_info: v.optional(v.string()),
    include_notes: v.optional(v.boolean()),
    caido_enabled: v.optional(v.boolean()),
    caido_port: v.optional(v.number()),
    extra_usage_enabled: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const MAX_CHAR_LIMIT = 1500;

    // Validate character limits
    if (args.nickname && args.nickname.length > MAX_CHAR_LIMIT) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: `Nickname exceeds ${MAX_CHAR_LIMIT} character limit`,
      });
    }
    if (args.occupation && args.occupation.length > MAX_CHAR_LIMIT) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: `Occupation exceeds ${MAX_CHAR_LIMIT} character limit`,
      });
    }
    if (args.personality && args.personality.length > MAX_CHAR_LIMIT) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: `Personality exceeds ${MAX_CHAR_LIMIT} character limit`,
      });
    }
    if (args.traits && args.traits.length > MAX_CHAR_LIMIT) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: `Traits exceeds ${MAX_CHAR_LIMIT} character limit`,
      });
    }
    if (args.additional_info && args.additional_info.length > MAX_CHAR_LIMIT) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: `Additional info exceeds ${MAX_CHAR_LIMIT} character limit`,
      });
    }
    if (
      args.caido_port !== undefined &&
      args.caido_port !== 0 &&
      (!Number.isInteger(args.caido_port) ||
        args.caido_port < 1 ||
        args.caido_port > 65535)
    ) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: "Caido port must be an integer between 1 and 65535",
      });
    }

    try {
      // Check if user already has customization data
      const existing = await ctx.db
        .query("user_customization")
        .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
        .first();

      if (existing) {
        // Partial update: only overwrite fields that were explicitly passed
        const patch: Record<string, unknown> = { updated_at: Date.now() };
        if (args.nickname !== undefined)
          patch.nickname = args.nickname.trim() || undefined;
        if (args.occupation !== undefined)
          patch.occupation = args.occupation.trim() || undefined;
        if (args.personality !== undefined)
          patch.personality = args.personality.trim() || undefined;
        if (args.traits !== undefined)
          patch.traits = args.traits.trim() || undefined;
        if (args.additional_info !== undefined)
          patch.additional_info = args.additional_info.trim() || undefined;
        if (args.include_notes !== undefined)
          patch.include_notes = args.include_notes;
        if (args.caido_enabled !== undefined)
          patch.caido_enabled = args.caido_enabled;
        if (args.caido_port !== undefined)
          patch.caido_port = args.caido_port ? args.caido_port : undefined;
        if (args.extra_usage_enabled !== undefined)
          patch.extra_usage_enabled = args.extra_usage_enabled;

        await ctx.db.patch(existing._id, patch);
      } else {
        // Create new customization with defaults for unset fields
        await ctx.db.insert("user_customization", {
          user_id: identity.subject,
          nickname: args.nickname?.trim() || undefined,
          occupation: args.occupation?.trim() || undefined,
          personality: args.personality?.trim() || undefined,
          traits: args.traits?.trim() || undefined,
          additional_info: args.additional_info?.trim() || undefined,
          include_notes: args.include_notes ?? true,
          caido_enabled: args.caido_enabled,
          caido_port: args.caido_port ? args.caido_port : undefined,
          extra_usage_enabled: args.extra_usage_enabled ?? false,
          updated_at: Date.now(),
        });
      }

      return null;
    } catch (error) {
      console.error("Failed to save user customization:", error);
      // Re-throw ConvexError as-is, wrap others
      if (error instanceof ConvexError) {
        throw error;
      }
      throw new ConvexError({
        code: "SAVE_FAILED",
        message: "Failed to save customization",
      });
    }
  },
});

/**
 * Get user customization data
 */
export const getUserCustomization = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      nickname: v.optional(v.string()),
      occupation: v.optional(v.string()),
      personality: v.optional(v.string()),
      traits: v.optional(v.string()),
      additional_info: v.optional(v.string()),
      include_notes: v.boolean(),
      caido_enabled: v.boolean(),
      caido_port: v.optional(v.number()),
      extra_usage_enabled: v.boolean(),
      updated_at: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    try {
      const customization = await ctx.db
        .query("user_customization")
        .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
        .first();

      if (!customization) {
        return null;
      }

      return {
        nickname: customization.nickname,
        occupation: customization.occupation,
        personality: customization.personality,
        traits: customization.traits,
        additional_info: customization.additional_info,
        include_notes: shouldIncludeNotes(customization),
        caido_enabled: customization.caido_enabled ?? false,
        caido_port: customization.caido_port,
        extra_usage_enabled: customization.extra_usage_enabled ?? false,
        updated_at: customization.updated_at,
      };
    } catch (error) {
      console.error("Failed to get user customization:", error);
      return null;
    }
  },
});

/**
 * Get user customization data for backend (with service key)
 */
export const getUserCustomizationForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      nickname: v.optional(v.string()),
      occupation: v.optional(v.string()),
      personality: v.optional(v.string()),
      traits: v.optional(v.string()),
      additional_info: v.optional(v.string()),
      include_notes: v.boolean(),
      caido_enabled: v.boolean(),
      caido_port: v.optional(v.number()),
      extra_usage_enabled: v.boolean(),
      updated_at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      const customization = await ctx.db
        .query("user_customization")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
        .first();

      if (!customization) {
        return null;
      }

      return {
        nickname: customization.nickname,
        occupation: customization.occupation,
        personality: customization.personality,
        traits: customization.traits,
        additional_info: customization.additional_info,
        include_notes: shouldIncludeNotes(customization),
        caido_enabled: customization.caido_enabled ?? false,
        caido_port: customization.caido_port,
        extra_usage_enabled: customization.extra_usage_enabled ?? false,
        updated_at: customization.updated_at,
      };
    } catch (error) {
      console.error("Failed to get user customization:", error);
      return null;
    }
  },
});

/**
 * One-off cleanup for the removed terminal guardrails customization field.
 *
 * Run from the Convex dashboard with dryRun=true first, then rerun with
 * dryRun=false using the returned cursor until isDone is true. After all
 * legacy rows are patched, guardrails_config can be removed from schema.ts.
 */
export const cleanupLegacyGuardrailsConfig = mutation({
  args: {
    serviceKey: v.string(),
    paginationOpts: paginationOptsValidator,
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    scanned: v.number(),
    matched: v.number(),
    patched: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const result = await ctx.db
      .query("user_customization")
      .order("asc")
      .paginate(args.paginationOpts);

    let matched = 0;
    let patched = 0;
    for (const customization of result.page) {
      if (!hasLegacyGuardrailsConfig(customization)) continue;

      matched++;
      if (args.dryRun === true) continue;

      await ctx.db.patch(customization._id, { guardrails_config: undefined });
      patched++;
    }

    return {
      scanned: result.page.length,
      matched,
      patched,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
