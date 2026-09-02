import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { validateServiceKey } from "./lib/utils";
import {
  MAX_ACTIVE_SUBAGENTS_PER_PARENT_RUN,
  MAX_SUBAGENTS_PER_PARENT_RUN,
  SUBAGENT_MAX_COST_DOLLARS,
  SUBAGENT_MAX_DURATION_SECONDS,
  SUBAGENT_ORCHESTRATION_BUDGET_DOLLARS,
  SUBAGENT_PARENT_SYNTHESIS_RESERVE_DOLLARS,
  SUBAGENT_MAX_QUEUE_SECONDS,
  SUBAGENT_WATCHDOG_GRACE_SECONDS,
} from "../lib/ai/subagents/contracts";
import { SUBAGENT_PARENT_DELIVERY_CLAIM_TTL_MS } from "../lib/ai/subagents/parent-delivery";
import { toSubagentHandle } from "../lib/ai/subagents/agent-handle";
import { isUserDeletionFenced } from "./lib/userDeletionFence";

const statusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("finalizing"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
  v.literal("timed_out"),
);

const profileValidator = v.union(
  v.literal("general"),
  v.literal("security_task"),
  v.literal("security_validation"),
);

const verdictValidator = v.union(
  v.literal("confirmed"),
  v.literal("rejected"),
  v.literal("inconclusive"),
);

const confidenceValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);

const messageFeedbackValidator = v.union(
  v.literal("positive"),
  v.literal("negative"),
);

const subagentMessageTypeValidator = v.union(
  v.literal("query"),
  v.literal("instruction"),
  v.literal("information"),
);

const subagentMessagePriorityValidator = v.union(
  v.literal("low"),
  v.literal("normal"),
  v.literal("high"),
  v.literal("urgent"),
);

const subscriptionValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("ultra"),
  v.literal("team"),
);

const candidateValidator = v.object({
  title: v.string(),
  affected_asset: v.string(),
  weakness_class: v.string(),
  claimed_impact: v.string(),
  reproduction_hint: v.optional(v.string()),
});

const subagentSummaryValidator = v.object({
  subagent_id: v.string(),
  parent_trigger_run_id: v.string(),
  parent_message_id: v.string(),
  parent_tool_call_id: v.string(),
  trigger_run_id: v.optional(v.string()),
  profile: profileValidator,
  status: statusValidator,
  name: v.string(),
  objective: v.string(),
  skills: v.optional(v.array(v.string())),
  title: v.string(),
  subtitle: v.optional(v.string()),
  candidate: v.optional(candidateValidator),
  summary: v.optional(v.string()),
  verdict: v.optional(verdictValidator),
  confidence: v.optional(confidenceValidator),
  failure_code: v.optional(v.string()),
  failure_reason: v.optional(v.string()),
  cancel_reason: v.optional(v.string()),
  cost_dollars: v.optional(v.number()),
  step_count: v.optional(v.number()),
  created_at: v.number(),
  started_at: v.optional(v.number()),
  completed_at: v.optional(v.number()),
  updated_at: v.number(),
});

async function isSubagentChatAvailable(
  ctx: MutationCtx,
  userId: string,
  chatId: string,
) {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .first();
  return (
    chat !== null &&
    chat.user_id === userId &&
    chat.deletion_started_at === undefined
  );
}

const ACTIVE_SUBAGENT_STATUSES = ["queued", "running", "finalizing"] as const;
const SUBAGENT_DELETION_CANCELLATION_BATCH_SIZE = 100;
const MAX_SUBAGENT_PROGRESS_EVENTS = 32;
const workLedgerSummaryValidator = v.object({
  subagent_id: v.string(),
  owner: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("in_progress"),
    v.literal("blocked"),
    v.literal("completed"),
  ),
  dependencies: v.array(v.string()),
  refs: v.array(v.string()),
  claims: v.array(v.object({ claim: v.string(), provenance: v.string() })),
  assessed_scope: v.array(v.string()),
  unassessed_scope: v.array(v.string()),
  artifacts: v.array(
    v.object({ path: v.string(), description: v.optional(v.string()) }),
  ),
  updated_at: v.number(),
});
const isActiveStatus = (status: string): boolean =>
  ACTIVE_SUBAGENT_STATUSES.some((activeStatus) => activeStatus === status);
const isPendingDeletionCancellation = (
  row: {
    status: string;
    cancel_reason?: string;
  },
  reason: string,
): boolean => row.status === "canceled" && row.cancel_reason === reason;
const deletionCancellationResultValidator = v.object({
  triggerRunIds: v.array(v.string()),
  hasMore: v.boolean(),
});

const toSummary = (row: {
  subagent_id: string;
  parent_trigger_run_id: string;
  parent_message_id: string;
  parent_tool_call_id: string;
  trigger_run_id?: string;
  profile: "general" | "security_task" | "security_validation";
  name?: string;
  objective: string;
  success_criteria?: string[];
  skills?: string[];
  status:
    | "queued"
    | "running"
    | "finalizing"
    | "completed"
    | "failed"
    | "canceled"
    | "timed_out";
  candidate?: {
    title: string;
    affected_asset: string;
    weakness_class: string;
    claimed_impact: string;
    reproduction_hint?: string;
  };
  summary?: string;
  verdict?: "confirmed" | "rejected" | "inconclusive";
  confidence?: "low" | "medium" | "high";
  failure_code?: string;
  failure_reason?: string;
  cancel_reason?: string;
  cost_dollars?: number;
  step_count?: number;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  updated_at: number;
}) => ({
  subagent_id: row.subagent_id,
  parent_trigger_run_id: row.parent_trigger_run_id,
  parent_message_id: row.parent_message_id,
  parent_tool_call_id: row.parent_tool_call_id,
  trigger_run_id: row.trigger_run_id,
  profile: row.profile,
  status: row.status,
  name: row.name ?? row.candidate?.title ?? "Subagent",
  objective: row.objective,
  skills: row.skills,
  title: row.name ?? row.candidate?.title ?? "Subagent",
  subtitle: row.candidate?.affected_asset,
  candidate: row.candidate,
  summary: row.summary,
  verdict: row.verdict,
  confidence: row.confidence,
  failure_code: row.failure_code,
  failure_reason: row.failure_reason,
  cancel_reason: row.cancel_reason,
  cost_dollars: row.cost_dollars,
  step_count: row.step_count,
  created_at: row.created_at,
  started_at: row.started_at,
  completed_at: row.completed_at,
  updated_at: row.updated_at,
});

