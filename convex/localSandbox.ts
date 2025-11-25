import { mutation, query, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./chats";

// ============================================================================
// TOKEN MANAGEMENT
// ============================================================================

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `hsb_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
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

export const verifyToken = query({
  args: {
    token: v.string(),
  },
  returns: v.object({
    valid: v.boolean(),
    userId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { token }) => {
    const tokenRecord = await ctx.db
      .query("local_sandbox_tokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();

    return tokenRecord
      ? { valid: true, userId: tokenRecord.user_id }
      : { valid: false, userId: null };
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

    return { success: true, userId, connectionId };
  },
});

export const heartbeat = mutation({
  args: {
    connectionId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (!connection) {
      return { success: false, error: "No connection found" };
    }

    await ctx.db.patch(connection._id, {
      last_heartbeat: Date.now(),
    });

    return { success: true };
  },
});

export const disconnect = mutation({
  args: {
    connectionId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (connection) {
      await ctx.db.patch(connection._id, {
        status: "disconnected",
      });
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

    // Check heartbeat timeout (30 seconds)
    const now = Date.now();
    const timeout = 30000;

    return connections
      .filter((conn) => now - conn.last_heartbeat < timeout)
      .map((conn) => ({
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
    serviceKey: v.optional(v.string()),
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

    // Check heartbeat timeout (30 seconds)
    const now = Date.now();
    const timeout = 30000;

    return connections
      .filter((conn) => now - conn.last_heartbeat < timeout)
      .map((conn) => ({
        connectionId: conn.connection_id,
        name: conn.connection_name,
        mode: conn.mode,
        osInfo: conn.os_info,
        containerId: conn.container_id,
        lastSeen: conn.last_heartbeat,
      }));
  },
});

export const isConnected = query({
  args: {
    connectionId: v.string(),
  },
  returns: v.object({
    connected: v.boolean(),
    containerId: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("docker"), v.literal("dangerous"))),
    osInfo: v.optional(
      v.object({
        platform: v.string(),
        arch: v.string(),
        release: v.string(),
        hostname: v.string(),
      }),
    ),
  }),
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (!connection || connection.status !== "connected") {
      return { connected: false };
    }

    // Check heartbeat timeout (30 seconds)
    const now = Date.now();
    const timeout = 30000;

    if (now - connection.last_heartbeat > timeout) {
      return { connected: false };
    }

    return {
      connected: true,
      containerId: connection.container_id,
      mode: connection.mode,
      osInfo: connection.os_info,
    };
  },
});

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

export const enqueueCommand = mutation({
  args: {
    serviceKey: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    commandId: v.string(),
    command: v.string(),
    env: v.optional(v.any()),
    cwd: v.optional(v.string()),
    timeout: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    await ctx.db.insert("local_sandbox_commands", {
      user_id: args.userId,
      connection_id: args.connectionId,
      command_id: args.commandId,
      command: args.command,
      env: args.env,
      cwd: args.cwd,
      timeout: args.timeout,
      status: "pending",
      created_at: Date.now(),
    });

    return { success: true };
  },
});

export const getPendingCommands = query({
  args: {
    connectionId: v.string(),
  },
  returns: v.object({
    commands: v.array(
      v.object({
        command_id: v.string(),
        command: v.string(),
        env: v.optional(v.any()),
        cwd: v.optional(v.string()),
        timeout: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx, { connectionId }) => {
    const commands = await ctx.db
      .query("local_sandbox_commands")
      .withIndex("by_connection_and_status", (q) =>
        q.eq("connection_id", connectionId).eq("status", "pending"),
      )
      .order("asc")
      .take(10);

    return {
      commands: commands.map((cmd) => ({
        command_id: cmd.command_id,
        command: cmd.command,
        env: cmd.env,
        cwd: cmd.cwd,
        timeout: cmd.timeout,
      })),
    };
  },
});

export const markCommandExecuting = mutation({
  args: {
    commandId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, { commandId }) => {
    const command = await ctx.db
      .query("local_sandbox_commands")
      .withIndex("by_command_id", (q) => q.eq("command_id", commandId))
      .first();

    if (!command) {
      return { success: false };
    }

    await ctx.db.patch(command._id, {
      status: "executing",
    });

    return { success: true };
  },
});

export const submitResult = mutation({
  args: {
    commandId: v.string(),
    userId: v.string(),
    stdout: v.string(),
    stderr: v.string(),
    exitCode: v.number(),
    duration: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Store result
    await ctx.db.insert("local_sandbox_results", {
      command_id: args.commandId,
      user_id: args.userId,
      stdout: args.stdout,
      stderr: args.stderr,
      exit_code: args.exitCode,
      duration: args.duration,
      completed_at: Date.now(),
    });

    // Mark command as completed
    const command = await ctx.db
      .query("local_sandbox_commands")
      .withIndex("by_command_id", (q) => q.eq("command_id", args.commandId))
      .first();

    if (command) {
      await ctx.db.patch(command._id, {
        status: "completed",
      });
    }

    return { success: true };
  },
});

export const getResult = query({
  args: {
    serviceKey: v.optional(v.string()),
    commandId: v.string(),
  },
  returns: v.object({
    found: v.boolean(),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    exitCode: v.optional(v.number()),
    duration: v.optional(v.number()),
  }),
  handler: async (ctx, { serviceKey, commandId }) => {
    validateServiceKey(serviceKey);

    const result = await ctx.db
      .query("local_sandbox_results")
      .withIndex("by_command_id", (q) => q.eq("command_id", commandId))
      .first();

    if (!result) {
      return { found: false };
    }

    return {
      found: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit_code,
      duration: result.duration,
    };
  },
});

// ============================================================================
// CLEANUP (internal mutations for cron jobs)
// ============================================================================

export const cleanupStaleConnections = internalMutation({
  args: {},
  returns: v.object({
    cleaned: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const staleTimeout = 60000; // 60 seconds

    // Find stale connections
    const staleConnections = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_status", (q) =>
        q.eq("status", "connected").lt("last_heartbeat", now - staleTimeout),
      )
      .collect();

    // Mark as disconnected
    for (const connection of staleConnections) {
      await ctx.db.patch(connection._id, {
        status: "disconnected",
      });
    }

    return { cleaned: staleConnections.length };
  },
});

export const cleanupOldCommands = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    let deletedCount = 0;

    // Delete old completed commands
    const oldCommands = await ctx.db
      .query("local_sandbox_commands")
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "completed"),
          q.lt(q.field("created_at"), now - maxAge),
        ),
      )
      .take(100);

    for (const cmd of oldCommands) {
      await ctx.db.delete(cmd._id);
      deletedCount++;
    }

    // Delete old results
    const oldResults = await ctx.db
      .query("local_sandbox_results")
      .filter((q) => q.lt(q.field("completed_at"), now - maxAge))
      .take(100);

    for (const result of oldResults) {
      await ctx.db.delete(result._id);
      deletedCount++;
    }

    // Delete old disconnected connections (older than 24 hours)
    const oldConnections = await ctx.db
      .query("local_sandbox_connections")
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "disconnected"),
          q.lt(q.field("created_at"), now - 24 * 60 * 60 * 1000),
        ),
      )
      .take(100);

    for (const conn of oldConnections) {
      await ctx.db.delete(conn._id);
      deletedCount++;
    }

    return { deleted: deletedCount };
  },
});
