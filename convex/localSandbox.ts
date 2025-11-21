import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Generate a random token without Node crypto
function generateToken(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "hsb_";
  for (let i = 0; i < 64; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

/**
 * Get or generate auth token for user
 */
export const getToken = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {

    // Check if user already has settings with token
    const existing = await ctx.db
      .query("user_settings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();

    if (existing?.local_sandbox_token) {
      return { token: existing.local_sandbox_token };
    }

    // Generate new token
    const token = generateToken();

    if (existing) {
      // Update existing record
      await ctx.db.patch(existing._id, {
        local_sandbox_token: token,
        updated_at: Date.now(),
      });
    } else {
      // Create new record
      await ctx.db.insert("user_settings", {
        user_id: userId,
        local_sandbox_token: token,
        use_local_sandbox: false,
        updated_at: Date.now(),
      });
    }

    return { token };
  },
});

/**
 * Regenerate auth token
 */
export const regenerateToken = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {

    // Generate new token
    const token = generateToken();

    const existing = await ctx.db
      .query("user_settings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        local_sandbox_token: token,
        updated_at: Date.now(),
      });
    } else {
      await ctx.db.insert("user_settings", {
        user_id: userId,
        local_sandbox_token: token,
        use_local_sandbox: false,
        updated_at: Date.now(),
      });
    }

    return { token, regenerated: true };
  },
});

/**
 * Verify token and return userId (for internal use)
 */
export const verifyToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userSettings = await ctx.db
      .query("user_settings")
      .filter((q) => q.eq(q.field("local_sandbox_token"), token))
      .first();

    if (!userSettings) {
      return { valid: false, userId: null };
    }

    return { valid: true, userId: userSettings.user_id };
  },
});

/**
 * Register sandbox connection
 */
export const connect = mutation({
  args: {
    userId: v.string(),
    containerId: v.string(),
    mode: v.literal("docker"),
  },
  handler: async (ctx, { userId, containerId, mode }) => {
    // Check for existing connection for this user
    const existingConnection = await ctx.db
      .query("sandbox_connections")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();

    if (existingConnection) {
      // Disconnect old connection
      await ctx.db.delete(existingConnection._id);
    }

    // Create new connection
    await ctx.db.insert("sandbox_connections", {
      user_id: userId,
      container_id: containerId,
      mode,
      last_ping: Date.now(),
      connected_at: Date.now(),
    });

    return { success: true, disconnectedOld: !!existingConnection };
  },
});

/**
 * Update last ping time
 */
export const ping = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const connection = await ctx.db
      .query("sandbox_connections")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();

    if (connection) {
      await ctx.db.patch(connection._id, {
        last_ping: Date.now(),
      });
      return { success: true };
    }

    return { success: false };
  },
});

/**
 * Disconnect sandbox
 */
export const disconnect = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const connection = await ctx.db
      .query("sandbox_connections")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();

    if (connection) {
      await ctx.db.delete(connection._id);
    }

    return { success: true };
  },
});

/**
 * Get connection status
 */
export const getConnectionStatus = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const connection = await ctx.db
      .query("sandbox_connections")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();

    if (!connection) {
      return { connected: false, lastPing: null, mode: null };
    }

    // Check if connection is stale (30s timeout)
    const isConnected = Date.now() - connection.last_ping < 30000;

    if (!isConnected) {
      // Clean up stale connection
      await ctx.db.delete(connection._id);
      return { connected: false, lastPing: null, mode: null };
    }

    return {
      connected: true,
      lastPing: connection.last_ping,
      mode: connection.mode,
    };
  },
});
