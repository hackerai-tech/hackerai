import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";

const MAX_SUBAGENTS_PER_PARENT_RUN = 3;
const MAX_ACTIVE_SUBAGENTS_PER_PARENT_RUN = 1;
const MAX_SUBAGENT_COST_DOLLARS = 1;
const MAX_PARENT_SUBAGENT_COST_DOLLARS = 3;

const statusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("finalizing"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
  v.literal("timed_out"),
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
  profile: v.literal("security_validation"),
  status: statusValidator,
  candidate: candidateValidator,
  summary: v.optional(v.string()),
  verdict: v.optional(verdictValidator),
  confidence: v.optional(confidenceValidator),
  failure_code: v.optional(v.string()),
  failure_reason: v.optional(v.string()),
  cancel_reason: v.optional(v.string()),
  report_id: v.optional(v.string()),
  cost_dollars: v.optional(v.number()),
  step_count: v.optional(v.number()),
  created_at: v.number(),
  started_at: v.optional(v.number()),
  completed_at: v.optional(v.number()),
  updated_at: v.number(),
});

const isActiveStatus = (status: string): boolean =>
  status === "queued" || status === "running" || status === "finalizing";

const toSummary = (row: {
  subagent_id: string;
  parent_trigger_run_id: string;
  parent_message_id: string;
  parent_tool_call_id: string;
  trigger_run_id?: string;
  profile: "security_validation";
  status:
    | "queued"
    | "running"
    | "finalizing"
    | "completed"
    | "failed"
    | "canceled"
    | "timed_out";
  candidate: {
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
  report_id?: string;
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
  candidate: row.candidate,
  summary: row.summary,
  verdict: row.verdict,
  confidence: row.confidence,
  failure_code: row.failure_code,
  failure_reason: row.failure_reason,
  cancel_reason: row.cancel_reason,
  report_id: row.report_id,
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
    objective: v.string(),
    candidate: candidateValidator,
    candidateFingerprint: v.string(),
    contextRefs: v.array(v.any()),
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

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .first();
    if (
      !chat ||
      chat.user_id !== args.userId ||
      chat.deletion_started_at !== undefined
    ) {
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
    if (parentCostDollars >= MAX_PARENT_SUBAGENT_COST_DOLLARS) {
      return { outcome: "spend_limit" as const };
    }
    const childCostLimitDollars = Math.min(
      MAX_SUBAGENT_COST_DOLLARS,
      MAX_PARENT_SUBAGENT_COST_DOLLARS - parentCostDollars,
    );
    if (
      parentRuns.filter((row) => isActiveStatus(row.status)).length >=
      MAX_ACTIVE_SUBAGENTS_PER_PARENT_RUN
    ) {
      return { outcome: "active_limit" as const };
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
      profile: "security_validation",
      depth: 1,
      status: "queued",
      objective: args.objective,
      candidate: args.candidate,
      candidate_fingerprint: args.candidateFingerprint,
      context_refs: args.contextRefs,
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

export const attachTriggerRunForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    triggerRunId: v.string(),
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
    await ctx.db.patch(row._id, {
      trigger_run_id: args.triggerRunId,
      status: row.status === "queued" ? "running" : row.status,
      started_at: row.started_at ?? Date.now(),
      updated_at: Date.now(),
    });
    return "updated" as const;
  },
});

export const markFinalizingForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    triggerRunId: v.string(),
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
      row.status !== "running"
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      status: "finalizing",
      updated_at: Date.now(),
    });
    return true;
  },
});

export const cancelForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    userId: v.string(),
    triggerRunId: v.string(),
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
      summary: "Independent validation was canceled.",
      cancel_reason: args.reason,
      failure_code: args.reason,
      completed_at: Date.now(),
      updated_at: Date.now(),
    });
    return true;
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
          summary: "Independent validation was canceled with its parent run.",
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
      verdict: args.verdict,
      confidence: args.confidence,
      structured_result: args.structuredResult,
      failure_code: isCanceledUsageFinalization
        ? (row.failure_code ?? args.failureCode)
        : args.failureCode,
      failure_reason: args.failureReason,
      cancel_reason: isCanceledUsageFinalization
        ? (row.cancel_reason ?? args.cancelReason)
        : args.cancelReason,
      cost_dollars: args.costDollars ?? row.cost_dollars,
      step_count: args.stepCount ?? row.step_count,
      completed_at: Date.now(),
      updated_at: Date.now(),
    });
    return "updated" as const;
  },
});

export const acknowledgeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    subagentId: v.string(),
    parentTriggerRunId: v.string(),
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
      row.status !== "completed"
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      acknowledged_by_parent_run_id: args.parentTriggerRunId,
      updated_at: Date.now(),
    });
    return true;
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
      sequence: v.number(),
      role: v.union(
        v.literal("user"),
        v.literal("assistant"),
        v.literal("system"),
      ),
      parts: v.array(v.any()),
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
      .withIndex("by_subagent_and_sequence", (q) =>
        q.eq("subagent_id", args.subagentId),
      )
      .order("asc")
      .take(200);
    return rows.map((row) => ({
      sequence: row.sequence,
      role: row.role,
      parts: row.parts,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
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
