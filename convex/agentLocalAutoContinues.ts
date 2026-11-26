import { v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./lib/serviceFunctions";
import type { Doc } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";
import { getOwnedChat } from "./lib/ownedChat";
import {
  localAutoContinueReasonValidator,
  localAutoContinueStateValidator,
} from "./lib/localAutoContinueValidators";
import { LOCAL_CONNECTION_LOST_FINISH_REASON } from "../lib/chat/local-connection-stop";
import {
  LOCAL_AUTO_CONTINUE_CAP_WINDOW_MS,
  LOCAL_AUTO_CONTINUE_MAX_STOP_AGE_MS,
  LOCAL_AUTO_CONTINUE_START_LEASE_MS,
  localAutoContinueCapAllows,
  localAutoContinueSandboxPreference,
  localAutoContinueStopEligibility,
  type LocalAutoContinueReason,
} from "../lib/chat/local-auto-continue";

/**
 * The durable decision record for HAC-275. Each row is keyed by the stopped
 * run's ID; every transition out of `awaiting_return` happens in one Convex
 * mutation, so concurrent reports (retries, reconnect storms, two tabs) can
 * never let more than one caller claim a stop's continuation.
 */

type Row = Doc<"agent_local_auto_continues">;
type Ctx = QueryCtx | MutationCtx;

const variantValidator = v.union(v.literal("control"), v.literal("test"));
const cancelReasonValidator = v.union(
  v.literal("user_stop"),
  v.literal("user_message"),
  v.literal("manual_resume"),
  v.literal("environment_switched"),
);
// A claimed start can only belong to a stop this recent.
const RECENT_STOP_MS =
  LOCAL_AUTO_CONTINUE_MAX_STOP_AGE_MS +
  LOCAL_AUTO_CONTINUE_CAP_WINDOW_MS +
  LOCAL_AUTO_CONTINUE_START_LEASE_MS;

const rowFor = (ctx: Ctx, stoppedRunId: string) =>
  ctx.db
    .query("agent_local_auto_continues")
    .withIndex("by_stopped_run_id", (q) => q.eq("stopped_run_id", stoppedRunId))
    .unique();

const recentRowsForChat = (ctx: Ctx, chatId: string, now: number) =>
  ctx.db
    .query("agent_local_auto_continues")
    .withIndex("by_chat_and_stopped_at", (q) =>
      q.eq("chat_id", chatId).gt("stopped_at", now - RECENT_STOP_MS),
    )
    .collect();

const connectionFor = (ctx: Ctx, connectionId: string) =>
  ctx.db
    .query("local_sandbox_connections")
    .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
    .unique();

/** The user's own Desktop connection that proved its native session. */
async function desktopSession(ctx: Ctx, userId: string, connectionId: string) {
  const connection = await connectionFor(ctx, connectionId);
  if (
    !connection ||
    connection.user_id !== userId ||
    connection.registration_origin !== "desktop" ||
    connection.native_launch_id === undefined ||
    connection.native_page_generation === undefined
  )
    return undefined;
  return connection;
}

/**
 * Whether the user saved a message (a send, a manual Resume) in the chat
 * after this stop released it. Read from the messages themselves, so a user
 * action holds even when its cancellation write or its run start failed.
 */
async function userMessagedSince(ctx: Ctx, row: Row) {
  const since = row.chat_finished_at ?? row.stopped_at;
  const newer = await ctx.db
    .query("messages")
    .withIndex("by_chat_id", (q) =>
      q.eq("chat_id", row.chat_id).gt("_creationTime", since),
    )
    .take(20);
  return newer.some((message) => message.role === "user");
}

const sameSession = (row: Row, connection: Doc<"local_sandbox_connections">) =>
  row.native_launch_id === connection.native_launch_id &&
  row.native_page_generation === connection.native_page_generation &&
  row.environment_id === connection.environment_id;

const finish = (
  ctx: MutationCtx,
  row: Row,
  state: Row["state"],
  reason: LocalAutoContinueReason | undefined,
  now: number,
) =>
  ctx.db.patch(row._id, {
    state,
    ...(reason ? { reason } : {}),
    settled_at: now,
  });

const decisionValidator = v.object({
  stoppedRunId: v.string(),
  chatId: v.string(),
  state: localAutoContinueStateValidator,
  reason: v.optional(localAutoContinueReasonValidator),
  stopReason: v.optional(v.string()),
  stoppedAt: v.number(),
  variant: v.optional(variantValidator),
});

const decision = (row: Row, patch: Partial<Row> = {}) => {
  const next = { ...row, ...patch };
  return {
    stoppedRunId: next.stopped_run_id,
    chatId: next.chat_id,
    state: next.state,
    ...(next.reason ? { reason: next.reason } : {}),
    ...(next.stop_reason ? { stopReason: next.stop_reason } : {}),
    stoppedAt: next.stopped_at,
    ...(next.variant ? { variant: next.variant } : {}),
  };
};

/**
 * Called by the worker after a Desktop run stopped for a lost connection and
 * released its chat. Idempotent: a repeated call returns the first decision.
 */
export const recordStop = mutation({
  args: {
    serviceKey: v.string(),
    stoppedRunId: v.string(),
    chatId: v.string(),
    userId: v.string(),
    stopReason: v.optional(v.string()),
    connectionId: v.optional(v.string()),
    usageLimited: v.boolean(),
    sandboxPreference: v.optional(v.string()),
    agentPermissionMode: v.optional(v.string()),
    selectedModel: v.optional(v.string()),
  },
  returns: v.object({ created: v.boolean(), decision: decisionValidator }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const existing = await rowFor(ctx, args.stoppedRunId);
    if (existing) return { created: false, decision: decision(existing) };
    const now = Date.now();
    const chat = await getOwnedChat(ctx, args.chatId, args.userId);
    const connection = args.connectionId
      ? await desktopSession(ctx, args.userId, args.connectionId)
      : undefined;
    const eligibility = localAutoContinueStopEligibility(args.stopReason);
    const chatReleased =
      !!chat &&
      chat.finish_reason === LOCAL_CONNECTION_LOST_FINISH_REASON &&
      chat.active_trigger_run_id === undefined;
    const chatRows = await recentRowsForChat(ctx, args.chatId, now);
    // A late report: a later run's stop already recorded the chat's current
    // finish, so that finish is not this run's.
    const laterStopRecorded =
      chatReleased &&
      chat.last_run_finished_at !== undefined &&
      chatRows.some(
        (other) =>
          other.stopped_run_id !== args.stoppedRunId &&
          other.chat_finished_at !== undefined &&
          other.chat_finished_at >= chat.last_run_finished_at!,
      );
    // Whether this run is still the chat's latest: no other run owns it or
    // changed its finish since this one stopped.
    const latestRun =
      !!chat &&
      (chat.active_trigger_run_id === undefined ||
        chat.active_trigger_run_id === args.stoppedRunId) &&
      chat.finish_reason === LOCAL_CONNECTION_LOST_FINISH_REASON &&
      !laterStopRecorded;
    const reason: LocalAutoContinueReason | undefined = !eligibility.eligible
      ? eligibility.reason
      : args.usageLimited
        ? "usage_limit"
        : !connection ||
            // The continuation must be able to target exactly this computer.
            !localAutoContinueSandboxPreference(
              args.sandboxPreference,
              connection.environment_id,
            )
          ? "session_unproven"
          : !latestRun
            ? laterStopRecorded
              ? "superseded"
              : "chat_changed"
            : undefined;
    // An earlier stop that never continued is replaced by this newer one. A
    // stale report never replaces the stop of a run that came after it.
    if (latestRun) {
      for (const older of chatRows) {
        if (older.state === "awaiting_return")
          await finish(ctx, older, "cancelled", "superseded", now);
      }
    }
    const id = await ctx.db.insert("agent_local_auto_continues", {
      stopped_run_id: args.stoppedRunId,
      chat_id: args.chatId,
      user_id: args.userId,
      state: reason
        ? reason === "chat_changed" || reason === "superseded"
          ? "cancelled"
          : "ineligible"
        : "awaiting_return",
      ...(reason ? { reason, settled_at: now } : {}),
      ...(args.stopReason ? { stop_reason: args.stopReason } : {}),
      stopped_at: now,
      ...(chatReleased && latestRun && chat.last_run_finished_at !== undefined
        ? { chat_finished_at: chat.last_run_finished_at }
        : {}),
      ...(args.connectionId ? { connection_id: args.connectionId } : {}),
      ...(connection && {
        environment_id: connection.environment_id,
        native_launch_id: connection.native_launch_id,
        native_page_generation: connection.native_page_generation,
      }),
      ...(args.sandboxPreference
        ? { sandbox_preference: args.sandboxPreference }
        : {}),
      ...(args.agentPermissionMode
        ? { agent_permission_mode: args.agentPermissionMode }
        : {}),
      ...(args.selectedModel ? { selected_model: args.selectedModel } : {}),
    });
    const row = await ctx.db.get(id);
    return { created: true, decision: decision(row!) };
  },
});

/** Bounds one report's work; a 30-minute window holds far fewer stops. */
const RETURN_BATCH = 50;

/**
 * A Desktop connection reported that it is connected again. Returns the
 * user's waiting stops from that same native session, newest first. The same
 * computer under a new launch or page can never be the stopped session again,
 * so its waiting stops become ineligible here, as do stops too old to
 * continue. Only this computer's recent stops are read, so stops elsewhere
 * cannot crowd them out.
 */
export const observeReturn = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    connectionId: v.string(),
  },
  returns: v.object({
    candidates: v.array(v.object({ stoppedRunId: v.string() })),
    settled: v.array(decisionValidator),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const connection = await desktopSession(
      ctx,
      args.userId,
      args.connectionId,
    );
    const environmentId = connection?.environment_id;
    if (!connection || connection.status !== "connected" || !environmentId)
      return { candidates: [], settled: [] };
    const now = Date.now();
    const oldest = now - LOCAL_AUTO_CONTINUE_MAX_STOP_AGE_MS;
    const waiting = (range: "recent" | "expired") =>
      ctx.db
        .query("agent_local_auto_continues")
        .withIndex("by_user_environment_state_stopped_at", (q) => {
          const scoped = q
            .eq("user_id", args.userId)
            .eq("environment_id", environmentId)
            .eq("state", "awaiting_return");
          return range === "recent"
            ? scoped.gt("stopped_at", oldest)
            : scoped.lte("stopped_at", oldest);
        })
        .order("desc")
        .take(RETURN_BATCH);
    const candidates = [];
    const settled = [];
    for (const row of await waiting("recent")) {
      if (sameSession(row, connection)) {
        candidates.push({ stoppedRunId: row.stopped_run_id });
      } else {
        await finish(ctx, row, "ineligible", "session_replaced", now);
        settled.push(
          decision(row, { state: "ineligible", reason: "session_replaced" }),
        );
      }
    }
    for (const row of await waiting("expired")) {
      await finish(ctx, row, "ineligible", "stop_too_old", now);
      settled.push(
        decision(row, { state: "ineligible", reason: "stop_too_old" }),
      );
    }
    return { candidates, settled };
  },
});

