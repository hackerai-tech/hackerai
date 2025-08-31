import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./chats";

/**
 * Generate upload URL for file storage with authentication
 */
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    // Check if user has pro-monthly-plan entitlement
    if (
      !Array.isArray(user.entitlements) ||
      !user.entitlements.includes("pro-monthly-plan")
    ) {
      throw new Error("Unauthorized: Pro plan required for file uploads");
    }

    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Get file URL from storage ID
 */
export const getFileUrl = query({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    return await ctx.storage.getUrl(args.storageId);
  },
});

/**
 * Get multiple file URLs from storage IDs
 */
export const getFileUrls = query({
  args: {
    storageIds: v.array(v.id("_storage")),
  },
  returns: v.array(v.union(v.string(), v.null())),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const urls = await Promise.all(
      args.storageIds.map((storageId) => ctx.storage.getUrl(storageId)),
    );

    return urls;
  },
});

/**
 * Get multiple file URLs from storage IDs using service key (for backend processing)
 */
export const getFileUrlsWithServiceKey = query({
  args: {
    serviceKey: v.optional(v.string()),
    storageIds: v.array(v.id("_storage")),
  },
  returns: v.array(v.union(v.string(), v.null())),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    const urls = await Promise.all(
      args.storageIds.map((storageId) => ctx.storage.getUrl(storageId)),
    );

    return urls;
  },
});

/**
 * Delete file from storage by storage ID
 */
export const deleteFile = mutation({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    await ctx.storage.delete(args.storageId);
    return null;
  },
});
