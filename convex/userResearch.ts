import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { validateUserResearchServiceKey } from "./lib/userResearchAuth";
import {
  researchCohortReportValidator,
  researchCoverageValidator,
  researchSamplingModeValidator,
  researchUserProfileValidator,
} from "./userResearchValidators";

const MIN_RESEARCH_COHORT_SIZE = 3;
const MAX_RESEARCH_COHORT_SIZE = 20;
const MIN_CHATS_PER_USER = 3;
const MAX_CHATS_PER_USER = 20;
const MIN_MESSAGES_PER_CHAT = 20;
const MAX_MESSAGES_PER_CHAT = 120;
const MAX_MESSAGE_CHARS = 8_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_EVIDENCE_WINDOW_DAYS = 365;
const MAX_SELECTION_LIMITATIONS = 8;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;

const researchChatValidator = v.object({
  chatId: v.string(),
  updatedAt: v.number(),
  mode: v.union(v.literal("ask"), v.literal("agent"), v.literal("unknown")),
  sandboxType: v.optional(v.string()),
  selectedModel: v.optional(v.string()),
});

const researchMessageValidator = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  text: v.string(),
});

const usageFields = {
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  costDollars: v.optional(v.number()),
};

type ResearchCtx = MutationCtx | QueryCtx;

const assertIntegerInRange = (
  value: number,
  min: number,
  max: number,
  field: string,
) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConvexError(`${field} must be an integer from ${min} to ${max}`);
  }
};

const researchMode = (
  value: string | undefined,
): "ask" | "agent" | "unknown" => {
  if (value === "ask") return "ask";
  if (value === "agent" || value === "agent-long") return "agent";
  return "unknown";
};

