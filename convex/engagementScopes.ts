import { v, ConvexError } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { scopePolicy, scopeSnapshot } from "./engagementScopeValidators";
import {
  normalizePolicy,
  MAX_SCOPE_TEXT,
  type ScopeSnapshot,
} from "../lib/engagement-scope/policy";

async function ownedChat(
  ctx: QueryCtx | MutationCtx,
  chatId: string,
  userId: string,
) {
  await assertUserCanAccessChatHistory(ctx, userId);
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .unique();
  if (!chat || chat.user_id !== userId || chat.deletion_started_at)
    throw new ConvexError("Chat unavailable");
  return chat;
}
async function rowForChat(ctx: QueryCtx | MutationCtx, chatId: string) {
  return ctx.db
    .query("engagement_scopes")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", chatId))
    .unique();
}
function snapshot(
  row: NonNullable<Awaited<ReturnType<typeof rowForChat>>>,
): ScopeSnapshot | null {
  if (!row.active && row.status === "ready") return null;
  const {
    rules,
    restrictions,
    revision,
    status,
    clarification,
    clarificationRequested,
  } = row;
  return {
    rules,
    restrictions,
    revision,
    status,
    clarification,
    clarificationRequested,
  };
}
async function read(ctx: QueryCtx, chatId: string, userId: string) {
  const chat = await ownedChat(ctx, chatId, userId);
  const row = await rowForChat(ctx, chatId);
  if (!row && chat.engagement_scope_expected)
    throw new ConvexError("Expected scope is unavailable");
  return row ? snapshot(row) : null;
}
export const get = query({
  args: { chatId: v.string() },
  returns: v.union(v.null(), scopeSnapshot),
  handler: async (ctx, { chatId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    return read(ctx, chatId, identity.subject);
  },
});
export const getForBackend = query({
  args: { serviceKey: v.string(), chatId: v.string(), userId: v.string() },
  returns: v.union(v.null(), scopeSnapshot),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    return read(ctx, args.chatId, args.userId);
  },
});

/** Called only by authenticated request admission, never by an agent tool. */
export const beginUserMessage = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    messageId: v.string(),
  },
  returns: v.object({
    complete: v.boolean(),
    revision: v.number(),
    sourceText: v.string(),
    current: v.union(v.null(), scopeSnapshot),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await ownedChat(ctx, args.chatId, args.userId);
    const message = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("id", args.messageId))
      .unique();
    if (
      !message ||
      message.chat_id !== args.chatId ||
      message.user_id !== args.userId ||
      message.role !== "user" ||
      message.is_hidden ||
      message.source_message_id
    )
      throw new ConvexError("Scope requires a genuine user message");
    const text = message.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    const row = await rowForChat(ctx, args.chatId);
    if (!row && chat.engagement_scope_expected)
      throw new ConvexError("Expected scope is unavailable");
    const event = await ctx.db
      .query("engagement_scope_events")
      .withIndex("by_chat_source", (q) =>
        q.eq("chat_id", args.chatId).eq("source_id", args.messageId),
      )
      .unique();
    if (event) {
      if (event.source_text !== text.slice(0, MAX_SCOPE_TEXT + 1))
        throw new ConvexError(
          "An already processed scope source was edited; send a new instruction",
        );
      return {
        complete:
          event.status === "applied" || row?.source_id !== args.messageId,
        revision: row?.revision ?? 0,
        sourceText: text,
        current: row ? snapshot(row) : null,
      };
    }
    if (row && (row.status === "processing" || row.status === "unavailable")) {
      throw new ConvexError(
        "The previous scope update is pending. Retry that request or edit the saved scope.",
      );
    }
    const revision = (row?.revision ?? 0) + 1;
    const change = {
      revision,
      status: "processing" as const,
      source_id: args.messageId,
    };
    if (row) await ctx.db.patch(row._id, change);
    else {
      await ctx.db.insert("engagement_scopes", {
        chat_id: args.chatId,
        user_id: args.userId,
        active: !!chat.branched_from_chat_id,
        rules: [],
        restrictions: [],
        clarification: chat.branched_from_chat_id
          ? "This branched task has no saved scope. Specify its targets or edit scope before active testing."
          : "",
        clarificationRequested: false,
        ...change,
      });
      await ctx.db.patch(chat._id, { engagement_scope_expected: true });
    }
    await ctx.db.insert("engagement_scope_events", {
      chat_id: args.chatId,
      source_id: args.messageId,
      source_text: text.slice(0, MAX_SCOPE_TEXT + 1),
      source_kind: "user_message",
      status: "pending",
      revision,
    });
    return {
      complete: false,
      revision,
      sourceText: text.slice(0, MAX_SCOPE_TEXT + 1),
      current: row
        ? snapshot(row)
        : snapshot((await rowForChat(ctx, args.chatId))!),
    };
  },
});

