import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { calculateCvss31 } from "../lib/findings/cvss31";
import {
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
};

const getFindingsByFacets = (
  ctx: FindingReadCtx,
  userId: string,
  { severity, category, status, chatId }: FindingListFilters,
) => {
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
  assumptions: finding.assumptions,
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
});

export const createFindingForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    messageId: v.string(),
    toolCallId: v.string(),
    report: v.any(),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const parsed = createVulnerabilityReportInputSchema.safeParse(args.report);
    if (!parsed.success) {
      return {
        success: false as const,
        error: "validation" as const,
        message: "The vulnerability report did not pass validation.",
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
        message: "A matching finding already exists in this chat.",
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
      assumptions: input.assumptions,
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
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);

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
        return toFindingSummary(finding, chat?.title ?? "Deleted chat");
      }),
    );

    return { page: summaries, isDone, continueCursor };
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
