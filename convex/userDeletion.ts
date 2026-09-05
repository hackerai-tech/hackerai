import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { fileCountAggregate } from "./fileAggregate";
import { validateServiceKey } from "./lib/utils";

export const DELETED_USER_ID = "__deleted_user__";

export const USER_DELETION_TABLE_POLICY = {
  delete: [
    "projects",
    "chats",
    "chat_summaries",
    "messages",
    "files",
    "feedback",
    "notes",
    "user_customization",
    "extra_usage",
    "team_member_usage",
    "local_sandbox_tokens",
    "local_sandbox_connections",
    "cancellation_reason_details",
    "research_run_members",
    "research_user_profiles",
    "subagent_messages",
    "subagent_events",
    "subagent_work_items",
    "subagent_runs",
  ],
  anonymize: [
    "usage_logs",
    "cancellation_reasons",
    "involuntary_churn_events",
    "referral_codes",
    "referral_attributions",
    "referral_rewards",
    "revenue_events",
    "extra_usage_purchases",
    "paid_start_events",
    "unit_economics_daily",
    "user_suspensions",
  ],
  retain: [
    // Operational tombstone that prevents stale authenticated requests from
    // recreating execution resources after account deletion begins.
    "user_deletion_fences",
    "team_extra_usage",
    "paid_start_mix_daily",
    "processed_webhooks",
    "processed_checkout_sessions",
    // Reports contain only cohort-level patterns from runs with at least three
    // users. Per-user profiles and their direct user IDs are deleted above.
    "research_runs",
    "research_reports",
  ],
} as const;

type AnyDoc = { _id: Id<any>; [key: string]: any };
type CleanupMode = "execute" | "dryRun";
type OrphanSubagentTable = "subagent_events" | "subagent_work_items";

// Convex counts full document payloads toward a mutation's 16 MiB read limit.
// Share one document budget across the entire cleanup pass; the account
// deletion route already repeats the mutation while `hasMore` is true.
const MAX_CLEANUP_DOCS_PER_MUTATION = 100;
const MAX_RESIDUE_USER_IDS_PER_MUTATION = 1;

type ReadBudget = {
  remaining: number;
};

type CleanupStats = {
  deleted: Record<string, number>;
  anonymized: Record<string, number>;
  retained: Record<string, number>;
  hasMore: boolean;
  orphanChatSummariesDeleted: number;
  orphanChatSummariesScanned: number;
  orphanChatSummariesIsDone: boolean;
  orphanChatSummariesContinueCursor?: string;
  orphanSubagentRowsTable?: OrphanSubagentTable;
  orphanSubagentRowsDeleted: number;
  orphanSubagentRowsScanned: number;
  orphanSubagentRowsIsDone: boolean;
  orphanSubagentRowsContinueCursor?: string;
  s3ObjectsQueued: number;
};

type IndexedBatch<T extends AnyDoc> = {
  docs: T[];
  hasMore: boolean;
};

const cleanupStatsValidator = v.object({
  deleted: v.any(),
  anonymized: v.any(),
  retained: v.any(),
  hasMore: v.boolean(),
  orphanChatSummariesDeleted: v.number(),
  orphanChatSummariesScanned: v.number(),
  orphanChatSummariesIsDone: v.boolean(),
  orphanChatSummariesContinueCursor: v.optional(v.string()),
  orphanSubagentRowsTable: v.optional(
    v.union(v.literal("subagent_events"), v.literal("subagent_work_items")),
  ),
  orphanSubagentRowsDeleted: v.number(),
  orphanSubagentRowsScanned: v.number(),
  orphanSubagentRowsIsDone: v.boolean(),
  orphanSubagentRowsContinueCursor: v.optional(v.string()),
  s3ObjectsQueued: v.number(),
});

function createStats(): CleanupStats {
  return {
    deleted: {},
    anonymized: {},
    retained: Object.fromEntries(
      USER_DELETION_TABLE_POLICY.retain.map((table) => [table, 0]),
    ),
    hasMore: false,
    orphanChatSummariesDeleted: 0,
    orphanChatSummariesScanned: 0,
    orphanChatSummariesIsDone: true,
    orphanSubagentRowsDeleted: 0,
    orphanSubagentRowsScanned: 0,
    orphanSubagentRowsIsDone: true,
    s3ObjectsQueued: 0,
  };
}

