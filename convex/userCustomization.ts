import { mutation, query } from "./lib/serviceFunctions";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { isUserDeletionFenced } from "./lib/userDeletionFence";

// Keep this preference out of customization payloads used to build model prompts.
// A default-on preference must never be treated as consent or export eligibility.
export const getModelImprovementPreference = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      enabled: v.boolean(),
      updatedAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || (await isUserDeletionFenced(ctx.db, identity.subject))) {
      return null;
    }
    const customization = await ctx.db
      .query("user_customization")
      .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
      .first();
    return {
      enabled: customization?.model_improvement_enabled ?? true,
      updatedAt: customization?.model_improvement_updated_at ?? null,
    };
  },
});

export const setModelImprovementPreference = mutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { enabled }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Sign in to update this preference.",
      });
    }
    if (await isUserDeletionFenced(ctx.db, identity.subject)) {
      throw new ConvexError({
        code: "ACCOUNT_DELETING",
        message: "This account is being deleted.",
      });
    }
    const customization = await ctx.db
      .query("user_customization")
      .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
      .first();
    const now = Date.now();
    const preference = {
      model_improvement_enabled: enabled,
      model_improvement_updated_at: now,
      updated_at: now,
    };
    if (customization) {
      await ctx.db.patch(customization._id, preference);
    } else {
      await ctx.db.insert("user_customization", {
        user_id: identity.subject,
        ...preference,
      });
    }
    return null;
  },
});

const shouldIncludeNotes = (customization: {
  include_notes?: boolean;
  include_memory_entries?: boolean;
}) =>
  customization.include_notes ?? customization.include_memory_entries ?? true;

/**
 * Save or update user customization data
 */
export const saveUserCustomization = mutation({
  args: {
    nickname: v.optional(v.string()),
    occupation: v.optional(v.string()),
    additional_info: v.optional(v.string()),
    include_notes: v.optional(v.boolean()),
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
    if (args.additional_info && args.additional_info.length > MAX_CHAR_LIMIT) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: `Additional info exceeds ${MAX_CHAR_LIMIT} character limit`,
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
        if (args.additional_info !== undefined)
          patch.additional_info = args.additional_info.trim() || undefined;
        if (args.include_notes !== undefined)
          patch.include_notes = args.include_notes;
        if (args.extra_usage_enabled !== undefined)
          patch.extra_usage_enabled = args.extra_usage_enabled;

        await ctx.db.patch(existing._id, patch);
      } else {
        // Create new customization with defaults for unset fields
        await ctx.db.insert("user_customization", {
          user_id: identity.subject,
          nickname: args.nickname?.trim() || undefined,
          occupation: args.occupation?.trim() || undefined,
          additional_info: args.additional_info?.trim() || undefined,
          include_notes: args.include_notes ?? true,
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
      additional_info: v.optional(v.string()),
      include_notes: v.boolean(),
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
        additional_info: customization.additional_info,
        include_notes: shouldIncludeNotes(customization),
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
      additional_info: v.optional(v.string()),
      include_notes: v.boolean(),
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
        additional_info: customization.additional_info,
        include_notes: shouldIncludeNotes(customization),
        extra_usage_enabled: customization.extra_usage_enabled ?? false,
        updated_at: customization.updated_at,
      };
    } catch (error) {
      console.error("Failed to get user customization:", error);
      return null;
    }
  },
});
