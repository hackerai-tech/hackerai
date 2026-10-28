import { goalTimingForState } from "../lib/goals/timing";
import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, mutation } from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import {
  goalDoc,
  goalCheckpoint,
  goalContractFields,
  goalJudgment,
} from "./lib/goalValidators";
import {
  isGoalEvidencePart,
  mergeGoalEvidence,
  serializeGoalEvidence,
  resolveGoalOutcome,
  validGoalStart,
  verificationGatePassed,
} from "../lib/goals/contracts";
import type { MutationCtx, QueryCtx } from "./lib/serviceFunctions";

async function owned(
  ctx: QueryCtx | MutationCtx,
  chatId: string,
  userId: string,
) {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .unique();
  if (!chat || chat.user_id !== userId || chat.deletion_started_at)
    throw new ConvexError("Goal chat unavailable");
  await assertUserCanAccessChatHistory(ctx, userId);
  return chat;
}
async function byChat(ctx: QueryCtx | MutationCtx, chatId: string) {
  return ctx.db
    .query("agent_goals")
    .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
    .unique();
}
export const get = query({
  args: { chatId: v.string() },
  returns: v.union(goalDoc, v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return null;
    try {
      await owned(ctx, args.chatId, user.subject);
    } catch (error) {
      if (error instanceof ConvexError) return null;
      throw error;
    }
    const goal = await byChat(ctx, args.chatId);
    return goal?.deletedAt ? null : goal;
  },
});
export const getForBackend = query({
  args: { serviceKey: v.string(), chatId: v.string(), userId: v.string() },
  returns: v.union(goalDoc, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await owned(ctx, args.chatId, args.userId);
    const goal = await byChat(ctx, args.chatId);
    return goal;
  },
});
export const start = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    ...goalContractFields,
    expectedGeneration: v.optional(v.number()),
    objective: v.string(),
    criteria: v.array(v.string()),
    // Accept older clients during rollout; run counts no longer limit goals.
    maxRuns: v.optional(v.number()),
    sandboxPreference: v.string(),
    permissionMode: v.string(),
    selectedModel: v.string(),
  },
  returns: goalDoc,
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!validGoalStart(args)) throw new ConvexError("Invalid goal");
    const chat = await owned(ctx, args.chatId, args.userId);
    const previous = await byChat(ctx, args.chatId);
    if (
      chat.active_trigger_run_id ||
      chat.active_stream_id ||
      previous?.activeRunId ||
      (previous &&
        ["queued", "running", "waiting", "needs_approval"].includes(
          previous.state,
        ))
    )
      throw new ConvexError("Pause or stop the active run first");
    if (
      args.expectedGeneration !== undefined &&
      (!previous ||
        previous.deletedAt ||
        previous.generation !== args.expectedGeneration)
    )
      throw new ConvexError(
        "The goal changed. Reopen it before sending your edit.",
      );
    const fields = {
      verificationCommand: args.verificationCommand?.trim(),
      constraints: args.constraints?.trim(),
      boundaries: args.boundaries?.trim(),
      stopWhen: args.stopWhen?.trim(),
      sandboxPreference: args.sandboxPreference,
      permissionMode: args.permissionMode,
      selectedModel: args.selectedModel,
      chatId: args.chatId,
      userId: args.userId,
      objective: args.objective.trim(),
      criteria: args.criteria.map((c) => c.trim()),
      runs: 0,
      generation: (previous?.generation ?? 0) + 1,
      state: "queued" as const,
      progress: "",
      reason: "Goal started",
      startedAt: Date.now(),
      elapsedMs: 0,
      activeSince: Date.now(),
      noProgressRuns: 0,
      evidence: [],
      updatedAt: Date.now(),
    };
    const id = previous?._id ?? (await ctx.db.insert("agent_goals", fields));
    if (previous) await ctx.db.replace(id, fields);
    return (await ctx.db.get(id))!;
  },
});
// Composer Stop targets a specific run. Pause only its goal, so a delayed
// cancellation cannot pause a replacement run or revive a removed goal.
export const pauseForCanceledRun = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    runId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await owned(ctx, args.chatId, args.userId);
    if (chat.active_trigger_run_id !== args.runId) return null;
    const goal = await byChat(ctx, args.chatId);
    if (
      !goal ||
      goal.deletedAt ||
      (goal.activeRunId && goal.activeRunId !== args.runId) ||
      !["queued", "running", "waiting", "needs_approval"].includes(goal.state)
    )
      return null;
    await ctx.db.patch(goal._id, {
      ...goalTimingForState(goal, "paused", Date.now()),
      state: "paused",
      dispatchId: undefined,
      continuationSourceRunId: undefined,
      waitUntil: undefined,
      reason: "Paused by user",
      updatedAt: Date.now(),
    });
    await ctx.db.patch(chat._id, { canceled_at: Date.now() });
    return null;
  },
});
export const control = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    action: v.union(
      v.literal("pause"),
      v.literal("stop"),
      v.literal("clear"),
      v.literal("resume"),
    ),
    additionalRuns: v.optional(v.number()),
    generation: v.optional(v.number()),
  },
  returns: goalDoc,
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await owned(ctx, args.chatId, args.userId);
    const goal = await byChat(ctx, args.chatId);
    if (!goal) throw new ConvexError("No goal in this chat");
    if (args.generation !== undefined && args.generation !== goal.generation)
      throw new ConvexError("Goal changed. Reload before changing it.");
    if (args.action === "resume") {
      if (
        goal.deletedAt ||
        goal.activeRunId ||
        chat.active_trigger_run_id ||
        chat.active_stream_id ||
        ["queued", "running", "needs_approval", "achieved"].includes(goal.state)
      )
        throw new ConvexError(
          "Wait for the current run to settle before resuming",
        );
      await ctx.db.patch(goal._id, {
        ...goalTimingForState(goal, "queued", Date.now()),
        state: "queued",
        waitUntil: undefined,
        generation: goal.generation + 1,
        checkpoint: undefined,
        dispatchId: undefined,
        continuationSourceRunId: undefined,
        noProgressRuns: 0,
        reason: "Resumed by user",
        updatedAt: Date.now(),
      });
      await ctx.db.patch(chat._id, { canceled_at: undefined });
    } else {
      if (goal.state === "achieved" && args.action !== "clear") return goal;
      await ctx.db.patch(goal._id, {
        ...goalTimingForState(
          goal,
          args.action === "pause" ? "paused" : "canceled",
          Date.now(),
        ),
        state: args.action === "pause" ? "paused" : "canceled",
        deletedAt: args.action === "clear" ? Date.now() : goal.deletedAt,
        generation: goal.generation + (args.action === "clear" ? 1 : 0),
        dispatchId: undefined,
        continuationSourceRunId: undefined,
        waitUntil: undefined,
        reason: args.action === "pause" ? "Paused by user" : "Stopped by user",
        updatedAt: Date.now(),
      });
      if (goal.activeRunId)
        await ctx.db.patch(chat._id, { canceled_at: Date.now() });
    }
    return (await ctx.db.get(goal._id))!;
  },
});
// Editing fences the old run before cancellation. Its late checkpoint or judge
// cannot certify the updated objective, and editing never grants more runs.
export const update = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    generation: v.number(),
    objective: v.string(),
    criteria: v.array(v.string()),
    ...goalContractFields,
  },
  returns: goalDoc,
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await owned(ctx, args.chatId, args.userId);
    const goal = await byChat(ctx, args.chatId);
    if (!goal || goal.deletedAt || goal.state === "achieved")
      throw new ConvexError("This goal is no longer editable");
    if (goal.generation !== args.generation)
      throw new ConvexError("Goal changed. Reopen the editor before saving.");
    if (!validGoalStart(args))
      throw new ConvexError("Invalid goal objective or completion criteria");
    await ctx.db.patch(goal._id, {
      objective: args.objective.trim(),
      criteria: args.criteria.map((c) => c.trim()),
      verificationCommand: args.verificationCommand?.trim(),
      constraints: args.constraints?.trim(),
      boundaries: args.boundaries?.trim(),
      stopWhen: args.stopWhen?.trim(),
      ...goalTimingForState(goal, "paused", Date.now()),
      state: "paused",
      generation: goal.generation + 1,
      checkpoint: undefined,
      evidence: [],
      judgment: undefined,
      progress: "",
      noProgressRuns: 0,
      dispatchId: undefined,
      continuationSourceRunId: undefined,
      waitUntil: undefined,
      reason: "Goal updated. Resume when ready.",
      updatedAt: Date.now(),
    });
    if (goal.activeRunId)
      await ctx.db.patch(chat._id, { canceled_at: Date.now() });
    return (await ctx.db.get(goal._id))!;
  },
});

