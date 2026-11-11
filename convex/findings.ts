import {
  FINDING_DEDUPE_LIMIT,
  findingComparisonSummary,
  findingDedupeVersions,
  sameFindingDedupeVersions,
} from "../lib/findings/dedupe-context";
import {
  findingRevisionValidator,
  findingFeedbackValidator,
  findingFeedbackAnswerValidator,
} from "./findingValidators";
import { evidenceVerificationSchema } from "../lib/ai/subagents/contracts";
import { internal } from "./_generated/api";
import { EVIDENCE_BASIS_FIELDS } from "../lib/findings/evidence-status";
import { internalMutation, mutation, query } from "./lib/serviceFunctions";
import type { QueryCtx } from "./lib/serviceFunctions";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { calculateCvss31 } from "../lib/findings/cvss31";
import {
  updateVulnerabilityReportInputSchema,
  mergeFindingReportChanges,
  createFindingDedupeKey,
  createFindingSearchText,
  createVulnerabilityReportInputSchema,
} from "../lib/findings/validation";
import {
  deriveFindingCategory,
  FINDING_CATEGORIES,
  FINDING_CATEGORY_LABELS,
  type FindingCategory,
} from "../lib/findings/category";
import {
  closeFindingInputSchema,
  type FindingStatus,
} from "../lib/findings/lifecycle";
import type { Doc } from "./_generated/dataModel";

const MAX_SEARCH_LENGTH = 200;
const MAX_FINDING_SOURCE_CHATS = 500;

const findingSeverityArgValidator = v.union(
  v.literal("critical"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
  v.literal("info"),
);

const findingCategoryArgValidator = v.union(
  v.literal("access_control"),
  v.literal("authentication_session"),
  v.literal("injection"),
  v.literal("cross_site_scripting"),
  v.literal("request_forgery"),
  v.literal("file_path_access"),
  v.literal("data_exposure"),
  v.literal("cryptography_secrets"),
  v.literal("parsing_deserialization"),
  v.literal("security_misconfiguration"),
  v.literal("denial_of_service"),
  v.literal("business_logic"),
  v.literal("other"),
);

const findingStatusArgValidator = v.union(
  v.literal("active"),
  v.literal("closed"),
);

const findingClosureReasonArgValidator = v.union(
  v.literal("already_fixed"),
  v.literal("wont_fix"),
  v.literal("false_positive"),
);

type FindingReadCtx = Pick<QueryCtx, "db">;

const getChat = async (ctx: FindingReadCtx, chatId: string) =>
  await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .unique();

const getFindingByPublicId = async (ctx: FindingReadCtx, findingId: string) =>
  await ctx.db
    .query("findings")
    .withIndex("by_finding_id", (q) => q.eq("finding_id", findingId))
    .unique();

const getFindingSource = async (
  ctx: FindingReadCtx,
  userId: string,
  chatId: string,
) =>
  await ctx.db
    .query("finding_sources")
    .withIndex("by_user_chat", (q) =>
      q.eq("user_id", userId).eq("chat_id", chatId),
    )
    .unique();

type FindingListFilters = {
  severity?: Doc<"findings">["severity"];
  category?: FindingCategory;
  status?: FindingStatus;
  chatId?: string;
  projectId?: import("./_generated/dataModel").Id<"projects">;
};

const getFindingsByFacets = (
  ctx: FindingReadCtx,
  userId: string,
  { severity, category, status, chatId, projectId }: FindingListFilters,
) => {
  if (projectId && status && category && severity)
    return ctx.db
      .query("findings")
      .withIndex("by_user_project_status_category_severity_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("project_id", projectId)
          .eq("status", status)
          .eq("category", category)
          .eq("severity", severity),
      );
  if (projectId && status && category)
    return ctx.db
      .query("findings")
      .withIndex("by_user_project_status_category_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("project_id", projectId)
          .eq("status", status)
          .eq("category", category),
      );
  if (projectId && status && severity)
    return ctx.db
      .query("findings")
      .withIndex("by_user_project_status_severity_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("project_id", projectId)
          .eq("status", status)
          .eq("severity", severity),
      );
  if (projectId && category && severity)
    return ctx.db
      .query("findings")
      .withIndex("by_user_project_category_severity_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("project_id", projectId)
          .eq("category", category)
          .eq("severity", severity),
      );
  if (projectId && status)
    return ctx.db
      .query("findings")
      .withIndex("by_user_project_status_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("project_id", projectId)
          .eq("status", status),
      );
  if (projectId && category)
    return ctx.db
      .query("findings")
      .withIndex("by_user_project_category_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("project_id", projectId)
          .eq("category", category),
      );
  if (projectId && severity)
    return ctx.db
      .query("findings")
      .withIndex("by_user_project_severity_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("project_id", projectId)
          .eq("severity", severity),
      );
  if (projectId)
    return ctx.db
      .query("findings")
      .withIndex("by_user_project_created", (q) =>
        q.eq("user_id", userId).eq("project_id", projectId),
      );
  if (status && category && severity && chatId) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_status_category_severity_chat_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("status", status)
          .eq("category", category)
          .eq("severity", severity)
          .eq("chat_id", chatId),
      );
  }
  if (status && category && severity) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_status_category_severity_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("status", status)
          .eq("category", category)
          .eq("severity", severity),
      );
  }
  if (status && category && chatId) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_status_category_chat_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("status", status)
          .eq("category", category)
          .eq("chat_id", chatId),
      );
  }
  if (status && severity && chatId) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_status_severity_chat_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("status", status)
          .eq("severity", severity)
          .eq("chat_id", chatId),
      );
  }
  if (category && severity && chatId) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_category_severity_chat_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("category", category)
          .eq("severity", severity)
          .eq("chat_id", chatId),
      );
  }
  if (status && category) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_status_category_created", (q) =>
        q.eq("user_id", userId).eq("status", status).eq("category", category),
      );
  }
  if (status && severity) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_status_severity_created", (q) =>
        q.eq("user_id", userId).eq("status", status).eq("severity", severity),
      );
  }
  if (status && chatId) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_status_chat_created", (q) =>
        q.eq("user_id", userId).eq("status", status).eq("chat_id", chatId),
      );
  }
  if (category && severity) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_category_severity_created", (q) =>
        q
          .eq("user_id", userId)
          .eq("category", category)
          .eq("severity", severity),
      );
  }
  if (category && chatId) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_category_chat_created", (q) =>
        q.eq("user_id", userId).eq("category", category).eq("chat_id", chatId),
      );
  }
  if (severity && chatId) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_severity_chat_created", (q) =>
        q.eq("user_id", userId).eq("severity", severity).eq("chat_id", chatId),
      );
  }
  if (status) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_status_created", (q) =>
        q.eq("user_id", userId).eq("status", status),
      );
  }
  if (category) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_category_created", (q) =>
        q.eq("user_id", userId).eq("category", category),
      );
  }
  if (severity) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_severity_created", (q) =>
        q.eq("user_id", userId).eq("severity", severity),
      );
  }
  if (chatId) {
    return ctx.db
      .query("findings")
      .withIndex("by_user_chat_created", (q) =>
        q.eq("user_id", userId).eq("chat_id", chatId),
      );
  }
  return ctx.db
    .query("findings")
    .withIndex("by_user_and_created", (q) => q.eq("user_id", userId));
};

