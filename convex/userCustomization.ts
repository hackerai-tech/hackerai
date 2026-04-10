import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";

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
    include_memory_entries: v.optional(v.boolean()),
    guardrails_config: v.optional(v.string()),
    caido_enabled: v.optional(v.boolean()),
    extra_usage_enabled: v.optional(v.boolean()),
    max_mode_enabled: v.optional(v.boolean()),
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
    const MAX_GUARDRAILS_LIMIT = 5000;

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
      args.guardrails_config &&
      args.guardrails_config.length > MAX_GUARDRAILS_LIMIT
    ) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: `Guardrails config exceeds ${MAX_GUARDRAILS_LIMIT} character limit`,
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
        if (args.include_memory_entries !== undefined)
          patch.include_memory_entries = args.include_memory_entries;
        if (args.guardrails_config !== undefined)
          patch.guardrails_config = args.guardrails_config.trim() || undefined;
        if (args.caido_enabled !== undefined)
          patch.caido_enabled = args.caido_enabled;
        if (args.extra_usage_enabled !== undefined)
          patch.extra_usage_enabled = args.extra_usage_enabled;
        if (args.max_mode_enabled !== undefined)
          patch.max_mode_enabled = args.max_mode_enabled;

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
          include_memory_entries: args.include_memory_entries ?? true,
          guardrails_config: args.guardrails_config?.trim() || undefined,
          caido_enabled: args.caido_enabled ?? false,
          extra_usage_enabled: args.extra_usage_enabled ?? false,
          max_mode_enabled: args.max_mode_enabled ?? false,
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
      include_memory_entries: v.boolean(),
      guardrails_config: v.optional(v.string()),
      caido_enabled: v.boolean(),
      extra_usage_enabled: v.boolean(),
      max_mode_enabled: v.boolean(),
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
        include_memory_entries: customization.include_memory_entries ?? true,
        guardrails_config: customization.guardrails_config,
        caido_enabled: customization.caido_enabled ?? false,
        extra_usage_enabled: customization.extra_usage_enabled ?? false,
        max_mode_enabled: customization.max_mode_enabled ?? false,
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
      include_memory_entries: v.boolean(),
      guardrails_config: v.optional(v.string()),
      caido_enabled: v.boolean(),
      extra_usage_enabled: v.boolean(),
      max_mode_enabled: v.boolean(),
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
        include_memory_entries: customization.include_memory_entries ?? true,
        guardrails_config: customization.guardrails_config,
        caido_enabled: customization.caido_enabled ?? false,
        extra_usage_enabled: customization.extra_usage_enabled ?? false,
        max_mode_enabled: customization.max_mode_enabled ?? false,
        updated_at: customization.updated_at,
      };
    } catch (error) {
      console.error("Failed to get user customization:", error);
      return null;
    }
  },
});