function increment(
  target: Record<string, number>,
  table: string,
  count: number,
) {
  if (count === 0) return;
  target[table] = (target[table] ?? 0) + count;
}

function mergeStats(target: CleanupStats, source: CleanupStats) {
  for (const [table, count] of Object.entries(source.deleted)) {
    increment(target.deleted, table, count);
  }
  for (const [table, count] of Object.entries(source.anonymized)) {
    increment(target.anonymized, table, count);
  }
  target.hasMore ||= source.hasMore;
  target.orphanChatSummariesDeleted += source.orphanChatSummariesDeleted;
  target.orphanChatSummariesScanned += source.orphanChatSummariesScanned;
  target.s3ObjectsQueued += source.s3ObjectsQueued;
  target.orphanChatSummariesIsDone = source.orphanChatSummariesIsDone;
  target.orphanChatSummariesContinueCursor =
    source.orphanChatSummariesContinueCursor;
  target.orphanSubagentRowsTable = source.orphanSubagentRowsTable;
  target.orphanSubagentRowsDeleted += source.orphanSubagentRowsDeleted;
  target.orphanSubagentRowsScanned += source.orphanSubagentRowsScanned;
  target.orphanSubagentRowsIsDone = source.orphanSubagentRowsIsDone;
  target.orphanSubagentRowsContinueCursor =
    source.orphanSubagentRowsContinueCursor;
}

function uniqueDocs<T extends AnyDoc>(docs: Array<T | null | undefined>): T[] {
  const byId = new Map<string, T>();
  for (const doc of docs) {
    if (!doc) continue;
    byId.set(String(doc._id), doc);
  }
  return Array.from(byId.values());
}

async function collectByIndexBatch<T extends AnyDoc>(
  ctx: MutationCtx,
  budget: ReadBudget,
  table: string,
  indexName: string,
  build: (q: any) => any,
  requestedLimit = MAX_CLEANUP_DOCS_PER_MUTATION,
): Promise<IndexedBatch<T>> {
  // Reserve one read for the lookahead row used to determine `hasMore`.
  const limit = Math.min(requestedLimit, budget.remaining - 1);
  if (limit <= 0) {
    return { docs: [], hasMore: true };
  }

  const rows = await (ctx.db.query(table as any) as any)
    .withIndex(indexName, build)
    .take(limit + 1);
  budget.remaining -= rows.length;

  const hasMore = rows.length > limit;
  const docs = hasMore ? rows.slice(0, limit) : rows;

  return { docs, hasMore };
}

async function firstByIndex<T extends AnyDoc>(
  ctx: MutationCtx,
  table: string,
  indexName: string,
  build: (q: any) => any,
): Promise<T | null> {
  return await (ctx.db.query(table as any) as any)
    .withIndex(indexName, build)
    .first();
}

async function deleteDocs(
  ctx: MutationCtx,
  stats: CleanupStats,
  table: string,
  docs: Array<AnyDoc | null | undefined>,
  mode: CleanupMode,
) {
  const unique = uniqueDocs(docs);
  increment(stats.deleted, table, unique.length);
  if (mode === "dryRun") return;

  for (const doc of unique) {
    await ctx.db.delete(doc._id);
  }
}

async function anonymizeDocs(
  ctx: MutationCtx,
  stats: CleanupStats,
  table: string,
  docs: AnyDoc[],
  patchForDoc: (doc: AnyDoc) => Record<string, any>,
  mode: CleanupMode,
) {
  const unique = uniqueDocs(docs);
  increment(stats.anonymized, table, unique.length);
  if (mode === "dryRun") return;

  for (const doc of unique) {
    const patch = patchForDoc(doc);
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(doc._id, patch);
    }
  }
}