export const reserveForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    userId: v.string(),
    organizationId: v.optional(v.string()),
    chatId: v.string(),
    parentMessageId: v.string(),
    parentToolCallId: v.string(),
    parentTriggerRunId: v.string(),
    profile: v.optional(profileValidator),
    name: v.optional(v.string()),
    objective: v.string(),
    successCriteria: v.optional(v.array(v.string())),
    inheritContext: v.optional(v.boolean()),
    skills: v.optional(v.array(v.string())),
    capabilityBundles: v.optional(v.array(v.string())),
    taskComplexity: v.optional(v.string()),
    expectedDurationMinutes: v.optional(v.number()),
    outputKind: v.optional(v.string()),
    candidate: v.optional(candidateValidator),
    candidateFingerprint: v.string(),
    contextRefs: v.optional(v.array(v.any())),
    sandboxPreference: v.optional(v.string()),
    sandboxIdentity: v.optional(v.string()),
    permissionMode: v.optional(v.string()),
    selectedModel: v.optional(v.string()),
    subscription: subscriptionValidator,
    freeQuotaSubject: v.optional(v.string()),
    userLocation: v.optional(v.any()),
  },
  returns: v.object({
    outcome: v.union(
      v.literal("created"),
      v.literal("existing"),
      v.literal("active_limit"),
      v.literal("total_limit"),
      v.literal("spend_limit"),
      v.literal("chat_missing"),
    ),
    subagentId: v.optional(v.string()),
    status: v.optional(statusValidator),
    triggerRunId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    if (await isUserDeletionFenced(ctx.db, args.userId)) {
      return { outcome: "chat_missing" as const };
    }
    if (!(await isSubagentChatAvailable(ctx, args.userId, args.chatId))) {
      return { outcome: "chat_missing" as const };
    }

    const exact = await ctx.db
      .query("subagent_runs")
      .withIndex("by_parent_run_and_tool_call", (q) =>
        q
          .eq("parent_trigger_run_id", args.parentTriggerRunId)
          .eq("parent_tool_call_id", args.parentToolCallId),
      )
      .first();
    if (exact) {
      return {
        outcome: "existing" as const,
        subagentId: exact.subagent_id,
        status: exact.status,
        triggerRunId: exact.trigger_run_id,
      };
    }

    const parentRuns = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN + 1);

    const sameCandidate = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_candidate", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("candidate_fingerprint", args.candidateFingerprint),
      )
      .order("desc")
      .take(5);
    const reusable = sameCandidate.find(
      (row) =>
        row.parent_trigger_run_id === args.parentTriggerRunId &&
        (isActiveStatus(row.status) || row.status === "completed"),
    );
    if (reusable) {
      return {
        outcome: "existing" as const,
        subagentId: reusable.subagent_id,
        status: reusable.status,
        triggerRunId: reusable.trigger_run_id,
      };
    }

    if (parentRuns.length >= MAX_SUBAGENTS_PER_PARENT_RUN) {
      return { outcome: "total_limit" as const };
    }
    const parentCostDollars = parentRuns.reduce(
      (total, row) => total + (row.cost_dollars ?? 0),
      0,
    );
    const childBudgetDollars =
      SUBAGENT_ORCHESTRATION_BUDGET_DOLLARS -
      SUBAGENT_PARENT_SYNTHESIS_RESERVE_DOLLARS;
    if (parentCostDollars >= childBudgetDollars) {
      return { outcome: "spend_limit" as const };
    }
    const childCostLimitDollars = Math.min(
      SUBAGENT_MAX_COST_DOLLARS,
      childBudgetDollars - parentCostDollars,
    );
    if (
      parentRuns.filter((row) => isActiveStatus(row.status)).length >=
      MAX_ACTIVE_SUBAGENTS_PER_PARENT_RUN
    ) {
      return { outcome: "active_limit" as const };
    }

    const contextRefs = [...(args.contextRefs ?? [])];
    if (args.inheritContext && contextRefs.length === 0) {
      const recentMessages = await ctx.db
        .query("messages")
        .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
        .order("desc")
        .take(12);
      const latestUserMessage = recentMessages.find(
        (message) => message.user_id === args.userId && message.role === "user",
      );
      if (latestUserMessage) {
        latestUserMessage.parts.slice(0, 2).forEach((_, partIndex) => {
          contextRefs.push({
            kind: "message_part",
            message_id: latestUserMessage.id,
            part_index: partIndex,
          });
        });
      }
    }

    const now = Date.now();
    await ctx.db.insert("subagent_runs", {
      subagent_id: args.subagentId,
      user_id: args.userId,
      organization_id: args.organizationId,
      chat_id: args.chatId,
      parent_message_id: args.parentMessageId,
      parent_tool_call_id: args.parentToolCallId,
      parent_trigger_run_id: args.parentTriggerRunId,
      profile: args.profile ?? "security_validation",
      depth: 1,
      status: "queued",
      name: args.name,
      objective: args.objective,
      success_criteria: args.successCriteria,
      inherit_context: args.inheritContext,
      skills: args.skills,
      capability_bundles: args.capabilityBundles,
      task_complexity: args.taskComplexity,
      expected_duration_minutes: args.expectedDurationMinutes,
      output_kind: args.outputKind,
      candidate: args.candidate,
      candidate_fingerprint: args.candidateFingerprint,
      context_refs: contextRefs,
      sandbox_preference: args.sandboxPreference,
      sandbox_identity: args.sandboxIdentity,
      permission_mode: args.permissionMode,
      selected_model: args.selectedModel,
      subscription: args.subscription,
      free_quota_subject: args.freeQuotaSubject,
      user_location: args.userLocation,
      cost_limit_dollars: childCostLimitDollars,
      created_at: now,
      updated_at: now,
    });
    await ctx.db.insert("subagent_work_items", {
      subagent_id: args.subagentId,
      user_id: args.userId,
      parent_trigger_run_id: args.parentTriggerRunId,
      owner: args.name ?? "Subagent",
      status: "pending",
      dependencies: [],
      refs: [],
      claims: [],
      assessed_scope: [],
      unassessed_scope: [],
      artifacts: [],
      created_at: now,
      updated_at: now,
    });
    await ctx.scheduler.runAfter(
      SUBAGENT_MAX_QUEUE_SECONDS * 1_000,
      internal.subagents.reconcileQueuedReservation,
      {
        subagentId: args.subagentId,
        expectedCreatedAt: now,
      },
    );

    return {
      outcome: "created" as const,
      subagentId: args.subagentId,
      status: "queued" as const,
    };
  },
});

