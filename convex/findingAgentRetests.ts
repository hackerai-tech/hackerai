import { v, type Infer } from "convex/values";
import { internalMutation, mutation, query } from "./lib/serviceFunctions";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./lib/serviceFunctions";
import type { Doc } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { isUserDeletionFenced } from "./lib/userDeletionFence";
import {
  agentRetestEnvironmentValidator,
  agentRetestEvidenceVerificationValidator,
  agentRetestResultValidator,
  agentRetestViewValidator,
} from "./findingAgentRetestValidators";
import {
  agentRetestResultKey,
  parseAgentRetestResult,
} from "../lib/findings/agent-retest";

export const AGENT_RETEST_HISTORY_LIMIT = 20;
export const AGENT_RETESTS_PER_HOUR = 20;
const RUNNING_SCAN_LIMIT = 20;
const DELETE_BATCH_SIZE = 50;
const HOUR_MS = 60 * 60 * 1000;
const MAX_ID_LENGTH = 128;

type ReadCtx = Pick<QueryCtx, "db">;
type Run = Doc<"finding_agent_retest_runs">;

/**
 * Re-authorize the finding, its source chat and the user's history access on
 * every operation. A deleting chat or user is treated as unavailable.
 */
async function authorizeFinding(
  ctx: ReadCtx,
  userId: string,
  findingId: string,
  chatId?: string,
): Promise<{ finding: Doc<"findings">; chat: Doc<"chats"> } | null> {
  await assertUserCanAccessChatHistory(ctx as QueryCtx, userId);
  if (await isUserDeletionFenced(ctx.db, userId)) return null;
  const finding = await ctx.db
    .query("findings")
    .withIndex("by_finding_id", (q) => q.eq("finding_id", findingId))
    .unique();
  if (!finding || finding.user_id !== userId) return null;
  if (chatId !== undefined && finding.chat_id !== chatId) return null;
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", finding.chat_id))
    .unique();
  if (
    !chat ||
    chat.user_id !== userId ||
    chat.deletion_started_at !== undefined
  )
    return null;
  return { finding, chat };
}

/** A retest is live only while the exact run that started it is still active. */
function isRunLive(run: Run, chat: Doc<"chats">): boolean {
  if (chat.canceled_at !== undefined) return false;
  if (run.trigger_run_id !== undefined)
    return chat.active_trigger_run_id === run.trigger_run_id;
  if (run.stream_id !== undefined)
    return chat.active_stream_id === run.stream_id;
  return false;
}

const interruptedPatch = (now: number) => ({
  status: "finished" as const,
  finished_at: now,
  outcome: "inconclusive" as const,
  interrupted: true,
});

/** Present a run whose Agent run ended without a result as interrupted. */
function toView(
  run: Run,
  chat: Doc<"chats">,
): Infer<typeof agentRetestViewValidator> {
  const interrupted =
    run.interrupted === true ||
    (run.status === "running" && !isRunLive(run, chat));
  return {
    retest_id: run._id as string,
    chat_id: run.chat_id,
    assistant_message_id: run.assistant_message_id,
    status: interrupted ? ("finished" as const) : run.status,
    started_at: run.started_at,
    ...(run.finished_at !== undefined && { finished_at: run.finished_at }),
    ...(interrupted
      ? { outcome: "inconclusive" as const, interrupted: true }
      : {
          ...(run.outcome && { outcome: run.outcome }),
          ...(run.summary !== undefined && { summary: run.summary }),
          ...(run.reproduction_steps && {
            reproduction_steps: run.reproduction_steps,
          }),
          ...(run.expected_result !== undefined && {
            expected_result: run.expected_result,
          }),
          ...(run.observed_result !== undefined && {
            observed_result: run.observed_result,
          }),
          ...(run.evidence_refs && { evidence_refs: run.evidence_refs }),
          ...(run.evidence_verification && {
            evidence_verification: run.evidence_verification,
          }),
          ...(run.limitations && { limitations: run.limitations }),
        }),
    ...(run.environment && { environment: run.environment }),
  };
}

const findRun = (ctx: ReadCtx, findingId: string, assistantMessageId: string) =>
  ctx.db
    .query("finding_agent_retest_runs")
    .withIndex("by_finding_and_message", (q) =>
      q
        .eq("finding_id", findingId)
        .eq("assistant_message_id", assistantMessageId),
    )
    .first();

