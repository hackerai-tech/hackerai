import { BROWSER_SESSION_MAX_LIFETIME_MS } from "../lib/ai/browser-handoff/constants";
import { v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./lib/serviceFunctions";
import type { Doc } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";

const state = v.union(
  v.literal("agent"),
  v.literal("waiting"),
  v.literal("claiming"),
  v.literal("human"),
  v.literal("recovery"),
  v.literal("resuming"),
  v.literal("closed"),
);
const publicSession = v.object({
  sessionId: v.string(),
  runId: v.string(),
  agentId: v.string(),
  state,
  grantExpiresAt: v.union(v.number(), v.null()),
  expiresAt: v.number(),
  updatedAt: v.number(),
});
const privateSession = v.object({
  runActive: v.boolean(),
  sessionId: v.string(),
  userId: v.string(),
  chatId: v.string(),
  runId: v.string(),
  agentId: v.string(),
  sandboxId: v.string(),
  triggerRegion: v.union(v.string(), v.null()),
  directory: v.string(),
  state,
  grantExpiresAt: v.union(v.number(), v.null()),
  controlledSessionName: v.union(v.string(), v.null()),
  expiresAt: v.number(),
  updatedAt: v.number(),
});
const serviceSessionArgs = {
  serviceKey: v.string(),
  userId: v.string(),
  sessionId: v.string(),
};
const GRANT_MS = 30_000;
const CLAIM_MS = 15_000;

async function ownsActiveRun(
  ctx: QueryCtx | MutationCtx,
  row: Doc<"browser_handoffs">,
): Promise<boolean> {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", row.chat_id))
    .first();
  if (!chat || chat.user_id !== row.user_id || chat.deletion_started_at)
    return false;
  if (row.agent_id === "parent") {
    return chat.active_trigger_run_id === row.run_id;
  }
  const child = await ctx.db
    .query("subagent_runs")
    .withIndex("by_subagent_id", (q) => q.eq("subagent_id", row.agent_id))
    .first();
  return (
    child?.user_id === row.user_id &&
    child.chat_id === row.chat_id &&
    child.trigger_run_id === row.run_id &&
    child.status === "running"
  );
}

async function currentOwner(
  ctx: QueryCtx | MutationCtx,
  row: Doc<"browser_handoffs">,
): Promise<boolean> {
  if (row.state === "closed" || row.expires_at <= Date.now()) return false;
  return ownsActiveRun(ctx, row);
}

async function getSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: string,
  userId: string,
  allowEnded = false,
): Promise<Doc<"browser_handoffs"> | null> {
  const row = await ctx.db
    .query("browser_handoffs")
    .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
    .first();
  if (!row || row.user_id !== userId) return null;
  if (allowEnded) {
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", row.chat_id))
      .first();
    if (!chat || chat.user_id !== userId || chat.deletion_started_at)
      return null;
  } else if (!(await currentOwner(ctx, row))) return null;
  // A recovered workspace can register a replacement session in the same
  // run. Older grants must not remain usable even after many replacements.
  const latest = await ctx.db
    .query("browser_handoffs")
    .withIndex("by_chat_and_agent", (q) =>
      q.eq("chat_id", row.chat_id).eq("agent_id", row.agent_id),
    )
    .order("desc")
    .first();
  return latest?._id === row._id ? row : null;
}

