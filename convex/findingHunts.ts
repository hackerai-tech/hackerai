import { v, type Infer } from "convex/values";
import { internalMutation, mutation, query } from "./lib/serviceFunctions";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./lib/serviceFunctions";
import type { Doc } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { isUserDeletionFenced } from "./lib/userDeletionFence";
import {
  huntCandidateInputValidator,
  huntEnvironmentValidator,
  huntEvidenceVerificationValidator,
  huntViewValidator,
} from "./findingHuntValidators";
import {
  HUNT_LIMITS,
  countHuntOutcomes,
  huntCandidateKey,
  huntCompletionKey,
  parseHuntCandidate,
  parseHuntCompletion,
} from "../lib/findings/variant-hunt";

export const FINDING_HUNT_HISTORY_LIMIT = 20;
export const FINDING_HUNTS_PER_HOUR = 20;
const RUNNING_SCAN_LIMIT = 20;
const DELETE_BATCH_SIZE = 50;
const HOUR_MS = 60 * 60 * 1000;
const MAX_ID_LENGTH = 128;
const MAX_ENVIRONMENT_NAME = 80;

type ReadCtx = Pick<QueryCtx, "db">;
type Hunt = Doc<"finding_variant_hunts">;

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

/** A hunt is live only while the exact run that started it is still active. */
function isRunLive(hunt: Hunt, chat: Doc<"chats">): boolean {
  if (chat.canceled_at !== undefined) return false;
  if (hunt.trigger_run_id !== undefined)
    return chat.active_trigger_run_id === hunt.trigger_run_id;
  if (hunt.stream_id !== undefined)
    return chat.active_stream_id === hunt.stream_id;
  return false;
}

// Saved candidates are always kept when a hunt is interrupted.
const interruptedPatch = (now: number) => ({
  status: "finished" as const,
  finished_at: now,
  interrupted: true,
});

/** Present a hunt whose Agent run ended without completing as interrupted. */
function toView(
  hunt: Hunt,
  chat: Doc<"chats">,
): Infer<typeof huntViewValidator> {
  const interrupted =
    hunt.interrupted === true ||
    (hunt.status === "running" && !isRunLive(hunt, chat));
  return {
    hunt_id: hunt._id as string,
    chat_id: hunt.chat_id,
    assistant_message_id: hunt.assistant_message_id,
    status: interrupted ? ("finished" as const) : hunt.status,
    started_at: hunt.started_at,
    ...(hunt.finished_at !== undefined && { finished_at: hunt.finished_at }),
    ...(interrupted && { interrupted: true }),
    ...(!interrupted &&
      hunt.summary !== undefined && { summary: hunt.summary }),
    ...(!interrupted && hunt.limitations && { limitations: hunt.limitations }),
    ...(hunt.environment && { environment: hunt.environment }),
    candidates: hunt.candidates.map(
      ({ content_key: _contentKey, ...candidate }) => candidate,
    ),
  };
}

const findHunt = (
  ctx: ReadCtx,
  findingId: string,
  assistantMessageId: string,
) =>
  ctx.db
    .query("finding_variant_hunts")
    .withIndex("by_finding_and_message", (q) =>
      q
        .eq("finding_id", findingId)
        .eq("assistant_message_id", assistantMessageId),
    )
    .first();

const failure = <E extends string>(error: E, message: string) => ({
  success: false as const,
  error,
  message,
});

const provenanceArgs = {
  serviceKey: v.string(),
  userId: v.string(),
  chatId: v.string(),
  findingId: v.string(),
  assistantMessageId: v.string(),
  triggerRunId: v.optional(v.string()),
};

/** Load the hunt this exact response started; another context can't write it. */
async function loadOwnHunt(
  ctx: ReadCtx,
  args: {
    userId: string;
    chatId: string;
    findingId: string;
    assistantMessageId: string;
    triggerRunId?: string;
  },
) {
  const access = await authorizeFinding(
    ctx,
    args.userId,
    args.findingId,
    args.chatId,
  );
  if (!access) return { access: null, hunt: null };
  const hunt = await findHunt(ctx, args.findingId, args.assistantMessageId);
  if (
    !hunt ||
    hunt.user_id !== args.userId ||
    hunt.chat_id !== args.chatId ||
    hunt.trigger_run_id !== args.triggerRunId
  )
    return { access, hunt: null };
  return { access, hunt };
}

const validEnvironment = (
  environment?: Infer<typeof huntEnvironmentValidator>,
) => (environment?.name?.length ?? 0) <= MAX_ENVIRONMENT_NAME;

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
      hunts: v.array(huntViewValidator),
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
        FINDING_HUNT_HISTORY_LIMIT,
        Math.floor(args.limit ?? FINDING_HUNT_HISTORY_LIMIT),
      ),
    );
    const hunts = await ctx.db
      .query("finding_variant_hunts")
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
      hunts: hunts
        .filter(
          (hunt) =>
            hunt.user_id === args.userId && hunt.chat_id === access.chat.id,
        )
        .map((hunt) => toView(hunt, access.chat)),
    };
  },
});