const toFindingSummary = (finding: Doc<"findings">, chatTitle: string) => {
  const category =
    finding.category ??
    deriveFindingCategory({ cwe: finding.cwe, title: finding.title });

  return {
    finding_id: finding.finding_id,
    title: finding.title,
    target: finding.target,
    ...(finding.endpoint ? { endpoint: finding.endpoint } : {}),
    severity: finding.severity,
    cvss_score: finding.cvss_score,
    category,
    status: finding.status ?? ("active" as const),
    chat_id: finding.chat_id,
    chat_title: chatTitle,
    created_at: finding.created_at,
    ...(finding.project_id ? { project_id: finding.project_id } : {}),
    ...(finding.evidence_status
      ? { evidence_status: finding.evidence_status }
      : {}),
  };
};

const toFindingDetail = (finding: Doc<"findings">, chatTitle: string) => ({
  ...toFindingSummary(finding, chatTitle),
  description: finding.description,
  impact: finding.impact,
  technical_analysis: finding.technical_analysis,
  poc_description: finding.poc_description,
  poc_script_code: finding.poc_script_code,
  remediation_steps: finding.remediation_steps,
  evidence: finding.evidence,
  ...(finding.evidence_refs ? { evidence_refs: finding.evidence_refs } : {}),
  ...(finding.evidence_verification
    ? { evidence_verification: finding.evidence_verification }
    : {}),
  assumptions: finding.assumptions,
  ...(finding.evidence_status_reason
    ? { evidence_status_reason: finding.evidence_status_reason }
    : {}),
  ...(finding.confidence ? { confidence: finding.confidence } : {}),
  ...(finding.counterevidence
    ? { counterevidence: finding.counterevidence }
    : {}),
  ...(finding.severity_change_conditions
    ? { severity_change_conditions: finding.severity_change_conditions }
    : {}),
  fix_effort: finding.fix_effort,
  cvss_breakdown: finding.cvss_breakdown,
  cvss_vector: finding.cvss_vector,
  ...(finding.method ? { method: finding.method } : {}),
  ...(finding.cve ? { cve: finding.cve } : {}),
  ...(finding.cwe ? { cwe: finding.cwe } : {}),
  ...(finding.code_locations ? { code_locations: finding.code_locations } : {}),
  message_id: finding.message_id,
  ...(finding.closure_reason ? { closure_reason: finding.closure_reason } : {}),
  ...(finding.closure_context
    ? { closure_context: finding.closure_context }
    : {}),
  ...(finding.closed_at ? { closed_at: finding.closed_at } : {}),
  updated_at: finding.updated_at,
  ...(finding.confidence_rationale
    ? { confidence_rationale: finding.confidence_rationale }
    : {}),
  ...(finding.correction_history
    ? { correction_history: finding.correction_history }
    : {}),
  ...(finding.correction_count !== undefined
    ? { correction_count: finding.correction_count }
    : {}),
  ...(finding.usefulness_feedback
    ? { usefulness_feedback: finding.usefulness_feedback }
    : {}),
});