async function collectChatSummariesForChats(
  ctx: MutationCtx,
  budget: ReadBudget,
  chats: Doc<"chats">[],
  stats: CleanupStats,
) {
  const summaries: Doc<"chat_summaries">[] = [];
  const incompleteChatIds = new Set<string>();

  for (const chat of chats) {
    if (budget.remaining <= 1) {
      stats.hasMore = true;
      incompleteChatIds.add(chat.id);
      continue;
    }

    const batch = await collectByIndexBatch<Doc<"chat_summaries">>(
      ctx,
      budget,
      "chat_summaries",
      "by_chat_id",
      (q) => q.eq("chat_id", chat.id),
    );
    summaries.push(...batch.docs);

    if (batch.hasMore) {
      stats.hasMore = true;
      incompleteChatIds.add(chat.id);
      continue;
    }

    if (!chat.latest_summary_id) {
      continue;
    }

    if (summaries.some((summary) => summary._id === chat.latest_summary_id)) {
      continue;
    }

    if (budget.remaining <= 0) {
      stats.hasMore = true;
      incompleteChatIds.add(chat.id);
      continue;
    }

    const latestSummary = await ctx.db.get(chat.latest_summary_id);
    budget.remaining -= 1;
    if (latestSummary) {
      summaries.push(latestSummary);
    }
  }

  return {
    summaries: uniqueDocs(summaries),
    incompleteChatIds,
  };
}

async function deleteFiles(
  ctx: MutationCtx,
  stats: CleanupStats,
  files: Doc<"files">[],
  mode: CleanupMode,
) {
  const unique = uniqueDocs(files);
  increment(stats.deleted, "files", unique.length);

  const s3Objects = unique.flatMap((file) =>
    file.s3_key
      ? [
          {
            s3Key: file.s3_key,
            ...(file.s3_region ? { s3Region: file.s3_region } : {}),
            ...(file.s3_bucket ? { s3Bucket: file.s3_bucket } : {}),
          },
        ]
      : [],
  );
  stats.s3ObjectsQueued += s3Objects.length;

  if (mode === "dryRun") return;

  for (const file of unique) {
    await fileCountAggregate.deleteIfExists(ctx, file);
    await ctx.db.delete(file._id);
  }

  if (s3Objects.length > 0) {
    const cleanupArgs = s3Objects.some(
      (object) => object.s3Region || object.s3Bucket,
    )
      ? { s3Objects }
      : { s3Keys: s3Objects.map((object) => object.s3Key) };
    await ctx.scheduler.runAfter(
      0,
      internal.s3Cleanup.deleteS3ObjectsBatchAction,
      cleanupArgs,
    );
    console.log(
      `Scheduled deletion of ${s3Objects.length} S3 objects for deleted user data cleanup`,
    );
  }
}

