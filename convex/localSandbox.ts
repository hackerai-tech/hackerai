import { internalMutation, mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { DatabaseReader, DatabaseWriter } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { SignJWT } from "jose";
import { isUserDeletionFenced } from "./lib/userDeletionFence";

/**
 * Internal mutation: purge disconnected sandbox connections older than cutoff.
 * Disconnected rows accumulate otherwise since they're never garbage-collected
 * on normal client shutdown flows. Uses the `by_status_and_created_at` index
 * to walk the oldest disconnected rows first.
 */
export const purgeStaleDisconnectedConnections = internalMutation({
  args: {
    cutoffTimeMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const rows = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_status_and_created_at", (q) =>
        q.eq("status", "disconnected").lt("created_at", args.cutoffTimeMs),
      )
      .order("asc")
      .take(limit);

    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deletedCount: rows.length };
  },
});

// ============================================================================
// TOKEN MANAGEMENT
// ============================================================================

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `hsb_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function generateCloudBootstrapToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `hcs_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function hashCloudBootstrapToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const CLOUD_SESSION_PROVIDER = "aws-lambda-microvm" as const;
const CLOUD_SESSION_TOKEN_TTL_MS = 9 * 60 * 60 * 1000;
const CLOUD_SESSION_STARTING_STALE_MS = 2 * 60 * 1000;
const CLOUD_SANDBOX_DELETION_FENCE_TTL_MS = 2 * 60 * 1000;
const RELAY_READY_CLIENT_VERSION = "aws-lambda-microvm-relay-ready-v1";

const cloudSessionStatus = v.union(
  v.literal("starting"),
  v.literal("active"),
  v.literal("running"),
  v.literal("failed"),
  v.literal("terminated"),
);

const cloudMicrovmState = v.union(
  v.literal("PENDING"),
  v.literal("RUNNING"),
  v.literal("SUSPENDING"),
  v.literal("SUSPENDED"),
  v.literal("TERMINATING"),
  v.literal("TERMINATED"),
);

