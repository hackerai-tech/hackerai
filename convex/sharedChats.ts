import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Share a chat by creating a public share link.
 * If the chat is already shared, returns the existing share_id.
 *
 * @param chatId - The ID of the chat to share
 * @returns Share metadata (shareId and shareDate)
 * @throws {Error} If chat not found or user not authorized
 */
export const shareChat = mutation({
  args: { chatId: v.string() },
  returns: v.object({
    shareId: v.string(),
    shareDate: v.number(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      throw new Error("Chat not found");
    }

    if (chat.user_id !== identity.subject) {
      throw new Error("Unauthorized: Chat does not belong to user");
    }

    // If already shared, return existing share_id
    if (chat.share_id && chat.share_date) {
      return {
        shareId: chat.share_id,
        shareDate: chat.share_date,
      };
    }

    // Generate new share_id using crypto.randomUUID() for security
    const shareId = crypto.randomUUID();
    const shareDate = Date.now();

    await ctx.db.patch(chat._id, {
      share_id: shareId,
      share_date: shareDate,
      update_time: Date.now(),
    });

    // Re-fetch to ensure we return the persisted value, handling potential race conditions
    const persisted = await ctx.db.get(chat._id);
    if (!persisted?.share_id || !persisted.share_date) {
      throw new Error("Failed to persist share metadata");
    }

    return {
      shareId: persisted.share_id,
      shareDate: persisted.share_date,
    };
  },
});

/**
 * Update an existing share by refreshing the share_date.
 * This allows the shared link to include new messages added after the original share.
 *
 * FROZEN SHARE CONCEPT:
 * - Original share shows messages up to original share_date
 * - After updating, shared link shows messages up to new share_date
 * - This gives users control over what content is publicly visible
 *
 * @param chatId - The ID of the chat to update
 * @returns Updated share metadata (same shareId, new shareDate)
 * @throws {Error} If chat not found, not shared, or user not authorized
 */
export const updateShareDate = mutation({
  args: { chatId: v.string() },
  returns: v.object({
    shareId: v.string(),
    shareDate: v.number(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      throw new Error("Chat not found");
    }

    if (chat.user_id !== identity.subject) {
      throw new Error("Unauthorized: Chat does not belong to user");
    }

    // Can only update if chat is already shared
    if (!chat.share_id || !chat.share_date) {
      throw new Error(
        "Chat is not shared - use shareChat to create a share first",
      );
    }

    // Update share_date to now, keeping same share_id
    const newShareDate = Date.now();

    await ctx.db.patch(chat._id, {
      share_date: newShareDate,
      update_time: Date.now(),
    });

    return {
      shareId: chat.share_id,
      shareDate: newShareDate,
    };
  },
});

/**
 * Unshare a chat by removing public access.
 *
 * @param chatId - The ID of the chat to unshare
 * @throws {Error} If chat not found or user not authorized
 */
export const unshareChat = mutation({
  args: { chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();

    if (!chat) {
      throw new Error("Chat not found");
    }

    if (chat.user_id !== identity.subject) {
      throw new Error("Unauthorized: Chat does not belong to user");
    }

    await ctx.db.patch(chat._id, {
      share_id: undefined,
      share_date: undefined,
      update_time: Date.now(),
    });

    return null;
  },
});

/**
 * Get shared chat by share_id (PUBLIC - no auth required).
 * Returns chat without user_id to maintain anonymity.
 *
 * @param shareId - The public share ID
 * @returns Chat data without sensitive user information, or null if not found
 */
export const getSharedChat = query({
  args: { shareId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("chats"),
      id: v.string(),
      title: v.string(),
      share_id: v.string(),
      share_date: v.number(),
      update_time: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_share_id", (q) => q.eq("share_id", args.shareId))
      .first();

    if (!chat || !chat.share_id || !chat.share_date) {
      return null;
    }

    // Return chat without user_id for anonymity
    return {
      _id: chat._id,
      id: chat.id,
      title: chat.title,
      share_id: chat.share_id,
      share_date: chat.share_date,
      update_time: chat.update_time,
    };
  },
});

/**
 * Get all shared chats for the authenticated user.
 *
 * @returns Array of shared chats with share metadata
 */
export const getUserSharedChats = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("chats"),
      id: v.string(),
      title: v.string(),
      share_id: v.string(),
      share_date: v.number(),
      update_time: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const chats = await ctx.db
      .query("chats")
      .withIndex("by_user_and_updated", (q) =>
        q.eq("user_id", identity.subject),
      )
      .collect();

    // Filter and map to only shared chats
    return chats
      .filter((chat) => chat.share_id && chat.share_date)
      .map((chat) => ({
        _id: chat._id,
        id: chat.id,
        title: chat.title,
        share_id: chat.share_id!,
        share_date: chat.share_date!,
        update_time: chat.update_time,
      }))
      .sort((a, b) => b.share_date - a.share_date); // Most recent first
  },
});

/**
 * Unshare all chats for the authenticated user.
 *
 * @throws {Error} If user not authenticated
 */
export const unshareAllChats = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const sharedChats = await ctx.db
      .query("chats")
      .withIndex("by_user_and_updated", (q) =>
        q.eq("user_id", identity.subject),
      )
      .collect();

    const updates = sharedChats
      .filter((chat) => chat.share_id)
      .map((chat) =>
        ctx.db.patch(chat._id, {
          share_id: undefined,
          share_date: undefined,
          update_time: Date.now(),
        }),
      );

    await Promise.all(updates);

    return null;
  },
});
