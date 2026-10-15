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
});
const serviceSessionArgs = {
  serviceKey: v.string(),
  userId: v.string(),
  sessionId: v.string(),
};
const GRANT_MS = 30_000;
const CLAIM_MS = 15_000;

async function currentOwner(
  ctx: QueryCtx | MutationCtx,
  row: Doc<"browser_handoffs">,
): Promise<boolean> {
  if (row.state === "closed" || row.expires_at <= Date.now()) return false;
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", row.chat_id))
    .first();
  if (!chat || chat.user_id !== row.user_id) return false;
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

async function getSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: string,
  userId: string,
): Promise<Doc<"browser_handoffs"> | null> {
  const row = await ctx.db
    .query("browser_handoffs")
    .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
    .first();
  if (row?.user_id !== userId || !(await currentOwner(ctx, row))) return null;
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
      args.expiresAt > Date.now() + 4.1 * 60 * 60 * 1000
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
    for (const row of existing) {
      if (row.session_id === args.sessionId) return row.state !== "closed";
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
  args: serviceSessionArgs,
  returns: v.union(privateSession, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getSession(ctx, args.sessionId, args.userId);
    if (!row) return null;
    return {
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
    };
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
      (!["agent", "recovery"].includes(row.state) &&
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
        state: args.paused ? "recovery" : "agent",
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
    await ctx.db.patch(row._id, { state: "agent", updated_at: Date.now() });
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
