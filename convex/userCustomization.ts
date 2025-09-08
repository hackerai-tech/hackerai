import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./chats";

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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const MAX_CHAR_LIMIT = 1500;

    // Validate character limits
    if (args.nickname && args.nickname.length > MAX_CHAR_LIMIT) {
      throw new Error(`Nickname exceeds ${MAX_CHAR_LIMIT} character limit`);
    }
    if (args.occupation && args.occupation.length > MAX_CHAR_LIMIT) {
      throw new Error(`Occupation exceeds ${MAX_CHAR_LIMIT} character limit`);
    }
    if (args.personality && args.personality.length > MAX_CHAR_LIMIT) {
      throw new Error(`Personality exceeds ${MAX_CHAR_LIMIT} character limit`);
    }
    if (args.traits && args.traits.length > MAX_CHAR_LIMIT) {
      throw new Error(`Traits exceeds ${MAX_CHAR_LIMIT} character limit`);
    }
    if (args.additional_info && args.additional_info.length > MAX_CHAR_LIMIT) {
      throw new Error(
        `Additional info exceeds ${MAX_CHAR_LIMIT} character limit`,
      );
    }

    try {
      // Check if user already has customization data
      const existing = await ctx.db
        .query("user_customization")
        .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
        .first();

      const customizationData = {
        user_id: identity.subject,
        nickname: args.nickname?.trim() || undefined,
        occupation: args.occupation?.trim() || undefined,
        personality: args.personality?.trim() || undefined,
        traits: args.traits?.trim() || undefined,
        additional_info: args.additional_info?.trim() || undefined,
        include_memory_entries:
          args.include_memory_entries !== undefined
            ? args.include_memory_entries
            : true, // Default to enabled
        updated_at: Date.now(),
      };

      if (existing) {
        // Update existing customization
        await ctx.db.patch(existing._id, customizationData);
      } else {
        // Create new customization
        await ctx.db.insert("user_customization", customizationData);
      }

      return null;
    } catch (error) {
      console.error("Failed to save user customization:", error);
      throw new Error("Failed to save customization");
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
      updated_at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
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
        include_memory_entries: customization.include_memory_entries ?? true, // Default to enabled if not set
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
    serviceKey: v.optional(v.string()),
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
        include_memory_entries: customization.include_memory_entries ?? true, // Default to enabled if not set
        updated_at: customization.updated_at,
      };
    } catch (error) {
      console.error("Failed to get user customization:", error);
      return null;
    }
  },
});