export const markMessage = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    messageId: v.string(),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await owned(ctx, args.chatId, args.userId);
    const goal = await byChat(ctx, args.chatId);
    const message = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("id", args.messageId))
      .unique();
    if (
      goal &&
      goal.generation === args.generation &&
      message?.chat_id === args.chatId &&
      message.role === "user"
    )
      await ctx.db.patch(message._id, { goal: { sent: true } });
    return null;
  },
});

// Only one dispatcher may launch a generation. Retrying its external call uses the same Trigger idempotency key.
export const claimDispatch = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    generation: v.number(),
    dispatchId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await owned(ctx, args.chatId, args.userId);
    const goal = await byChat(ctx, args.chatId);
    if (
      !goal ||
      goal.generation !== args.generation ||
      !["queued", "waiting"].includes(goal.state) ||
      (goal.waitUntil !== undefined && goal.waitUntil > Date.now()) ||
      goal.activeRunId ||
      chat.active_trigger_run_id ||
      chat.active_stream_id ||
      (goal.dispatchId && goal.dispatchId !== args.dispatchId)
    )
      return false;
    await ctx.db.patch(goal._id, {
      ...goalTimingForState(goal, goal.state, Date.now()),
      dispatchId: args.dispatchId,
      updatedAt: Date.now(),
    });
    return true;
  },
});
// Associate before returning the start response so Stop can target a worker
// that has not claimed its goal yet. Never reattach a finished or replaced run.
export const associateStartedRun = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    generation: v.number(),
    runId: v.string(),
    approvalSessionId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await owned(ctx, args.chatId, args.userId);
    const goal = await byChat(ctx, args.chatId);
    if (!goal || goal.deletedAt || goal.generation !== args.generation)
      return false;
    if (goal.activeRunId === args.runId)
      return chat.active_trigger_run_id === args.runId;
    if (goal.activeRunId || chat.active_trigger_run_id || chat.active_stream_id)
      return false;
    // A fast worker may have already completed before token creation finishes.
    if (
      [
        "achieved",
        "blocked",
        "budget_exhausted",
        "usage_exhausted",
        "needs_input",
        "failed",
      ].includes(goal.state)
    )
      return true;
    if (!["queued", "waiting"].includes(goal.state)) return false;
    await ctx.db.patch(chat._id, {
      active_trigger_run_id: args.runId,
      active_agent_approval_session_id: args.approvalSessionId,
      active_agent_approval_pending: undefined,
    });
    return true;
  },
});
export const claimRun = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    generation: v.number(),
    runId: v.string(),
    approvalSessionId: v.optional(v.string()),
  },
  returns: v.union(goalDoc, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await owned(ctx, args.chatId, args.userId);
    const goal = await byChat(ctx, args.chatId);
    if (
      !goal ||
      goal.generation !== args.generation ||
      !["queued", "waiting"].includes(goal.state) ||
      (goal.waitUntil !== undefined && goal.waitUntil > Date.now()) ||
      goal.activeRunId ||
      chat.active_stream_id ||
      (chat.active_trigger_run_id && chat.active_trigger_run_id !== args.runId)
    )
      return null;
    await ctx.db.patch(goal._id, {
      ...goalTimingForState(goal, "running", Date.now()),
      state: "running",
      activeRunId: args.runId,
      continuationSourceRunId: undefined,
      runs: goal.runs + 1,
      waitUntil: undefined,
      checkpoint: undefined,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(chat._id, {
      active_trigger_run_id: args.runId,
      active_agent_approval_session_id: args.approvalSessionId,
      active_agent_approval_pending: undefined,
      canceled_at: undefined,
    });
    return (await ctx.db.get(goal._id))!;
  },
});
export const checkpoint = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    runId: v.string(),
    checkpoint: goalCheckpoint,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await owned(ctx, args.chatId, args.userId);
    const goal = await byChat(ctx, args.chatId);
    if (
      !goal ||
      goal.activeRunId !== args.runId ||
      !["running", "needs_approval"].includes(goal.state)
    )
      return false;
    if (
      args.checkpoint.outcome === "wait" &&
      (!Number.isInteger(args.checkpoint.waitSeconds) ||
        Number(args.checkpoint.waitSeconds) < 1 ||
        Number(args.checkpoint.waitSeconds) > 1800)
    )
      throw new ConvexError("Wait must be between 1 and 1800 seconds");
    if (
      !args.checkpoint.progress.trim() ||
      args.checkpoint.progress.length > 4000 ||
      args.checkpoint.evidence.length > 8 ||
      args.checkpoint.evidence.some(
        (e) =>
          !Number.isInteger(e.criterion) ||
          e.criterion < 0 ||
          e.criterion >= goal.criteria.length ||
          e.runId !== args.runId ||
          !e.explanation.trim() ||
          e.explanation.length > 1000 ||
          e.toolCallId.length > 200,
      )
    )
      throw new ConvexError("Invalid goal checkpoint");
    await ctx.db.patch(goal._id, {
      checkpoint: args.checkpoint,
      progress: args.checkpoint.progress,
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const finish = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    runId: v.string(),
    finishReason: v.optional(v.string()),
    messageId: v.optional(v.string()),
    messageIds: v.optional(v.array(v.string())),
    canceled: v.boolean(),
    failed: v.boolean(),
    usageExhausted: v.boolean(),
    judgment: v.optional(goalJudgment),
  },
  returns: v.union(goalDoc, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const goal = await byChat(ctx, args.chatId);
    if (!goal || goal.userId !== args.userId || goal.activeRunId !== args.runId)
      return null;
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .unique();
    const message = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) =>
        q.eq("id", args.messageId ?? args.runId),
      )
      .unique();
    // A canceled or edited run may finish after the user acted. Settle its
    // lease without importing evidence or judgments from the old objective.
    if (["paused", "canceled"].includes(goal.state)) {
      await ctx.db.patch(goal._id, {
        ...goalTimingForState(goal, goal.state, Date.now()),
        activeRunId: undefined,
        dispatchId: undefined,
        continuationSourceRunId: undefined,
        updatedAt: Date.now(),
      });
      return (await ctx.db.get(goal._id))!;
    }
    // The service registers each assistant response created by this worker,
    // including provider retries. Keep proof ownership with the source message.
    const runMessages: Doc<"messages">[] = [];
    for (const id of new Set([
      args.runId,
      ...(args.messageIds ?? []).slice(0, 16),
      args.messageId ?? args.runId,
    ])) {
      const source =
        id === message?.id
          ? message
          : await ctx.db
              .query("messages")
              .withIndex("by_message_id", (q) => q.eq("id", id))
              .unique();
      if (source?.chat_id === args.chatId && source.role === "assistant")
        runMessages.push(source);
    }
    const verified = (goal.checkpoint?.evidence ?? []).flatMap((e) => {
      const source = runMessages.find((m) =>
        m.parts?.some((p) => isGoalEvidencePart(p, e.toolCallId)),
      );
      return source ? [{ ...e, messageId: source.id }] : [];
    });
    const evidence = mergeGoalEvidence(goal.evidence, verified);
    const progressed =
      verified.length > 0 ||
      runMessages.some((m) =>
        m.parts?.some((p) => {
          const id = (p as { toolCallId?: string }).toolCallId;
          return !!id && isGoalEvidencePart(p, id);
        }),
      );
    const noProgressRuns = progressed ? 0 : goal.noProgressRuns + 1;
    const state = ["paused", "canceled"].includes(goal.state)
      ? goal.state
      : !chat || chat.deletion_started_at
        ? "canceled"
        : resolveGoalOutcome({
            ...args,
            noProgressRuns,
            checkpoint: goal.checkpoint,
            allCriteriaVerified:
              verificationGatePassed(
                message?.parts ?? [],
                goal.verificationCommand,
              ) &&
              goal.criteria.every((_, i) =>
                evidence.some((e) => e.criterion === i),
              ),
          });
    const timing = goalTimingForState(goal, state, Date.now());
    await ctx.db.patch(goal._id, {
      ...timing,
      state,
      achievedAt: state === "achieved" ? Date.now() : undefined,
      activeRunId: undefined,
      dispatchId: undefined,
      evidence,
      noProgressRuns,
      // Only this settled worker may schedule its automatic successor. Manual
      // resume and replacement must use their newly admitted execution settings.
      continuationSourceRunId: ["queued", "waiting"].includes(state)
        ? args.runId
        : undefined,
      generation: ["queued", "waiting"].includes(state)
        ? goal.generation + 1
        : goal.generation,
      waitUntil:
        state === "waiting"
          ? Date.now() + (goal.checkpoint?.waitSeconds ?? 0) * 1000
          : undefined,
      judgment: args.judgment,
      reason: ["paused", "canceled"].includes(goal.state)
        ? goal.reason
        : state === "queued"
          ? (args.judgment?.reason ?? "Continuing from saved progress")
          : state === "paused"
            ? "Run paused. Resume when ready."
            : state === "waiting"
              ? "Waiting before the next work slice"
              : state === "achieved"
                ? "Completion verified against saved evidence"
                : state === "blocked"
                  ? (args.judgment?.reason ??
                    goal.checkpoint?.progress ??
                    "Two runs produced no verified progress")
                  : state === "usage_exhausted"
                    ? "Usage or run spend limit reached; explicit user action required"
                    : state === "failed"
                      ? "Run failed; review saved work before resuming"
                      : (args.judgment?.reason ??
                        goal.checkpoint?.progress ??
                        goal.reason),
      updatedAt: Date.now(),
    });
    if (
      state === "achieved" &&
      goal.startedAt !== undefined &&
      message?.chat_id === args.chatId &&
      message.role === "assistant"
    ) {
      await ctx.db.patch(message._id, {
        goal: { achievedElapsedMs: timing.elapsedMs },
      });
    }
    return (await ctx.db.get(goal._id))!;
  },
});
export const failDispatch = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    generation: v.number(),
    continuationSourceRunId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const goal = await byChat(ctx, args.chatId);
    if (
      goal &&
      goal.userId === args.userId &&
      goal.generation === args.generation &&
      (args.continuationSourceRunId === undefined ||
        goal.continuationSourceRunId === args.continuationSourceRunId) &&
      ["queued", "waiting"].includes(goal.state)
    )
      await ctx.db.patch(goal._id, {
        ...goalTimingForState(goal, "failed", Date.now()),
        state: "failed",
        dispatchId: undefined,
        continuationSourceRunId: undefined,
        reason:
          "Continuation could not start. Review saved progress and resume.",
        updatedAt: Date.now(),
      });
    return null;
  },
});

export const evidenceForBackend = query({
  args: { serviceKey: v.string(), chatId: v.string(), userId: v.string() },
  returns: v.array(
    v.object({
      criterion: v.number(),
      runId: v.string(),
      messageId: v.optional(v.string()),
      toolCallId: v.string(),
      explanation: v.string(),
      result: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await owned(ctx, args.chatId, args.userId);
    const goal = await byChat(ctx, args.chatId);
    const result = [];
    for (const e of goal?.evidence ?? []) {
      const message = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("id", e.messageId ?? e.runId))
        .unique();
      const part =
        message?.chat_id === args.chatId && message.role === "assistant"
          ? message.parts?.find((p) => isGoalEvidencePart(p, e.toolCallId))
          : undefined;
      if (part) result.push({ ...e, result: serializeGoalEvidence(part) });
    }
    return result;
  },
});