const dedupeVersionValidator = v.object({
  finding_id: v.string(),
  updated_at: v.number(),
});

async function recentDedupeFindings(
  ctx: FindingReadCtx,
  userId: string,
  chatId: string,
) {
  // Findings include captures, code and correction history. Bound bytes as well
  // as rows so unusually large reports cannot exhaust Convex's read budget.
  const result = await ctx.db
    .query("findings")
    .withIndex("by_user_chat_created", (q) =>
      q.eq("user_id", userId).eq("chat_id", chatId),
    )
    .order("desc")
    .paginate({
      numItems: FINDING_DEDUPE_LIMIT,
      cursor: null,
      maximumBytesRead: 2_000_000,
    });
  return result.page;
}

export const getFindingDedupeContextForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    dedupeKey: v.string(),
  },
  returns: v.object({
    exact_duplicate_id: v.union(v.string(), v.null()),
    candidates: v.array(
      v.object({
        finding_id: v.string(),
        updated_at: v.number(),
        summary: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const chat = await getChat(ctx, args.chatId);
    if (
      !chat ||
      chat.user_id !== args.userId ||
      chat.deletion_started_at ||
      chat.canceled_at
    ) {
      throw new ConvexError("The source chat is no longer available.");
    }
    await assertUserCanAccessChatHistory(ctx, args.userId);
    const exact = await ctx.db
      .query("findings")
      .withIndex("by_user_chat_dedupe", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("dedupe_key", args.dedupeKey),
      )
      .first();
    const findings = await recentDedupeFindings(ctx, args.userId, args.chatId);
    return {
      exact_duplicate_id: exact?.finding_id ?? null,
      candidates: findings.map((finding) => ({
        finding_id: finding.finding_id,
        updated_at: finding.updated_at,
        summary: findingComparisonSummary(finding),
      })),
    };
  },
});

export const createFindingForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    messageId: v.string(),
    toolCallId: v.string(),
    report: v.any(),
    comparisonSnapshot: v.optional(v.array(dedupeVersionValidator)),
    semanticDuplicateId: v.optional(v.string()),
    evidenceVerification: v.optional(
      v.object({
        checked_refs: v.array(v.string()),
        unavailable_refs: v.array(v.string()),
        warning: v.optional(v.string()),
      }),
    ),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      finding_id: v.string(),
      title: v.string(),
      target: v.string(),
      endpoint: v.optional(v.string()),
      severity: findingSeverityArgValidator,
      cvss_score: v.number(),
      warning: v.optional(v.string()),
    }),
    v.object({
      success: v.literal(false),
      error: v.union(v.literal("validation"), v.literal("chat_not_found")),
      message: v.string(),
    }),
    v.object({
      success: v.literal(false),
      error: v.literal("duplicate"),
      duplicate_of: v.string(),
      message: v.string(),
    }),
    v.object({
      success: v.literal(false),
      error: v.literal("comparison_stale"),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const parsed = createVulnerabilityReportInputSchema.safeParse(args.report);
    if (!parsed.success) {
      return {
        success: false as const,
        error: "validation" as const,
        message: `The vulnerability report did not pass validation. Check fields: ${[...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join(", ")}. Confidence, counterevidence and severity-change conditions are required; low/medium confidence needs a rationale.`,
      };
    }

    const chat = await getChat(ctx, args.chatId);
    if (
      !chat ||
      chat.user_id !== args.userId ||
      chat.deletion_started_at ||
      chat.canceled_at
    ) {
      return {
        success: false as const,
        error: "chat_not_found" as const,
        message: "The source chat is no longer available.",
      };
    }

    await assertUserCanAccessChatHistory(ctx, args.userId);
    const evidenceVerification = args.evidenceVerification
      ? evidenceVerificationSchema.parse(args.evidenceVerification)
      : undefined;
    const input = parsed.data;
    const dedupeKey = createFindingDedupeKey(input);
    const duplicate = await ctx.db
      .query("findings")
      .withIndex("by_user_chat_dedupe", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("dedupe_key", dedupeKey),
      )
      .first();

    if (duplicate) {
      return {
        success: false as const,
        error: "duplicate" as const,
        duplicate_of: duplicate.finding_id,
        message:
          "A matching finding already exists in this chat. Use get_report to inspect it; use update_vulnerability_report for new evidence.",
      };
    }

    if (args.comparisonSnapshot) {
      const current = await recentDedupeFindings(ctx, args.userId, args.chatId);
      // This indexed read participates in Convex OCC: a concurrent create,
      // correction or deletion invalidates the model's comparison before commit.
      if (
        !sameFindingDedupeVersions(
          args.comparisonSnapshot,
          findingDedupeVersions(current),
        )
      ) {
        return { success: false as const, error: "comparison_stale" as const };
      }
      if (args.semanticDuplicateId) {
        const match = current.find(
          (finding) => finding.finding_id === args.semanticDuplicateId,
        );
        if (!match) {
          return {
            success: false as const,
            error: "validation" as const,
            message: "The duplicate comparison is invalid.",
          };
        }
        return {
          success: false as const,
          error: "duplicate" as const,
          duplicate_of: match.finding_id,
          message:
            "This root cause is already reported in this chat. Use get_report to inspect it; use update_vulnerability_report for new evidence.",
        };
      }
    } else if (args.semanticDuplicateId) {
      return {
        success: false as const,
        error: "validation" as const,
        message: "The duplicate comparison is invalid.",
      };
    }

    const findingId = crypto.randomUUID();
    const now = Date.now();
    const cvss = calculateCvss31(input.cvss_breakdown);
    const method = input.method?.toUpperCase();
    const category = deriveFindingCategory({
      cwe: input.cwe,
      title: input.title,
    });

    await ctx.db.insert("findings", {
      finding_id: findingId,
      user_id: args.userId,
      chat_id: args.chatId,
      ...(chat.project_id ? { project_id: chat.project_id } : {}),
      ...(input.evidence_status
        ? {
            evidence_status: input.evidence_status,
            evidence_status_reason: input.evidence_status_reason,
          }
        : {}),
      message_id: args.messageId,
      tool_call_id: args.toolCallId,
      title: input.title,
      description: input.description,
      impact: input.impact,
      target: input.target,
      technical_analysis: input.technical_analysis,
      poc_description: input.poc_description,
      poc_script_code: input.poc_script_code,
      remediation_steps: input.remediation_steps,
      evidence: input.evidence,
      ...(input.evidence_refs ? { evidence_refs: input.evidence_refs } : {}),
      ...(evidenceVerification
        ? { evidence_verification: evidenceVerification }
        : {}),
      assumptions: input.assumptions,
      ...(input.confidence ? { confidence: input.confidence } : {}),
      ...(input.confidence_rationale
        ? { confidence_rationale: input.confidence_rationale }
        : {}),
      ...(input.counterevidence
        ? { counterevidence: input.counterevidence }
        : {}),
      ...(input.severity_change_conditions
        ? { severity_change_conditions: input.severity_change_conditions }
        : {}),
      fix_effort: input.fix_effort,
      cvss_breakdown: input.cvss_breakdown,
      cvss_score: cvss.score,
      cvss_vector: cvss.vector,
      severity: cvss.severity,
      category,
      status: "active",
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(method ? { method } : {}),
      ...(input.cve ? { cve: input.cve } : {}),
      ...(input.cwe ? { cwe: input.cwe } : {}),
      ...(input.code_locations ? { code_locations: input.code_locations } : {}),
      dedupe_key: dedupeKey,
      search_text: createFindingSearchText(
        input,
        FINDING_CATEGORY_LABELS[category],
      ),
      created_at: now,
      updated_at: now,
    });

    const source = await getFindingSource(ctx, args.userId, args.chatId);
    if (source) {
      await ctx.db.patch(source._id, {
        chat_title: chat.title,
        finding_count: source.finding_count + 1,
        latest_finding_at: now,
      });
    } else {
      await ctx.db.insert("finding_sources", {
        user_id: args.userId,
        chat_id: args.chatId,
        chat_title: chat.title,
        finding_count: 1,
        latest_finding_at: now,
      });
    }

    return {
      success: true as const,
      ...(evidenceVerification?.warning
        ? { warning: evidenceVerification.warning }
        : {}),
      finding_id: findingId,
      title: input.title,
      target: input.target,
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      severity: cvss.severity,
      cvss_score: cvss.score,
    };
  },
});

