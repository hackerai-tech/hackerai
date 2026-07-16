import { mutation, query } from "./_generated/server";
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
import type { Doc } from "./_generated/dataModel";

const MAX_SEARCH_LENGTH = 200;

const getChat = async (ctx: any, chatId: string) =>
  await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q: any) => q.eq("id", chatId))
    .first();

const getFindingByPublicId = async (ctx: any, findingId: string) =>
  await ctx.db
    .query("findings")
    .withIndex("by_finding_id", (q: any) => q.eq("finding_id", findingId))
    .first();

const toFindingSummary = (finding: Doc<"findings">, chatTitle: string) => ({
  finding_id: finding.finding_id,
  title: finding.title,
  target: finding.target,
  ...(finding.endpoint ? { endpoint: finding.endpoint } : {}),
  severity: finding.severity,
  cvss_score: finding.cvss_score,
  chat_id: finding.chat_id,
  chat_title: chatTitle,
  created_at: finding.created_at,
});

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
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(method ? { method } : {}),
      ...(input.cve ? { cve: input.cve } : {}),
      ...(input.cwe ? { cwe: input.cwe } : {}),
      ...(input.code_locations ? { code_locations: input.code_locations } : {}),
      dedupe_key: dedupeKey,
      search_text: createFindingSearchText(input),
      created_at: now,
      updated_at: now,
    });

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
    severity: v.optional(
      v.union(
        v.literal("critical"),
        v.literal("high"),
        v.literal("medium"),
        v.literal("low"),
        v.literal("info"),
      ),
    ),
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
          if (args.severity) builder = builder.eq("severity", args.severity);
          if (args.chatId) builder = builder.eq("chat_id", args.chatId);
          return builder;
        })
        .paginate(args.paginationOpts);

      page = result.page;
      isDone = result.isDone;
      continueCursor = result.continueCursor;
    } else {
      let findingsQuery;
      if (args.severity) {
        findingsQuery = ctx.db
          .query("findings")
          .withIndex("by_user_severity_created", (q) =>
            q.eq("user_id", identity.subject).eq("severity", args.severity!),
          );
      } else if (args.chatId) {
        findingsQuery = ctx.db
          .query("findings")
          .withIndex("by_user_chat_created", (q) =>
            q.eq("user_id", identity.subject).eq("chat_id", args.chatId!),
          );
      } else {
        findingsQuery = ctx.db
          .query("findings")
          .withIndex("by_user_and_created", (q) =>
            q.eq("user_id", identity.subject),
          );
      }

      if (args.severity && args.chatId) {
        findingsQuery = findingsQuery.filter((q: any) =>
          q.eq(q.field("chat_id"), args.chatId),
        );
      }

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

    const chats = await ctx.db
      .query("chats")
      .withIndex("by_user_and_updated", (q) =>
        q.eq("user_id", identity.subject),
      )
      .order("desc")
      .collect();
    return chats.map((chat) => ({
      chat_id: chat.id,
      chat_title: chat.title,
    }));
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
    return { deleted: true };
  },
});