export const startForBackend = mutation({
  args: { ...provenanceArgs, expectedUpdatedAt: v.number() },
  returns: v.union(
    v.object({
      success: v.literal(true),
      hunt_id: v.string(),
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
      return failure("not_found", "Hunt provenance is unavailable.");
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
        "This Agent run can't be tracked, so no hunt was started. Report results in chat only.",
      );

    // A tool retry in the same message resumes the same record.
    const existing = await findHunt(
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
          hunt_id: existing._id as string,
          duplicate: true,
        };
      if (existing.status === "running")
        await ctx.db.patch(existing._id, interruptedPatch(Date.now()));
      return failure(
        "already_finished",
        "This response already recorded a hunt for this report.",
      );
    }

    const now = Date.now();
    const recent = await ctx.db
      .query("finding_variant_hunts")
      .withIndex("by_finding_and_started", (q) =>
        q.eq("finding_id", finding.finding_id),
      )
      .order("desc")
      .take(RUNNING_SCAN_LIMIT);
    for (const hunt of recent) {
      if (hunt.status !== "running") continue;
      if (isRunLive(hunt, chat))
        return failure(
          "busy",
          "Another hunt for this report is still running in this task.",
        );
      await ctx.db.patch(hunt._id, interruptedPatch(now));
    }

    const hourly = await ctx.db
      .query("finding_variant_hunts")
      .withIndex("by_user_and_started", (q) =>
        q.eq("user_id", args.userId).gte("started_at", now - HOUR_MS),
      )
      .take(FINDING_HUNTS_PER_HOUR);
    if (hourly.length >= FINDING_HUNTS_PER_HOUR)
      return failure(
        "rate_limited",
        "The hourly hunt limit was reached. Report results in chat only.",
      );

    const id = await ctx.db.insert("finding_variant_hunts", {
      user_id: args.userId,
      chat_id: chat.id,
      finding_id: finding.finding_id,
      assistant_message_id: args.assistantMessageId,
      ...ref,
      finding_updated_at: finding.updated_at,
      target: finding.target,
      started_at: now,
      status: "running",
      candidates: [],
    });
    return { success: true as const, hunt_id: id as string, duplicate: false };
  },
});

export const recordCandidateForBackend = mutation({
  args: {
    ...provenanceArgs,
    candidate: huntCandidateInputValidator,
    retainedEvidenceRefs: v.array(v.string()),
    evidenceVerification: v.optional(huntEvidenceVerificationValidator),
    environment: v.optional(huntEnvironmentValidator),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      hunt_id: v.string(),
      candidate_count: v.number(),
      duplicate: v.boolean(),
    }),
    v.object({
      success: v.literal(false),
      error: v.union(
        v.literal("not_found"),
        v.literal("validation"),
        v.literal("conflict"),
        v.literal("interrupted"),
        v.literal("already_finished"),
        v.literal("limit_reached"),
      ),
      message: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const parsed = parseHuntCandidate(args.candidate);
    if (!parsed.success) return failure("validation", parsed.message);
    const candidate = parsed.value;
    const submitted = new Set(candidate.evidence_refs);
    if (
      args.retainedEvidenceRefs.some((ref) => !submitted.has(ref)) ||
      !validEnvironment(args.environment)
    )
      return failure("validation", "Invalid evidence or environment.");

    const { access, hunt } = await loadOwnHunt(ctx, args);
    if (!access)
      return failure("not_found", "The report is not available in this chat.");
    if (!hunt)
      return failure(
        "not_found",
        "No hunt was started by this response. Call start_finding_hunt first.",
      );

    // Saved candidates are immutable; only an identical retry succeeds, even
    // after the hunt ended.
    const contentKey = huntCandidateKey(candidate);
    const existing = hunt.candidates.find(
      (saved) => saved.candidate_key === candidate.candidate_key,
    );
    if (existing)
      return existing.content_key === contentKey
        ? {
            success: true as const,
            hunt_id: hunt._id as string,
            candidate_count: hunt.candidates.length,
            duplicate: true,
          }
        : failure(
            "conflict",
            "This candidate is already saved and can't be changed. Use a new candidate_key for a different surface.",
          );

    if (hunt.status === "finished")
      return hunt.interrupted
        ? failure(
            "interrupted",
            "This hunt was already recorded as stopped early. Its saved candidates were kept.",
          )
        : failure("already_finished", "This hunt is already complete.");

    const now = Date.now();
    if (!isRunLive(hunt, access.chat)) {
      await ctx.db.patch(hunt._id, interruptedPatch(now));
      return failure(
        "interrupted",
        "The Agent run that started this hunt is no longer active. Saved candidates were kept.",
      );
    }
    if (
      access.finding.updated_at !== hunt.finding_updated_at ||
      access.finding.target !== hunt.target
    ) {
      await ctx.db.patch(hunt._id, interruptedPatch(now));
      return failure(
        "conflict",
        "The report changed during this hunt, so this candidate was not saved. Earlier candidates were kept.",
      );
    }
    if (hunt.candidates.length >= HUNT_LIMITS.maxCandidates)
      return failure(
        "limit_reached",
        `A hunt can save at most ${HUNT_LIMITS.maxCandidates} candidates. Complete the hunt and list the rest as limitations.`,
      );

    const candidateCount = hunt.candidates.length + 1;
    await ctx.db.patch(hunt._id, {
      candidates: [
        ...hunt.candidates,
        {
          candidate_key: candidate.candidate_key,
          surface: candidate.surface,
          rationale: candidate.rationale,
          outcome: candidate.outcome,
          ...(candidate.evidence_basis && {
            evidence_basis: candidate.evidence_basis,
          }),
          reproduction_steps: candidate.reproduction_steps,
          ...(candidate.expected_result && {
            expected_result: candidate.expected_result,
          }),
          ...(candidate.observed_result && {
            observed_result: candidate.observed_result,
          }),
          evidence_refs: args.retainedEvidenceRefs,
          ...(args.evidenceVerification && {
            evidence_verification: args.evidenceVerification,
          }),
          limitations: candidate.limitations,
          recorded_at: now,
          content_key: contentKey,
        },
      ],
      ...(hunt.environment === undefined &&
        args.environment && { environment: args.environment }),
    });
    return {
      success: true as const,
      hunt_id: hunt._id as string,
      candidate_count: candidateCount,
      duplicate: false,
    };
  },
});