export const getFinding = query({
  args: { findingId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    const finding = await getFindingByPublicId(ctx, args.findingId);
    if (!finding || finding.user_id !== identity.subject) return null;

    const chat = await getChat(ctx, finding.chat_id);
    return toFindingDetail(finding, chat?.title ?? "Deleted chat");
  },
});

export const listFindings = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    severity: v.optional(findingSeverityArgValidator),
    category: v.optional(findingCategoryArgValidator),
    status: v.optional(findingStatusArgValidator),
    chatId: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    if (args.projectId) {
      const project = await ctx.db.get(args.projectId);
      if (
        !project ||
        project.user_id !== identity.subject ||
        project.deletion_started_at !== undefined
      ) {
        return { page: [], isDone: true, continueCursor: "" };
      }
      if (args.chatId)
        throw new ConvexError(
          "Choose a project or source chat filter, not both",
        );
    }
    const search = args.search?.trim().slice(0, MAX_SEARCH_LENGTH);
    let page: Doc<"findings">[];
    let isDone: boolean;
    let continueCursor: string;

    if (search) {
      const result = await ctx.db
        .query("findings")
        .withSearchIndex("search_findings", (q) => {
          let builder = q
            .search("search_text", search)
            .eq("user_id", identity.subject);
          if (args.projectId)
            builder = builder.eq("project_id", args.projectId);
          if (args.status) builder = builder.eq("status", args.status);
          if (args.category) builder = builder.eq("category", args.category);
          if (args.severity) builder = builder.eq("severity", args.severity);
          if (args.chatId) builder = builder.eq("chat_id", args.chatId);
          return builder;
        })
        .paginate(args.paginationOpts);

      page = result.page;
      isDone = result.isDone;
      continueCursor = result.continueCursor;
    } else {
      const findingsQuery = getFindingsByFacets(ctx, identity.subject, args);

      const result = await findingsQuery
        .order("desc")
        .paginate(args.paginationOpts);
      page = result.page;
      isDone = result.isDone;
      continueCursor = result.continueCursor;
    }

    const summaries = await Promise.all(
      page.map(async (finding) => {
        const chat = await getChat(ctx, finding.chat_id);
        // Membership synchronization is batched. Never show a stale old-project
        // result while a move/detach is still catching up.
        if (
          args.projectId &&
          (!chat ||
            chat.project_id !== args.projectId ||
            chat.user_id !== identity.subject)
        )
          return null;
        return toFindingSummary(finding, chat?.title ?? "Deleted chat");
      }),
    );

    return {
      page: summaries.filter((row) => row !== null),
      isDone,
      continueCursor,
    };
  },
});