const cloudSessionForBackend = v.object({
  sessionId: v.string(),
  status: cloudSessionStatus,
  microvmId: v.optional(v.string()),
  connectionId: v.optional(v.string()),
  region: v.string(),
  requestedRegion: v.optional(v.string()),
  placementReason: v.optional(v.string()),
  imageIdentifier: v.string(),
  imageVersion: v.optional(v.string()),
  egressConnectorArn: v.optional(v.string()),
  egressIpv4Address: v.optional(v.string()),
  failoverFromRegion: v.optional(v.string()),
  failoverErrorName: v.optional(v.string()),
  failoverStartedAt: v.optional(v.number()),
  failoverCompletedAt: v.optional(v.number()),
  failoverDurationMs: v.optional(v.number()),
  failoverOutcome: v.optional(
    v.union(v.literal("succeeded"), v.literal("failed")),
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
  bootstrapExpiresAt: v.number(),
  relayReadyAt: v.optional(v.number()),
  awsState: v.optional(cloudMicrovmState),
  awsStateCheckedAt: v.optional(v.number()),
  failureCode: v.optional(v.string()),
});

const cloudSessionForReconciliation = v.object({
  userId: v.string(),
  session: cloudSessionForBackend,
});

const cloudSessionCleanupCandidate = v.object({
  sessionId: v.string(),
  microvmId: v.optional(v.string()),
  region: v.string(),
  failureCode: v.string(),
});

function serializeCloudSession(session: {
  session_id: string;
  status: "starting" | "active" | "running" | "failed" | "terminated";
  microvm_id?: string;
  connection_id?: string;
  region: string;
  requested_region?: string;
  placement_reason?: string;
  image_identifier: string;
  image_version?: string;
  egress_connector_arn?: string;
  egress_ipv4_address?: string;
  failover_from_region?: string;
  failover_error_name?: string;
  failover_started_at?: number;
  failover_completed_at?: number;
  failover_duration_ms?: number;
  failover_outcome?: "succeeded" | "failed";
  created_at: number;
  updated_at: number;
  bootstrap_expires_at: number;
  relay_ready_at?: number;
  aws_state?:
    | "PENDING"
    | "RUNNING"
    | "SUSPENDING"
    | "SUSPENDED"
    | "TERMINATING"
    | "TERMINATED";
  aws_state_checked_at?: number;
  failure_code?: string;
}) {
  return {
    sessionId: session.session_id,
    status: session.status,
    microvmId: session.microvm_id,
    connectionId: session.connection_id,
    region: session.region,
    requestedRegion: session.requested_region,
    placementReason: session.placement_reason,
    imageIdentifier: session.image_identifier,
    imageVersion: session.image_version,
    egressConnectorArn: session.egress_connector_arn,
    egressIpv4Address: session.egress_ipv4_address,
    failoverFromRegion: session.failover_from_region,
    failoverErrorName: session.failover_error_name,
    failoverStartedAt: session.failover_started_at,
    failoverCompletedAt: session.failover_completed_at,
    failoverDurationMs: session.failover_duration_ms,
    failoverOutcome: session.failover_outcome,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    bootstrapExpiresAt: session.bootstrap_expires_at,
    relayReadyAt: session.relay_ready_at,
    awsState: session.aws_state,
    awsStateCheckedAt: session.aws_state_checked_at,
    failureCode: session.failure_code,
  };
}

function cloudMicrovmStatePatch(
  session: {
    status: "starting" | "active" | "running" | "failed" | "terminated";
  },
  state:
    | "PENDING"
    | "RUNNING"
    | "SUSPENDING"
    | "SUSPENDED"
    | "TERMINATING"
    | "TERMINATED",
  now: number,
) {
  const terminal = state === "TERMINATING" || state === "TERMINATED";
  return {
    aws_state: state,
    aws_state_checked_at: now,
    ...(terminal
      ? { status: "terminated" as const, ended_at: now }
      : session.status === "running"
        ? { status: "active" as const }
        : {}),
    updated_at: now,
  };
}

async function disconnectCloudSessionConnection(
  db: DatabaseWriter,
  connectionId: string | undefined,
  now: number,
): Promise<void> {
  if (!connectionId) return;
  const connection = await db
    .query("local_sandbox_connections")
    .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
    .unique();
  if (connection?.status !== "connected") return;
  await db.patch(connection._id, {
    status: "disconnected",
    disconnected_at: now,
    disconnect_reason: "client_disconnect",
  });
}

// ============================================================================
// CENTRIFUGO JWT GENERATION
// ============================================================================

async function generateCentrifugoToken(
  userId: string,
  connectionId: string,
): Promise<string> {
  const secret = process.env.CENTRIFUGO_TOKEN_SECRET;
  if (!secret) {
    throw new Error("CENTRIFUGO_TOKEN_SECRET environment variable not set");
  }

  const encodedSecret = new TextEncoder().encode(secret);

  return new SignJWT({ sub: userId, info: { connectionId } })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime("1h")
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

    // Disconnect existing *connected* rows. Skip already-disconnected rows so
    // we don't clobber their original disconnect_reason/disconnected_at —
    // those are the diagnostic signal we're trying to preserve.
    const connections = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_user_and_status", (q) =>
        q.eq("user_id", userId).eq("status", "connected"),
      )
      .collect();

    const now = Date.now();
    for (const connection of connections) {
      await ctx.db.patch(connection._id, {
        status: "disconnected",
        disconnected_at: now,
        disconnect_reason: "token_regenerated",
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
    clientVersion: v.string(),
    osInfo: v.optional(
      v.object({
        platform: v.string(),
        arch: v.string(),
        release: v.string(),
        hostname: v.string(),
      }),
    ),
    capabilities: v.optional(
      v.object({
        commands: v.boolean(),
        pty: v.boolean(),
        files: v.optional(v.boolean()),
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
    const centrifugoWsUrl = process.env.CENTRIFUGO_WS_URL;
    if (!centrifugoWsUrl) {
      return { success: false, error: "Centrifugo not configured" };
    }

    const connectionId = crypto.randomUUID();

    // Create new connection (multiple connections allowed)
    await ctx.db.insert("local_sandbox_connections", {
      user_id: userId,
      connection_id: connectionId,
      connection_name: args.connectionName,
      client_version: args.clientVersion,
      mode: "dangerous",
      os_info: args.osInfo,
      capabilities: args.capabilities ?? { commands: true, pty: true },
      last_heartbeat: Date.now(),
      status: "connected",
      created_at: Date.now(),
    });

    const centrifugoToken = await generateCentrifugoToken(userId, connectionId);

    return {
      success: true,
      userId,
      connectionId,
      centrifugoToken,
      centrifugoWsUrl,
    };
  },
});

// Shared return shape for both refresh handlers. Connection-state failures
// (row missing, ownership mismatch, status flipped to disconnected) used to
// throw ConvexError, but they're expected lifecycle outcomes — every reconnect
// after a token regen, presence sweep, or desktop kick produced a logged
// error. They now return a discriminated union so the client can shut down
// the Centrifuge retry loop without polluting the error dashboard.
const refreshCentrifugoTokenReturns = v.union(
  v.object({
    ok: v.literal(true),
    centrifugoToken: v.string(),
  }),
  v.object({
    ok: v.literal(false),
    terminated: v.literal(true),
    reason: v.union(
      v.literal("connection_not_found"),
      v.literal("ownership_mismatch"),
      v.literal("connection_inactive"),
    ),
    connectionId: v.string(),
    clientVersion: v.union(v.string(), v.null()),
    status: v.union(v.string(), v.null()),
    disconnectReason: v.union(
      v.literal("client_disconnect"),
      v.literal("desktop_disconnect"),
      v.literal("desktop_kicked_by_new_session"),
      v.literal("token_regenerated"),
      v.literal("presence_sweep"),
      v.literal("command_unresponsive"),
      v.null(),
    ),
    msSinceDisconnected: v.union(v.number(), v.null()),
    msSinceLastHeartbeat: v.union(v.number(), v.null()),
    msSinceCreated: v.union(v.number(), v.null()),
  }),
);

type ConnectionRow = {
  connection_id: string;
  client_version: string;
  status: "connected" | "disconnected";
  disconnect_reason?:
    | "client_disconnect"
    | "desktop_disconnect"
    | "desktop_kicked_by_new_session"
    | "token_regenerated"
    | "presence_sweep"
    | "command_unresponsive";
  disconnected_at?: number;
  last_heartbeat: number;
  created_at: number;
};

function terminatedResult(
  reason: "connection_not_found" | "ownership_mismatch" | "connection_inactive",
  connectionId: string,
  connection: ConnectionRow | null,
) {
  const now = Date.now();
  return {
    ok: false as const,
    terminated: true as const,
    reason,
    connectionId,
    clientVersion: connection?.client_version ?? null,
    status: connection?.status ?? null,
    disconnectReason: connection?.disconnect_reason ?? null,
    msSinceDisconnected:
      connection?.disconnected_at != null
        ? now - connection.disconnected_at
        : null,
    msSinceLastHeartbeat:
      connection != null ? now - connection.last_heartbeat : null,
    msSinceCreated: connection != null ? now - connection.created_at : null,
  };
}

export const refreshCentrifugoToken = mutation({
  args: {
    token: v.string(),
    connectionId: v.string(),
  },
  returns: refreshCentrifugoTokenReturns,
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
      return terminatedResult("connection_not_found", connectionId, null);
    }

    if (connection.user_id !== tokenResult.userId) {
      return terminatedResult("ownership_mismatch", connectionId, null);
    }

    if (connection.status !== "connected") {
      return terminatedResult("connection_inactive", connectionId, connection);
    }

    await ctx.db.patch(connection._id, { last_heartbeat: Date.now() });

    const centrifugoToken = await generateCentrifugoToken(
      connection.user_id,
      connection.connection_id,
    );
    return { ok: true as const, centrifugoToken };
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

    if (
      connection &&
      connection.user_id === tokenResult.userId &&
      connection.status === "connected"
    ) {
      await ctx.db.patch(connection._id, {
        status: "disconnected",
        disconnected_at: Date.now(),
        disconnect_reason: "client_disconnect",
      });
    }

    return { success: true };
  },
});

// ============================================================================
// AWS LAMBDA MICROVM CLOUD CONNECTIONS
// ============================================================================

export const beginCloudSandboxDeletion = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.union(
    v.object({
      acquired: v.literal(true),
      operationId: v.string(),
    }),
    v.object({ acquired: v.literal(false) }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const now = Date.now();
    const existing = await ctx.db
      .query("cloud_sandbox_deletion_fences")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();

    if (existing && existing.expires_at > now) {
      return { acquired: false as const };
    }
    if (existing) {
      await ctx.db.delete(existing._id);
    }

    const operationId = crypto.randomUUID();
    await ctx.db.insert("cloud_sandbox_deletion_fences", {
      user_id: args.userId,
      operation_id: operationId,
      started_at: now,
      expires_at: now + CLOUD_SANDBOX_DELETION_FENCE_TTL_MS,
    });
    return { acquired: true as const, operationId };
  },
});

export const finishCloudSandboxDeletion = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    operationId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const existing = await ctx.db
      .query("cloud_sandbox_deletion_fences")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();
    if (!existing || existing.operation_id !== args.operationId) return false;
    await ctx.db.delete(existing._id);
    return true;
  },
});

