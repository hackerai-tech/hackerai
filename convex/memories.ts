import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./chats";

/**
 * Get memories for backend processing (with service key)
 * Enforces token limit based on user plan (10k for pro, 5k for free)
 */
export const getMemoriesForBackend = query({
  args: {
    serviceKey: v.optional(v.string()),
    userId: v.string(),
    subscription: v.optional(
      v.union(
        v.literal("free"),
        v.literal("pro"),
        v.literal("ultra"),
        v.literal("team"),
      ),
    ),
  },
  returns: v.array(
    v.object({
      memory_id: v.string(),
      content: v.string(),
      update_time: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      // Get all memories sorted by update time (newest first)
      const memories = await ctx.db
        .query("memories")
        .withIndex("by_user_and_update_time", (q) =>
          q.eq("user_id", args.userId),
        )
        .order("desc")
        .collect();

      // Calculate total tokens and enforce token limit based on subscription
      const tokenLimit =
        args.subscription === "ultra"
          ? 20000
          : args.subscription === "pro" || args.subscription === "team"
            ? 10000
            : 5000;
      let totalTokens = 0;
      const validMemories = [];

      for (const memory of memories) {
        const tokensValue = Number(memory.tokens);
        const safeTokens =
          Number.isFinite(tokensValue) && tokensValue > 0 ? tokensValue : 0;
        if (totalTokens + safeTokens <= tokenLimit) {
          totalTokens += safeTokens;
          validMemories.push(memory);
        } else {
          // Token limit exceeded, stop adding memories
          break;
        }
      }

      return validMemories.map((memory) => ({
        memory_id: memory.memory_id,
        content: memory.content,
        update_time: memory.update_time,
      }));
    } catch (error) {
      console.error("Failed to get memories for backend:", error);
      return [];
    }
  },
});

/**
 * Create a memory entry with service key authentication (for backend use)
 * Respects user's memory preference setting
 */
export const createMemoryForBackend = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    userId: v.string(),
    memoryId: v.string(),
    content: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      // Validate content length (max 2000 characters, roughly 500 tokens)
      const maxContentLength = 2000;
      if (args.content.length > maxContentLength) {
        throw new Error(
          `Memory content exceeds maximum length of ${maxContentLength} characters`,
        );
      }

      // Check user's memory preference first
      const userCustomization = await ctx.db
        .query("user_customization")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
        .first();

      // If user has disabled memory entries, don't create memory
      const memoryEnabled = userCustomization?.include_memory_entries ?? true;
      if (!memoryEnabled) {
        return args.memoryId; // Return the ID as if created, but don't actually create
      }

      // Check if memory with this ID already exists
      const existing = await ctx.db
        .query("memories")
        .withIndex("by_memory_id", (q) => q.eq("memory_id", args.memoryId))
        .first();

      if (existing) {
        throw new Error(`Memory with ID ${args.memoryId} already exists`);
      }

      // Simple token estimation (about 4 characters per token)
      const estimatedTokens = Math.ceil(args.content.length / 4);

      await ctx.db.insert("memories", {
        user_id: args.userId,
        memory_id: args.memoryId,
        content: args.content.trim(),
        update_time: Date.now(),
        tokens: estimatedTokens,
      });

      return args.memoryId;
    } catch (error) {
      console.error("Failed to create memory:", error);
      throw new Error(
        error instanceof Error ? error.message : "Failed to create memory",
      );
    }
  },
});

/**
 * Update a memory entry with service key authentication (for backend use)
 */
export const updateMemoryForBackend = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    userId: v.string(),
    memoryId: v.string(),
    content: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      // Validate content length (max 2000 characters, roughly 500 tokens)
      const maxContentLength = 2000;
      if (args.content.length > maxContentLength) {
        throw new Error(
          `Memory content exceeds maximum length of ${maxContentLength} characters`,
        );
      }

      // Find the existing memory
      const existing = await ctx.db
        .query("memories")
        .withIndex("by_memory_id", (q) => q.eq("memory_id", args.memoryId))
        .first();

      if (!existing) {
        throw new Error(`Memory with ID ${args.memoryId} not found`);
      }

      // Verify ownership
      if (existing.user_id !== args.userId) {
        throw new Error("Access denied: You don't own this memory");
      }

      // Simple token estimation (about 4 characters per token)
      const estimatedTokens = Math.ceil(args.content.length / 4);

      await ctx.db.patch(existing._id, {
        content: args.content.trim(),
        update_time: Date.now(),
        tokens: estimatedTokens,
      });

      return null;
    } catch (error) {
      console.error("Failed to update memory:", error);
      throw new Error(
        error instanceof Error ? error.message : "Failed to update memory",
      );
    }
  },
});