const extractText = (parts: unknown[]): string =>
  parts
    .flatMap((part) => {
      if (
        !part ||
        typeof part !== "object" ||
        !("type" in part) ||
        !("text" in part)
      ) {
        return [];
      }
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("\n")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);

const getRunningResearchMember = async (
  ctx: ResearchCtx,
  analysisId: string,
  userId: string,
) => {
  const run = await ctx.db
    .query("research_runs")
    .withIndex("by_analysis_id", (q) => q.eq("analysis_id", analysisId))
    .unique();
  if (!run || run.status !== "running") {
    throw new ConvexError("Research run is not active");
  }
  const member = await ctx.db
    .query("research_run_members")
    .withIndex("by_analysis_and_user", (q) =>
      q.eq("analysis_id", analysisId).eq("user_id", userId),
    )
    .unique();
  if (!member) {
    throw new ConvexError("User is not part of this research run");
  }
  return { run, member };
};

export const createRun = mutation({
  args: {
    serviceKey: v.string(),
    analysisId: v.string(),
    linearIssueId: v.optional(v.string()),
    question: v.string(),
    cohortLabel: v.string(),
    requestedBy: v.string(),
    cohortSource: v.literal("posthog"),
    posthogProjectId: v.number(),
    cohortSelectedAt: v.number(),
    selectionQueryFingerprint: v.string(),
    selectionLimitations: v.array(v.string()),
    samplingMode: researchSamplingModeValidator,
    evidenceWindowDays: v.optional(v.number()),
    members: v.array(
      v.object({
        userId: v.string(),
        pseudonym: v.string(),
        evidenceAnchorAt: v.optional(v.number()),
      }),
    ),
    maxChatsPerUser: v.number(),
    model: v.string(),
    reasoningEnabled: v.boolean(),
    reasoningEffort: v.literal("low"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateUserResearchServiceKey(args.serviceKey);
    assertIntegerInRange(
      args.members.length,
      MIN_RESEARCH_COHORT_SIZE,
      MAX_RESEARCH_COHORT_SIZE,
      "cohortSize",
    );
    assertIntegerInRange(
      args.maxChatsPerUser,
      MIN_CHATS_PER_USER,
      MAX_CHATS_PER_USER,
      "maxChatsPerUser",
    );
    if (
      !Number.isInteger(args.posthogProjectId) ||
      args.posthogProjectId <= 0
    ) {
      throw new ConvexError("posthogProjectId must be a positive integer");
    }
    if (
      !Number.isInteger(args.cohortSelectedAt) ||
      args.cohortSelectedAt <= 0
    ) {
      throw new ConvexError("cohortSelectedAt must be a positive timestamp");
    }
    if (!SHA_256_PATTERN.test(args.selectionQueryFingerprint)) {
      throw new ConvexError(
        "selectionQueryFingerprint must be a SHA-256 hex digest",
      );
    }
    if (args.selectionLimitations.length > MAX_SELECTION_LIMITATIONS) {
      throw new ConvexError("selectionLimitations exceeds the bounded limit");
    }
    if (
      args.selectionLimitations.some(
        (limitation) =>
          limitation.trim().length === 0 || limitation.length > 300,
      )
    ) {
      throw new ConvexError("selectionLimitations contains an invalid entry");
    }
    if (args.samplingMode === "pre_event") {
      if (args.evidenceWindowDays === undefined) {
        throw new ConvexError(
          "evidenceWindowDays is required for pre_event sampling",
        );
      }
      assertIntegerInRange(
        args.evidenceWindowDays,
        1,
        MAX_EVIDENCE_WINDOW_DAYS,
        "evidenceWindowDays",
      );
      if (
        args.members.some(
          (member) =>
            member.evidenceAnchorAt === undefined ||
            !Number.isInteger(member.evidenceAnchorAt) ||
            member.evidenceAnchorAt <= 0 ||
            member.evidenceAnchorAt > args.cohortSelectedAt,
        )
      ) {
        throw new ConvexError(
          "Every pre_event member requires an evidenceAnchorAt no later than cohort selection",
        );
      }
    } else if (
      args.evidenceWindowDays !== undefined ||
      args.members.some((member) => member.evidenceAnchorAt !== undefined)
    ) {
      throw new ConvexError(
        "Evidence windows and anchors require pre_event sampling",
      );
    }

    const existing = await ctx.db
      .query("research_runs")
      .withIndex("by_analysis_id", (q) => q.eq("analysis_id", args.analysisId))
      .unique();
    if (existing) {
      if (
        existing.linear_issue_id !== args.linearIssueId ||
        existing.question !== args.question ||
        existing.cohort_label !== args.cohortLabel ||
        existing.requested_by !== args.requestedBy ||
        existing.cohort_source !== args.cohortSource ||
        existing.posthog_project_id !== args.posthogProjectId ||
        existing.cohort_selected_at !== args.cohortSelectedAt ||
        existing.selection_query_fingerprint !==
          args.selectionQueryFingerprint ||
        JSON.stringify(existing.selection_limitations ?? []) !==
          JSON.stringify(args.selectionLimitations) ||
        (existing.sampling_mode ?? "representative") !== args.samplingMode ||
        existing.evidence_window_days !== args.evidenceWindowDays ||
        existing.cohort_size !== args.members.length ||
        existing.max_chats_per_user !== args.maxChatsPerUser ||
        existing.model !== args.model ||
        existing.reasoning_enabled !== args.reasoningEnabled ||
        existing.reasoning_effort !== args.reasoningEffort
      ) {
        throw new ConvexError("analysisId already belongs to another run");
      }
      const existingMembers = await ctx.db
        .query("research_run_members")
        .withIndex("by_analysis_and_user", (q) =>
          q.eq("analysis_id", args.analysisId),
        )
        .take(MAX_RESEARCH_COHORT_SIZE + 1);
      const expectedMembers = args.members
        .map(
          (member) =>
            `${member.userId}:${member.pseudonym}:${member.evidenceAnchorAt ?? ""}`,
        )
        .sort();
      const actualMembers = existingMembers
        .map(
          (member) =>
            `${member.user_id}:${member.pseudonym}:${member.evidence_anchor_at ?? ""}`,
        )
        .sort();
      if (JSON.stringify(expectedMembers) !== JSON.stringify(actualMembers)) {
        throw new ConvexError("analysisId already belongs to another run");
      }
      return null;
    }

    if (
      new Set(args.members.map((member) => member.userId)).size !==
        args.members.length ||
      new Set(args.members.map((member) => member.pseudonym)).size !==
        args.members.length
    ) {
      throw new ConvexError("Research run members must be unique");
    }

    const now = Date.now();
    await ctx.db.insert("research_runs", {
      analysis_id: args.analysisId,
      ...(args.linearIssueId ? { linear_issue_id: args.linearIssueId } : {}),
      question: args.question,
      cohort_label: args.cohortLabel,
      requested_by: args.requestedBy,
      cohort_source: args.cohortSource,
      posthog_project_id: args.posthogProjectId,
      cohort_selected_at: args.cohortSelectedAt,
      selection_query_fingerprint: args.selectionQueryFingerprint,
      selection_limitations: args.selectionLimitations,
      sampling_mode: args.samplingMode,
      ...(args.evidenceWindowDays !== undefined
        ? { evidence_window_days: args.evidenceWindowDays }
        : {}),
      cohort_size: args.members.length,
      max_chats_per_user: args.maxChatsPerUser,
      model: args.model,
      reasoning_enabled: args.reasoningEnabled,
      reasoning_effort: args.reasoningEffort,
      status: "queued",
      profiles_completed: 0,
      profiles_failed: 0,
      created_at: now,
      updated_at: now,
    });
    await Promise.all(
      args.members.map((member) =>
        ctx.db.insert("research_run_members", {
          analysis_id: args.analysisId,
          user_id: member.userId,
          pseudonym: member.pseudonym,
          ...(member.evidenceAnchorAt !== undefined
            ? { evidence_anchor_at: member.evidenceAnchorAt }
            : {}),
          created_at: now,
        }),
      ),
    );
    return null;
  },
});

export const markRunRunning = mutation({
  args: { serviceKey: v.string(), analysisId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateUserResearchServiceKey(args.serviceKey);
    const run = await ctx.db
      .query("research_runs")
      .withIndex("by_analysis_id", (q) => q.eq("analysis_id", args.analysisId))
      .unique();
    if (!run || run.status !== "queued") {
      throw new ConvexError("Research run is not queued");
    }
    await ctx.db.patch(run._id, {
      status: "running",
      error: undefined,
      updated_at: Date.now(),
    });
    return null;
  },
});

/** Select bounded chats across either lifetime history or a pre-event window. */
export const listRepresentativeChats = query({
  args: {
    serviceKey: v.string(),
    analysisId: v.string(),
    userId: v.string(),
    maxChats: v.number(),
  },
  returns: v.array(researchChatValidator),
  handler: async (ctx, args) => {
    validateUserResearchServiceKey(args.serviceKey);
    const { run, member } = await getRunningResearchMember(
      ctx,
      args.analysisId,
      args.userId,
    );
    assertIntegerInRange(
      args.maxChats,
      MIN_CHATS_PER_USER,
      MAX_CHATS_PER_USER,
      "maxChats",
    );

    const samplingMode = run.sampling_mode ?? "representative";
    const evidenceWindowEndAt = member.evidence_anchor_at;
    const evidenceWindowDays = run.evidence_window_days;
    if (
      samplingMode === "pre_event" &&
      (evidenceWindowEndAt === undefined || evidenceWindowDays === undefined)
    ) {
      throw new ConvexError("Pre-event research evidence window is incomplete");
    }
    const evidenceWindowStartAt =
      evidenceWindowEndAt !== undefined && evidenceWindowDays !== undefined
        ? evidenceWindowEndAt - evidenceWindowDays * DAY_MS
        : undefined;

    const queryChats = (minimumUpdatedAt?: number) =>
      ctx.db.query("chats").withIndex("by_user_and_updated", (q) => {
        const scoped = q.eq("user_id", args.userId);
        const lowerBound =
          minimumUpdatedAt ??
          (samplingMode === "pre_event" ? evidenceWindowStartAt : undefined);
        if (lowerBound === undefined) return scoped;
        const afterLowerBound = scoped.gte("update_time", lowerBound);
        return samplingMode === "pre_event"
          ? afterLowerBound.lte("update_time", evidenceWindowEndAt!)
          : afterLowerBound;
      });
    const oldest = await queryChats().order("asc").first();
    const newest = await queryChats().order("desc").first();
    if (!oldest || !newest) return [];

    const selected = new Map<string, typeof oldest>();
    const span = Math.max(0, newest.update_time - oldest.update_time);
    const bucketCount = Math.min(args.maxChats, span === 0 ? 1 : args.maxChats);

    const bucketCandidates = await Promise.all(
      Array.from({ length: bucketCount }, (_, index) => {
        const target =
          bucketCount === 1
            ? oldest.update_time
            : oldest.update_time + (span * index) / (bucketCount - 1);
        return queryChats(target).order("asc").take(3);
      }),
    );
    for (const candidates of bucketCandidates) {
      const chat = candidates.find(
        (candidate) => !candidate.deletion_started_at,
      );
      if (chat) selected.set(chat.id, chat);
    }

    if (selected.size < args.maxChats) {
      const recent = await queryChats()
        .order("desc")
        .take(args.maxChats * 3);
      for (const chat of recent) {
        if (!chat.deletion_started_at) selected.set(chat.id, chat);
        if (selected.size >= args.maxChats) break;
      }
    }

    return Array.from(selected.values())
      .sort((a, b) => a.update_time - b.update_time)
      .slice(0, args.maxChats)
      .map((chat) => ({
        chatId: chat.id,
        updatedAt: chat.update_time,
        mode: researchMode(chat.default_model_slug),
        ...(chat.sandbox_type ? { sandboxType: chat.sandbox_type } : {}),
        ...(chat.selected_model ? { selectedModel: chat.selected_model } : {}),
      }));
  },
});

/**
 * Return text-only excerpts from both ends of a chat. Files, tool outputs,
 * reasoning parts, system messages, message IDs, and hidden messages are never
 * exposed to the research worker.
 */
export const getMessageExcerpt = query({
  args: {
    serviceKey: v.string(),
    analysisId: v.string(),
    userId: v.string(),
    chatId: v.string(),
    maxMessages: v.number(),
  },
  returns: v.object({
    messages: v.array(researchMessageValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateUserResearchServiceKey(args.serviceKey);
    await getRunningResearchMember(ctx, args.analysisId, args.userId);
    assertIntegerInRange(
      args.maxMessages,
      MIN_MESSAGES_PER_CHAT,
      MAX_MESSAGES_PER_CHAT,
      "maxMessages",
    );

    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .unique();
    if (!chat || chat.user_id !== args.userId || chat.deletion_started_at) {
      return { messages: [], truncated: false };
    }

    const firstLimit = Math.ceil(args.maxMessages / 2);
    const lastLimit = Math.floor(args.maxMessages / 2);
    const first = await ctx.db
      .query("messages")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .order("asc")
      .take(firstLimit + 1);
    const last = await ctx.db
      .query("messages")
      .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
      .order("desc")
      .take(lastLimit + 1);

    const selectedFirst = first.slice(0, firstLimit);
    const selectedLast = last.slice(0, lastLimit);
    const byId = new Map(
      [...selectedFirst, ...selectedLast].map((message) => [
        message._id,
        message,
      ]),
    );
    const lookaheads = [first[firstLimit], last[lastLimit]].filter(
      (message) => message !== undefined,
    );
    const messages = Array.from(byId.values())
      .sort((a, b) => a._creationTime - b._creationTime)
      .flatMap((message) => {
        if (
          message.is_hidden === true ||
          (message.role !== "user" && message.role !== "assistant")
        ) {
          return [];
        }
        const text = extractText(message.parts);
        return text ? [{ role: message.role, text }] : [];
      });

    return {
      messages,
      truncated: lookaheads.some((message) => !byId.has(message._id)),
    };
  },
});

export const saveUserProfile = mutation({
  args: {
    serviceKey: v.string(),
    analysisId: v.string(),
    userId: v.string(),
    pseudonym: v.string(),
    profile: researchUserProfileValidator,
    coverage: researchCoverageValidator,
    model: v.string(),
    promptVersion: v.string(),
    ...usageFields,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateUserResearchServiceKey(args.serviceKey);
    const { member } = await getRunningResearchMember(
      ctx,
      args.analysisId,
      args.userId,
    );
    if (member.pseudonym !== args.pseudonym) {
      throw new ConvexError("Pseudonym does not match the research run");
    }

    const existing = await ctx.db
      .query("research_user_profiles")
      .withIndex("by_analysis_and_user", (q) =>
        q.eq("analysis_id", args.analysisId).eq("user_id", args.userId),
      )
      .unique();
    const now = Date.now();
    const value = {
      pseudonym: args.pseudonym,
      profile: args.profile,
      coverage: args.coverage,
      model: args.model,
      prompt_version: args.promptVersion,
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      cost_dollars: args.costDollars,
      updated_at: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("research_user_profiles", {
        analysis_id: args.analysisId,
        user_id: args.userId,
        ...value,
        created_at: now,
      });
    }

    return null;
  },
});

export const listProfiles = query({
  args: { serviceKey: v.string(), analysisId: v.string() },
  returns: v.array(
    v.object({
      pseudonym: v.string(),
      profile: researchUserProfileValidator,
      coverage: researchCoverageValidator,
      inputTokens: v.optional(v.number()),
      outputTokens: v.optional(v.number()),
      costDollars: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    validateUserResearchServiceKey(args.serviceKey);
    const profiles = await ctx.db
      .query("research_user_profiles")
      .withIndex("by_analysis_and_user", (q) =>
        q.eq("analysis_id", args.analysisId),
      )
      .take(MAX_RESEARCH_COHORT_SIZE + 1);
    if (profiles.length > MAX_RESEARCH_COHORT_SIZE) {
      throw new ConvexError("Research run exceeds the cohort limit");
    }
    return profiles.map((profile) => ({
      pseudonym: profile.pseudonym,
      profile: profile.profile,
      coverage: profile.coverage,
      inputTokens: profile.input_tokens,
      outputTokens: profile.output_tokens,
      costDollars: profile.cost_dollars,
    }));
  },
});

export const completeRun = mutation({
  args: {
    serviceKey: v.string(),
    analysisId: v.string(),
    report: researchCohortReportValidator,
    model: v.string(),
    promptVersion: v.string(),
    ...usageFields,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateUserResearchServiceKey(args.serviceKey);
    const run = await ctx.db
      .query("research_runs")
      .withIndex("by_analysis_id", (q) => q.eq("analysis_id", args.analysisId))
      .unique();
    if (!run || run.status !== "running") {
      throw new ConvexError("Research run is not active");
    }

    const profiles = await ctx.db
      .query("research_user_profiles")
      .withIndex("by_analysis_and_user", (q) =>
        q.eq("analysis_id", args.analysisId),
      )
      .take(MAX_RESEARCH_COHORT_SIZE + 1);
    if (profiles.length > MAX_RESEARCH_COHORT_SIZE) {
      throw new ConvexError("Research run exceeds the cohort limit");
    }
    if (profiles.length < MIN_RESEARCH_COHORT_SIZE) {
      throw new ConvexError(
        "At least three user profiles are required for a cohort report",
      );
    }
    const existingReport = await ctx.db
      .query("research_reports")
      .withIndex("by_analysis_id", (q) => q.eq("analysis_id", args.analysisId))
      .unique();
    const now = Date.now();
    const value = {
      report: args.report,
      model: args.model,
      prompt_version: args.promptVersion,
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      cost_dollars: args.costDollars,
      updated_at: now,
    };
    if (existingReport) {
      await ctx.db.patch(existingReport._id, value);
    } else {
      await ctx.db.insert("research_reports", {
        analysis_id: args.analysisId,
        ...value,
        created_at: now,
      });
    }

    const sum = (values: Array<number | undefined>) => {
      const total = values.reduce<number>(
        (acc, value) => acc + (value ?? 0),
        0,
      );
      return total > 0 ? total : undefined;
    };
    await ctx.db.patch(run._id, {
      status: "completed",
      profiles_completed: profiles.length,
      profiles_failed: args.report.coverage.profilesFailed,
      input_tokens: sum([
        ...profiles.map((profile) => profile.input_tokens),
        args.inputTokens,
      ]),
      output_tokens: sum([
        ...profiles.map((profile) => profile.output_tokens),
        args.outputTokens,
      ]),
      cost_dollars: sum([
        ...profiles.map((profile) => profile.cost_dollars),
        args.costDollars,
      ]),
      error: undefined,
      updated_at: now,
      completed_at: now,
    });
    return null;
  },
});

export const failRun = mutation({
  args: {
    serviceKey: v.string(),
    analysisId: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateUserResearchServiceKey(args.serviceKey);
    const run = await ctx.db
      .query("research_runs")
      .withIndex("by_analysis_id", (q) => q.eq("analysis_id", args.analysisId))
      .unique();
    if (!run || run.status === "completed" || run.status === "failed") {
      return null;
    }
    const profiles = await ctx.db
      .query("research_user_profiles")
      .withIndex("by_analysis_and_user", (q) =>
        q.eq("analysis_id", args.analysisId),
      )
      .take(MAX_RESEARCH_COHORT_SIZE + 1);
    if (profiles.length > MAX_RESEARCH_COHORT_SIZE) {
      throw new ConvexError("Research run exceeds the cohort limit");
    }
    await ctx.db.patch(run._id, {
      status: "failed",
      profiles_completed: profiles.length,
      error: args.error.slice(0, 500),
      updated_at: Date.now(),
    });
    return null;
  },
});