export const getForBackend = query({
  args: { serviceKey: v.string(), subagentId: v.string() },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    return await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
  },
});

export const listActiveForParentBackend = query({
  args: { serviceKey: v.string(), parentTriggerRunId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = await ctx.db
      .query("subagent_runs")
      .withIndex("by_parent_run", (q) =>
        q.eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN);
    return rows.filter((row) => isActiveStatus(row.status));
  },
});

export const listForParentBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    parentTriggerRunId: v.string(),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    return await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .order("asc")
      .take(MAX_SUBAGENTS_PER_PARENT_RUN);
  },
});

export const getForParentBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    parentTriggerRunId: v.string(),
    targetAgentId: v.string(),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN + 1);
    const exact = rows.find((row) => row.subagent_id === args.targetAgentId);
    if (exact) return exact;
    const matches = rows.filter(
      (row) => toSubagentHandle(row.subagent_id) === args.targetAgentId,
    );
    return matches.length === 1 ? matches[0] : null;
  },
});

export const listActiveForUserBackend = query({
  args: { serviceKey: v.string(), userId: v.string(), limit: v.number() },
  returns: v.object({ runs: v.array(v.any()), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 100);
    const activeRows = (
      await Promise.all(
        ACTIVE_SUBAGENT_STATUSES.map((status) =>
          ctx.db
            .query("subagent_runs")
            .withIndex("by_user_and_status", (q) =>
              q.eq("user_id", args.userId).eq("status", status),
            )
            .take(limit + 1),
        ),
      )
    ).flat();
    return {
      runs: activeRows.slice(0, limit),
      hasMore: activeRows.length > limit,
    };
  },
});

export const sendMessageForBackend = mutation({
  args: {
    serviceKey: v.string(),
    targetAgentId: v.string(),
    userId: v.string(),
    chatId: v.string(),
    parentTriggerRunId: v.string(),
    parentToolCallId: v.string(),
    messageId: v.string(),
    message: v.string(),
    messageType: subagentMessageTypeValidator,
    priority: subagentMessagePriorityValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const parentRuns = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN + 1);
    const exact = parentRuns.find(
      (candidate) => candidate.subagent_id === args.targetAgentId,
    );
    const handleMatches = exact
      ? []
      : parentRuns.filter(
          (candidate) =>
            toSubagentHandle(candidate.subagent_id) === args.targetAgentId,
        );
    const run = exact ?? (handleMatches.length === 1 ? handleMatches[0] : null);
    if (!run) {
      return { outcome: "not_found" as const };
    }

    const agentName = run.name ?? run.candidate?.title ?? "Subagent";
    if (run.status !== "queued" && run.status !== "running") {
      return {
        outcome: "not_active" as const,
        subagentId: run.subagent_id,
        agentName,
        profile: run.profile,
        status: run.status,
        parentMessageId: run.parent_message_id,
      };
    }

    const existing = await ctx.db
      .query("subagent_messages")
      .withIndex("by_subagent_and_external_message_id", (q) =>
        q
          .eq("subagent_id", run.subagent_id)
          .eq("external_message_id", args.messageId),
      )
      .first();
    if (!existing) {
      const now = Date.now();
      await ctx.db.insert("subagent_messages", {
        subagent_id: run.subagent_id,
        user_id: run.user_id,
        sequence: now,
        role: "user",
        parts: [{ type: "text", text: args.message }],
        message_source: "parent_update",
        external_message_id: args.messageId,
        parent_tool_call_id: args.parentToolCallId,
        message_type: args.messageType,
        priority: args.priority,
        delivery_status: "pending",
        created_at: now,
        updated_at: now,
      });
    }

    return {
      outcome: "delivered" as const,
      subagentId: run.subagent_id,
      messageId: existing?.external_message_id ?? args.messageId,
      agentName,
      profile: run.profile,
      status: run.status,
      parentMessageId: run.parent_message_id,
    };
  },
});

export const consumePendingMessagesForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    triggerRunId: v.string(),
  },
  returns: v.array(
    v.object({
      messageId: v.string(),
      content: v.string(),
      messageType: subagentMessageTypeValidator,
      priority: subagentMessagePriorityValidator,
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const run = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (
      !run ||
      run.trigger_run_id !== args.triggerRunId ||
      run.status !== "running"
    ) {
      return [];
    }

    const pending = await ctx.db
      .query("subagent_messages")
      .withIndex("by_subagent_and_delivery_status", (q) =>
        q.eq("subagent_id", args.subagentId).eq("delivery_status", "pending"),
      )
      .order("asc")
      .take(8);
    const now = Date.now();
    await Promise.all(
      pending.map((message) =>
        ctx.db.patch(message._id, {
          delivery_status: "consumed",
          consumed_at: now,
          updated_at: now,
        }),
      ),
    );
    return pending.flatMap((message) => {
      const textPart = message.parts.find(
        (part) =>
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      ) as { text: string } | undefined;
      if (!textPart || !message.external_message_id) return [];
      return [
        {
          messageId: message.external_message_id,
          content: textPart.text,
          messageType: message.message_type ?? ("information" as const),
          priority: message.priority ?? ("normal" as const),
        },
      ];
    });
  },
});