/**
 * Delete a memory entry with service key authentication (for backend use)
 * Idempotent - returns success even if memory doesn't exist
 */
export const deleteMemoryForBackend = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    userId: v.string(),
    memoryId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      // Find the memory to delete
      const memory = await ctx.db
        .query("memories")
        .withIndex("by_memory_id", (q) => q.eq("memory_id", args.memoryId))
        .first();

      // If memory doesn't exist, treat as successful deletion (idempotent)
      if (!memory) {
        return null;
      }

      // Verify ownership
      if (memory.user_id !== args.userId) {
        throw new Error("Access denied: You don't own this memory");
      }

      await ctx.db.delete(memory._id);
      return null;
    } catch (error) {
      console.error("Failed to delete memory:", error);
      throw new Error(
        error instanceof Error ? error.message : "Failed to delete memory",
      );
    }
  },
});

/**
 * Get a single memory by memory ID (for backend use)
 */
export const getMemoryByIdForBackend = query({
  args: {
    serviceKey: v.optional(v.string()),
    memoryId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      const memory = await ctx.db
        .query("memories")
        .withIndex("by_memory_id", (q) => q.eq("memory_id", args.memoryId))
        .first();

      return memory?.content || null;
    } catch (error) {
      console.error("Failed to get memory by ID:", error);
      throw new Error(
        error instanceof Error ? error.message : "Failed to get memory",
      );
    }
  },
});

/**
 * Get memories for frontend display (authenticated user)
 * Returns all memories for the current user
 */
export const getUserMemories = query({
  args: {},
  returns: v.array(
    v.object({
      memory_id: v.string(),
      content: v.string(),
      update_time: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      // Get all memories sorted by update time (newest first)
      const memories = await ctx.db
        .query("memories")
        .withIndex("by_user_and_update_time", (q) =>
          q.eq("user_id", identity.subject),
        )
        .order("desc")
        .collect();

      return memories.map((memory) => ({
        memory_id: memory.memory_id,
        content: memory.content,
        update_time: memory.update_time,
      }));
    } catch (error) {
      console.error("Failed to get user memories:", error);
      return [];
    }
  },
});

/**
 * Delete a specific memory for the authenticated user
 * Idempotent - returns success even if memory doesn't exist
 */
export const deleteUserMemory = mutation({
  args: {
    memoryId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      // Find the memory to delete
      const memory = await ctx.db
        .query("memories")
        .withIndex("by_memory_id", (q) => q.eq("memory_id", args.memoryId))
        .first();

      // If memory doesn't exist, treat as successful deletion (idempotent)
      if (!memory) {
        return null;
      }

      // Verify ownership
      if (memory.user_id !== identity.subject) {
        throw new Error("Access denied: You don't own this memory");
      }

      await ctx.db.delete(memory._id);
      return null;
    } catch (error) {
      console.error("Failed to delete memory:", error);
      throw new Error(
        error instanceof Error ? error.message : "Failed to delete memory",
      );
    }
  },
});

/**
 * Delete all memories for the authenticated user
 */
export const deleteAllUserMemories = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      // Get all memories for the user
      const memories = await ctx.db
        .query("memories")
        .withIndex("by_user_and_update_time", (q) =>
          q.eq("user_id", identity.subject),
        )
        .collect();

      // Delete all memories
      for (const memory of memories) {
        await ctx.db.delete(memory._id);
      }

      return null;
    } catch (error) {
      console.error("Failed to delete all memories:", error);
      throw new Error(
        error instanceof Error ? error.message : "Failed to delete memories",
      );
    }
  },
});
