import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./chats";

/**
 * Get memories for backend processing (with service key)
 * Enforces 10,000 token limit by removing old memories if needed
 */
export const getMemoriesForBackend = query({
  args: {
    serviceKey: v.optional(v.string()),
    userId: v.string(),
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

      // Calculate total tokens and enforce 10,000 token limit
      let totalTokens = 0;
      const validMemories = [];

      for (const memory of memories) {
        if (totalTokens + memory.tokens <= 10000) {
          totalTokens += memory.tokens;
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

      if (!memory) {
        throw new Error(`Memory with ID ${args.memoryId} not found`);
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
