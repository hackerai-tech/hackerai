import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { fileCountAggregate } from "./fileAggregate";
import { validateServiceKey } from "./lib/utils";

export const DELETED_USER_ID = "__deleted_user__";

export const USER_DELETION_TABLE_POLICY = {
  delete: [
    "chats",
    "chat_summaries",
    "messages",
    "files",
    "feedback",
    "notes",
    "user_customization",
    "extra_usage",
    "team_member_usage",
    "temp_streams",
    "local_sandbox_tokens",
    "local_sandbox_connections",
    "cancellation_reason_details",
  ],
  anonymize: [
    "usage_logs",
    "cancellation_reasons",
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
    "team_extra_usage",
    "paid_start_mix_daily",
    "processed_webhooks",
    "processed_checkout_sessions",
  ],
} as const;

type AnyDoc = { _id: Id<any>; [key: string]: any };
type CleanupMode = "execute" | "dryRun";

const MAX_CLEANUP_DOCS_PER_INDEX = 500;
const MAX_RESIDUE_USER_IDS_PER_MUTATION = 1;

type CleanupStats = {
  deleted: Record<string, number>;
  anonymized: Record<string, number>;
  retained: Record<string, number>;
  orphanChatSummariesDeleted: number;
  orphanChatSummariesScanned: number;
  orphanChatSummariesIsDone: boolean;
  orphanChatSummariesContinueCursor?: string;
  s3ObjectsQueued: number;
};

