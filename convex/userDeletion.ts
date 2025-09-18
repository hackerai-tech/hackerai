import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Delete all Convex data for the authenticated user in correct dependency order.
 *
 * Deletion order (respects foreign key constraints):
 * 1) Feedback records (referenced by messages)
 * 2) Messages (owned by user, reference chats and files)
 * 3) Chats (owned by user)
 * 4) Files + storage blobs (owned by user, may be referenced by messages)
 * 5) Memories (owned by user)
 * 6) User customization (owned by user)
 *
 * Uses parallel queries and deletions for optimal performance.
 */
export const deleteAllUserData = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      // Fetch all user data in parallel using indexed queries
      const [chats, files, memories, customization, messagesByUser] =
        await Promise.all([
          ctx.db
            .query("chats")
            .withIndex("by_user_and_updated", (q) =>
              q.eq("user_id", user.subject),
            )
            .collect(),
          ctx.db
            .query("files")
            .withIndex("by_user_id", (q) => q.eq("user_id", user.subject))
            .collect(),
          ctx.db
            .query("memories")
            .withIndex("by_user_and_update_time", (q) =>
              q.eq("user_id", user.subject),
            )
            .collect(),
          ctx.db
            .query("user_customization")
            .withIndex("by_user_id", (q) => q.eq("user_id", user.subject))
            .first(),
          ctx.db
            .query("messages")
            .withIndex("by_user_id", (q) => q.eq("user_id", user.subject))
            .collect(),
        ]);

      // All user-owned messages (assistant/system messages also have user_id in this app)
      const allMessages = messagesByUser;

      // Step 1: Delete feedback records (no dependencies)
      const feedbackIds = allMessages
        .map((m) => m.feedback_id)
        .filter((id): id is NonNullable<typeof id> => !!id);

      await Promise.all(
        feedbackIds.map(async (feedbackId) => {
          try {
            await ctx.db.delete(feedbackId);
          } catch (error) {
            console.error(`Failed to delete feedback ${feedbackId}:`, error);
          }
        }),
      );

      // Step 2: Delete messages (now safe since feedback is gone)
      await Promise.all(
        allMessages.map(async (message) => {
          try {
            await ctx.db.delete(message._id);
          } catch (error) {
            console.error(`Failed to delete message ${message._id}:`, error);
          }
        }),
      );

      // Step 3: Delete chats (now safe since messages are gone)
      await Promise.all(
        chats.map(async (chat) => {
          try {
            await ctx.db.delete(chat._id);
          } catch (error) {
            console.error(`Failed to delete chat ${chat._id}:`, error);
          }
        }),
      );

      // Step 4: Delete files and storage blobs (safe since messages no longer reference them)
      await Promise.all(
        files.map(async (file) => {
          try {
            try {
              await ctx.storage.delete(file.storage_id);
            } catch (e) {
              console.warn(
                "Failed to delete storage blob:",
                file.storage_id,
                e,
              );
            }
            await ctx.db.delete(file._id);
          } catch (error) {
            console.error(`Failed to delete file record ${file._id}:`, error);
          }
        }),
      );

      // Step 5: Delete memories (independent of other data)
      await Promise.all(
        memories.map(async (memory) => {
          try {
            await ctx.db.delete(memory._id);
          } catch (error) {
            console.error(`Failed to delete memory ${memory._id}:`, error);
          }
        }),
      );

      // Step 6: Delete user customization (independent of other data)
      if (customization) {
        try {
          await ctx.db.delete(customization._id);
        } catch (error) {
          console.error(
            `Failed to delete user customization ${customization._id}:`,
            error,
          );
        }
      }

      return null;
    } catch (error) {
      console.error("Failed to delete user data:", error);
      throw new Error(
        "Account deletion failed. Please try again or contact support.",
      );
    }
  },
});