export const claimNextTerminalForParentBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    parentTriggerRunId: v.string(),
    targetAgentIds: v.optional(v.array(v.string())),
    deliveryClaimId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .order("desc")
      .take(MAX_SUBAGENTS_PER_PARENT_RUN);
    const scopedRows = args.targetAgentIds?.length
      ? rows.filter(
          (row) =>
            args.targetAgentIds?.includes(row.subagent_id) ||
            args.targetAgentIds?.includes(toSubagentHandle(row.subagent_id)),
        )
      : rows;
    const unmatchedTargetAgentIds = (args.targetAgentIds ?? []).filter(
      (targetAgentId) =>
        !rows.some(
          (row) =>
            row.subagent_id === targetAgentId ||
            toSubagentHandle(row.subagent_id) === targetAgentId,
        ),
    );
    const active = scopedRows.filter(
      (row) => row.name !== undefined && isActiveStatus(row.status),
    );
    const unconsumedTerminalRows = scopedRows.filter(
      (row) =>
        row.name !== undefined &&
        !isActiveStatus(row.status) &&
        !row.parent_result_consumed_at,
    );
    if (unmatchedTargetAgentIds.length > 0) {
      return {
        terminal: null,
        active,
        unmatchedTargetAgentIds,
        pendingDeliveryCount: unconsumedTerminalRows.length,
      };
    }
    const now = Date.now();
    const terminal = scopedRows
      .filter(
        (row) =>
          row.name !== undefined &&
          !isActiveStatus(row.status) &&
          (Boolean(args.targetAgentIds?.length) ||
            !row.parent_result_consumed_at) &&
          (row.parent_result_consumed_at !== undefined ||
            row.parent_delivery_claim_id === args.deliveryClaimId ||
            !row.parent_delivery_claim_expires_at ||
            row.parent_delivery_claim_expires_at <= now),
      )
      .sort(
        (a, b) =>
          Number(Boolean(a.parent_result_consumed_at)) -
            Number(Boolean(b.parent_result_consumed_at)) ||
          a.created_at - b.created_at,
      )[0];
    let deliveryClaimId: string | undefined;
    if (terminal && !terminal.parent_result_consumed_at) {
      deliveryClaimId = args.deliveryClaimId;
      await ctx.db.patch(terminal._id, {
        parent_delivery_claim_id: deliveryClaimId,
        parent_delivery_claimed_at: now,
        parent_delivery_claim_expires_at:
          now + SUBAGENT_PARENT_DELIVERY_CLAIM_TTL_MS,
        updated_at: now,
      });
    }
    return {
      terminal: terminal
        ? {
            ...terminal,
          }
        : null,
      active,
      unmatchedTargetAgentIds,
      pendingDeliveryCount: unconsumedTerminalRows.length,
      deliveryClaimId,
    };
  },
});

const parentDeliveryTransitionArgs = {
  serviceKey: v.string(),
  userId: v.string(),
  chatId: v.string(),
  parentTriggerRunId: v.string(),
  subagentId: v.string(),
  deliveryClaimId: v.string(),
};

const getOwnedParentDeliveryRow = async (
  ctx: MutationCtx,
  args: {
    userId: string;
    chatId: string;
    parentTriggerRunId: string;
    subagentId: string;
  },
) => {
  const row = await ctx.db
    .query("subagent_runs")
    .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
    .unique();
  if (
    !row ||
    row.user_id !== args.userId ||
    row.chat_id !== args.chatId ||
    row.parent_trigger_run_id !== args.parentTriggerRunId
  ) {
    return null;
  }
  return row;
};

export const markResultInjectedForParentBackend = mutation({
  args: parentDeliveryTransitionArgs,
  returns: v.union(
    v.literal("updated"),
    v.literal("already_consumed"),
    v.literal("stale_claim"),
    v.literal("not_found"),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getOwnedParentDeliveryRow(ctx, args);
    if (!row) return "not_found" as const;
    if (row.parent_result_consumed_at) return "already_consumed" as const;
    if (row.parent_delivery_claim_id !== args.deliveryClaimId) {
      return "stale_claim" as const;
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      parent_result_injected_at: now,
      parent_delivery_claim_expires_at:
        now + SUBAGENT_PARENT_DELIVERY_CLAIM_TTL_MS,
      updated_at: now,
    });
    return "updated" as const;
  },
});

export const markResultConsumedForParentBackend = mutation({
  args: parentDeliveryTransitionArgs,
  returns: v.union(
    v.literal("updated"),
    v.literal("already_consumed"),
    v.literal("stale_claim"),
    v.literal("not_found"),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await getOwnedParentDeliveryRow(ctx, args);
    if (!row) return "not_found" as const;
    if (row.parent_result_consumed_at) return "already_consumed" as const;
    if (row.parent_delivery_claim_id !== args.deliveryClaimId) {
      return "stale_claim" as const;
    }
    if (!row.parent_result_injected_at) return "stale_claim" as const;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      parent_result_consumed_at: now,
      parent_notified_at: now,
      updated_at: now,
    });
    return "updated" as const;
  },
});

export const attachTriggerRunForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    triggerRunId: v.string(),
  },
  returns: v.union(
    v.literal("updated"),
    v.literal("terminal"),
    v.literal("stale"),
    v.literal("not_found"),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (!row) return "not_found" as const;
    if (row.trigger_run_id && row.trigger_run_id !== args.triggerRunId) {
      return "stale" as const;
    }
    const terminal = !isActiveStatus(row.status);
    const now = Date.now();
    await ctx.db.patch(row._id, {
      trigger_run_id: args.triggerRunId,
      status: row.status === "queued" ? "running" : row.status,
      started_at: terminal ? row.started_at : (row.started_at ?? now),
      updated_at: now,
    });
    if (!terminal) {
      await ctx.scheduler.runAfter(
        (SUBAGENT_MAX_DURATION_SECONDS + SUBAGENT_WATCHDOG_GRACE_SECONDS) *
          1_000,
        internal.subagents.reconcileAttachedRun,
        {
          subagentId: args.subagentId,
          triggerRunId: args.triggerRunId,
        },
      );
    }
    return terminal ? ("terminal" as const) : ("updated" as const);
  },
});