function createStats(): CleanupStats {
  return {
    deleted: {},
    anonymized: {},
    retained: Object.fromEntries(
      USER_DELETION_TABLE_POLICY.retain.map((table) => [table, 0]),
    ),
    orphanChatSummariesDeleted: 0,
    orphanChatSummariesScanned: 0,
    orphanChatSummariesIsDone: true,
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
  target.orphanChatSummariesDeleted += source.orphanChatSummariesDeleted;
  target.orphanChatSummariesScanned += source.orphanChatSummariesScanned;
  target.s3ObjectsQueued += source.s3ObjectsQueued;
  target.orphanChatSummariesIsDone = source.orphanChatSummariesIsDone;
  target.orphanChatSummariesContinueCursor =
    source.orphanChatSummariesContinueCursor;
}

function uniqueDocs<T extends AnyDoc>(docs: Array<T | null | undefined>): T[] {
  const byId = new Map<string, T>();
  for (const doc of docs) {
    if (!doc) continue;
    byId.set(String(doc._id), doc);
  }
  return Array.from(byId.values());
}

async function collectByIndex<T extends AnyDoc>(
  ctx: MutationCtx,
  table: string,
  indexName: string,
  build: (q: any) => any,
): Promise<T[]> {
  const rows = await (ctx.db.query(table as any) as any)
    .withIndex(indexName, build)
    .take(MAX_CLEANUP_DOCS_PER_INDEX + 1);

  if (rows.length > MAX_CLEANUP_DOCS_PER_INDEX) {
    throw new Error(
      `Account cleanup matched more than ${MAX_CLEANUP_DOCS_PER_INDEX} rows in ${table}.${indexName}; run a narrower cleanup before deleting this account.`,
    );
  }

  return rows;
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
  chats: Doc<"chats">[],
) {
  const summariesByChat = await Promise.all(
    chats.map((chat) =>
      collectByIndex<Doc<"chat_summaries">>(
        ctx,
        "chat_summaries",
        "by_chat_id",
        (q) => q.eq("chat_id", chat.id),
      ),
    ),
  );

  const latestSummaries = await Promise.all(
    chats.map((chat) =>
      chat.latest_summary_id ? ctx.db.get(chat.latest_summary_id) : null,
    ),
  );

  return uniqueDocs([...summariesByChat.flat(), ...latestSummaries]);
}

async function deleteFiles(
  ctx: MutationCtx,
  stats: CleanupStats,
  files: Doc<"files">[],
  mode: CleanupMode,
) {
  const unique = uniqueDocs(files);
  increment(stats.deleted, "files", unique.length);

  const s3Keys = unique
    .map((file) => file.s3_key)
    .filter((key): key is string => typeof key === "string" && key.length > 0);
  stats.s3ObjectsQueued += s3Keys.length;

  if (mode === "dryRun") return;

  for (const file of unique) {
    await fileCountAggregate.deleteIfExists(ctx, file);
    await ctx.db.delete(file._id);
  }

  if (s3Keys.length > 0) {
    await ctx.scheduler.runAfter(
      0,
      internal.s3Cleanup.deleteS3ObjectsBatchAction,
      { s3Keys },
    );
    console.log(
      `Scheduled deletion of ${s3Keys.length} S3 objects for deleted user data cleanup`,
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

  const [
    chats,
    files,
    notes,
    customization,
    messages,
    tempStreams,
    localSandboxTokens,
    localSandboxConnections,
    extraUsage,
    teamMemberUsage,
    cancellationReasonDetails,
  ] = await Promise.all([
    collectByIndex<Doc<"chats">>(ctx, "chats", "by_user_and_updated", (q) =>
      q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"files">>(ctx, "files", "by_user_id", (q) =>
      q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"notes">>(ctx, "notes", "by_user_and_updated", (q) =>
      q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"user_customization">>(
      ctx,
      "user_customization",
      "by_user_id",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"messages">>(ctx, "messages", "by_user_id", (q) =>
      q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"temp_streams">>(
      ctx,
      "temp_streams",
      "by_user_id",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"local_sandbox_tokens">>(
      ctx,
      "local_sandbox_tokens",
      "by_user_id",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"local_sandbox_connections">>(
      ctx,
      "local_sandbox_connections",
      "by_user_id",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"extra_usage">>(ctx, "extra_usage", "by_user_id", (q) =>
      q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"team_member_usage">>(
      ctx,
      "team_member_usage",
      "by_user_id",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"cancellation_reason_details">>(
      ctx,
      "cancellation_reason_details",
      "by_user_id_and_created_at",
      (q) => q.eq("user_id", userId),
    ),
  ]);

  const feedbackIds = uniqueDocs(messages)
    .map((message) => message.feedback_id)
    .filter((id): id is Id<"feedback"> => !!id);
  const feedback = await Promise.all(feedbackIds.map((id) => ctx.db.get(id)));
  const chatSummaries = await collectChatSummariesForChats(ctx, chats);

  await deleteDocs(ctx, stats, "feedback", feedback, mode);
  await deleteDocs(ctx, stats, "messages", messages, mode);
  await deleteDocs(ctx, stats, "chat_summaries", chatSummaries, mode);
  await deleteDocs(ctx, stats, "chats", chats, mode);
  await deleteFiles(ctx, stats, files, mode);
  await deleteDocs(ctx, stats, "notes", notes, mode);
  await deleteDocs(ctx, stats, "user_customization", customization, mode);
  await deleteDocs(ctx, stats, "temp_streams", tempStreams, mode);
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

  const [
    cancellationReasons,
    usageLogs,
    referralCodes,
    referredAttributions,
    referrerAttributions,
    referralRewardsByUser,
    referralRewardsByReferrer,
    referralRewardsByReferred,
    userSuspensions,
    revenueByUser,
    revenueByEntity,
    extraUsagePurchases,
    paidStartsByUser,
    paidStartsByEntity,
    unitEconomicsByUser,
    unitEconomicsByEntity,
  ] = await Promise.all([
    collectByIndex<Doc<"cancellation_reasons">>(
      ctx,
      "cancellation_reasons",
      "by_user_started",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"usage_logs">>(ctx, "usage_logs", "by_user", (q) =>
      q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"referral_codes">>(
      ctx,
      "referral_codes",
      "by_user_id",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"referral_attributions">>(
      ctx,
      "referral_attributions",
      "by_referred_user_id",
      (q) => q.eq("referred_user_id", userId),
    ),
    collectByIndex<Doc<"referral_attributions">>(
      ctx,
      "referral_attributions",
      "by_referrer_user_id",
      (q) => q.eq("referrer_user_id", userId),
    ),
    collectByIndex<Doc<"referral_rewards">>(
      ctx,
      "referral_rewards",
      "by_user_id",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"referral_rewards">>(
      ctx,
      "referral_rewards",
      "by_referrer_user_id",
      (q) => q.eq("referrer_user_id", userId),
    ),
    collectByIndex<Doc<"referral_rewards">>(
      ctx,
      "referral_rewards",
      "by_referred_user_id",
      (q) => q.eq("referred_user_id", userId),
    ),
    collectByIndex<Doc<"user_suspensions">>(
      ctx,
      "user_suspensions",
      "by_user_id",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"revenue_events">>(
      ctx,
      "revenue_events",
      "by_user_occurred",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"revenue_events">>(
      ctx,
      "revenue_events",
      "by_entity_occurred",
      (q) => q.eq("entity_type", "user").eq("entity_id", userId),
    ),
    collectByIndex<Doc<"extra_usage_purchases">>(
      ctx,
      "extra_usage_purchases",
      "by_user_created_at",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"paid_start_events">>(
      ctx,
      "paid_start_events",
      "by_user_day",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"paid_start_events">>(
      ctx,
      "paid_start_events",
      "by_entity_day",
      (q) => q.eq("entity_type", "user").eq("entity_id", userId),
    ),
    collectByIndex<Doc<"unit_economics_daily">>(
      ctx,
      "unit_economics_daily",
      "by_user_day",
      (q) => q.eq("user_id", userId),
    ),
    collectByIndex<Doc<"unit_economics_daily">>(
      ctx,
      "unit_economics_daily",
      "by_entity_day",
      (q) => q.eq("entity_type", "user").eq("entity_id", userId),
    ),
  ]);

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
    () => ({ user_id: DELETED_USER_ID, chat_id: undefined }),
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

/**
 * Delete all data for the authenticated user in the same policy path used by
 * the server-side account deletion route.
 */
export const deleteAllUserData = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    await cleanupUserDataForUser(ctx, user.subject, "execute");
    return null;
  },
});

export const deleteAllUserDataByService = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    await cleanupUserDataForUser(ctx, args.userId, "execute");
    return null;
  },
});

export const cleanupDeletedUserResidue = mutation({
  args: {
    serviceKey: v.string(),
    userIds: v.optional(v.array(v.string())),
    dryRun: v.optional(v.boolean()),
    deleteOrphanChatSummaries: v.optional(v.boolean()),
    orphanCursor: v.optional(v.union(v.string(), v.null())),
    orphanNumItems: v.optional(v.number()),
  },
  returns: v.object({
    deleted: v.any(),
    anonymized: v.any(),
    retained: v.any(),
    orphanChatSummariesDeleted: v.number(),
    orphanChatSummariesScanned: v.number(),
    orphanChatSummariesIsDone: v.boolean(),
    orphanChatSummariesContinueCursor: v.optional(v.string()),
    s3ObjectsQueued: v.number(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const mode: CleanupMode = args.dryRun === false ? "execute" : "dryRun";
    const stats = createStats();
    const userIds = args.userIds ?? [];

    if (userIds.length === 0 && !args.deleteOrphanChatSummaries) {
      throw new Error(
        "Pass at least one userId or enable deleteOrphanChatSummaries",
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

    return stats;
  },
});
