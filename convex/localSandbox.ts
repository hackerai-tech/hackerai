import { mutation, query, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";

// ============================================================================
// TOKEN MANAGEMENT
// ============================================================================

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `hsb_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ============================================================================
// SIGNED SESSION TOKENS (HMAC-SHA256)
// ============================================================================
// These allow query-time verification without database lookups,
// avoiding reactive surface issues while maintaining security.

const SESSION_SIGNING_SECRET = process.env.LOCAL_SANDBOX_SESSION_SECRET;
const SESSION_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes (refreshed on heartbeat)

async function signSession(
  userId: string,
  connectionId: string,
  expiresAt: number,
): Promise<string> {
  if (!SESSION_SIGNING_SECRET) {
    throw new Error(
      "LOCAL_SANDBOX_SESSION_SECRET environment variable not set",
    );
  }

  const payload = `${userId}:${connectionId}:${expiresAt}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SESSION_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return Array.from(new Uint8Array(signature), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function verifySession(
  userId: string,
  connectionId: string,
  expiresAt: number,
  signature: string,
): Promise<boolean> {
  if (!SESSION_SIGNING_SECRET) {
    return false;
  }

  // Check expiration first (cheap check)
  if (Date.now() > expiresAt) {
    return false;
  }

  // Validate signature format: HMAC-SHA256 produces 32 bytes = 64 hex chars
  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return false;
  }

  const payload = `${userId}:${connectionId}:${expiresAt}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SESSION_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // Convert hex signature to bytes (format already validated above)
  const signatureBytes = new Uint8Array(
    signature.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)),
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encoder.encode(payload),
  );
}

import { DatabaseReader } from "./_generated/server";

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
    // Signed session for secure query-time verification without DB lookups
    session: v.optional(
      v.object({
        expiresAt: v.number(),
        signature: v.string(),
      }),
    ),
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
    const expiresAt = Date.now() + SESSION_EXPIRY_MS;

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

    // Generate signed session for secure query access
    const signature = await signSession(userId, connectionId, expiresAt);

    return {
      success: true,
      userId,
      connectionId,
      session: { expiresAt, signature },
    };
  },
});

export const heartbeat = mutation({
  args: {
    token: v.string(),
    connectionId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    // Refreshed session for continued query access
    session: v.optional(
      v.object({
        expiresAt: v.number(),
        signature: v.string(),
      }),
    ),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, { token, connectionId }) => {
    const tokenResult = await validateToken(ctx.db, token);
    if (!tokenResult.valid) {
      return { success: false, error: "Invalid token" };
    }

    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (!connection) {
      return { success: false, error: "No connection found" };
    }

    if (connection.user_id !== tokenResult.userId) {
      return {
        success: false,
        error: "Connection does not belong to this user",
      };
    }

    if (connection.status === "disconnected") {
      return { success: false, error: "Connection was terminated" };
    }

    await ctx.db.patch(connection._id, {
      last_heartbeat: Date.now(),
    });

    // Generate refreshed session for query access
    const expiresAt = Date.now() + SESSION_EXPIRY_MS;
    const signature = await signSession(
      tokenResult.userId,
      connectionId,
      expiresAt,
    );

    return { success: true, session: { expiresAt, signature } };
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

    // Check heartbeat timeout (90 seconds)
    // Client sends heartbeat every 60s ± 10s jitter, so use 90s to be safe
    const now = Date.now();
    const timeout = 90000;

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

    // Check heartbeat timeout (90 seconds)
    // Client sends heartbeat every 60s ± 10s jitter, so use 90s to be safe
    const now = Date.now();
    const timeout = 90000;

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

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

export const enqueueCommand = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    connectionId: v.string(),
    commandId: v.string(),
    command: v.string(),
    env: v.optional(v.record(v.string(), v.string())),
    cwd: v.optional(v.string()),
    timeout: v.optional(v.number()),
    background: v.optional(v.boolean()),
    // Optional display name for CLI output (empty string = hide, undefined = show command)
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    // Signed session for subscribing to results (no DB lookup needed)
    session: v.optional(
      v.object({
        userId: v.string(),
        connectionId: v.string(),
        expiresAt: v.number(),
        signature: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // Validate connection exists and belongs to the specified user
    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) =>
        q.eq("connection_id", args.connectionId),
      )
      .first();

    if (!connection) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Connection not found",
      });
    }

    if (connection.user_id !== args.userId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Connection does not belong to this user",
      });
    }

    if (connection.status !== "connected") {
      throw new ConvexError({
        code: "BAD_REQUEST",
        message: "Connection is not active",
      });
    }

    await ctx.db.insert("local_sandbox_commands", {
      user_id: args.userId,
      connection_id: args.connectionId,
      command_id: args.commandId,
      command: args.command,
      env: args.env,
      cwd: args.cwd,
      timeout: args.timeout,
      background: args.background,
      display_name: args.displayName,
      status: "pending",
      created_at: Date.now(),
    });

    // Generate signed session for result subscription
    const expiresAt = Date.now() + SESSION_EXPIRY_MS;
    const signature = await signSession(
      args.userId,
      args.connectionId,
      expiresAt,
    );

    return {
      success: true,
      session: {
        userId: args.userId,
        connectionId: args.connectionId,
        expiresAt,
        signature,
      },
    };
  },
});

export const getPendingCommands = query({
  args: {
    connectionId: v.string(),
    // Signed session for secure verification without DB lookups
    session: v.object({
      userId: v.string(),
      expiresAt: v.number(),
      signature: v.string(),
    }),
  },
  returns: v.object({
    commands: v.array(
      v.object({
        command_id: v.string(),
        command: v.string(),
        env: v.optional(v.record(v.string(), v.string())),
        cwd: v.optional(v.string()),
        timeout: v.optional(v.number()),
        background: v.optional(v.boolean()),
        display_name: v.optional(v.string()),
      }),
    ),
    // Indicates session verification failed - client should re-authenticate
    authError: v.optional(v.boolean()),
  }),
  handler: async (ctx, { connectionId, session }) => {
    // Verify signed session - cryptographic check, no DB lookup needed
    // This maintains security while avoiding reactive surface issues
    const isValid = await verifySession(
      session.userId,
      connectionId,
      session.expiresAt,
      session.signature,
    );

    if (!isValid) {
      // Signal auth failure so client can re-authenticate via connect()
      return { commands: [], authError: true };
    }

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
        background: cmd.background,
        display_name: cmd.display_name,
      })),
    };
  },
});

export const markCommandExecuting = mutation({
  args: {
    token: v.string(),
    commandId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, { token, commandId }) => {
    const tokenResult = await validateToken(ctx.db, token);
    if (!tokenResult.valid) {
      return { success: false };
    }

    const command = await ctx.db
      .query("local_sandbox_commands")
      .withIndex("by_command_id", (q) => q.eq("command_id", commandId))
      .first();

    if (!command || command.user_id !== tokenResult.userId) {
      return { success: false };
    }

    // Prevent duplicate execution - only transition from pending to executing
    if (command.status !== "pending") {
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
    token: v.string(),
    commandId: v.string(),
    stdout: v.string(),
    stderr: v.string(),
    exitCode: v.number(),
    pid: v.optional(v.number()),
    duration: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const tokenResult = await validateToken(ctx.db, args.token);
    if (!tokenResult.valid) {
      return { success: false };
    }

    const command = await ctx.db
      .query("local_sandbox_commands")
      .withIndex("by_command_id", (q) => q.eq("command_id", args.commandId))
      .first();

    if (!command || command.user_id !== tokenResult.userId) {
      return { success: false };
    }

    await ctx.db.insert("local_sandbox_results", {
      command_id: args.commandId,
      user_id: tokenResult.userId,
      stdout: args.stdout,
      stderr: args.stderr,
      exit_code: args.exitCode,
      pid: args.pid,
      duration: args.duration,
      completed_at: Date.now(),
    });

    await ctx.db.patch(command._id, {
      status: "completed",
    });

    return { success: true };
  },
});

// Optimized subscription query - minimal reactive surface (only reads results table)
// Security: Session signature verified cryptographically without DB lookups
export const subscribeToResult = query({
  args: {
    commandId: v.string(),
    // Signed session for secure verification without DB lookups
    session: v.object({
      userId: v.string(),
      connectionId: v.string(),
      expiresAt: v.number(),
      signature: v.string(),
    }),
  },
  returns: v.object({
    found: v.boolean(),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    exitCode: v.optional(v.number()),
    pid: v.optional(v.number()),
    duration: v.optional(v.number()),
    // Indicates session verification failed - client should re-authenticate
    authError: v.optional(v.boolean()),
  }),
  handler: async (ctx, { commandId, session }) => {
    // Verify signed session - cryptographic check, no DB lookup needed
    const isValid = await verifySession(
      session.userId,
      session.connectionId,
      session.expiresAt,
      session.signature,
    );

    if (!isValid) {
      // Signal auth failure so client can distinguish from "not found"
      return { found: false, authError: true };
    }

    const result = await ctx.db
      .query("local_sandbox_results")
      .withIndex("by_command_id", (q) => q.eq("command_id", commandId))
      .first();

    if (!result || result.user_id !== session.userId) {
      return { found: false };
    }

    return {
      found: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit_code,
      pid: result.pid,
      duration: result.duration,
    };
  },
});

// Delete result after it's been read - reduces storage
export const deleteResult = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    commandId: v.string(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, { serviceKey, userId, commandId }) => {
    validateServiceKey(serviceKey);

    const result = await ctx.db
      .query("local_sandbox_results")
      .withIndex("by_command_id", (q) => q.eq("command_id", commandId))
      .first();

    if (result && result.user_id === userId) {
      await ctx.db.delete(result._id);
    }

    return { success: true };
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
    const staleTimeout = 5 * 60 * 1000; // 5 minutes - allows several missed heartbeats

    // Find stale connections
    const staleConnections = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_status_and_last_heartbeat", (q) =>
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
    const stuckCommandTimeout = 60 * 60 * 1000; // 1 hour for stuck pending/executing

    let deletedCount = 0;

    // Delete old completed commands
    const oldCompletedCommands = await ctx.db
      .query("local_sandbox_commands")
      .withIndex("by_status_and_created_at", (q) =>
        q.eq("status", "completed").lt("created_at", now - maxAge),
      )
      .take(100);

    for (const cmd of oldCompletedCommands) {
      await ctx.db.delete(cmd._id);
      deletedCount++;
    }

    // Delete orphaned pending commands (stuck for more than 1 hour)
    const stuckPendingCommands = await ctx.db
      .query("local_sandbox_commands")
      .withIndex("by_status_and_created_at", (q) =>
        q.eq("status", "pending").lt("created_at", now - stuckCommandTimeout),
      )
      .take(100);

    for (const cmd of stuckPendingCommands) {
      await ctx.db.delete(cmd._id);
      deletedCount++;
    }

    // Delete orphaned executing commands (stuck for more than 1 hour)
    const stuckExecutingCommands = await ctx.db
      .query("local_sandbox_commands")
      .withIndex("by_status_and_created_at", (q) =>
        q.eq("status", "executing").lt("created_at", now - stuckCommandTimeout),
      )
      .take(100);

    for (const cmd of stuckExecutingCommands) {
      await ctx.db.delete(cmd._id);
      deletedCount++;
    }

    // Delete old results
    const oldResults = await ctx.db
      .query("local_sandbox_results")
      .withIndex("by_completed_at", (q) => q.lt("completed_at", now - maxAge))
      .take(100);

    for (const result of oldResults) {
      await ctx.db.delete(result._id);
      deletedCount++;
    }

    // Delete old disconnected connections (older than 24 hours)
    const oldConnections = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_status_and_created_at", (q) =>
        q
          .eq("status", "disconnected")
          .lt("created_at", now - 24 * 60 * 60 * 1000),
      )
      .take(100);

    for (const conn of oldConnections) {
      await ctx.db.delete(conn._id);
      deletedCount++;
    }

    return { deleted: deletedCount };
  },
});
