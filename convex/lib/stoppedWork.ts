import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type QueryCtx,
  type MutationCtx,
} from "./serviceFunctions";
import { validateServiceKey } from "./utils";
import { isUserDeletionFenced } from "./userDeletionFence";
import type { Doc } from "../_generated/dataModel";

export const stoppedWorkDirectiveValidator = v.object({
  id: v.string(),
  instruction: v.string(),
  sourceMessageId: v.string(),
  sourceText: v.string(),
  quote: v.string(),
  taskIds: v.array(v.string()),
  createdAt: v.number(),
  reopenedBy: v.optional(
    v.object({
      messageId: v.string(),
      sourceText: v.string(),
      quote: v.string(),
    }),
  ),
});
export const stoppedWorkSourceValidator = v.object({
  messageId: v.string(),
  text: v.string(),
  processed: v.boolean(),
});
const ownerArgs = {
  serviceKey: v.string(),
  userId: v.string(),
  chatId: v.string(),
};
async function ownedChat(
  ctx: QueryCtx | MutationCtx,
  args: { userId: string; chatId: string },
) {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
    .first();
  if (
    !chat ||
    chat.user_id !== args.userId ||
    chat.deletion_started_at !== undefined ||
    (await isUserDeletionFenced(ctx.db, args.userId))
  )
    throw new ConvexError("Stopped-work chat unavailable");
  return chat;
}
export function assertStoppedWorkAdmission(
  chat: Doc<"chats">,
  revision?: number,
  taskId?: string,
) {
  if (chat.agent_work_source && !chat.agent_work_source.processed)
    throw new ConvexError("User instructions are awaiting stopped-work review");
  const active = (chat.agent_work_directives ?? []).filter(
    (d) => !d.reopenedBy,
  );
  if (active.length && revision !== (chat.agent_work_revision ?? 0))
    throw new ConvexError(
      "Stopped-work policy changed; review the operation again",
    );
  if (taskId && active.some((d) => d.taskIds.includes(taskId)))
    throw new ConvexError("This task was explicitly stopped by the user");
}
export async function registerStoppedWorkSource(
  ctx: MutationCtx,
  args: {
    serviceKey: string;
    userId: string;
    chatId: string;
    messageId: string;
  },
) {
  validateServiceKey(args.serviceKey);
  const chat = await ownedChat(ctx, args);
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
    .order("desc")
    .take(100);
  const source = messages.find((m) => m.role === "user" && !m.is_hidden);
  if (
    !source ||
    source.id !== args.messageId ||
    source.user_id !== args.userId ||
    source.source_message_id
  )
    throw new ConvexError("Invalid user instruction source");
  const text = source.parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
  if (text.length > 24_000)
    throw new ConvexError(
      "User instruction is too long for stopped-work review; split the message",
    );
  if (
    chat.agent_work_source?.messageId === source.id &&
    chat.agent_work_source.text === text
  )
    return null;
  if (chat.agent_work_source && !chat.agent_work_source.processed) {
    throw new ConvexError(
      "Previous user instructions await stopped-work review. Retry the previous turn before submitting another instruction.",
    );
  }
  await ctx.db.patch(chat._id, {
    agent_work_source: { messageId: source.id, text, processed: false },
    agent_work_revision: (chat.agent_work_revision ?? 0) + 1,
  });
  return null;
}
export const getStoppedWorkForBackend = query({
  args: ownerArgs,
  returns: v.object({
    revision: v.number(),
    directives: v.array(stoppedWorkDirectiveValidator),
    source: v.optional(stoppedWorkSourceValidator),
    tasks: v.array(
      v.object({
        id: v.string(),
        name: v.optional(v.string()),
        objective: v.string(),
        status: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await ownedChat(ctx, args);
    // Capture is bounded; only exact returned IDs may be selected by the extractor.
    const tasks =
      chat.agent_work_source && !chat.agent_work_source.processed
        ? await ctx.db
            .query("subagent_runs")
            .withIndex("by_user_and_chat", (q) =>
              q.eq("user_id", args.userId).eq("chat_id", args.chatId),
            )
            .order("desc")
            .take(100)
        : [];
    return {
      revision: chat.agent_work_revision ?? 0,
      directives: chat.agent_work_directives ?? [],
      source: chat.agent_work_source,
      tasks: tasks.map((t) => ({
        id: t.subagent_id,
        name: t.name,
        objective: t.objective.slice(0, 2000),
        status: t.status,
      })),
    };
  },
});
export const applyStoppedWorkForBackend = mutation({
  args: {
    ...ownerArgs,
    expectedRevision: v.number(),
    sourceMessageId: v.string(),
    sourceText: v.string(),
    changes: v.array(
      v.object({
        action: v.union(v.literal("stop"), v.literal("reopen")),
        directiveId: v.optional(v.string()),
        instruction: v.string(),
        quote: v.string(),
        taskIds: v.array(v.string()),
      }),
    ),
  },
  returns: v.object({
    revision: v.number(),
    triggerRunIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await ownedChat(ctx, args);
    const source = chat.agent_work_source;
    if (
      source?.processed &&
      source.messageId === args.sourceMessageId &&
      source.text === args.sourceText &&
      chat.agent_work_revision === args.expectedRevision + 1
    ) {
      return { revision: chat.agent_work_revision, triggerRunIds: [] };
    }
    if (
      !source ||
      source.processed ||
      source.messageId !== args.sourceMessageId ||
      source.text !== args.sourceText ||
      (chat.agent_work_revision ?? 0) !== args.expectedRevision
    )
      throw new ConvexError("Stale stopped-work source or revision");
    if (args.changes.length > 8)
      throw new ConvexError("Too many stopped-work changes");
    const directives = [...(chat.agent_work_directives ?? [])];
    const triggerRunIds: string[] = [];
    for (const [index, change] of args.changes.entries()) {
      if (
        !change.quote.trim() ||
        change.quote.length > 2000 ||
        !source.text.includes(change.quote) ||
        !change.instruction.trim() ||
        change.instruction.length > 2000 ||
        change.taskIds.length > 100
      )
        throw new ConvexError("Invalid stopped-work evidence");
      if (change.action === "reopen") {
        const directive = directives.find((d) => d.id === change.directiveId);
        if (
          !directive ||
          directive.reopenedBy ||
          directive.sourceMessageId === source.messageId
        )
          throw new ConvexError("Invalid stopped-work reopening");
        directive.reopenedBy = {
          messageId: source.messageId,
          sourceText: source.text,
          quote: change.quote,
        };
        continue;
      }
      if (directives.length >= 32)
        throw new ConvexError(
          "Stopped-work history is full; no constraints were discarded",
        );
      const id = `${source.messageId}:${args.expectedRevision}:${index}`;
      for (const taskId of new Set(change.taskIds)) {
        const task = await ctx.db
          .query("subagent_runs")
          .withIndex("by_subagent_id", (q) => q.eq("subagent_id", taskId))
          .first();
        if (
          !task ||
          task.user_id !== args.userId ||
          task.chat_id !== args.chatId
        )
          throw new ConvexError("Invalid stopped-work task owner");
        if (["queued", "running", "finalizing"].includes(task.status)) {
          await ctx.db.patch(task._id, {
            status: "canceled",
            cancel_reason: "user_stopped_work",
            completed_at: Date.now(),
            updated_at: Date.now(),
          });
          if (task.trigger_run_id) triggerRunIds.push(task.trigger_run_id);
        }
      }
      directives.push({
        id,
        instruction: change.instruction,
        quote: change.quote,
        sourceMessageId: source.messageId,
        sourceText: source.text,
        taskIds: [...new Set(change.taskIds)],
        createdAt: Date.now(),
      });
    }
    if (JSON.stringify(directives).length > 128_000)
      throw new ConvexError(
        "Stopped-work history is full; no constraints were discarded",
      );
    const revision = args.expectedRevision + 1;
    await ctx.db.patch(chat._id, {
      agent_work_directives: directives,
      agent_work_revision: revision,
      agent_work_source: { ...source, processed: true },
    });
    return { revision, triggerRunIds };
  },
});