/**
 * The eligible moment: the stopped run's own Desktop session is back. Exactly
 * one caller moves the row out of `awaiting_return`; everyone else gets
 * `claimed: false`. `exposed` is true only for that caller, and only when the
 * stop was still eligible, so exposure is counted once per stop in both arms.
 */
export const claimReturn = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    stoppedRunId: v.string(),
    connectionId: v.string(),
    /** Absent when the flag was unavailable: behaves as control, unexposed. */
    variant: v.optional(variantValidator),
  },
  returns: v.union(
    v.object({ claimed: v.literal(false), pending: v.boolean() }),
    v.object({
      claimed: v.literal(true),
      exposed: v.boolean(),
      decision: decisionValidator,
      settings: v.object({
        sandboxPreference: v.optional(v.string()),
        agentPermissionMode: v.optional(v.string()),
        selectedModel: v.optional(v.string()),
      }),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await rowFor(ctx, args.stoppedRunId);
    if (!row || row.user_id !== args.userId || row.state !== "awaiting_return")
      return { claimed: false as const, pending: false };
    const connection = await desktopSession(
      ctx,
      args.userId,
      args.connectionId,
    );
    if (
      !connection ||
      connection.status !== "connected" ||
      !sameSession(row, connection)
    )
      return { claimed: false as const, pending: false };
    const now = Date.now();
    const sandboxPreference = localAutoContinueSandboxPreference(
      row.sandbox_preference,
      row.environment_id,
    );
    const settings = {
      ...(sandboxPreference ? { sandboxPreference } : {}),
      ...(row.agent_permission_mode
        ? { agentPermissionMode: row.agent_permission_mode }
        : {}),
      ...(row.selected_model ? { selectedModel: row.selected_model } : {}),
    };
    const settle = async (
      state: Row["state"],
      reason: LocalAutoContinueReason | undefined,
      exposed: boolean,
      patch: Partial<Row> = {},
    ) => {
      await ctx.db.patch(row._id, {
        state,
        ...(reason ? { reason } : {}),
        ...(state === "starting" ? {} : { settled_at: now }),
        ...patch,
      });
      return {
        claimed: true as const,
        exposed,
        decision: decision(row, { state, reason, ...patch }),
        settings,
      };
    };
    if (now - row.stopped_at > LOCAL_AUTO_CONTINUE_MAX_STOP_AGE_MS)
      return settle("ineligible", "stop_too_old", false);
    // Never start on a generic preference that could pick another Desktop.
    if (!sandboxPreference)
      return settle("ineligible", "session_unproven", false);
    const chat = await getOwnedChat(ctx, row.chat_id, args.userId);
    // The stopped run has not released its chat yet; ask again shortly.
    if (chat?.active_trigger_run_id === row.stopped_run_id)
      return { claimed: false as const, pending: true };
    if (
      !chat ||
      chat.active_trigger_run_id !== undefined ||
      chat.active_agent_user_wait !== undefined ||
      chat.canceled_at !== undefined ||
      chat.finish_reason !== LOCAL_CONNECTION_LOST_FINISH_REASON ||
      (row.chat_finished_at !== undefined &&
        chat.last_run_finished_at !== row.chat_finished_at)
    )
      return settle("cancelled", "chat_changed", false);
    // The user's own message wins, even if cancelling this stop failed.
    if (await userMessagedSince(ctx, row))
      return settle("cancelled", "user_message", false);
    const returned = {
      returned_at: now,
      ...(args.variant ? { variant: args.variant } : {}),
    };
    if (args.variant !== "test")
      return settle("manual", "control", args.variant !== undefined, returned);
    const recentStarts = (await recentRowsForChat(ctx, row.chat_id, now))
      .filter(
        (other) =>
          other.claimed_at !== undefined &&
          (other.state === "starting" || other.state === "started"),
      )
      .map((other) => other.claimed_at!);
    if (!localAutoContinueCapAllows(recentStarts, now))
      return settle("suppressed", "cap", true, returned);
    return settle("starting", undefined, true, {
      ...returned,
      claimed_at: now,
    });
  },
});