export const beginCloudSession = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    region: v.string(),
    requestedRegion: v.optional(v.string()),
    placementReason: v.optional(v.string()),
    imageIdentifier: v.string(),
    imageVersion: v.optional(v.string()),
    egressConnectorArn: v.optional(v.string()),
    egressIpv4Address: v.optional(v.string()),
    failoverFromRegion: v.optional(v.string()),
    failoverErrorName: v.optional(v.string()),
    failoverStartedAt: v.optional(v.number()),
  },
  returns: v.object({
    created: v.boolean(),
    session: cloudSessionForBackend,
    bootstrapToken: v.optional(v.string()),
    cleanupCandidates: v.array(cloudSessionCleanupCandidate),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.userId)) {
      throw new ConvexError({
        code: "ACCOUNT_DELETION_IN_PROGRESS",
        message: "Account deletion is in progress",
      });
    }
    const now = Date.now();
    const sandboxDeletionFence = await ctx.db
      .query("cloud_sandbox_deletion_fences")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();
    if (sandboxDeletionFence && sandboxDeletionFence.expires_at > now) {
      throw new ConvexError({
        code: "SANDBOX_DELETION_IN_PROGRESS",
        message: "Sandbox deletion is in progress",
      });
    }
    if (sandboxDeletionFence) {
      await ctx.db.delete(sandboxDeletionFence._id);
    }
    const [active, starting, running] = await Promise.all([
      ctx.db
        .query("cloud_sandbox_sessions")
        .withIndex("by_user_and_status", (q) =>
          q.eq("user_id", args.userId).eq("status", "active"),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("cloud_sandbox_sessions")
        .withIndex("by_user_and_status", (q) =>
          q.eq("user_id", args.userId).eq("status", "starting"),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("cloud_sandbox_sessions")
        .withIndex("by_user_and_status", (q) =>
          q.eq("user_id", args.userId).eq("status", "running"),
        )
        .order("desc")
        .take(50),
    ]);
    const candidates = [...active, ...running, ...starting];
    const isReusable = (session: (typeof candidates)[number]) =>
      session.failure_code === undefined &&
      session.bootstrap_expires_at > now &&
      !(
        session.status === "starting" &&
        now - session.updated_at > CLOUD_SESSION_STARTING_STALE_MS
      );
    // An active sandbox owns in-memory and disk state. Keep it pinned to its
    // persisted region and image even when a later Agent run is routed to a
    // different Trigger region or a new global image release is promoted.
    // New placement inputs apply only after the active session naturally ends.
    // Prefer an already-connected VM over a newer session that is still
    // starting. This is both the lowest-latency and least-expensive choice.
    const reusable =
      active.find(isReusable) ??
      running.find(isReusable) ??
      starting.find(isReusable);
    const cleanupCandidates: Array<{
      sessionId: string;
      microvmId?: string;
      region: string;
      failureCode: string;
    }> = [];

    for (const candidate of candidates) {
      if (candidate._id === reusable?._id) continue;
      const startingIsStale =
        candidate.status === "starting" &&
        now - candidate.updated_at > CLOUD_SESSION_STARTING_STALE_MS;
      const imageMatches =
        candidate.region === args.region &&
        candidate.image_identifier === args.imageIdentifier &&
        candidate.image_version === args.imageVersion;
      const candidateFailureCode =
        candidate.failure_code ??
        (startingIsStale
          ? "starting_timeout"
          : candidate.bootstrap_expires_at <= now
            ? "bootstrap_expired"
            : !imageMatches
              ? "image_configuration_changed"
              : "duplicate_active_session");

      // Keep the session active until the backend confirms AWS termination.
      // Otherwise a transient AWS failure would hide a still-billable VM from
      // all future cleanup attempts.
      await ctx.db.patch(candidate._id, {
        updated_at: now,
        failure_code: candidateFailureCode,
      });
      await disconnectCloudSessionConnection(
        ctx.db,
        candidate.connection_id,
        now,
      );
      cleanupCandidates.push({
        sessionId: candidate.session_id,
        microvmId: candidate.microvm_id,
        region: candidate.region,
        failureCode: candidateFailureCode,
      });
    }

    if (reusable) {
      return {
        created: false,
        session: serializeCloudSession(reusable),
        cleanupCandidates,
      };
    }

    const bootstrapToken = generateCloudBootstrapToken();
    const sessionId = crypto.randomUUID();
    const session = {
      user_id: args.userId,
      session_id: sessionId,
      provider: CLOUD_SESSION_PROVIDER,
      status: "starting" as const,
      bootstrap_token_hash: await hashCloudBootstrapToken(bootstrapToken),
      bootstrap_expires_at: now + CLOUD_SESSION_TOKEN_TTL_MS,
      region: args.region,
      requested_region: args.requestedRegion,
      placement_reason: args.placementReason,
      image_identifier: args.imageIdentifier,
      image_version: args.imageVersion,
      egress_connector_arn: args.egressConnectorArn,
      egress_ipv4_address: args.egressIpv4Address,
      failover_from_region: args.failoverFromRegion,
      failover_error_name: args.failoverErrorName,
      failover_started_at: args.failoverStartedAt,
      created_at: now,
      updated_at: now,
    };
    await ctx.db.insert("cloud_sandbox_sessions", session);

    return {
      created: true,
      session: serializeCloudSession(session),
      bootstrapToken,
      cleanupCandidates,
    };
  },
});