const countsValidator = v.object({
  reproduced: v.number(),
  ruled_out: v.number(),
  inconclusive: v.number(),
  not_examined: v.number(),
});

export const completeForBackend = mutation({
  args: {
    ...provenanceArgs,
    summary: v.string(),
    limitations: v.array(v.string()),
    environment: v.optional(huntEnvironmentValidator),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      hunt_id: v.string(),
      duplicate: v.boolean(),
      counts: countsValidator,
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
    const parsed = parseHuntCompletion({
      summary: args.summary,
      limitations: args.limitations,
    });
    if (!parsed.success) return failure("validation", parsed.message);
    if (!validEnvironment(args.environment))
      return failure("validation", "Invalid environment.");
    const key = huntCompletionKey(parsed.value);

    const { access, hunt } = await loadOwnHunt(ctx, args);
    if (!access)
      return failure("not_found", "The report is not available in this chat.");
    if (!hunt)
      return failure(
        "not_found",
        "No hunt was started by this response. Call start_finding_hunt first.",
      );
    const counts = countHuntOutcomes(hunt.candidates);

    // Completed hunts are immutable; only an identical retry succeeds.
    if (hunt.status === "finished") {
      if (hunt.interrupted)
        return failure(
          "interrupted",
          "This hunt was already recorded as stopped early. Its saved candidates were kept.",
        );
      return hunt.result_key === key
        ? {
            success: true as const,
            hunt_id: hunt._id as string,
            duplicate: true,
            counts,
          }
        : failure(
            "conflict",
            "This hunt is already complete and can't be changed.",
          );
    }

    const now = Date.now();
    if (!isRunLive(hunt, access.chat)) {
      await ctx.db.patch(hunt._id, interruptedPatch(now));
      return failure(
        "interrupted",
        "The Agent run that started this hunt is no longer active. Saved candidates were kept.",
      );
    }
    if (
      access.finding.updated_at !== hunt.finding_updated_at ||
      access.finding.target !== hunt.target
    ) {
      await ctx.db.patch(hunt._id, interruptedPatch(now));
      return failure(
        "conflict",
        "The report changed during this hunt, so it was recorded as stopped early. Saved candidates were kept.",
      );
    }

    await ctx.db.patch(hunt._id, {
      status: "finished",
      finished_at: now,
      summary: parsed.value.summary,
      limitations: parsed.value.limitations,
      result_key: key,
      ...(hunt.environment === undefined &&
        args.environment && { environment: args.environment }),
    });
    return {
      success: true as const,
      hunt_id: hunt._id as string,
      duplicate: false,
      counts,
    };
  },
});

/**
 * Delete one batch of hunt rows for a chat. Returns true while rows remain, so
 * chat deletion can reschedule before removing the chat itself.
 */
export async function deleteFindingHuntsForChatBatch(
  ctx: MutationCtx,
  userId: string,
  chatId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("finding_variant_hunts")
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
      .query("finding_variant_hunts")
      .withIndex("by_finding_and_started", (q) =>
        q.eq("finding_id", args.findingId),
      )
      .take(DELETE_BATCH_SIZE + 1);
    for (const row of rows.slice(0, DELETE_BATCH_SIZE))
      if (row.user_id === args.userId) await ctx.db.delete(row._id);
    if (rows.length > DELETE_BATCH_SIZE)
      await ctx.scheduler.runAfter(
        0,
        internal.findingHunts.deleteForFinding,
        args,
      );
    return null;
  },
});