/**
 * Settles a claimed start. When the user cancelled while it started, returns
 * `cancelled: true` so the caller stops the run it just created.
 */
export const settleStart = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    stoppedRunId: v.string(),
    continuedRunId: v.optional(v.string()),
    failureReason: v.optional(
      v.union(v.literal("admission_refused"), v.literal("start_error")),
    ),
  },
  returns: v.object({ cancelled: v.boolean() }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await rowFor(ctx, args.stoppedRunId);
    if (!row || row.user_id !== args.userId) return { cancelled: false };
    const now = Date.now();
    if (row.state === "starting") {
      await ctx.db.patch(row._id, {
        ...(args.continuedRunId
          ? { state: "started", continued_run_id: args.continuedRunId }
          : { state: "start_failed", reason: args.failureReason }),
        settled_at: now,
      });
      return { cancelled: false };
    }
    if (row.state === "cancelled" && args.continuedRunId) {
      await ctx.db.patch(row._id, { continued_run_id: args.continuedRunId });
      return { cancelled: true };
    }
    return { cancelled: false };
  },
});

/**
 * The user acted first: stopped, sent a message, resumed manually or picked
 * another environment. Waiting and in-flight stops of that chat never
 * continue automatically. Returns the rows it settled, for telemetry.
 */
export const cancelForChat = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    reason: cancelReasonValidator,
  },
  returns: v.array(decisionValidator),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const now = Date.now();
    const cancelled = [];
    for (const row of await recentRowsForChat(ctx, args.chatId, now)) {
      if (
        row.user_id === args.userId &&
        (row.state === "awaiting_return" || row.state === "starting")
      ) {
        await finish(ctx, row, "cancelled", args.reason, now);
        cancelled.push(
          decision(row, { state: "cancelled", reason: args.reason }),
        );
      }
    }
    return cancelled;
  },
});