export const getCloudSessionForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    sessionId: v.optional(v.string()),
  },
  returns: v.union(cloudSessionForBackend, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const session = args.sessionId
      ? await ctx.db
          .query("cloud_sandbox_sessions")
          .withIndex("by_session_id", (q) =>
            q.eq("session_id", args.sessionId!),
          )
          .unique()
      : await ctx.db
          .query("cloud_sandbox_sessions")
          .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
          .order("desc")
          .first();

    if (!session || session.user_id !== args.userId) return null;
    return serializeCloudSession(session);
  },
});

export const listActiveCloudSessionsForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.array(cloudSessionForBackend),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const [active, starting, running] = await Promise.all([
      ctx.db
        .query("cloud_sandbox_sessions")
        .withIndex("by_user_and_status", (q) =>
          q.eq("user_id", args.userId).eq("status", "active"),
        )
        .take(100),
      ctx.db
        .query("cloud_sandbox_sessions")
        .withIndex("by_user_and_status", (q) =>
          q.eq("user_id", args.userId).eq("status", "starting"),
        )
        .take(100),
      ctx.db
        .query("cloud_sandbox_sessions")
        .withIndex("by_user_and_status", (q) =>
          q.eq("user_id", args.userId).eq("status", "running"),
        )
        .take(100),
    ]);
    return [...starting, ...active, ...running].map(serializeCloudSession);
  },
});