export const markFinalizingForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    triggerRunId: v.string(),
  },
  returns: v.union(
    v.literal("updated"),
    v.literal("pending_messages"),
    v.literal("stale"),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (
      !row ||
      row.trigger_run_id !== args.triggerRunId ||
      row.status !== "running"
    ) {
      return "stale" as const;
    }
    const pendingMessage = await ctx.db
      .query("subagent_messages")
      .withIndex("by_subagent_and_delivery_status", (q) =>
        q.eq("subagent_id", args.subagentId).eq("delivery_status", "pending"),
      )
      .first();
    if (pendingMessage) return "pending_messages" as const;
    await ctx.db.patch(row._id, {
      status: "finalizing",
      updated_at: Date.now(),
    });
    return "updated" as const;
  },
});

export const cancelForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    userId: v.string(),
    triggerRunId: v.optional(v.string()),
    reason: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (
      !row ||
      row.user_id !== args.userId ||
      row.trigger_run_id !== args.triggerRunId ||
      !isActiveStatus(row.status)
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      status: "canceled",
      summary: "Subagent was canceled.",
      cancel_reason: args.reason,
      failure_code: args.reason,
      completed_at: Date.now(),
      updated_at: Date.now(),
    });
    return true;
  },
});

export const failUnattachedForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    parentTriggerRunId: v.string(),
    failureCode: v.string(),
    summary: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (
      !row ||
      row.parent_trigger_run_id !== args.parentTriggerRunId ||
      row.trigger_run_id !== undefined ||
      row.status !== "queued"
    ) {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "failed",
      summary: args.summary,
      failure_code: args.failureCode,
      completed_at: now,
      updated_at: now,
    });
    return true;
  },
});

export const recordRecoveryForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    triggerRunId: v.string(),
    kind: v.union(v.literal("provider_retry"), v.literal("result_recovery")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (
      !row ||
      row.trigger_run_id !== args.triggerRunId ||
      !isActiveStatus(row.status)
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      ...(args.kind === "provider_retry"
        ? { provider_retry_count: (row.provider_retry_count ?? 0) + 1 }
        : { result_recovery_count: (row.result_recovery_count ?? 0) + 1 }),
      updated_at: Date.now(),
    });
    return true;
  },
});

export const reconcileQueuedReservation = internalMutation({
  args: {
    subagentId: v.string(),
    expectedCreatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (
      !row ||
      row.created_at !== args.expectedCreatedAt ||
      row.trigger_run_id !== undefined ||
      row.status !== "queued"
    ) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "failed",
      summary: "Subagent could not start within the queue limit.",
      failure_code: "queue_timeout",
      completed_at: now,
      updated_at: now,
    });
    return null;
  },
});

export const reconcileAttachedRun = internalMutation({
  args: {
    subagentId: v.string(),
    triggerRunId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (
      !row ||
      row.trigger_run_id !== args.triggerRunId ||
      !isActiveStatus(row.status)
    ) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "timed_out",
      summary: "Subagent exceeded its maximum runtime.",
      failure_code: "runtime_watchdog_timeout",
      completed_at: now,
      updated_at: now,
    });
    return null;
  },
});

export const cancelForParentBackend = mutation({
  args: {
    serviceKey: v.string(),
    parentTriggerRunId: v.string(),
    reason: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const rows = await ctx.db
      .query("subagent_runs")
      .withIndex("by_parent_run", (q) =>
        q.eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN);
    const activeRows = rows.filter((row) => isActiveStatus(row.status));
    const now = Date.now();
    await Promise.all(
      activeRows.map((row) =>
        ctx.db.patch(row._id, {
          status: "canceled",
          summary: "Subagent was canceled with its parent run.",
          cancel_reason: args.reason,
          failure_code: args.reason,
          completed_at: now,
          updated_at: now,
        }),
      ),
    );
    return activeRows.length;
  },
});

export const cancelForChatDeletionBackend = mutation({
  args: {
    serviceKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    reason: v.string(),
  },
  returns: deletionCancellationResultValidator,
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const batches = await Promise.all([
      ...ACTIVE_SUBAGENT_STATUSES.map((status) =>
        ctx.db
          .query("subagent_runs")
          .withIndex("by_chat_and_status", (q) =>
            q.eq("chat_id", args.chatId).eq("status", status),
          )
          .take(SUBAGENT_DELETION_CANCELLATION_BATCH_SIZE + 1),
      ),
      ctx.db
        .query("subagent_runs")
        .withIndex("by_chat_status_and_cancel_reason", (q) =>
          q
            .eq("chat_id", args.chatId)
            .eq("status", "canceled")
            .eq("cancel_reason", args.reason),
        )
        .take(SUBAGENT_DELETION_CANCELLATION_BATCH_SIZE + 1),
    ]);
    if (
      batches.some(
        (batch) => batch.length > SUBAGENT_DELETION_CANCELLATION_BATCH_SIZE,
      )
    ) {
      return { triggerRunIds: [], hasMore: true };
    }
    const candidateRows = batches
      .flat()
      .filter((row) => row.user_id === args.userId);
    const activeRows = candidateRows.filter((row) =>
      isActiveStatus(row.status),
    );
    const cancellationRows = candidateRows.filter(
      (row) =>
        isActiveStatus(row.status) ||
        isPendingDeletionCancellation(row, args.reason),
    );
    const now = Date.now();
    await Promise.all(
      activeRows.map((row) =>
        ctx.db.patch(row._id, {
          status: "canceled",
          summary: "Subagent was canceled because its chat was deleted.",
          cancel_reason: args.reason,
          failure_code: args.reason,
          completed_at: now,
          updated_at: now,
        }),
      ),
    );
    return {
      triggerRunIds: cancellationRows.flatMap((row) =>
        row.trigger_run_id ? [row.trigger_run_id] : [],
      ),
      hasMore: false,
    };
  },
});

