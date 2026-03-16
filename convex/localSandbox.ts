import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { DatabaseReader } from "./_generated/server";
import { SignJWT } from "jose";

// ============================================================================
// TOKEN MANAGEMENT
// ============================================================================

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `hsb_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ============================================================================
// CENTRIFUGO JWT GENERATION
// ============================================================================

async function generateCentrifugoToken(userId: string): Promise<string> {
  const secret = process.env.CENTRIFUGO_TOKEN_SECRET;
  if (!secret) {
    throw new Error("CENTRIFUGO_TOKEN_SECRET environment variable not set");
  }

  const encodedSecret = new TextEncoder().encode(secret);

  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime("24h")
    .sign(encodedSecret);
}

// ============================================================================
// TOKEN VALIDATION
// ============================================================================

async function validateToken(
  db: DatabaseReader,
  token: string,
): Promise<{ valid: false } | { valid: true; userId: string }> {
  const tokenRecord = await db
    .query("local_sandbox_tokens")
    .withIndex("by_token", (q) => q.eq("token", token))
    .first();

  if (!tokenRecord) {
    return { valid: false };
  }

  return { valid: true, userId: tokenRecord.user_id };
}

export const getToken = mutation({
  args: {},
  returns: v.object({
    token: v.string(),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const userId = identity.subject;

    const existing = await ctx.db
      .query("local_sandbox_tokens")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();

    if (existing) {
      return { token: existing.token };
    }

    const token = generateToken();

    await ctx.db.insert("local_sandbox_tokens", {
      user_id: userId,
      token: token,
      token_created_at: Date.now(),
      updated_at: Date.now(),
    });

    return { token };
  },
});

export const regenerateToken = mutation({
  args: {},
  returns: v.object({
    token: v.string(),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const userId = identity.subject;
    const token = generateToken();

    const existing = await ctx.db
      .query("local_sandbox_tokens")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        token: token,
        token_created_at: Date.now(),
        updated_at: Date.now(),
      });
    } else {
      await ctx.db.insert("local_sandbox_tokens", {
        user_id: userId,
        token: token,
        token_created_at: Date.now(),
        updated_at: Date.now(),
      });
    }

    // Disconnect all existing connections for this user
    const connections = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    for (const connection of connections) {
      await ctx.db.patch(connection._id, {
        status: "disconnected",
      });
    }

    return { token };
  },
});

// ============================================================================
// CONNECTION MANAGEMENT
// ============================================================================

export const connect = mutation({
  args: {
    token: v.string(),
    connectionName: v.string(),
    containerId: v.optional(v.string()),
    clientVersion: v.string(),
    mode: v.union(v.literal("docker"), v.literal("dangerous")),
    osInfo: v.optional(
      v.object({
        platform: v.string(),
        arch: v.string(),
        release: v.string(),
        hostname: v.string(),
      }),
    ),
  },
  returns: v.object({
    success: v.boolean(),
    userId: v.optional(v.string()),
    connectionId: v.optional(v.string()),
    centrifugoToken: v.optional(v.string()),
    centrifugoWsUrl: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    // Verify token
    const tokenRecord = await ctx.db
      .query("local_sandbox_tokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (!tokenRecord) {
      return { success: false, error: "Invalid token" };
    }

    const userId = tokenRecord.user_id;
    const connectionId = crypto.randomUUID();

    // Create new connection (multiple connections allowed)
    await ctx.db.insert("local_sandbox_connections", {
      user_id: userId,
      connection_id: connectionId,
      connection_name: args.connectionName,
      container_id: args.containerId,
      client_version: args.clientVersion,
      mode: args.mode,
      os_info: args.osInfo,
      last_heartbeat: Date.now(),
      status: "connected",
      created_at: Date.now(),
    });

    const centrifugoToken = await generateCentrifugoToken(userId);
    const centrifugoWsUrl = process.env.CENTRIFUGO_WS_URL;

    return {
      success: true,
      userId,
      connectionId,
      centrifugoToken,
      centrifugoWsUrl,
    };
  },
});

export const refreshCentrifugoToken = mutation({
  args: {
    token: v.string(),
    connectionId: v.string(),
  },
  returns: v.object({
    centrifugoToken: v.string(),
  }),
  handler: async (ctx, { token, connectionId }) => {
    const tokenResult = await validateToken(ctx.db, token);
    if (!tokenResult.valid) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Invalid token",
      });
    }

    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (!connection) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Connection not found",
      });
    }

    if (connection.user_id !== tokenResult.userId) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Connection does not belong to this user",
      });
    }

    if (connection.status !== "connected") {
      throw new ConvexError({
        code: "BAD_REQUEST",
        message: "Connection is not active",
      });
    }

    const centrifugoToken = await generateCentrifugoToken(connection.user_id);
    return { centrifugoToken };
  },
});

export const disconnect = mutation({
  args: {
    token: v.string(),
    connectionId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, { token, connectionId }) => {
    const tokenResult = await validateToken(ctx.db, token);
    if (!tokenResult.valid) {
      return { success: false };
    }

    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (connection && connection.user_id === tokenResult.userId) {
      await ctx.db.patch(connection._id, {
        status: "disconnected",
      });
    }

    return { success: true };
  },
});

export const disconnectByBackend = mutation({
  args: {
    serviceKey: v.string(),
    connectionId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, { serviceKey, connectionId }) => {
    validateServiceKey(serviceKey);

    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (connection && connection.status === "connected") {
      await ctx.db.patch(connection._id, { status: "disconnected" });
    }

    return { success: true };
  },
});

export const listConnections = query({
  args: {},
  returns: v.array(
    v.object({
      connectionId: v.string(),
      name: v.string(),
      mode: v.union(v.literal("docker"), v.literal("dangerous")),
      osInfo: v.optional(
        v.object({
          platform: v.string(),
          arch: v.string(),
          release: v.string(),
          hostname: v.string(),
        }),
      ),
      containerId: v.optional(v.string()),
      lastSeen: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const userId = identity.subject;

    const connections = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_user_and_status", (q) =>
        q.eq("user_id", userId).eq("status", "connected"),
      )
      .collect();

    return connections.map((conn) => ({
      connectionId: conn.connection_id,
      name: conn.connection_name,
      mode: conn.mode,
      osInfo: conn.os_info,
      containerId: conn.container_id,
      lastSeen: conn.last_heartbeat,
    }));
  },
});

export const listConnectionsForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.array(
    v.object({
      connectionId: v.string(),
      name: v.string(),
      mode: v.union(v.literal("docker"), v.literal("dangerous")),
      osInfo: v.optional(
        v.object({
          platform: v.string(),
          arch: v.string(),
          release: v.string(),
          hostname: v.string(),
        }),
      ),
      containerId: v.optional(v.string()),
      lastSeen: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const connections = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_user_and_status", (q) =>
        q.eq("user_id", args.userId).eq("status", "connected"),
      )
      .collect();

    return connections.map((conn) => ({
      connectionId: conn.connection_id,
      name: conn.connection_name,
      mode: conn.mode,
      osInfo: conn.os_info,
      containerId: conn.container_id,
      lastSeen: conn.last_heartbeat,
    }));
  },
});