export const getHistoryForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    findingId: v.string(),
    chatId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ available: v.literal(false) }),
    v.object({
      available: v.literal(true),
      finding: v.object({
        finding_id: v.string(),
        chat_id: v.string(),
        chat_title: v.string(),
        updated_at: v.number(),
      }),
      retests: v.array(agentRetestViewValidator),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const access = await authorizeFinding(
      ctx,
      args.userId,
      args.findingId,
      args.chatId,
    );
    if (!access) return { available: false as const };
    const limit = Math.max(
      1,
      Math.min(
        AGENT_RETEST_HISTORY_LIMIT,
        Math.floor(args.limit ?? AGENT_RETEST_HISTORY_LIMIT),
      ),
    );
    const runs = await ctx.db
      .query("finding_agent_retest_runs")
      .withIndex("by_finding_and_started", (q) =>
        q.eq("finding_id", args.findingId),
      )
      .order("desc")
      .take(limit);
    return {
      available: true as const,
      finding: {
        finding_id: access.finding.finding_id,
        chat_id: access.chat.id,
        chat_title: access.chat.title,
        updated_at: access.finding.updated_at,
      },
      retests: runs
        .filter(
          (run) =>
            run.user_id === args.userId && run.chat_id === access.chat.id,
        )
        .map((run) => toView(run, access.chat)),
    };
  },
});

const failure = <E extends string>(error: E, message: string) => ({
  success: false as const,
  error,
  message,
});

export const startForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    findingId: v.string(),
    assistantMessageId: v.string(),
    triggerRunId: v.optional(v.string()),
    expectedUpdatedAt: v.number(),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      retest_id: v.string(),
      duplicate: v.boolean(),
    }),
    v.object({
      success: v.literal(false),
      error: v.union(
        v.literal("not_found"),
        v.literal("conflict"),
        v.literal("not_active"),
        v.literal("busy"),
        v.literal("rate_limited"),
        v.literal("already_finished"),
      ),
      message: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (
      !args.assistantMessageId ||
      args.assistantMessageId.length > MAX_ID_LENGTH ||
      (args.triggerRunId?.length ?? 0) > MAX_ID_LENGTH
    )
      return failure("not_found", "Retest provenance is unavailable.");
    const access = await authorizeFinding(
      ctx,
      args.userId,
      args.findingId,
      args.chatId,
    );
    if (!access)
      return failure("not_found", "The report is not available in this chat.");
    const { finding, chat } = access;
    if (finding.updated_at !== args.expectedUpdatedAt)
      return failure(
        "conflict",
        "The report changed. Read it again with get_report before starting.",
      );

    // Bind the record to the exact active run so a stopped, crashed or
    // replaced run is shown as interrupted rather than still running.
    const ref =
      args.triggerRunId !== undefined
        ? chat.active_trigger_run_id === args.triggerRunId
          ? { trigger_run_id: args.triggerRunId }
          : null
        : chat.active_stream_id !== undefined
          ? { stream_id: chat.active_stream_id }
          : null;
    if (!ref || chat.canceled_at !== undefined)
      return failure(
        "not_active",
        "This Agent run can't be tracked, so no retest was started. Report results in chat only.",
      );

    // A tool retry in the same message resumes the same record.
    const existing = await findRun(
      ctx,
      finding.finding_id,
      args.assistantMessageId,
    );
    if (existing) {
      if (existing.user_id !== args.userId || existing.chat_id !== chat.id)
        return failure(
          "not_found",
          "The report is not available in this chat.",
        );
      if (existing.status === "running" && isRunLive(existing, chat))
        return {
          success: true as const,
          retest_id: existing._id as string,
          duplicate: true,
        };
      if (existing.status === "running")
        await ctx.db.patch(existing._id, interruptedPatch(Date.now()));
      return failure(
        "already_finished",
        "This response already recorded a retest for this report.",
      );
    }

    const now = Date.now();
    const recent = await ctx.db
      .query("finding_agent_retest_runs")
      .withIndex("by_finding_and_started", (q) =>
        q.eq("finding_id", finding.finding_id),
      )
      .order("desc")
      .take(RUNNING_SCAN_LIMIT);
    for (const run of recent) {
      if (run.status !== "running") continue;
      if (isRunLive(run, chat))
        return failure(
          "busy",
          "Another retest of this report is still running in this task.",
        );
      await ctx.db.patch(run._id, interruptedPatch(now));
    }

    const hourly = await ctx.db
      .query("finding_agent_retest_runs")
      .withIndex("by_user_and_started", (q) =>
        q.eq("user_id", args.userId).gte("started_at", now - HOUR_MS),
      )
      .take(AGENT_RETESTS_PER_HOUR);
    if (hourly.length >= AGENT_RETESTS_PER_HOUR)
      return failure(
        "rate_limited",
        "The hourly retest limit was reached. Report results in chat only.",
      );

    const id = await ctx.db.insert("finding_agent_retest_runs", {
      user_id: args.userId,
      chat_id: chat.id,
      finding_id: finding.finding_id,
      assistant_message_id: args.assistantMessageId,
      ...ref,
      finding_updated_at: finding.updated_at,
      target: finding.target,
      started_at: now,
      status: "running",
    });
    return {
      success: true as const,
      retest_id: id as string,
      duplicate: false,
    };
  },
});