export const cancelForUserDeletionBackend = mutation({
  args: { serviceKey: v.string(), userId: v.string(), reason: v.string() },
  returns: deletionCancellationResultValidator,
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const batches = await Promise.all([
      ...ACTIVE_SUBAGENT_STATUSES.map((status) =>
        ctx.db
          .query("subagent_runs")
          .withIndex("by_user_and_status", (q) =>
            q.eq("user_id", args.userId).eq("status", status),
          )
          .take(SUBAGENT_DELETION_CANCELLATION_BATCH_SIZE + 1),
      ),
      ctx.db
        .query("subagent_runs")
        .withIndex("by_user_status_and_cancel_reason", (q) =>
          q
            .eq("user_id", args.userId)
            .eq("status", "canceled")
            .eq("cancel_reason", args.reason),
        )
        .take(SUBAGENT_DELETION_CANCELLATION_BATCH_SIZE + 1),
    ]);
    if (
      batches.some(
        (batch) => batch.length > SUBAGENT_DELETION_CANCELLATION_BATCH_SIZE,
      )
    ) {
      return { triggerRunIds: [], hasMore: true };
    }
    const candidateRows = batches.flat();
    const activeRows = candidateRows.filter((row) =>
      isActiveStatus(row.status),
    );
    const cancellationRows = candidateRows.filter(
      (row) =>
        isActiveStatus(row.status) ||
        isPendingDeletionCancellation(row, args.reason),
    );
    const now = Date.now();
    await Promise.all(
      activeRows.map((row) =>
        ctx.db.patch(row._id, {
          status: "canceled",
          summary: "Subagent was canceled during data deletion.",
          cancel_reason: args.reason,
          failure_code: args.reason,
          completed_at: now,
          updated_at: now,
        }),
      ),
    );
    return {
      triggerRunIds: cancellationRows.flatMap((row) =>
        row.trigger_run_id ? [row.trigger_run_id] : [],
      ),
      hasMore: false,
    };
  },
});

export const finishForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    triggerRunId: v.string(),
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled"),
      v.literal("timed_out"),
    ),
    summary: v.string(),
    verdict: v.optional(verdictValidator),
    confidence: v.optional(confidenceValidator),
    structuredResult: v.optional(v.any()),
    failureCode: v.optional(v.string()),
    failureReason: v.optional(v.string()),
    cancelReason: v.optional(v.string()),
    costDollars: v.optional(v.number()),
    stepCount: v.optional(v.number()),
  },
  returns: v.union(
    v.literal("updated"),
    v.literal("stale"),
    v.literal("not_found"),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (!row) return "not_found" as const;
    if (row.trigger_run_id && row.trigger_run_id !== args.triggerRunId) {
      return "stale" as const;
    }
    const isCanceledUsageFinalization =
      row.status === "canceled" &&
      args.status === "canceled" &&
      (args.costDollars !== undefined || args.stepCount !== undefined);
    if (!isActiveStatus(row.status) && !isCanceledUsageFinalization) {
      return "stale" as const;
    }
    await ctx.db.patch(row._id, {
      status: args.status,
      summary: isCanceledUsageFinalization
        ? (row.summary ?? args.summary)
        : args.summary,
      verdict: isCanceledUsageFinalization ? row.verdict : args.verdict,
      confidence: isCanceledUsageFinalization
        ? row.confidence
        : args.confidence,
      structured_result: isCanceledUsageFinalization
        ? row.structured_result
        : args.structuredResult,
      failure_code: isCanceledUsageFinalization
        ? (row.failure_code ?? args.failureCode)
        : args.failureCode,
      failure_reason: isCanceledUsageFinalization
        ? (row.failure_reason ?? args.failureReason)
        : args.failureReason,
      cancel_reason: isCanceledUsageFinalization
        ? (row.cancel_reason ?? args.cancelReason)
        : args.cancelReason,
      cost_dollars:
        args.costDollars === undefined
          ? row.cost_dollars
          : (row.continuation_count ?? 0) > 0
            ? (row.cost_dollars ?? 0) + args.costDollars
            : args.costDollars,
      step_count:
        args.stepCount === undefined
          ? row.step_count
          : (row.continuation_count ?? 0) > 0
            ? (row.step_count ?? 0) + args.stepCount
            : args.stepCount,
      completed_at: isCanceledUsageFinalization
        ? (row.completed_at ?? Date.now())
        : Date.now(),
      updated_at: Date.now(),
    });
    return "updated" as const;
  },
});

export const saveMessageForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    userId: v.string(),
    sequence: v.number(),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    parts: v.array(v.any()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const run = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (!run || run.user_id !== args.userId) return false;

    const existing = await ctx.db
      .query("subagent_messages")
      .withIndex("by_subagent_and_sequence", (q) =>
        q.eq("subagent_id", args.subagentId).eq("sequence", args.sequence),
      )
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        role: args.role,
        parts: args.parts,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("subagent_messages", {
        subagent_id: args.subagentId,
        user_id: args.userId,
        sequence: args.sequence,
        role: args.role,
        parts: args.parts,
        created_at: now,
        updated_at: now,
      });
    }
    return true;
  },
});

export const getMessagesForBackend = query({
  args: { serviceKey: v.string(), subagentId: v.string(), userId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const run = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (!run || run.user_id !== args.userId) return [];
    return await ctx.db
      .query("subagent_messages")
      .withIndex("by_subagent_and_created_at", (q) =>
        q.eq("subagent_id", args.subagentId),
      )
      .order("asc")
      .take(200);
  },
});

export const listForParentMessage = query({
  args: { parentMessageId: v.string() },
  returns: v.array(subagentSummaryValidator),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_and_parent_message", (q) =>
        q
          .eq("user_id", identity.subject)
          .eq("parent_message_id", args.parentMessageId),
      )
      .order("desc")
      .take(MAX_SUBAGENTS_PER_PARENT_RUN);
    return rows.map(toSummary);
  },
});