export const getFindingSourceChats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    const sources = await ctx.db
      .query("finding_sources")
      .withIndex("by_user_and_latest", (q) => q.eq("user_id", identity.subject))
      .order("desc")
      .take(MAX_FINDING_SOURCE_CHATS);

    return sources.map((source) => ({
      chat_id: source.chat_id,
      chat_title: source.chat_title,
    }));
  },
});

export const closeFinding = mutation({
  args: {
    findingId: v.string(),
    reason: findingClosureReasonArgValidator,
    context: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    const parsed = closeFindingInputSchema.safeParse({
      reason: args.reason,
      context: args.context,
    });
    if (!parsed.success) {
      throw new ConvexError({
        code: "INVALID_CLOSURE",
        message: parsed.error.issues[0]?.message ?? "Invalid closure details",
      });
    }

    const finding = await getFindingByPublicId(ctx, args.findingId);
    if (!finding) return { closed: false, not_found: true };
    if (finding.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Access denied",
      });
    }
    if (finding.status === "closed") {
      return { closed: false, already_closed: true };
    }

    const now = Date.now();
    await ctx.db.patch(finding._id, {
      status: "closed",
      category:
        finding.category ??
        deriveFindingCategory({ cwe: finding.cwe, title: finding.title }),
      closure_reason: parsed.data.reason,
      closure_context: parsed.data.context,
      closed_at: now,
      updated_at: now,
    });

    return { closed: true, closed_at: now };
  },
});

export const deleteFinding = mutation({
  args: { findingId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    const finding = await getFindingByPublicId(ctx, args.findingId);
    if (!finding) return { deleted: false };
    if (finding.user_id !== identity.subject) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "Access denied",
      });
    }

    const message = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("id", finding.message_id))
      .first();
    if (
      message &&
      message.user_id === identity.subject &&
      message.chat_id === finding.chat_id
    ) {
      const scrubbedParts = message.parts.filter(
        (part: any) => part?.toolCallId !== finding.tool_call_id,
      );
      if (scrubbedParts.length !== message.parts.length) {
        await ctx.db.patch(message._id, {
          parts: scrubbedParts,
          update_time: Date.now(),
        });
      }
    }

    await ctx.db.delete(finding._id);
    await ctx.scheduler.runAfter(0, internal.findingRetests.deleteForFinding, {
      findingId: finding.finding_id,
      userId: identity.subject,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.findingAgentRetests.deleteForFinding,
      { findingId: finding.finding_id, userId: identity.subject },
    );

    const source = await getFindingSource(
      ctx,
      identity.subject,
      finding.chat_id,
    );
    if (source) {
      const latestRemaining = await ctx.db
        .query("findings")
        .withIndex("by_user_chat_created", (q) =>
          q.eq("user_id", identity.subject).eq("chat_id", finding.chat_id),
        )
        .order("desc")
        .first();

      if (latestRemaining) {
        await ctx.db.patch(source._id, {
          finding_count: Math.max(1, source.finding_count - 1),
          latest_finding_at: latestRemaining.created_at,
        });
      } else {
        await ctx.db.delete(source._id);
      }
    }
    return { deleted: true };
  },
});

