import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { fileCountAggregate } from "./fileAggregate";

/**
 * Delete all data for the authenticated user in correct dependency order.
 *
 * Deletion order (respects foreign key constraints):
 * 1) Feedback records (referenced by messages)
 * 2) Messages (owned by user, reference chats and files)
 * 3) Chats (owned by user)
 * 4) Files + storage (owned by user, may be referenced by messages)
 *    - S3 files: Batch deleted using scheduled action
 *    - Convex storage files: Deleted directly
 * 5) Memories (owned by user)
 * 6) Notes (owned by user)
 * 7) User customization (owned by user)
 *
 * Uses parallel queries and deletions for optimal performance.
 * S3 cleanup is scheduled asynchronously and errors don't block user deletion.
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
      const [chats, files, memories, notes, customization, messagesByUser] =
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
            .query("notes")
            .withIndex("by_user_and_updated", (q) =>
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

      // Collect S3 keys for batch deletion
      const s3Keys: string[] = [];

      await Promise.all(
        files.map(async (file) => {
          try {
            // Handle S3 files
            if (file.s3_key) {
              s3Keys.push(file.s3_key);
            }
            // Handle Convex storage files
            if (file.storage_id) {
              try {
                await ctx.storage.delete(file.storage_id);
              } catch (e) {
                console.warn(
                  "Failed to delete storage blob:",
                  file.storage_id,
                  e,
                );
              }
            }

            // Delete from aggregate
            await fileCountAggregate.deleteIfExists(ctx, file);

            // Delete database record
            await ctx.db.delete(file._id);
          } catch (error) {
            console.error(`Failed to delete file record ${file._id}:`, error);
          }
        }),
      );

      // Batch delete all S3 files for efficiency
      if (s3Keys.length > 0) {
        try {
          await ctx.scheduler.runAfter(
            0,
            internal.s3Cleanup.deleteS3ObjectsBatchAction,
            { s3Keys },
          );
          console.log(
            `Scheduled deletion of ${s3Keys.length} S3 objects for user ${user.subject}`,
          );
        } catch (error) {
          console.error("Failed to schedule S3 batch deletion:", error);
          // Don't fail user deletion on S3 cleanup errors
        }
      }

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

      // Step 6: Delete notes (independent of other data)
      await Promise.all(
        notes.map(async (note) => {
          try {
            await ctx.db.delete(note._id);
          } catch (error) {
            console.error(`Failed to delete note ${note._id}:`, error);
          }
        }),
      );

      // Step 7: Delete user customization (independent of other data)
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