export const listCloudSessionsForReconciliation = query({
  args: {
    serviceKey: v.string(),
    limit: v.number(),
  },
  returns: v.array(cloudSessionForReconciliation),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const limit = Math.max(1, Math.min(Math.floor(args.limit), 200));
    const statuses = ["starting", "active", "running"] as const;
    const groups = await Promise.all(
      statuses.map((status) =>
        ctx.db
          .query("cloud_sandbox_sessions")
          .withIndex("by_status_and_aws_state_checked_at", (q) =>
            q.eq("status", status),
          )
          .order("asc")
          .take(limit),
      ),
    );
    return groups
      .flat()
      .filter((session) => session.microvm_id !== undefined)
      .sort(
        (left, right) =>
          (left.aws_state_checked_at ?? 0) - (right.aws_state_checked_at ?? 0),
      )
      .slice(0, limit)
      .map((session) => ({
        userId: session.user_id,
        session: serializeCloudSession(session),
      }));
  },
});

export const attachCloudMicrovm = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    microvmId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const session = await ctx.db
      .query("cloud_sandbox_sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (
      !session ||
      session.user_id !== args.userId ||
      (session.status !== "starting" &&
        session.status !== "active" &&
        session.status !== "running")
    ) {
      return false;
    }
    if (session.microvm_id && session.microvm_id !== args.microvmId) {
      throw new ConvexError({
        code: "CLOUD_SESSION_MISMATCH",
        message: "Cloud session is already attached to another MicroVM",
      });
    }
    await ctx.db.patch(session._id, {
      microvm_id: args.microvmId,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const markCloudDirectReady = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    microvmId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const session = await ctx.db
      .query("cloud_sandbox_sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (
      !session ||
      session.user_id !== args.userId ||
      session.microvm_id !== args.microvmId ||
      (session.status !== "starting" &&
        session.status !== "active" &&
        session.status !== "running")
    ) {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(session._id, {
      status: "active",
      aws_state: "RUNNING",
      aws_state_checked_at: now,
      relay_ready_at: now,
      last_connected_at: now,
      ...(session.failover_started_at !== undefined &&
      session.failover_completed_at === undefined
        ? {
            failover_completed_at: now,
            failover_duration_ms: Math.max(
              0,
              now - session.failover_started_at,
            ),
            failover_outcome: "succeeded" as const,
          }
        : {}),
      updated_at: now,
    });
    return true;
  },
});

export const markCloudSessionCleanupPending = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    failureCode: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const session = await ctx.db
      .query("cloud_sandbox_sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (!session || session.user_id !== args.userId) return false;
    if (session.status === "failed" || session.status === "terminated") {
      return true;
    }
    const now = Date.now();
    await ctx.db.patch(session._id, {
      failure_code: args.failureCode,
      updated_at: now,
    });
    await disconnectCloudSessionConnection(ctx.db, session.connection_id, now);
    return true;
  },
});

export const resolveCloudSessionCleanupTarget = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    sessionId: v.string(),
  },
  returns: v.object({
    microvmId: v.optional(v.string()),
    endedWithoutMicrovm: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const session = await ctx.db
      .query("cloud_sandbox_sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (!session || session.user_id !== args.userId) {
      return { endedWithoutMicrovm: true };
    }
    if (session.microvm_id) {
      return {
        microvmId: session.microvm_id,
        endedWithoutMicrovm: false,
      };
    }
    if (session.status === "failed" || session.status === "terminated") {
      return { endedWithoutMicrovm: true };
    }

    // This mutation is atomic with attachCloudMicrovm. If attach wins, its ID
    // is returned for AWS termination. If cleanup wins, attach is rejected and
    // the creator will terminate the ID from its own failure path.
    const now = Date.now();
    await ctx.db.patch(session._id, {
      status: "failed",
      failure_code: "cleanup_microvm_id_missing",
      ended_at: now,
      updated_at: now,
    });
    await disconnectCloudSessionConnection(ctx.db, session.connection_id, now);
    return { endedWithoutMicrovm: true };
  },
});