export const getOwned = query({
  args: { subagentId: v.string() },
  returns: v.union(subagentSummaryValidator, v.null()),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    return row?.user_id === identity.subject ? toSummary(row) : null;
  },
});

export const getMessagesOwned = query({
  args: { subagentId: v.string() },
  returns: v.array(
    v.object({
      message_id: v.id("subagent_messages"),
      sequence: v.number(),
      role: v.union(
        v.literal("user"),
        v.literal("assistant"),
        v.literal("system"),
      ),
      parts: v.array(v.any()),
      feedback_type: v.optional(messageFeedbackValidator),
      message_source: v.optional(v.literal("parent_update")),
      message_type: v.optional(subagentMessageTypeValidator),
      priority: v.optional(subagentMessagePriorityValidator),
      created_at: v.number(),
      updated_at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const run = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (!run || run.user_id !== identity.subject) return [];
    const rows = await ctx.db
      .query("subagent_messages")
      .withIndex("by_subagent_and_created_at", (q) =>
        q.eq("subagent_id", args.subagentId),
      )
      .order("asc")
      .take(200);
    return rows.map((row) => ({
      message_id: row._id,
      sequence: row.sequence,
      role: row.role,
      parts: row.parts,
      feedback_type: row.feedback_type,
      message_source: row.message_source,
      message_type: row.message_type,
      priority: row.priority,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  },
});

export const setMessageFeedback = mutation({
  args: {
    messageId: v.id("subagent_messages"),
    feedbackType: messageFeedbackValidator,
    feedbackDetails: v.optional(v.string()),
  },
  returns: v.union(v.literal("updated"), v.literal("not_found")),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const message = await ctx.db.get(args.messageId);
    if (!message) return "not_found" as const;
    if (message.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Unauthorized: User cannot rate this subagent message",
      });
    }
    if (message.role !== "assistant") {
      throw new ConvexError({
        code: "INVALID_MESSAGE",
        message: "Only subagent responses can be rated",
      });
    }

    await ctx.db.patch(message._id, {
      feedback_type: args.feedbackType,
      feedback_details: args.feedbackDetails,
      updated_at: Date.now(),
    });
    return "updated" as const;
  },
});

export const requireOwnedForBackend = query({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    userId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (!row || row.user_id !== args.userId) {
      throw new ConvexError("Subagent not found");
    }
    return row;
  },
});

export const resolveContextForBackend = query({
  args: { serviceKey: v.string(), subagentId: v.string() },
  returns: v.array(
    v.object({
      label: v.string(),
      content: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const run = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (!run) return [];

    const resolved: Array<{ label: string; content: string }> = [];
    // Keep delegated context well below the parent transcript size. The child
    // can inspect referenced sandbox paths with tools when more detail is needed.
    let remainingCharacters = 48_000;
    const append = (label: string, value: unknown) => {
      if (remainingCharacters <= 0) return;
      const serialized =
        typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const content = serialized.slice(
        0,
        Math.min(12_000, remainingCharacters),
      );
      remainingCharacters -= content.length;
      resolved.push({ label, content });
    };

    for (const rawRef of run.context_refs.slice(0, 8)) {
      if (!rawRef || typeof rawRef !== "object") continue;
      const ref = rawRef as Record<string, unknown>;
      if (ref.kind === "sandbox_file" && typeof ref.path === "string") {
        append(
          "Sandbox file reference",
          `${ref.path}${typeof ref.start_line === "number" ? `:${ref.start_line}` : ""}${typeof ref.end_line === "number" ? `-${ref.end_line}` : ""}`,
        );
        continue;
      }
      if (ref.kind === "note" && typeof ref.note_id === "string") {
        const note = await ctx.db
          .query("notes")
          .withIndex("by_note_id", (q) =>
            q.eq("note_id", ref.note_id as string),
          )
          .first();
        if (note?.user_id === run.user_id) {
          append(`Note: ${note.title}`, note.content);
        }
        continue;
      }
      if (
        (ref.kind === "message_part" || ref.kind === "tool_call") &&
        typeof ref.message_id === "string"
      ) {
        const message = await ctx.db
          .query("messages")
          .withIndex("by_message_id", (q) =>
            q.eq("id", ref.message_id as string),
          )
          .first();
        if (
          !message ||
          message.user_id !== run.user_id ||
          message.chat_id !== run.chat_id
        ) {
          continue;
        }
        if (ref.kind === "message_part" && typeof ref.part_index === "number") {
          const part = message.parts[ref.part_index];
          if (part !== undefined) append("Parent message evidence", part);
          continue;
        }
        if (ref.kind === "tool_call" && typeof ref.tool_call_id === "string") {
          const part = message.parts.find(
            (candidate) =>
              candidate &&
              typeof candidate === "object" &&
              "toolCallId" in candidate &&
              candidate.toolCallId === ref.tool_call_id,
          );
          if (part !== undefined) append("Parent tool evidence", part);
        }
      }
    }

    return resolved;
  },
});

export const recordEventForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    triggerRunId: v.string(),
    eventType: v.union(
      v.literal("progress"),
      v.literal("question"),
      v.literal("blocker"),
      v.literal("artifact"),
      v.literal("result"),
    ),
    message: v.string(),
    refs: v.array(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (
      !row ||
      row.trigger_run_id !== args.triggerRunId ||
      !isActiveStatus(row.status)
    ) {
      return false;
    }
    const eventCount = (
      await ctx.db
        .query("subagent_events")
        .withIndex("by_subagent", (q) => q.eq("subagent_id", args.subagentId))
        .take(MAX_SUBAGENT_PROGRESS_EVENTS + 1)
    ).length;
    if (eventCount >= MAX_SUBAGENT_PROGRESS_EVENTS) return false;
    await ctx.db.insert("subagent_events", {
      subagent_id: row.subagent_id,
      user_id: row.user_id,
      parent_trigger_run_id: row.parent_trigger_run_id,
      event_type: args.eventType,
      message: args.message,
      refs: args.refs,
      created_at: Date.now(),
    });
    return true;
  },
});

export const consumeEventsForParentBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    parentTriggerRunId: v.string(),
    targetAgentIds: v.optional(v.array(v.string())),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const runs = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN);
    const scopedRuns = args.targetAgentIds?.length
      ? runs.filter((run) =>
          args.targetAgentIds?.some(
            (target) =>
              target === run.subagent_id ||
              target === toSubagentHandle(run.subagent_id),
          ),
        )
      : runs;
    const allowed = new Map(
      scopedRuns.map((run) => [run.subagent_id, run.name ?? "Subagent"]),
    );
    const events = await ctx.db
      .query("subagent_events")
      .withIndex("by_parent_run_and_consumed_at", (q) =>
        q
          .eq("parent_trigger_run_id", args.parentTriggerRunId)
          .eq("consumed_at", undefined),
      )
      .order("asc")
      .take(MAX_SUBAGENTS_PER_PARENT_RUN * MAX_SUBAGENT_PROGRESS_EVENTS);
    const pending = events
      .filter((event) => allowed.has(event.subagent_id))
      .slice(0, 8);
    const now = Date.now();
    await Promise.all(
      pending.map((event) => ctx.db.patch(event._id, { consumed_at: now })),
    );
    return pending.map((event) => ({
      agentId: event.subagent_id,
      agentName: allowed.get(event.subagent_id),
      eventType: event.event_type,
      message: event.message,
      refs: event.refs,
      createdAt: event.created_at,
    }));
  },
});