/** For the start route: whether this stop's continuation is claimed now. */
export const getClaim = query({
  args: { serviceKey: v.string(), stoppedRunId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      chatId: v.string(),
      userId: v.string(),
      claimedAt: v.number(),
      /** The only sandbox this start may use: the computer that came back. */
      sandboxPreference: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await rowFor(ctx, args.stoppedRunId);
    const sandboxPreference = row
      ? localAutoContinueSandboxPreference(
          row.sandbox_preference,
          row.environment_id,
        )
      : undefined;
    if (
      !row ||
      !sandboxPreference ||
      row.state !== "starting" ||
      row.claimed_at === undefined ||
      Date.now() - row.claimed_at > LOCAL_AUTO_CONTINUE_START_LEASE_MS
    )
      return null;
    return {
      chatId: row.chat_id,
      userId: row.user_id,
      claimedAt: row.claimed_at,
      sandboxPreference,
    };
  },
});

/**
 * The chat's automatic continuation while it is starting or running, for the
 * "Your computer is back — continuing" notice. Nothing else is exposed, so a
 * stop that is still waiting looks the same in both arms.
 */
export const getForChat = query({
  args: { chatId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      state: v.union(v.literal("starting"), v.literal("started")),
      stoppedRunId: v.string(),
      continuedRunId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    if (!(await getOwnedChat(ctx, args.chatId, identity.subject))) return null;
    const latest = await ctx.db
      .query("agent_local_auto_continues")
      .withIndex("by_chat_and_stopped_at", (q) => q.eq("chat_id", args.chatId))
      .order("desc")
      .first();
    if (!latest || latest.user_id !== identity.subject) return null;
    if (
      latest.state === "starting" &&
      latest.claimed_at !== undefined &&
      Date.now() - latest.claimed_at <= LOCAL_AUTO_CONTINUE_START_LEASE_MS
    )
      return {
        state: "starting" as const,
        stoppedRunId: latest.stopped_run_id,
      };
    if (latest.state === "started")
      return {
        state: "started" as const,
        stoppedRunId: latest.stopped_run_id,
        ...(latest.continued_run_id
          ? { continuedRunId: latest.continued_run_id }
          : {}),
      };
    return null;
  },
});