async function cleanupUserDataForUser(
  ctx: MutationCtx,
  userId: string,
  mode: CleanupMode,
) {
  const stats = createStats();
  const now = Date.now();
  const budget: ReadBudget = {
    remaining: MAX_CLEANUP_DOCS_PER_MUTATION,
  };

  // A message may point to one feedback document that must be deleted first,
  // so reserve enough of the shared budget for those direct lookups.
  const messageLimit = Math.floor((budget.remaining - 1) / 2);
  const messagesBatch = await collectByIndexBatch<Doc<"messages">>(
    ctx,
    budget,
    "messages",
    "by_user_id",
    (q) => q.eq("user_id", userId),
    messageLimit,
  );
  const messages = messagesBatch.docs;
  const feedbackIds = uniqueDocs(messages)
    .map((message) => message.feedback_id)
    .filter((id): id is Id<"feedback"> => !!id);
  const feedback: Array<Doc<"feedback"> | null> = [];
  for (const feedbackId of feedbackIds) {
    if (budget.remaining <= 0) {
      stats.hasMore = true;
      break;
    }
    feedback.push(await ctx.db.get(feedbackId));
    budget.remaining -= 1;
  }

  // Chat cleanup can require both an indexed summary read and a legacy latest
  // summary lookup for each chat, so leave room for both.
  const chatLimit = Math.floor((budget.remaining - 1) / 3);
  const chatsBatch = await collectByIndexBatch<Doc<"chats">>(
    ctx,
    budget,
    "chats",
    "by_user_and_updated",
    (q) => q.eq("user_id", userId),
    chatLimit,
  );
  const chats = chatsBatch.docs;
  const { summaries: chatSummaries, incompleteChatIds } =
    await collectChatSummariesForChats(ctx, budget, chats, stats);

  const projectsBatch = await collectByIndexBatch<Doc<"projects">>(
    ctx,
    budget,
    "projects",
    "by_user_and_updated",
    (q) => q.eq("user_id", userId),
  );
  const filesBatch = await collectByIndexBatch<Doc<"files">>(
    ctx,
    budget,
    "files",
    "by_user_id",
    (q) => q.eq("user_id", userId),
  );
  const notesBatch = await collectByIndexBatch<Doc<"notes">>(
    ctx,
    budget,
    "notes",
    "by_user_and_updated",
    (q) => q.eq("user_id", userId),
  );
  const customizationBatch = await collectByIndexBatch<
    Doc<"user_customization">
  >(ctx, budget, "user_customization", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const localSandboxTokensBatch = await collectByIndexBatch<
    Doc<"local_sandbox_tokens">
  >(ctx, budget, "local_sandbox_tokens", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const localSandboxConnectionsBatch = await collectByIndexBatch<
    Doc<"local_sandbox_connections">
  >(ctx, budget, "local_sandbox_connections", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const extraUsageBatch = await collectByIndexBatch<Doc<"extra_usage">>(
    ctx,
    budget,
    "extra_usage",
    "by_user_id",
    (q) => q.eq("user_id", userId),
  );
  const teamMemberUsageBatch = await collectByIndexBatch<
    Doc<"team_member_usage">
  >(ctx, budget, "team_member_usage", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const cancellationReasonDetailsBatch = await collectByIndexBatch<
    Doc<"cancellation_reason_details">
  >(
    ctx,
    budget,
    "cancellation_reason_details",
    "by_user_id_and_created_at",
    (q) => q.eq("user_id", userId),
  );
  const researchUserProfilesBatch = await collectByIndexBatch<
    Doc<"research_user_profiles">
  >(ctx, budget, "research_user_profiles", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const researchRunMembersBatch = await collectByIndexBatch<
    Doc<"research_run_members">
  >(ctx, budget, "research_run_members", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const subagentMessagesBatch = await collectByIndexBatch<
    Doc<"subagent_messages">
  >(ctx, budget, "subagent_messages", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const subagentEventsBatch = await collectByIndexBatch<Doc<"subagent_events">>(
    ctx,
    budget,
    "subagent_events",
    "by_user_id",
    (q) => q.eq("user_id", userId),
  );
  const subagentWorkItemsBatch = await collectByIndexBatch<
    Doc<"subagent_work_items">
  >(ctx, budget, "subagent_work_items", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const subagentRunsBatch = await collectByIndexBatch<Doc<"subagent_runs">>(
    ctx,
    budget,
    "subagent_runs",
    "by_user_id",
    (q) => q.eq("user_id", userId),
  );
  const deletionBatches = [
    projectsBatch,
    chatsBatch,
    filesBatch,
    notesBatch,
    customizationBatch,
    messagesBatch,
    localSandboxTokensBatch,
    localSandboxConnectionsBatch,
    extraUsageBatch,
    teamMemberUsageBatch,
    cancellationReasonDetailsBatch,
    researchRunMembersBatch,
    researchUserProfilesBatch,
    subagentMessagesBatch,
    subagentEventsBatch,
    subagentWorkItemsBatch,
    subagentRunsBatch,
  ];
  stats.hasMore ||= deletionBatches.some((batch) => batch.hasMore);

  const projects = projectsBatch.docs;
  const files = filesBatch.docs;
  const notes = notesBatch.docs;
  const customization = customizationBatch.docs;
  const localSandboxTokens = localSandboxTokensBatch.docs;
  const localSandboxConnections = localSandboxConnectionsBatch.docs;
  const extraUsage = extraUsageBatch.docs;
  const teamMemberUsage = teamMemberUsageBatch.docs;
  const cancellationReasonDetails = cancellationReasonDetailsBatch.docs;
  const researchRunMembers = researchRunMembersBatch.docs;
  const researchUserProfiles = researchUserProfilesBatch.docs;
  const subagentMessages = subagentMessagesBatch.docs;
  const subagentEvents = subagentEventsBatch.docs;
  const subagentWorkItems = subagentWorkItemsBatch.docs;
  const subagentRuns = subagentRunsBatch.docs;

  const chatsReadyToDelete =
    messagesBatch.hasMore ||
    subagentMessagesBatch.hasMore ||
    subagentEventsBatch.hasMore ||
    subagentWorkItemsBatch.hasMore ||
    subagentRunsBatch.hasMore
      ? []
      : chats.filter((chat) => !incompleteChatIds.has(chat.id));
  if (chatsReadyToDelete.length < chats.length) {
    stats.hasMore = true;
  }

  await deleteDocs(ctx, stats, "feedback", feedback, mode);
  await deleteDocs(ctx, stats, "messages", messages, mode);
  await deleteDocs(ctx, stats, "chat_summaries", chatSummaries, mode);
  await deleteDocs(ctx, stats, "subagent_messages", subagentMessages, mode);
  await deleteDocs(ctx, stats, "subagent_events", subagentEvents, mode);
  await deleteDocs(ctx, stats, "subagent_work_items", subagentWorkItems, mode);
  await deleteDocs(ctx, stats, "subagent_runs", subagentRuns, mode);
  await deleteDocs(ctx, stats, "chats", chatsReadyToDelete, mode);
  await deleteDocs(ctx, stats, "projects", projects, mode);
  await deleteFiles(ctx, stats, files, mode);
  await deleteDocs(ctx, stats, "notes", notes, mode);
  await deleteDocs(ctx, stats, "user_customization", customization, mode);
  await deleteDocs(
    ctx,
    stats,
    "local_sandbox_tokens",
    localSandboxTokens,
    mode,
  );
  await deleteDocs(
    ctx,
    stats,
    "local_sandbox_connections",
    localSandboxConnections,
    mode,
  );
  await deleteDocs(ctx, stats, "extra_usage", extraUsage, mode);
  await deleteDocs(ctx, stats, "team_member_usage", teamMemberUsage, mode);
  await deleteDocs(
    ctx,
    stats,
    "cancellation_reason_details",
    cancellationReasonDetails,
    mode,
  );
  await deleteDocs(
    ctx,
    stats,
    "research_run_members",
    researchRunMembers,
    mode,
  );
  await deleteDocs(
    ctx,
    stats,
    "research_user_profiles",
    researchUserProfiles,
    mode,
  );

  const cancellationReasonsBatch = await collectByIndexBatch<
    Doc<"cancellation_reasons">
  >(ctx, budget, "cancellation_reasons", "by_user_started", (q) =>
    q.eq("user_id", userId),
  );
  const usageLogsBatch = await collectByIndexBatch<Doc<"usage_logs">>(
    ctx,
    budget,
    "usage_logs",
    "by_user",
    (q) => q.eq("user_id", userId),
  );
  const involuntaryChurnEventsBatch = await collectByIndexBatch<
    Doc<"involuntary_churn_events">
  >(ctx, budget, "involuntary_churn_events", "by_user_and_occurred", (q) =>
    q.eq("user_id", userId),
  );
  const referralCodesBatch = await collectByIndexBatch<Doc<"referral_codes">>(
    ctx,
    budget,
    "referral_codes",
    "by_user_id",
    (q) => q.eq("user_id", userId),
  );
  const referredAttributionsBatch = await collectByIndexBatch<
    Doc<"referral_attributions">
  >(ctx, budget, "referral_attributions", "by_referred_user_id", (q) =>
    q.eq("referred_user_id", userId),
  );
  const referrerAttributionsBatch = await collectByIndexBatch<
    Doc<"referral_attributions">
  >(ctx, budget, "referral_attributions", "by_referrer_user_id", (q) =>
    q.eq("referrer_user_id", userId),
  );
  const referralRewardsByUserBatch = await collectByIndexBatch<
    Doc<"referral_rewards">
  >(ctx, budget, "referral_rewards", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const referralRewardsByReferrerBatch = await collectByIndexBatch<
    Doc<"referral_rewards">
  >(ctx, budget, "referral_rewards", "by_referrer_user_id", (q) =>
    q.eq("referrer_user_id", userId),
  );
  const referralRewardsByReferredBatch = await collectByIndexBatch<
    Doc<"referral_rewards">
  >(ctx, budget, "referral_rewards", "by_referred_user_id", (q) =>
    q.eq("referred_user_id", userId),
  );
  const userSuspensionsBatch = await collectByIndexBatch<
    Doc<"user_suspensions">
  >(ctx, budget, "user_suspensions", "by_user_id", (q) =>
    q.eq("user_id", userId),
  );
  const revenueByUserBatch = await collectByIndexBatch<Doc<"revenue_events">>(
    ctx,
    budget,
    "revenue_events",
    "by_user_occurred",
    (q) => q.eq("user_id", userId),
  );
  const revenueByEntityBatch = await collectByIndexBatch<Doc<"revenue_events">>(
    ctx,
    budget,
    "revenue_events",
    "by_entity_occurred",
    (q) => q.eq("entity_type", "user").eq("entity_id", userId),
  );
  const extraUsagePurchasesBatch = await collectByIndexBatch<
    Doc<"extra_usage_purchases">
  >(ctx, budget, "extra_usage_purchases", "by_user_created_at", (q) =>
    q.eq("user_id", userId),
  );
  const paidStartsByUserBatch = await collectByIndexBatch<
    Doc<"paid_start_events">
  >(ctx, budget, "paid_start_events", "by_user_day", (q) =>
    q.eq("user_id", userId),
  );
  const paidStartsByEntityBatch = await collectByIndexBatch<
    Doc<"paid_start_events">
  >(ctx, budget, "paid_start_events", "by_entity_day", (q) =>
    q.eq("entity_type", "user").eq("entity_id", userId),
  );
  const unitEconomicsByUserBatch = await collectByIndexBatch<
    Doc<"unit_economics_daily">
  >(ctx, budget, "unit_economics_daily", "by_user_day", (q) =>
    q.eq("user_id", userId),
  );
  const unitEconomicsByEntityBatch = await collectByIndexBatch<
    Doc<"unit_economics_daily">
  >(ctx, budget, "unit_economics_daily", "by_entity_day", (q) =>
    q.eq("entity_type", "user").eq("entity_id", userId),
  );

  const anonymizeBatches = [
    cancellationReasonsBatch,
    usageLogsBatch,
    involuntaryChurnEventsBatch,
    referralCodesBatch,
    referredAttributionsBatch,
    referrerAttributionsBatch,
    referralRewardsByUserBatch,
    referralRewardsByReferrerBatch,
    referralRewardsByReferredBatch,
    userSuspensionsBatch,
    revenueByUserBatch,
    revenueByEntityBatch,
    extraUsagePurchasesBatch,
    paidStartsByUserBatch,
    paidStartsByEntityBatch,
    unitEconomicsByUserBatch,
    unitEconomicsByEntityBatch,
  ];
  stats.hasMore ||= anonymizeBatches.some((batch) => batch.hasMore);

  const cancellationReasons = cancellationReasonsBatch.docs;
  const usageLogs = usageLogsBatch.docs;
  const involuntaryChurnEvents = involuntaryChurnEventsBatch.docs;
  const referralCodes = referralCodesBatch.docs;
  const referredAttributions = referredAttributionsBatch.docs;
  const referrerAttributions = referrerAttributionsBatch.docs;
  const referralRewardsByUser = referralRewardsByUserBatch.docs;
  const referralRewardsByReferrer = referralRewardsByReferrerBatch.docs;
  const referralRewardsByReferred = referralRewardsByReferredBatch.docs;
  const userSuspensions = userSuspensionsBatch.docs;
  const revenueByUser = revenueByUserBatch.docs;
  const revenueByEntity = revenueByEntityBatch.docs;
  const extraUsagePurchases = extraUsagePurchasesBatch.docs;
  const paidStartsByUser = paidStartsByUserBatch.docs;
  const paidStartsByEntity = paidStartsByEntityBatch.docs;
  const unitEconomicsByUser = unitEconomicsByUserBatch.docs;
  const unitEconomicsByEntity = unitEconomicsByEntityBatch.docs;

  await anonymizeDocs(
    ctx,
    stats,
    "cancellation_reasons",
    cancellationReasons,
    () => ({
      user_id: DELETED_USER_ID,
      reason_details_id: undefined,
      updated_at: now,
    }),
    mode,
  );
  await anonymizeDocs(
    ctx,
    stats,
    "usage_logs",
    usageLogs,
    () => ({
      user_id: DELETED_USER_ID,
      chat_id: undefined,
      assistant_message_id: undefined,
    }),
    mode,
  );
  await anonymizeDocs(
    ctx,
    stats,
    "involuntary_churn_events",
    involuntaryChurnEvents,
    (event) => ({
      user_id: DELETED_USER_ID,
      idempotency_key: `${event.stripe_event_id}:${DELETED_USER_ID}:${event._id}`,
    }),
    mode,
  );
  await anonymizeDocs(
    ctx,
    stats,
    "referral_codes",
    referralCodes,
    (code) => ({
      user_id: DELETED_USER_ID,
      status: "deactivated",
      deactivated_at: code.deactivated_at ?? now,
      deactivated_reason: "account_deleted",
      updated_at: now,
    }),
    mode,
  );
  await anonymizeDocs(
    ctx,
    stats,
    "referral_attributions",
    [...referredAttributions, ...referrerAttributions],
    (attribution) => ({
      referred_user_id:
        attribution.referred_user_id === userId
          ? DELETED_USER_ID
          : attribution.referred_user_id,
      referrer_user_id:
        attribution.referrer_user_id === userId
          ? DELETED_USER_ID
          : attribution.referrer_user_id,
      updated_at: now,
    }),
    mode,
  );
  await anonymizeDocs(
    ctx,
    stats,
    "referral_rewards",
    [
      ...referralRewardsByUser,
      ...referralRewardsByReferrer,
      ...referralRewardsByReferred,
    ],
    (reward) => ({
      ...(reward.user_id === userId ? { user_id: undefined } : {}),
      ...(reward.referrer_user_id === userId
        ? { referrer_user_id: undefined }
        : {}),
      ...(reward.referred_user_id === userId
        ? { referred_user_id: undefined }
        : {}),
    }),
    mode,
  );
  await anonymizeDocs(
    ctx,
    stats,
    "user_suspensions",
    userSuspensions,
    () => ({ user_id: DELETED_USER_ID, updated_at: now }),
    mode,
  );

  const anonymizeEntityLedger = (row: AnyDoc) => ({
    ...(row.entity_type === "user" && row.entity_id === userId
      ? { entity_id: DELETED_USER_ID }
      : {}),
    ...(row.user_id === userId ? { user_id: undefined } : {}),
  });
  await anonymizeDocs(
    ctx,
    stats,
    "revenue_events",
    [...revenueByUser, ...revenueByEntity],
    anonymizeEntityLedger,
    mode,
  );
  await anonymizeDocs(
    ctx,
    stats,
    "extra_usage_purchases",
    extraUsagePurchases,
    () => ({ user_id: DELETED_USER_ID, updated_at: now }),
    mode,
  );
  await anonymizeDocs(
    ctx,
    stats,
    "paid_start_events",
    [...paidStartsByUser, ...paidStartsByEntity],
    anonymizeEntityLedger,
    mode,
  );
  await anonymizeDocs(
    ctx,
    stats,
    "unit_economics_daily",
    [...unitEconomicsByUser, ...unitEconomicsByEntity],
    (row) => ({
      ...anonymizeEntityLedger(row),
      updated_at: now,
    }),
    mode,
  );

  return stats;
}

async function cleanupOrphanChatSummaries(
  ctx: MutationCtx,
  mode: CleanupMode,
  opts: { cursor?: string | null; numItems: number },
) {
  const stats = createStats();
  const page = await (ctx.db.query("chat_summaries") as any).paginate({
    cursor: opts.cursor ?? null,
    numItems: opts.numItems,
  });

  stats.orphanChatSummariesScanned = page.page.length;
  stats.orphanChatSummariesIsDone = page.isDone;
  stats.orphanChatSummariesContinueCursor = page.continueCursor ?? undefined;
  stats.hasMore = !page.isDone;

  const orphanSummaries: Doc<"chat_summaries">[] = [];
  for (const summary of page.page as Doc<"chat_summaries">[]) {
    const chat = await firstByIndex<Doc<"chats">>(
      ctx,
      "chats",
      "by_chat_id",
      (q) => q.eq("id", summary.chat_id),
    );
    if (!chat) {
      orphanSummaries.push(summary);
    }
  }

  stats.orphanChatSummariesDeleted = orphanSummaries.length;
  await deleteDocs(ctx, stats, "chat_summaries", orphanSummaries, mode);
  return stats;
}

async function cleanupOrphanSubagentRows(
  ctx: MutationCtx,
  mode: CleanupMode,
  table: OrphanSubagentTable,
  opts: { cursor?: string | null; numItems: number },
) {
  const stats = createStats();
  const page = await (ctx.db.query(table) as any).paginate({
    cursor: opts.cursor ?? null,
    numItems: opts.numItems,
  });

  stats.orphanSubagentRowsTable = table;
  stats.orphanSubagentRowsScanned = page.page.length;
  stats.orphanSubagentRowsIsDone = page.isDone;
  stats.orphanSubagentRowsContinueCursor = page.continueCursor ?? undefined;
  stats.hasMore = !page.isDone;

  const orphanRows: Array<Doc<"subagent_events"> | Doc<"subagent_work_items">> =
    [];
  for (const row of page.page as Array<
    Doc<"subagent_events"> | Doc<"subagent_work_items">
  >) {
    const run = await firstByIndex<Doc<"subagent_runs">>(
      ctx,
      "subagent_runs",
      "by_subagent_id",
      (q) => q.eq("subagent_id", row.subagent_id),
    );
    if (!run) orphanRows.push(row);
  }

  stats.orphanSubagentRowsDeleted = orphanRows.length;
  await deleteDocs(ctx, stats, table, orphanRows, mode);
  return stats;
}

/**
 * Preserve the legacy public function as a fail-closed compatibility shim.
 * Account deletion must run through the server route so Trigger runs and
 * provider resources are terminated before their durable identifiers vanish.
 */
export const deleteAllUserData = mutation({
  args: {},
  returns: cleanupStatsValidator,
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    throw new Error(
      "Direct user data deletion is disabled; use the secure account deletion endpoint",
    );
  },
});

export const beginUserDataDeletionByService = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const existing = await ctx.db
      .query("user_deletion_fences")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .unique();
    if (!existing) {
      await ctx.db.insert("user_deletion_fences", {
        user_id: args.userId,
        started_at: Date.now(),
      });
    }
    return null;
  },
});

export const deleteAllUserDataByService = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: cleanupStatsValidator,
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    return await cleanupUserDataForUser(ctx, args.userId, "execute");
  },
});

export const cleanupDeletedUserResidue = mutation({
  args: {
    serviceKey: v.string(),
    userIds: v.optional(v.array(v.string())),
    dryRun: v.optional(v.boolean()),
    deleteOrphanChatSummaries: v.optional(v.boolean()),
    orphanSubagentTable: v.optional(
      v.union(v.literal("subagent_events"), v.literal("subagent_work_items")),
    ),
    orphanCursor: v.optional(v.union(v.string(), v.null())),
    orphanNumItems: v.optional(v.number()),
  },
  returns: cleanupStatsValidator,
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const mode: CleanupMode = args.dryRun === false ? "execute" : "dryRun";
    const stats = createStats();
    const userIds = args.userIds ?? [];
    const orphanOperations =
      Number(args.deleteOrphanChatSummaries === true) +
      Number(args.orphanSubagentTable !== undefined);

    if (userIds.length === 0 && orphanOperations === 0) {
      throw new Error("Pass at least one userId or select one orphan cleanup");
    }

    if (userIds.length > 0 && orphanOperations > 0) {
      throw new Error(
        "Run user data cleanup and orphan cleanup in separate mutations to keep Convex transactions bounded",
      );
    }

    if (orphanOperations > 1) {
      throw new Error(
        "Run each orphan cleanup in a separate mutation to keep Convex transactions bounded",
      );
    }

    if (userIds.length > MAX_RESIDUE_USER_IDS_PER_MUTATION) {
      throw new Error(
        "cleanupDeletedUserResidue processes one userId per mutation to keep Convex transactions bounded",
      );
    }

    for (const userId of userIds) {
      mergeStats(stats, await cleanupUserDataForUser(ctx, userId, mode));
    }

    if (args.deleteOrphanChatSummaries) {
      mergeStats(
        stats,
        await cleanupOrphanChatSummaries(ctx, mode, {
          cursor: args.orphanCursor,
          numItems: Math.min(Math.max(args.orphanNumItems ?? 500, 1), 1000),
        }),
      );
    }

    if (args.orphanSubagentTable) {
      mergeStats(
        stats,
        await cleanupOrphanSubagentRows(ctx, mode, args.orphanSubagentTable, {
          cursor: args.orphanCursor,
          numItems: Math.min(Math.max(args.orphanNumItems ?? 100, 1), 100),
        }),
      );
    }

    return stats;
  },
});