function publicView(row: Doc<"browser_handoffs">) {
  return {
    sessionId: row.session_id,
    runId: row.run_id,
    agentId: row.agent_id,
    state:
      ((row.state === "human" || row.state === "claiming") &&
        (row.grant_expires_at ?? 0) <= Date.now()) ||
      (row.state === "resuming" && row.updated_at + 30_000 <= Date.now())
        ? ("recovery" as const)
        : row.state,
    grantExpiresAt: row.grant_expires_at ?? null,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

/** Browser paths never enter the public reactive result. */
export const getForUser = query({
  args: { chatId: v.string(), agentId: v.string() },
  returns: v.union(publicSession, v.null()),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const row = await ctx.db
      .query("browser_handoffs")
      .withIndex("by_chat_and_agent", (q) =>
        q.eq("chat_id", args.chatId).eq("agent_id", args.agentId),
      )
      .order("desc")
      .first();
    if (
      !row ||
      row.user_id !== identity.subject ||
      !(await currentOwner(ctx, row))
    )
      return null;
    return publicView(row);
  },
});

/** Registration is accepted only for the exact running parent or child. */
export const registerForBackend = mutation({
  args: {
    serviceKey: v.string(),
    sessionId: v.string(),
    userId: v.string(),
    chatId: v.string(),
    runId: v.string(),
    agentId: v.string(),
    sandboxId: v.string(),
    triggerRegion: v.optional(v.string()),
    directory: v.string(),
    expiresAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (
      !/^\/dev\/shm\/hackerai-browser-[a-f0-9]{24}$/.test(args.directory) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(args.sandboxId) ||
      args.expiresAt <= Date.now() ||
      args.expiresAt > Date.now() + BROWSER_SESSION_MAX_LIFETIME_MS
    )
      return false;
    const probe = {
      session_id: args.sessionId,
      user_id: args.userId,
      chat_id: args.chatId,
      run_id: args.runId,
      agent_id: args.agentId,
      state: "agent" as const,
      expires_at: args.expiresAt,
    } as Doc<"browser_handoffs">;
    if (!(await currentOwner(ctx, probe))) return false;
    const existing = await ctx.db
      .query("browser_handoffs")
      .withIndex("by_chat_and_agent", (q) =>
        q.eq("chat_id", args.chatId).eq("agent_id", args.agentId),
      )
      .order("desc")
      .take(8);
    // Resolve retries before mutating newer rows, including sessions older than
    // the bounded replacement window. A retired session must never reclaim it.
    const match = await ctx.db
      .query("browser_handoffs")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (match)
      return (
        match._id === existing[0]?._id &&
        match.user_id === args.userId &&
        match.run_id === args.runId &&
        match.state !== "closed"
      );
    for (const row of existing) {
      if (row.state !== "closed") {
        await ctx.db.patch(row._id, {
          state: "closed",
          grant: undefined,
          grant_expires_at: undefined,
          updated_at: Date.now(),
        });
      }
    }
    await ctx.db.insert("browser_handoffs", {
      session_id: args.sessionId,
      user_id: args.userId,
      chat_id: args.chatId,
      run_id: args.runId,
      agent_id: args.agentId,
      sandbox_id: args.sandboxId,
      trigger_region: args.triggerRegion,
      directory: args.directory,
      state: "agent",
      expires_at: args.expiresAt,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const getForBackend = query({
  args: { ...serviceSessionArgs, allowEnded: v.optional(v.boolean()) },
  returns: v.union(privateSession, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(
      ctx,
      args.sessionId,
      args.userId,
      args.allowEnded,
    );
    if (!row) return null;
    return {
      runActive: await currentOwner(ctx, row),
      sessionId: row.session_id,
      userId: row.user_id,
      chatId: row.chat_id,
      runId: row.run_id,
      agentId: row.agent_id,
      sandboxId: row.sandbox_id,
      triggerRegion: row.trigger_region ?? null,
      directory: row.directory,
      state: publicView(row).state,
      grantExpiresAt: row.grant_expires_at ?? null,
      controlledSessionName: row.controlled_session_name ?? null,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    };
  },
});

/** Park the Agent before takeover without keeping a shell command running. */
export const requestWaitForBackend = mutation({
  args: {
    ...serviceSessionArgs,
    expectedUpdatedAt: v.number(),
    requestAnotherTakeover: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (!row) return false;
    if (row.state === "waiting") return true;
    // A takeover or completed resume that won the race must not be overwritten.
    if (row.state !== "agent" || row.updated_at !== args.expectedUpdatedAt)
      return false;
    // The user can finish takeover before the model calls its first wait tool.
    // Treat that request as already fulfilled instead of silently parking again.
    if (row.exit_note_ids?.length && !args.requestAnotherTakeover) return true;
    await ctx.db.patch(row._id, {
      state: "waiting",
      waiting_for_handoff: true,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const beginTakeoverForBackend = mutation({
  args: { ...serviceSessionArgs, grant: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (
      !row ||
      args.grant.length < 32 ||
      (row.input_expires_at ?? 0) > Date.now() ||
      (!["agent", "waiting", "recovery"].includes(row.state) &&
        !(row.state === "resuming" && row.updated_at + 30_000 <= Date.now()) &&
        !(
          ["human", "claiming"].includes(row.state) &&
          (row.grant_expires_at ?? 0) <= Date.now()
        ))
    )
      return false;
    await ctx.db.patch(row._id, {
      state: "claiming",
      grant: args.grant,
      grant_expires_at: Date.now() + CLAIM_MS,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const finishTakeoverForBackend = mutation({
  args: {
    ...serviceSessionArgs,
    grant: v.string(),
    browserSessionName: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (
      !row ||
      row.state !== "claiming" ||
      row.grant !== args.grant ||
      (row.grant_expires_at ?? 0) <= Date.now() ||
      !/^[^/\u0000]{1,80}$/.test(args.browserSessionName)
    )
      return false;
    await ctx.db.patch(row._id, {
      state: "human",
      controlled_session_name: args.browserSessionName,
      grant_expires_at: Date.now() + GRANT_MS,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const abortTakeoverForBackend = mutation({
  args: { ...serviceSessionArgs, grant: v.string(), paused: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (row?.state === "claiming" && row.grant === args.grant) {
      await ctx.db.patch(row._id, {
        state: args.paused
          ? "recovery"
          : row.waiting_for_handoff
            ? "waiting"
            : "agent",
        grant: undefined,
        grant_expires_at: undefined,
        controlled_session_name: undefined,
        updated_at: Date.now(),
      });
    }
    return null;
  },
});

export const assertGrantForBackend = mutation({
  args: { ...serviceSessionArgs, grant: v.string(), renew: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (
      !row ||
      row.state !== "human" ||
      row.grant !== args.grant ||
      (row.grant_expires_at ?? 0) <= Date.now()
    )
      return false;
    if (args.renew) {
      await ctx.db.patch(row._id, {
        grant_expires_at: Date.now() + GRANT_MS,
        updated_at: Date.now(),
      });
    }
    return true;
  },
});

export const beginInputForBackend = mutation({
  args: { ...serviceSessionArgs, grant: v.string(), inputId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (
      !row ||
      row.state !== "human" ||
      row.grant !== args.grant ||
      (row.grant_expires_at ?? 0) <= Date.now() ||
      (row.input_expires_at ?? 0) > Date.now() ||
      args.inputId.length < 16
    )
      return false;
    await ctx.db.patch(row._id, {
      input_id: args.inputId,
      input_expires_at: Date.now() + 30_000,
      grant_expires_at: Date.now() + GRANT_MS,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const finishInputForBackend = mutation({
  args: { ...serviceSessionArgs, inputId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (row?.input_id === args.inputId) {
      await ctx.db.patch(row._id, {
        input_id: undefined,
        input_expires_at: undefined,
        updated_at: Date.now(),
      });
    }
    return null;
  },
});

export const releaseForBackend = mutation({
  args: { ...serviceSessionArgs, grant: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (!row || row.state !== "human" || row.grant !== args.grant) return false;
    await ctx.db.patch(row._id, {
      state: "recovery",
      grant: undefined,
      grant_expires_at: undefined,
      controlled_session_name: undefined,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const beginResumeForBackend = mutation({
  args: { ...serviceSessionArgs, grant: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (
      !row ||
      (!["human", "recovery", "claiming"].includes(row.state) &&
        !(row.state === "resuming" && row.updated_at + 30_000 <= Date.now())) ||
      (row.input_expires_at ?? 0) > Date.now()
    )
      return false;
    if (
      row.state === "human" &&
      (row.grant_expires_at ?? 0) > Date.now() &&
      row.grant !== args.grant
    )
      return false;
    if (row.state === "claiming" && (row.grant_expires_at ?? 0) > Date.now())
      return false;
    await ctx.db.patch(row._id, {
      state: "resuming",
      grant: undefined,
      grant_expires_at: undefined,
      controlled_session_name: undefined,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const finishResumeForBackend = mutation({
  args: serviceSessionArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (!row || row.state !== "resuming") return false;
    await ctx.db.patch(row._id, {
      state: "agent",
      waiting_for_handoff: undefined,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const abortResumeForBackend = mutation({
  args: serviceSessionArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (row?.state === "resuming") {
      await ctx.db.patch(row._id, {
        state: "recovery",
        updated_at: Date.now(),
      });
    }
    return null;
  },
});

export const markExposedForBackend = mutation({
  args: serviceSessionArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (!row || row.exposed_at) return false;
    await ctx.db.patch(row._id, { exposed_at: Date.now() });
    return true;
  },
});

export const closeForBackend = mutation({
  args: { serviceKey: v.string(), sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("browser_handoffs")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (row) {
      await ctx.db.patch(row._id, {
        state: "closed",
        grant: undefined,
        grant_expires_at: undefined,
        controlled_session_name: undefined,
        updated_at: Date.now(),
      });
    }
    return null;
  },
});

/** Save private Agent context atomically, including after run cleanup. */
export const saveExitNoteForBackend = mutation({
  args: { ...serviceSessionArgs, requestId: v.string(), note: v.string() },
  returns: v.object({
    id: v.string(),
    text: v.string(),
    runActive: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!/^[a-f0-9-]{36}$/.test(args.requestId) || args.note.length > 4000)
      throw new Error("Invalid handoff note");
    const row = await getSession(ctx, args.sessionId, args.userId, true);
    if (!row) throw new Error("Browser session unavailable");
    const runActive = await currentOwner(ctx, row);
    const id = `browser-handoff-${row.session_id}-${args.requestId}`;
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("id", id))
      .first();
    if (existing) {
      if (existing.user_id !== args.userId || existing.chat_id !== row.chat_id)
        throw new Error("Invalid handoff message");
      await ctx.db.patch(existing._id, {
        is_hidden: true,
        is_browser_handoff: true,
      });
      return { id, text: "Continue after browser takeover.", runActive };
    }
    if (runActive && row.state !== "resuming")
      throw new Error("Exit takeover must claim resume first");
    const note = args.note.trim();
    const text = note
      ? `I've finished browser takeover.\n\n${note}`
      : "I've finished browser takeover. No additional details to add; please continue the task.";
    await ctx.db.insert("messages", {
      id,
      chat_id: row.chat_id,
      user_id: args.userId,
      role: "user",
      parts: [{ type: "text", text }],
      content: text,
      mode: "agent",
      trigger_run_id: row.run_id,
      is_hidden: true,
      is_browser_handoff: true,
      update_time: Date.now(),
    });
    await ctx.db.patch(row._id, {
      exit_note_ids: [...(row.exit_note_ids ?? []), id].slice(-32),
    });
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", row.chat_id))
      .first();
    if (chat) await ctx.db.patch(chat._id, { update_time: Date.now() });
    // The browser only needs a continuation signal, never the saved note.
    return { id, text: "Continue after browser takeover.", runActive };
  },
});

/** The owning runner re-reads saved notes at model boundaries; no destructive consumption. */
export const getExitNotesForBackend = query({
  args: serviceSessionArgs,
  returns: v.array(v.object({ id: v.string(), text: v.string() })),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    // Browser replacement revokes control, but saved instructions still belong
    // to this run. Do not apply the latest-browser/grant checks to context reads.
    const row = await ctx.db
      .query("browser_handoffs")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (!row || row.user_id !== args.userId || !(await ownsActiveRun(ctx, row)))
      return [];
    const messages = await Promise.all(
      (row.exit_note_ids ?? []).map((id) =>
        ctx.db
          .query("messages")
          .withIndex("by_message_id", (q) => q.eq("id", id))
          .first(),
      ),
    );
    return messages.flatMap((message) =>
      message?.user_id === row.user_id &&
      message.chat_id === row.chat_id &&
      message.content
        ? [{ id: message.id, text: message.content }]
        : [],
    );
  },
});