export const completeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    findingId: v.string(),
    assistantMessageId: v.string(),
    triggerRunId: v.optional(v.string()),
    result: agentRetestResultValidator,
    retainedEvidenceRefs: v.array(v.string()),
    evidenceVerification: v.optional(agentRetestEvidenceVerificationValidator),
    environment: v.optional(agentRetestEnvironmentValidator),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      retest_id: v.string(),
      duplicate: v.boolean(),
    }),
    v.object({
      success: v.literal(false),
      error: v.union(
        v.literal("not_found"),
        v.literal("validation"),
        v.literal("conflict"),
        v.literal("interrupted"),
      ),
      message: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const parsed = parseAgentRetestResult(args.result);
    if (!parsed.success) return failure("validation", parsed.message);
    const submitted = new Set(parsed.result.evidence_refs);
    if (
      args.retainedEvidenceRefs.some((ref) => !submitted.has(ref)) ||
      (args.environment?.name?.length ?? 0) > 80
    )
      return failure("validation", "Invalid evidence or environment.");
    const key = agentRetestResultKey(
      parsed.result,
      parsed.result.evidence_refs,
    );

    const access = await authorizeFinding(
      ctx,
      args.userId,
      args.findingId,
      args.chatId,
    );
    if (!access)
      return failure("not_found", "The report is not available in this chat.");

    const run = await findRun(ctx, args.findingId, args.assistantMessageId);
    if (
      !run ||
      run.user_id !== args.userId ||
      run.chat_id !== args.chatId ||
      run.trigger_run_id !== args.triggerRunId
    )
      return failure(
        "not_found",
        "No retest was started by this response. Call start_finding_retest first.",
      );

    // Finished records are immutable; only an identical retry succeeds.
    if (run.status === "finished") {
      if (run.interrupted)
        return failure(
          "interrupted",
          "This retest was already recorded as interrupted.",
        );
      return run.result_key === key
        ? {
            success: true as const,
            retest_id: run._id as string,
            duplicate: true,
          }
        : failure(
            "conflict",
            "This retest is already saved and can't be changed.",
          );
    }

    const now = Date.now();
    if (!isRunLive(run, access.chat)) {
      await ctx.db.patch(run._id, interruptedPatch(now));
      return failure(
        "interrupted",
        "The Agent run that started this retest is no longer active. It was recorded as inconclusive.",
      );
    }
    if (
      access.finding.updated_at !== run.finding_updated_at ||
      access.finding.target !== run.target
    ) {
      await ctx.db.patch(run._id, interruptedPatch(now));
      return failure(
        "conflict",
        "The report changed during this retest, so the result was not saved. It was recorded as inconclusive.",
      );
    }

    const result = parsed.result;
    await ctx.db.patch(run._id, {
      outcome: result.outcome,
      summary: result.summary,
      reproduction_steps: result.reproduction_steps,
      expected_result: result.expected_result,
      observed_result: result.observed_result,
      limitations: result.limitations,
      status: "finished",
      finished_at: now,
      evidence_refs: args.retainedEvidenceRefs,
      ...(args.evidenceVerification && {
        evidence_verification: args.evidenceVerification,
      }),
      ...(args.environment && { environment: args.environment }),
      result_key: key,
    });
    return {
      success: true as const,
      retest_id: run._id as string,
      duplicate: false,
    };
  },
});

/**
 * Delete one batch of Agent retest rows for a chat. Returns true while rows
 * remain, so chat deletion can reschedule before removing the chat itself.
 */
export async function deleteFindingAgentRetestsForChatBatch(
  ctx: MutationCtx,
  userId: string,
  chatId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("finding_agent_retest_runs")
    .withIndex("by_user_and_chat", (q) =>
      q.eq("user_id", userId).eq("chat_id", chatId),
    )
    .take(DELETE_BATCH_SIZE + 1);
  for (const row of rows.slice(0, DELETE_BATCH_SIZE))
    await ctx.db.delete(row._id);
  return rows.length > DELETE_BATCH_SIZE;
}

/** Continue cleanup of an individual deleted finding in bounded batches. */
export const deleteForFinding = internalMutation({
  args: { findingId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("finding_agent_retest_runs")
      .withIndex("by_finding_and_started", (q) =>
        q.eq("finding_id", args.findingId),
      )
      .take(DELETE_BATCH_SIZE + 1);
    for (const row of rows.slice(0, DELETE_BATCH_SIZE))
      if (row.user_id === args.userId) await ctx.db.delete(row._id);
    if (rows.length > DELETE_BATCH_SIZE)
      await ctx.scheduler.runAfter(
        0,
        internal.findingAgentRetests.deleteForFinding,
        args,
      );
    return null;
  },
});