const reportErrorFields = {
  success: v.literal(false),
  error: v.union(
    v.literal("not_found"),
    v.literal("validation"),
    v.literal("conflict"),
    v.literal("duplicate"),
    v.literal("chat_not_found"),
  ),
  message: v.string(),
};
const reportErrorValidator = v.object(reportErrorFields);
const reportSummaryFields = {
  finding_id: v.string(),
  title: v.string(),
  target: v.string(),
  endpoint: v.optional(v.string()),
  severity: findingSeverityArgValidator,
  cvss_score: v.number(),
  category: findingCategoryArgValidator,
  status: findingStatusArgValidator,
  chat_id: v.string(),
  chat_title: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
  project_id: v.optional(v.id("projects")),
  evidence_status: v.optional(
    v.union(
      v.literal("source_review_only"),
      v.literal("runtime_reproduced"),
      v.literal("inconclusive"),
    ),
  ),
};
const reportSummaryValidator = v.object(reportSummaryFields);
const reportDetailValidator = v.object({
  ...reportSummaryFields,
  description: v.string(),
  impact: v.string(),
  technical_analysis: v.string(),
  poc_description: v.string(),
  poc_script_code: v.string(),
  remediation_steps: v.string(),
  evidence: v.string(),
  evidence_refs: v.optional(v.array(v.string())),
  evidence_verification: v.optional(
    v.object({
      checked_refs: v.array(v.string()),
      unavailable_refs: v.array(v.string()),
      warning: v.optional(v.string()),
    }),
  ),
  assumptions: v.string(),
  evidence_status_reason: v.optional(v.string()),
  confidence: v.optional(
    v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
  ),
  confidence_rationale: v.optional(v.string()),
  correction_history: v.optional(v.array(findingRevisionValidator)),
  correction_count: v.optional(v.number()),
  usefulness_feedback: v.optional(findingFeedbackValidator),
  counterevidence: v.optional(v.string()),
  severity_change_conditions: v.optional(v.string()),
  fix_effort: v.union(
    v.literal("trivial"),
    v.literal("low"),
    v.literal("medium"),
    v.literal("high"),
  ),
  cvss_breakdown: v.object({
    attack_vector: v.union(
      v.literal("N"),
      v.literal("A"),
      v.literal("L"),
      v.literal("P"),
    ),
    attack_complexity: v.union(v.literal("L"), v.literal("H")),
    privileges_required: v.union(
      v.literal("N"),
      v.literal("L"),
      v.literal("H"),
    ),
    user_interaction: v.union(v.literal("N"), v.literal("R")),
    scope: v.union(v.literal("U"), v.literal("C")),
    confidentiality: v.union(v.literal("N"), v.literal("L"), v.literal("H")),
    integrity: v.union(v.literal("N"), v.literal("L"), v.literal("H")),
    availability: v.union(v.literal("N"), v.literal("L"), v.literal("H")),
  }),
  cvss_vector: v.string(),
  method: v.optional(v.string()),
  cve: v.optional(v.string()),
  cwe: v.optional(v.string()),
  code_locations: v.optional(
    v.array(
      v.object({
        file: v.string(),
        start_line: v.number(),
        end_line: v.number(),
        snippet: v.optional(v.string()),
        label: v.optional(v.string()),
        fix_before: v.optional(v.string()),
        fix_after: v.optional(v.string()),
      }),
    ),
  ),
  message_id: v.string(),
  closure_reason: v.optional(findingClosureReasonArgValidator),
  closure_context: v.optional(v.string()),
  closed_at: v.optional(v.number()),
});

const reportNotFound = () => ({
  success: false as const,
  error: "not_found" as const,
  message: "The report is not available in this chat.",
});