export const markCloudSessionEnded = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    status: v.union(v.literal("failed"), v.literal("terminated")),
    failureCode: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const session = await ctx.db
      .query("cloud_sandbox_sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (!session || session.user_id !== args.userId) return false;
    const now = Date.now();
    await ctx.db.patch(session._id, {
      status: args.status,
      ...(args.status === "terminated"
        ? {
            aws_state: "TERMINATED" as const,
            aws_state_checked_at: now,
          }
        : {}),
      failure_code: args.failureCode,
      ...(args.status === "failed" &&
      session.failover_started_at !== undefined &&
      session.failover_completed_at === undefined
        ? {
            failover_completed_at: now,
            failover_duration_ms: Math.max(
              0,
              now - session.failover_started_at,
            ),
            failover_outcome: "failed" as const,
          }
        : {}),
      ended_at: now,
      updated_at: now,
    });
    await disconnectCloudSessionConnection(ctx.db, session.connection_id, now);
    return true;
  },
});

export const recordCloudMicrovmStateForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    microvmId: v.string(),
    state: cloudMicrovmState,
    failureCode: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const session = await ctx.db
      .query("cloud_sandbox_sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (
      !session ||
      session.user_id !== args.userId ||
      session.microvm_id !== args.microvmId ||
      session.status === "failed" ||
      session.status === "terminated"
    ) {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(session._id, {
      ...cloudMicrovmStatePatch(session, args.state, now),
      ...(args.failureCode ? { failure_code: args.failureCode } : {}),
    });
    if (args.state === "TERMINATING" || args.state === "TERMINATED") {
      await disconnectCloudSessionConnection(
        ctx.db,
        session.connection_id,
        now,
      );
    }
    return true;
  },
});