export const commitUserMessage = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    messageId: v.string(),
    expectedRevision: v.number(),
    policy: scopePolicy,
    clarification: v.string(),
    unavailable: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await ownedChat(ctx, args.chatId, args.userId);
    const row = await rowForChat(ctx, args.chatId);
    if (
      !row ||
      row.revision !== args.expectedRevision ||
      row.source_id !== args.messageId
    )
      return false;
    const event = await ctx.db
      .query("engagement_scope_events")
      .withIndex("by_chat_source", (q) =>
        q.eq("chat_id", args.chatId).eq("source_id", args.messageId),
      )
      .unique();
    if (!event || event.status === "applied") return false;
    const message = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("id", args.messageId))
      .unique();
    const sourceText = message?.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    if (
      !message ||
      message.role !== "user" ||
      message.is_hidden ||
      message.source_message_id ||
      message.chat_id !== args.chatId ||
      message.user_id !== args.userId ||
      sourceText?.slice(0, MAX_SCOPE_TEXT + 1) !== event.source_text
    )
      throw new ConvexError("Scope source changed");
    const policy = normalizePolicy(args.policy);
    if (args.clarification.length > 1000)
      throw new ConvexError("Scope clarification too long");
    // Extraction failures never replace the last valid policy.
    const next = args.unavailable
      ? { rules: row.rules, restrictions: row.restrictions }
      : policy;
    await ctx.db.patch(row._id, {
      ...next,
      active:
        row.active ||
        next.rules.length > 0 ||
        next.restrictions.length > 0 ||
        !!args.clarification,
      status: args.unavailable
        ? "unavailable"
        : args.clarification
          ? "ambiguous"
          : "ready",
      clarification: args.clarification,
      clarificationRequested:
        args.clarification === row.clarification && row.clarificationRequested,
      revision: row.revision + 1,
    });
    await ctx.db.patch(event._id, {
      status: args.unavailable ? "pending" : "applied",
      revision: row.revision + 1,
      policy: next,
    });
    return true;
  },
});

export const claimClarification = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    revision: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await ownedChat(ctx, args.chatId, args.userId);
    const row = await rowForChat(ctx, args.chatId);
    if (
      !row ||
      row.revision !== args.revision ||
      row.status !== "ambiguous" ||
      row.clarificationRequested
    )
      return false;
    await ctx.db.patch(row._id, { clarificationRequested: true });
    return true;
  },
});

export const edit = mutation({
  args: {
    chatId: v.string(),
    expectedRevision: v.number(),
    policy: scopePolicy,
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ownedChat(ctx, args.chatId, identity.subject);
    const row = await rowForChat(ctx, args.chatId);
    if (!row || row.revision !== args.expectedRevision)
      throw new ConvexError("Scope changed. Reopen it before saving.");
    const policy = normalizePolicy(args.policy);
    const revision = row.revision + 1;
    await ctx.db.patch(row._id, {
      ...policy,
      active: true,
      revision,
      status: "ready",
      clarification: "",
      clarificationRequested: false,
      source_id: `edit:${revision}`,
    });
    await ctx.db.insert("engagement_scope_events", {
      chat_id: args.chatId,
      source_id: `edit:${revision}`,
      source_text: "",
      source_kind: "user_edit",
      status: "applied",
      revision,
      policy,
    });
    return revision;
  },
});

/** A copied transcript never grants authority, even if regenerated before a new user turn. */
export async function initializeBranchedScope(
  ctx: MutationCtx,
  chatId: string,
  userId: string,
) {
  await ctx.db.insert("engagement_scopes", {
    chat_id: chatId,
    user_id: userId,
    active: true,
    revision: 0,
    status: "ambiguous",
    rules: [],
    restrictions: [],
    clarification:
      "This branched task has no saved scope. Specify its targets or edit scope before active testing.",
    clarificationRequested: false,
    source_id: "branch",
  });
}

export async function deleteScopeBatch(
  ctx: MutationCtx,
  chatId: string,
): Promise<boolean> {
  const events = await ctx.db
    .query("engagement_scope_events")
    .withIndex("by_chat_source", (q) => q.eq("chat_id", chatId))
    .take(100);
  for (const event of events) await ctx.db.delete(event._id);
  if (events.length === 100) return true;
  const row = await rowForChat(ctx, chatId);
  if (row) await ctx.db.delete(row._id);
  return false;
}