export const updateWorkLedgerForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    triggerRunId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("in_progress"),
      v.literal("blocked"),
      v.literal("completed"),
    ),
    dependencies: v.array(v.string()),
    refs: v.array(v.string()),
    claims: v.array(v.object({ claim: v.string(), provenance: v.string() })),
    assessedScope: v.array(v.string()),
    unassessedScope: v.array(v.string()),
    artifacts: v.array(
      v.object({ path: v.string(), description: v.optional(v.string()) }),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const run = await ctx.db
      .query("subagent_runs")
      .withIndex("by_subagent_id", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (
      !run ||
      run.trigger_run_id !== args.triggerRunId ||
      !isActiveStatus(run.status)
    )
      return false;
    const item = await ctx.db
      .query("subagent_work_items")
      .withIndex("by_subagent", (q) => q.eq("subagent_id", args.subagentId))
      .first();
    if (!item) return false;
    await ctx.db.patch(item._id, {
      status: args.status,
      dependencies: args.dependencies,
      refs: args.refs,
      claims: args.claims,
      assessed_scope: args.assessedScope,
      unassessed_scope: args.unassessedScope,
      artifacts: args.artifacts,
      updated_at: Date.now(),
    });
    return true;
  },
});

export const listWorkLedgerForParentBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    parentTriggerRunId: v.string(),
  },
  returns: v.array(workLedgerSummaryValidator),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const runs = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN);
    const ids = new Set(runs.map((run) => run.subagent_id));
    const items = await ctx.db
      .query("subagent_work_items")
      .withIndex("by_parent_run", (q) =>
        q.eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN);
    return items
      .filter((item) => ids.has(item.subagent_id))
      .map((item) => ({
        subagent_id: item.subagent_id,
        owner: item.owner,
        status: item.status,
        dependencies: item.dependencies,
        refs: item.refs,
        claims: item.claims,
        assessed_scope: item.assessed_scope,
        unassessed_scope: item.unassessed_scope,
        artifacts: item.artifacts,
        updated_at: item.updated_at,
      }));
  },
});

export const resumeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    parentTriggerRunId: v.string(),
    targetAgentId: v.string(),
    followUp: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.userId)) {
      return { outcome: "not_found" as const };
    }
    if (!(await isSubagentChatAvailable(ctx, args.userId, args.chatId))) {
      return { outcome: "not_found" as const };
    }
    const rows = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.parentTriggerRunId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN);
    const row = rows.find(
      (candidate) =>
        candidate.subagent_id === args.targetAgentId ||
        toSubagentHandle(candidate.subagent_id) === args.targetAgentId,
    );
    if (!row) return { outcome: "not_found" as const };
    if (row.profile !== "general" || row.status !== "completed")
      return { outcome: "not_resumable" as const };
    if (
      rows.filter((candidate) => isActiveStatus(candidate.status)).length >=
      MAX_ACTIVE_SUBAGENTS_PER_PARENT_RUN
    )
      return { outcome: "active_limit" as const };
    const childBudgetDollars =
      SUBAGENT_ORCHESTRATION_BUDGET_DOLLARS -
      SUBAGENT_PARENT_SYNTHESIS_RESERVE_DOLLARS;
    const spentDollars = rows.reduce(
      (total, candidate) => total + (candidate.cost_dollars ?? 0),
      0,
    );
    const remainingDollars = childBudgetDollars - spentDollars;
    if (remainingDollars <= 0) return { outcome: "spend_limit" as const };
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "queued",
      trigger_run_id: undefined,
      continuation_count: (row.continuation_count ?? 0) + 1,
      continuation_prompt: args.followUp,
      cost_limit_dollars: Math.min(SUBAGENT_MAX_COST_DOLLARS, remainingDollars),
      summary: undefined,
      structured_result: undefined,
      failure_code: undefined,
      failure_reason: undefined,
      cancel_reason: undefined,
      parent_delivery_claim_id: undefined,
      parent_delivery_claimed_at: undefined,
      parent_delivery_claim_expires_at: undefined,
      parent_result_injected_at: undefined,
      parent_result_consumed_at: undefined,
      parent_notified_at: undefined,
      completed_at: undefined,
      updated_at: now,
    });
    await ctx.scheduler.runAfter(
      SUBAGENT_MAX_QUEUE_SECONDS * 1_000,
      internal.subagents.reconcileQueuedReservation,
      { subagentId: row.subagent_id, expectedCreatedAt: row.created_at },
    );
    return { outcome: "resumed" as const, subagentId: row.subagent_id };
  },
});