export const reportCloudLifecycleState = mutation({
  args: {
    sessionId: v.string(),
    bootstrapToken: v.string(),
    microvmId: v.string(),
    state: v.union(
      v.literal("RUNNING"),
      v.literal("SUSPENDING"),
      v.literal("SUSPENDED"),
      v.literal("TERMINATING"),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await validateCloudSessionCredential(
      ctx,
      args.sessionId,
      args.bootstrapToken,
    );
    if (!session || session.microvm_id !== args.microvmId) return false;
    const now = Date.now();
    await ctx.db.patch(
      session._id,
      cloudMicrovmStatePatch(session, args.state, now),
    );
    if (args.state === "TERMINATING") {
      await disconnectCloudSessionConnection(
        ctx.db,
        session.connection_id,
        now,
      );
    }
    return true;
  },
});

async function validateCloudSessionCredential(
  ctx: { db: DatabaseReader },
  sessionId: string,
  bootstrapToken: string,
) {
  const session = await ctx.db
    .query("cloud_sandbox_sessions")
    .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
    .unique();
  if (!session) return null;
  if (
    session.status === "failed" ||
    session.status === "terminated" ||
    session.bootstrap_expires_at <= Date.now()
  ) {
    return null;
  }
  const tokenHash = await hashCloudBootstrapToken(bootstrapToken);
  return tokenHash === session.bootstrap_token_hash ? session : null;
}

export const connectCloud = mutation({
  args: {
    sessionId: v.string(),
    bootstrapToken: v.string(),
    microvmId: v.string(),
    clientVersion: v.string(),
    osInfo: v.optional(
      v.object({
        platform: v.string(),
        arch: v.string(),
        release: v.string(),
        hostname: v.string(),
      }),
    ),
    capabilities: v.optional(
      v.object({
        commands: v.boolean(),
        pty: v.boolean(),
        files: v.optional(v.boolean()),
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
    const session = await validateCloudSessionCredential(
      ctx,
      args.sessionId,
      args.bootstrapToken,
    );
    if (!session) return { success: false, error: "Invalid cloud session" };
    if (session.microvm_id && session.microvm_id !== args.microvmId) {
      return { success: false, error: "Cloud MicroVM mismatch" };
    }
    const centrifugoWsUrl = process.env.CENTRIFUGO_WS_URL;
    if (!centrifugoWsUrl) {
      return { success: false, error: "Centrifugo not configured" };
    }

    const now = Date.now();
    let connectionId = session.connection_id;
    let connection = connectionId
      ? await ctx.db
          .query("local_sandbox_connections")
          .withIndex("by_connection_id", (q) =>
            q.eq("connection_id", connectionId!),
          )
          .unique()
      : null;

    if (!connection) {
      connectionId = crypto.randomUUID();
      await ctx.db.insert("local_sandbox_connections", {
        user_id: session.user_id,
        connection_id: connectionId,
        connection_name: "AWS Lambda MicroVM",
        client_version: args.clientVersion,
        mode: "cloud",
        os_info: args.osInfo,
        capabilities: args.capabilities ?? { commands: true, pty: true },
        last_heartbeat: now,
        status: "connected",
        created_at: now,
      });
    } else {
      await ctx.db.patch(connection._id, {
        status: "connected",
        disconnected_at: undefined,
        disconnect_reason: undefined,
        last_heartbeat: now,
        os_info: args.osInfo,
        capabilities: args.capabilities ?? { commands: true, pty: true },
      });
    }

    if (!connectionId) {
      throw new Error("Cloud connection ID was not created");
    }

    await ctx.db.patch(session._id, {
      ...(args.clientVersion === RELAY_READY_CLIENT_VERSION
        ? {}
        : { status: "running" as const }),
      microvm_id: args.microvmId,
      connection_id: connectionId,
      last_connected_at: now,
      updated_at: now,
    });

    return {
      success: true,
      userId: session.user_id,
      connectionId,
      centrifugoToken: await generateCentrifugoToken(
        session.user_id,
        connectionId,
      ),
      centrifugoWsUrl,
    };
  },
});

export const markCloudRelayReady = mutation({
  args: {
    sessionId: v.string(),
    bootstrapToken: v.string(),
    microvmId: v.string(),
    connectionId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await validateCloudSessionCredential(
      ctx,
      args.sessionId,
      args.bootstrapToken,
    );
    if (
      !session ||
      session.microvm_id !== args.microvmId ||
      session.connection_id !== args.connectionId
    ) {
      return false;
    }

    const now = Date.now();
    await ctx.db.patch(session._id, {
      status: "running",
      relay_ready_at: now,
      updated_at: now,
    });
    return true;
  },
});

export const refreshCloudCentrifugoToken = mutation({
  args: {
    sessionId: v.string(),
    bootstrapToken: v.string(),
    connectionId: v.string(),
  },
  returns: refreshCentrifugoTokenReturns,
  handler: async (ctx, args) => {
    const session = await validateCloudSessionCredential(
      ctx,
      args.sessionId,
      args.bootstrapToken,
    );
    if (!session || session.connection_id !== args.connectionId) {
      return terminatedResult("ownership_mismatch", args.connectionId, null);
    }
    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) =>
        q.eq("connection_id", args.connectionId),
      )
      .unique();
    if (!connection) {
      return terminatedResult("connection_not_found", args.connectionId, null);
    }
    if (connection.status !== "connected") {
      return terminatedResult(
        "connection_inactive",
        args.connectionId,
        connection,
      );
    }
    const now = Date.now();
    await ctx.db.patch(connection._id, { last_heartbeat: now });
    await ctx.db.patch(session._id, {
      last_connected_at: now,
      updated_at: now,
    });
    return {
      ok: true as const,
      centrifugoToken: await generateCentrifugoToken(
        session.user_id,
        args.connectionId,
      ),
    };
  },
});

export const disconnectCloud = mutation({
  args: {
    sessionId: v.string(),
    bootstrapToken: v.string(),
    connectionId: v.string(),
    terminated: v.optional(v.boolean()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const session = await validateCloudSessionCredential(
      ctx,
      args.sessionId,
      args.bootstrapToken,
    );
    if (!session || session.connection_id !== args.connectionId) {
      return { success: false };
    }
    const now = Date.now();
    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) =>
        q.eq("connection_id", args.connectionId),
      )
      .unique();
    if (connection?.status === "connected") {
      await ctx.db.patch(connection._id, {
        status: "disconnected",
        disconnected_at: now,
        disconnect_reason: "client_disconnect",
      });
    }
    await ctx.db.patch(session._id, {
      ...(args.terminated
        ? { status: "terminated" as const, ended_at: now }
        : {}),
      updated_at: now,
    });
    return { success: true };
  },
});

export const purgeStaleCloudSessions = internalMutation({
  args: {
    cutoffTimeMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    // Non-terminal rows retain the only durable MicroVM identifier available
    // to backend AWS cleanup. Never delete them from a database-only cron;
    // the AWS termination path marks them terminal after cleanup is confirmed.
    const staleStates = ["failed", "terminated"] as const;
    const rows: Doc<"cloud_sandbox_sessions">[] = [];
    for (const status of staleStates) {
      const remaining = limit - rows.length;
      if (remaining <= 0) break;
      rows.push(
        ...(await ctx.db
          .query("cloud_sandbox_sessions")
          .withIndex("by_status_and_updated_at", (q) =>
            q.eq("status", status).lt("updated_at", args.cutoffTimeMs),
          )
          .order("asc")
          .take(remaining)),
      );
    }
    const now = Date.now();
    for (const row of rows) {
      await disconnectCloudSessionConnection(ctx.db, row.connection_id, now);
      await ctx.db.delete(row._id);
    }
    return { deletedCount: rows.length };
  },
});

export const connectDesktop = mutation({
  args: {
    connectionName: v.string(),
    osInfo: v.optional(
      v.object({
        platform: v.string(),
        arch: v.string(),
        release: v.string(),
        hostname: v.string(),
      }),
    ),
    capabilities: v.optional(
      v.object({
        commands: v.boolean(),
        pty: v.boolean(),
        files: v.optional(v.boolean()),
      }),
    ),
  },
  returns: v.object({
    connectionId: v.string(),
    centrifugoToken: v.string(),
    centrifugoWsUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const userId = identity.subject;

    // Disconnect stale desktop connections for this user (page reload, etc.)
    const existingDesktop = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_user_and_status", (q) =>
        q.eq("user_id", userId).eq("status", "connected"),
      )
      .collect();
    const now = Date.now();
    for (const conn of existingDesktop) {
      if (conn.client_version === "desktop") {
        await ctx.db.patch(conn._id, {
          status: "disconnected",
          disconnected_at: now,
          disconnect_reason: "desktop_kicked_by_new_session",
        });
      }
    }

    const connectionId = crypto.randomUUID();

    await ctx.db.insert("local_sandbox_connections", {
      user_id: userId,
      connection_id: connectionId,
      connection_name: args.connectionName,
      container_id: undefined,
      client_version: "desktop",
      mode: "dangerous",
      os_info: args.osInfo,
      capabilities: args.capabilities ?? { commands: true, pty: true },
      last_heartbeat: Date.now(),
      status: "connected",
      created_at: Date.now(),
    });

    const centrifugoToken = await generateCentrifugoToken(userId, connectionId);
    const centrifugoWsUrl = process.env.CENTRIFUGO_WS_URL;
    if (!centrifugoWsUrl) {
      throw new Error("CENTRIFUGO_WS_URL environment variable not set");
    }

    return {
      connectionId,
      centrifugoToken,
      centrifugoWsUrl,
    };
  },
});

export const refreshCentrifugoTokenDesktop = mutation({
  args: {
    connectionId: v.string(),
  },
  returns: refreshCentrifugoTokenReturns,
  handler: async (ctx, { connectionId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const userId = identity.subject;

    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (!connection) {
      return terminatedResult("connection_not_found", connectionId, null);
    }

    if (connection.user_id !== userId) {
      return terminatedResult("ownership_mismatch", connectionId, null);
    }

    if (connection.status !== "connected") {
      return terminatedResult("connection_inactive", connectionId, connection);
    }

    await ctx.db.patch(connection._id, { last_heartbeat: Date.now() });

    const centrifugoToken = await generateCentrifugoToken(userId, connectionId);
    return { ok: true as const, centrifugoToken };
  },
});

export const heartbeatDesktop = mutation({
  args: {
    connectionId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, { connectionId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (
      !connection ||
      connection.user_id !== identity.subject ||
      connection.client_version !== "desktop" ||
      connection.status !== "connected"
    ) {
      return { success: false };
    }

    await ctx.db.patch(connection._id, { last_heartbeat: Date.now() });
    return { success: true };
  },
});

export const disconnectDesktop = mutation({
  args: {
    connectionId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, { connectionId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const userId = identity.subject;

    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (!connection || connection.user_id !== userId) {
      return { success: false };
    }

    if (connection.status === "connected") {
      await ctx.db.patch(connection._id, {
        status: "disconnected",
        disconnected_at: Date.now(),
        disconnect_reason: "desktop_disconnect",
      });
    }

    return { success: true };
  },
});

export const disconnectByBackend = mutation({
  args: {
    serviceKey: v.string(),
    connectionId: v.string(),
    reason: v.optional(
      v.union(v.literal("presence_sweep"), v.literal("command_unresponsive")),
    ),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, { serviceKey, connectionId, reason }) => {
    validateServiceKey(serviceKey);

    const connection = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
      .first();

    if (connection && connection.status === "connected") {
      await ctx.db.patch(connection._id, {
        status: "disconnected",
        disconnected_at: Date.now(),
        disconnect_reason: reason ?? "presence_sweep",
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
      osInfo: v.optional(
        v.object({
          platform: v.string(),
          arch: v.string(),
          release: v.string(),
          hostname: v.string(),
        }),
      ),
      lastSeen: v.number(),
      isDesktop: v.boolean(),
      capabilities: v.object({
        commands: v.boolean(),
        pty: v.boolean(),
        files: v.optional(v.boolean()),
      }),
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

    return connections
      .filter((conn) => conn.mode !== "cloud")
      .map((conn) => ({
        connectionId: conn.connection_id,
        name: conn.connection_name,
        osInfo: conn.os_info,
        lastSeen: conn.last_heartbeat,
        isDesktop: conn.client_version === "desktop",
        capabilities: conn.capabilities ?? { commands: true, pty: true },
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
      osInfo: v.optional(
        v.object({
          platform: v.string(),
          arch: v.string(),
          release: v.string(),
          hostname: v.string(),
        }),
      ),
      lastSeen: v.number(),
      isDesktop: v.boolean(),
      capabilities: v.object({
        commands: v.boolean(),
        pty: v.boolean(),
        files: v.optional(v.boolean()),
      }),
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

    return connections
      .filter((conn) => conn.mode !== "cloud")
      .map((conn) => ({
        connectionId: conn.connection_id,
        name: conn.connection_name,
        osInfo: conn.os_info,
        lastSeen: conn.last_heartbeat,
        isDesktop: conn.client_version === "desktop",
        capabilities: conn.capabilities ?? { commands: true, pty: true },
      }));
  },
});