export const listReportsForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    status: v.optional(findingStatusArgValidator),
  },
  returns: v.union(
    reportErrorValidator,
    v.object({
      success: v.literal(true),
      reports: v.array(reportSummaryValidator),
      is_done: v.boolean(),
      next_cursor: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await assertUserCanAccessChatHistory(ctx, args.userId);
    const chat = await getChat(ctx, args.chatId);
    if (!chat || chat.user_id !== args.userId || chat.deletion_started_at)
      return reportNotFound();
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 25 ||
      (args.search?.length ?? 0) > MAX_SEARCH_LENGTH
    ) {
      return {
        success: false as const,
        error: "validation" as const,
        message:
          "Use a page size of 1–25 and search text of at most 200 characters.",
      };
    }
    const search = args.search?.trim();
    const reportQuery = search
      ? ctx.db.query("findings").withSearchIndex("search_findings", (q) => {
          let b = q
            .search("search_text", search)
            .eq("user_id", args.userId)
            .eq("chat_id", args.chatId);
          if (args.status) b = b.eq("status", args.status);
          return b;
        })
      : getFindingsByFacets(ctx, args.userId, {
          chatId: args.chatId,
          status: args.status,
        }).order("desc");
    let page;
    try {
      page = await reportQuery.paginate(args.paginationOpts);
    } catch (error) {
      // A malformed model-supplied cursor needs a new first-page request, not a retry.
      if (
        args.paginationOpts.cursor !== null &&
        error instanceof Error &&
        error.message === "Failed to parse cursor"
      ) {
        return {
          success: false as const,
          error: "validation" as const,
          message:
            "The report cursor is invalid. Start again without a cursor and use only the next_cursor returned for the same search and status filters.",
        };
      }
      throw error;
    }
    return {
      success: true as const,
      reports: page.page.map((f) => ({
        ...toFindingSummary(f, chat.title),
        updated_at: f.updated_at,
      })),
      is_done: page.isDone,
      next_cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const getReportForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    findingId: v.string(),
  },
  returns: v.union(
    reportErrorValidator,
    v.object({ success: v.literal(true), report: reportDetailValidator }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await assertUserCanAccessChatHistory(ctx, args.userId);
    const chat = await getChat(ctx, args.chatId);
    if (!chat || chat.user_id !== args.userId || chat.deletion_started_at)
      return reportNotFound();
    const finding = await getFindingByPublicId(ctx, args.findingId);
    if (
      !finding ||
      finding.user_id !== args.userId ||
      finding.chat_id !== args.chatId
    )
      return reportNotFound();
    return {
      success: true as const,
      report: toFindingDetail(finding, chat.title),
    };
  },
});

export const updateFindingForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    messageId: v.string(),
    toolCallId: v.string(),
    update: v.any(),
    evidenceVerification: v.optional(
      v.object({
        checked_refs: v.array(v.string()),
        unavailable_refs: v.array(v.string()),
        warning: v.optional(v.string()),
      }),
    ),
  },
  returns: v.union(
    reportErrorValidator,
    v.object({
      success: v.literal(true),
      finding_id: v.string(),
      title: v.string(),
      target: v.string(),
      endpoint: v.optional(v.string()),
      severity: findingSeverityArgValidator,
      cvss_score: v.number(),
      updated_at: v.number(),
      warning: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await assertUserCanAccessChatHistory(ctx, args.userId);
    const parsed = updateVulnerabilityReportInputSchema.safeParse(args.update);
    if (!parsed.success)
      return {
        success: false as const,
        error: "validation" as const,
        message: "The report changes did not pass validation.",
      };
    const chat = await getChat(ctx, args.chatId);
    if (
      !chat ||
      chat.user_id !== args.userId ||
      chat.deletion_started_at ||
      chat.canceled_at
    )
      return {
        success: false as const,
        error: "chat_not_found" as const,
        message: "The source chat is no longer available for updates.",
      };
    const update = parsed.data;
    const finding = await getFindingByPublicId(ctx, update.finding_id);
    if (
      !finding ||
      finding.user_id !== args.userId ||
      finding.chat_id !== args.chatId
    )
      return reportNotFound();
    if (finding.updated_at !== update.expected_updated_at)
      return {
        success: false as const,
        error: "conflict" as const,
        message:
          "The report changed. Read it again and reconcile the changes before updating.",
      };
    if (
      Object.hasOwn(update.changes, "evidence_status") !==
      Object.hasOwn(update.changes, "evidence_status_reason")
    )
      return {
        success: false as const,
        error: "validation" as const,
        message: "Supply the evidence status and its factual reason together.",
      };
    const merged = mergeFindingReportChanges(finding, update.changes);
    const changedBasis = EVIDENCE_BASIS_FIELDS.some(
      (key) =>
        Object.hasOwn(update.changes, key) &&
        JSON.stringify(merged[key]) !== JSON.stringify(finding[key]),
    );
    if (changedBasis && !Object.hasOwn(update.changes, "evidence_status")) {
      merged.evidence_status = undefined;
      merged.evidence_status_reason = undefined;
    }
    const report = createVulnerabilityReportInputSchema.safeParse(merged);
    if (!report.success)
      return {
        success: false as const,
        error: "validation" as const,
        message: `The complete report did not pass validation. Check fields: ${[...new Set(report.error.issues.map((issue) => issue.path[0]))].join(", ")}. Include missing assessment limits when correcting an older report.`,
      };
    const input = report.data;
    const dedupeKey = createFindingDedupeKey(input);
    const matches = await ctx.db
      .query("findings")
      .withIndex("by_user_chat_dedupe", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("dedupe_key", dedupeKey),
      )
      .take(2);
    if (matches.some((f) => f._id !== finding._id))
      return {
        success: false as const,
        error: "duplicate" as const,
        message: "These changes would duplicate another finding in this chat.",
      };
    const cvss = calculateCvss31(input.cvss_breakdown);
    const category = deriveFindingCategory({
      cwe: input.cwe,
      title: input.title,
    });
    const now = Math.max(Date.now(), finding.updated_at + 1);
    const evidenceVerification = Object.hasOwn(update.changes, "evidence_refs")
      ? args.evidenceVerification
        ? evidenceVerificationSchema.parse(args.evidenceVerification)
        : undefined
      : finding.evidence_verification;
    await ctx.db.patch(finding._id, {
      ...input,
      method: input.method?.toUpperCase(),
      // Explicit undefined clears optional fields rather than retaining their old values.
      endpoint: input.endpoint,
      cve: input.cve,
      cwe: input.cwe,
      code_locations: input.code_locations,
      confidence: input.confidence,
      confidence_rationale: input.confidence_rationale,
      counterevidence: input.counterevidence,
      severity_change_conditions: input.severity_change_conditions,
      evidence_refs: input.evidence_refs,
      evidence_verification: evidenceVerification,
      evidence_status: input.evidence_status,
      evidence_status_reason: input.evidence_status_reason,
      cvss_score: cvss.score,
      cvss_vector: cvss.vector,
      severity: cvss.severity,
      category,
      dedupe_key: dedupeKey,
      search_text: createFindingSearchText(
        input,
        FINDING_CATEGORY_LABELS[category],
      ),
      updated_at: now,
      correction_count: (finding.correction_count ?? 0) + 1,
      correction_history: [
        ...(finding.correction_history ?? []),
        {
          updated_at: now,
          message_id: args.messageId,
          reason: update.reason,
          changed_fields: [
            ...Object.keys(update.changes),
            ...(changedBasis &&
            !Object.hasOwn(update.changes, "evidence_status")
              ? ["evidence_status", "evidence_status_reason"]
              : []),
          ].filter((key) => {
            const next =
              key === "method"
                ? input.method?.toUpperCase()
                : input[key as keyof typeof input];
            return (
              JSON.stringify(finding[key as keyof typeof finding]) !==
              JSON.stringify(next)
            );
          }),
          previous_severity: finding.severity,
          severity: cvss.severity,
          previous_cvss_score: finding.cvss_score,
          cvss_score: cvss.score,
          ...(finding.confidence
            ? { previous_confidence: finding.confidence }
            : {}),
          ...(input.confidence ? { confidence: input.confidence } : {}),
        },
      ].slice(-20),
      last_update: {
        message_id: args.messageId,
        tool_call_id: args.toolCallId,
        reason: update.reason,
      },
    });
    return {
      success: true as const,
      finding_id: finding.finding_id,
      title: input.title,
      target: input.target,
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      severity: cvss.severity,
      cvss_score: cvss.score,
      updated_at: now,
      ...(evidenceVerification?.warning
        ? { warning: evidenceVerification.warning }
        : {}),
    };
  },
});

