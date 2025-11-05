import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./chats";
import { internal } from "./_generated/api";
import { isSupportedImageMediaType } from "../lib/utils/file-utils";

/**
 * Get download URL for a file by storageId (on-demand for non-image files)
 */
export const getFileDownloadUrl = query({
  args: {
    storageId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    try {
      // Query all user's files and find the one with matching storage_id
      const userFiles = await ctx.db
        .query("files")
        .withIndex("by_user_id", (q) => q.eq("user_id", user.subject))
        .collect();

      const file = userFiles.find((f) => f.storage_id === args.storageId);

      if (!file) {
        throw new Error("File not found");
      }

      // Generate and return signed URL
      const url = await ctx.storage.getUrl(args.storageId);
      return url;
    } catch (error) {
      console.error("Failed to get file download URL:", error);
      throw error;
    }
  },
});

/**
 * Internal query to count files for a user
 */
export const countUserFiles = internalQuery({
  args: {
    userId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("files")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();

    return files.length;
  },
});

/**
 * Determine file limit based on user entitlements
 * Pro: 300, Team: 500, Ultra: 1000, Free: 0
 */
const getFileLimit = (entitlements: Array<string>): number => {
  if (
    entitlements.includes("ultra-plan") ||
    entitlements.includes("ultra-monthly-plan") ||
    entitlements.includes("ultra-yearly-plan")
  ) {
    return 1000;
  }
  if (entitlements.includes("team-plan")) {
    return 500;
  }
  if (
    entitlements.includes("pro-plan") ||
    entitlements.includes("pro-monthly-plan") ||
    entitlements.includes("pro-yearly-plan")
  ) {
    return 300;
  }
  return 0; // Free users
};

/**
 * Generate upload URL for file storage with authentication
 */
export const generateUploadUrl = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    userId: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    let actingUserId: string;
    let entitlements: Array<string> = [];

    // Service key flow (backend)
    if (args.serviceKey) {
      validateServiceKey(args.serviceKey);
      if (!args.userId) {
        throw new Error("userId is required when using serviceKey");
      }
      actingUserId = args.userId;
      entitlements = ["ultra-plan"]; // Max limit for service flows
    } else {
      // User-authenticated flow
      const user = await ctx.auth.getUserIdentity();
      if (!user) {
        throw new Error("Unauthorized: User not authenticated");
      }
      actingUserId = user.subject;
      entitlements = Array.isArray(user.entitlements)
        ? user.entitlements.filter(
            (e: unknown): e is string => typeof e === "string",
          )
        : [];
    }

    // Check file limit
    const fileLimit = getFileLimit(entitlements);
    if (fileLimit === 0) {
      throw new Error("Paid plan required for file uploads");
    }

    const currentFileCount = await ctx.runQuery(
      internal.fileStorage.countUserFiles,
      { userId: actingUserId },
    );

    if (currentFileCount >= fileLimit) {
      throw new Error(
        `Upload limit exceeded: Maximum ${fileLimit} files allowed for your plan`,
      );
    }

    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Get multiple file URLs from file IDs using service key (for backend processing)
 */
export const getFileUrlsByFileIds = query({
  args: {
    serviceKey: v.optional(v.string()),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(v.union(v.string(), v.null())),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    // Get file records from database to extract storage IDs
    const files = await Promise.all(
      args.fileIds.map((fileId) => ctx.db.get(fileId)),
    );

    // Get URLs from storage using the storage IDs
    const urls = await Promise.all(
      files.map((file) => (file ? ctx.storage.getUrl(file.storage_id) : null)),
    );

    return urls;
  },
});

/**
 * Delete file from storage by storage ID
 */
export const deleteFile = mutation({
  args: {
    fileId: v.id("files"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const file = await ctx.db.get(args.fileId);

    if (!file) {
      throw new Error("File not found");
    }

    if (file.user_id !== user.subject) {
      throw new Error("Unauthorized: File does not belong to user");
    }

    await ctx.storage.delete(file.storage_id);

    await ctx.db.delete(args.fileId);

    return null;
  },
});

/**
 * Get file token sizes by file IDs using service key (for backend processing)
 */
export const getFileTokensByFileIds = query({
  args: {
    serviceKey: v.optional(v.string()),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(v.number()),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    // Get file records from database to extract token sizes
    const files = await Promise.all(
      args.fileIds.map((fileId) => ctx.db.get(fileId)),
    );

    // Return token sizes, defaulting to 0 for missing files
    return files.map((file) => file?.file_token_size ?? 0);
  },
});

/**
 * Get file content and metadata by file IDs using service key (for backend processing)
 * Only returns content for non-image, non-PDF files
 */
export const getFileContentByFileIds = query({
  args: {
    serviceKey: v.optional(v.string()),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      mediaType: v.string(),
      content: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    // Get file records from database
    const files = await Promise.all(
      args.fileIds.map((fileId) => ctx.db.get(fileId)),
    );

    // Return file content and metadata
    return files.map((file, index) => {
      if (!file) {
        return {
          id: args.fileIds[index],
          name: "Unknown",
          mediaType: "unknown",
          content: null,
        };
      }

      // Only return content for non-image, non-PDF files
      // Note: Supported image formats don't have content, unsupported images may have extracted content
      const isSupportedImage = isSupportedImageMediaType(file.media_type);
      const isPdf = file.media_type === "application/pdf";

      return {
        id: args.fileIds[index],
        name: file.name,
        mediaType: file.media_type,
        content: isSupportedImage || isPdf ? null : file.content || null,
      };
    });
  },
});

/**
 * Internal mutation: purge unattached files older than cutoff
 */
export const purgeExpiredUnattachedFiles = internalMutation({
  args: {
    cutoffTimeMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const candidates = await ctx.db
      .query("files")
      .withIndex("by_is_attached", (q) =>
        q.eq("is_attached", false).lt("_creationTime", args.cutoffTimeMs),
      )
      .order("asc")
      .take(limit);

    let deletedCount = 0;
    for (const file of candidates) {
      try {
        await ctx.storage.delete(file.storage_id);
      } catch (e) {
        console.warn("Failed to delete storage blob:", file.storage_id, e);
      }
      await ctx.db.delete(file._id);
      deletedCount++;
    }

    return { deletedCount };
  },
});

/**
 * Internal mutation to save file metadata to database
 * This is separated from the action to handle database operations
 */
export const saveFileToDb = internalMutation({
  args: {
    storageId: v.id("_storage"),
    userId: v.string(),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
    fileTokenSize: v.number(),
    content: v.optional(v.string()),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    const fileId = await ctx.db.insert("files", {
      storage_id: args.storageId,
      user_id: args.userId,
      name: args.name,
      media_type: args.mediaType,
      size: args.size,
      file_token_size: args.fileTokenSize,
      content: args.content,
      is_attached: false,
    });
    return fileId;
  },
});