/** Deliberate, private feedback on a specific saved revision. Never modifies report content. */
export const submitFindingFeedback = mutation({
  args: {
    findingId: v.string(),
    expectedUpdatedAt: v.number(),
    answer: findingFeedbackAnswerValidator,
  },
  returns: v.union(
    v.object({ success: v.literal(true), changed: v.boolean() }),
    v.object({
      success: v.literal(false),
      error: v.union(v.literal("not_found"), v.literal("conflict")),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity)
      throw new ConvexError({ code: "UNAUTHORIZED", message: "Unauthorized" });
    await assertUserCanAccessChatHistory(ctx, identity.subject);
    const finding = await getFindingByPublicId(ctx, args.findingId);
    if (!finding || finding.user_id !== identity.subject)
      return { success: false as const, error: "not_found" as const };
    const chat = await getChat(ctx, finding.chat_id);
    if (!chat || chat.user_id !== identity.subject || chat.deletion_started_at)
      return { success: false as const, error: "not_found" as const };
    if (finding.updated_at !== args.expectedUpdatedAt)
      return { success: false as const, error: "conflict" as const };
    if (
      finding.usefulness_feedback?.report_updated_at === finding.updated_at &&
      finding.usefulness_feedback.answer === args.answer
    )
      return { success: true as const, changed: false };
    await ctx.db.patch(finding._id, {
      usefulness_feedback: {
        answer: args.answer,
        report_updated_at: finding.updated_at,
        submitted_at: Date.now(),
      },
    });
    return { success: true as const, changed: true };
  },
});

/** Backfill existing records before enabling project navigation in an environment.
 * Run once with cursor:null; each bounded batch schedules its continuation.
 * Source chats remain authoritative, including concurrent moves/deletions.
 */
export const backfillFindingProjects = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const batch = await ctx.db.query("findings").order("asc").paginate({
      numItems: 20,
      cursor: args.cursor,
      maximumBytesRead: 1_000_000,
    });
    for (const finding of batch.page) {
      const chat = await getChat(ctx, finding.chat_id);
      const projectId =
        chat?.user_id === finding.user_id ? chat.project_id : undefined;
      if (finding.project_id !== projectId)
        await ctx.db.patch(finding._id, { project_id: projectId });
    }
    if (!batch.isDone)
      await ctx.scheduler.runAfter(
        0,
        internal.findings.backfillFindingProjects,
        { cursor: batch.continueCursor },
      );
    return null;
  },
});

/** Follow current chat membership, never a captured project ID from an old job. */
export const syncChatFindingProject = internalMutation({
  args: {
    chatId: v.string(),
    userId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await getChat(ctx, args.chatId);
    if (!chat || chat.user_id !== args.userId) return null;
    const batch = await ctx.db
      .query("findings")
      .withIndex("by_user_chat_created", (q) =>
        q.eq("user_id", args.userId).eq("chat_id", args.chatId),
      )
      .paginate({
        numItems: 20,
        cursor: args.cursor,
        maximumBytesRead: 1_000_000,
      });
    for (const finding of batch.page)
      if (finding.project_id !== chat.project_id)
        await ctx.db.patch(finding._id, { project_id: chat.project_id });
    if (!batch.isDone)
      await ctx.scheduler.runAfter(
        0,
        internal.findings.syncChatFindingProject,
        { ...args, cursor: batch.continueCursor },
      );
    return null;
  },
});
