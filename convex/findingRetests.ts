import { v } from "convex/values";
import { internalMutation, mutation, query } from "./lib/serviceFunctions";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./lib/serviceFunctions";
import type { Doc, Id } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";
import { isUserDeletionFenced } from "./lib/userDeletionFence";
import {
  httpRetestEnvironmentValidator,
  httpRetestOutcomeValidator,
  httpRetestReasonValidator,
  httpRetestRecipeViewValidator,
  httpRetestRunViewValidator,
  httpRetestStepValidator,
} from "./findingRetestValidators";
import {
  HTTP_RETEST_LIMITS,
  httpRetestFindingOrigin,
  httpRetestStepSchema,
  parseHttpRetestRecipe,
} from "../lib/findings/http-retest";

/** Longer than the route's maxDuration, so a live route always finalizes. */
export const RETEST_RUN_LEASE_MS = 120_000;
export const RETEST_HISTORY_LIMIT = 10;
export const RETEST_RUNS_PER_HOUR = 30;
export const RETEST_MAX_RECIPE_VERSIONS = 50;
const DELETE_BATCH_SIZE = 50;
const HOUR_MS = 60 * 60 * 1000;

type ReadCtx = Pick<QueryCtx, "db">;

/**
 * Every operation re-authorizes the finding, its source chat and the user's
 * history access. A deleting chat or user is treated as unavailable.
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

const latestRecipe = (ctx: ReadCtx, findingId: string) =>
  ctx.db
    .query("finding_retest_recipes")
    .withIndex("by_finding_and_version", (q) => q.eq("finding_id", findingId))
    .order("desc")
    .first();

/** Present an expired running lease as interrupted without writing in a query. */
function toRunView(run: Doc<"finding_retest_runs">, now: number) {
  const interrupted = run.status === "running" && run.lease_expires_at <= now;
  return {
    run_id: run._id as string,
    request_id: run.request_id,
    status: interrupted ? ("finished" as const) : run.status,
    recipe_version: run.recipe_version,
    recipe: run.recipe,
    started_at: run.started_at,
    ...(interrupted
      ? {
          finished_at: run.lease_expires_at,
          outcome: "error" as const,
          reason: "interrupted" as const,
        }
      : {
          ...(run.finished_at !== undefined && {
            finished_at: run.finished_at,
          }),
          ...(run.outcome && { outcome: run.outcome }),
          ...(run.reason && { reason: run.reason }),
        }),
    ...(run.steps && { steps: run.steps }),
    ...(run.environment && { environment: run.environment }),
    ...(run.evidence_sha256 && { evidence_sha256: run.evidence_sha256 }),
  };
}

const unavailable = { available: false as const };

export const getStateForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    findingId: v.string(),
    chatId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ available: v.literal(false) }),
    v.object({
      available: v.literal(true),
      finding: v.object({
        finding_id: v.string(),
        chat_id: v.string(),
        chat_title: v.string(),
        title: v.string(),
        target: v.string(),
        sandbox_preference: v.string(),
      }),
      recipe: v.union(httpRetestRecipeViewValidator, v.null()),
      runs: v.array(httpRetestRunViewValidator),
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
    if (!access) return unavailable;
    const recipe = await latestRecipe(ctx, args.findingId);
    const runs = await ctx.db
      .query("finding_retest_runs")
      .withIndex("by_finding_and_started", (q) =>
        q.eq("finding_id", args.findingId),
      )
      .order("desc")
      .take(RETEST_HISTORY_LIMIT);
    const now = Date.now();
    return {
      available: true as const,
      finding: {
        finding_id: access.finding.finding_id,
        chat_id: access.chat.id,
        chat_title: access.chat.title,
        title: access.finding.title,
        target: access.finding.target,
        sandbox_preference: access.chat.sandbox_type ?? "e2b",
      },
      recipe: recipe
        ? {
            version: recipe.version,
            recipe: recipe.recipe,
            source: recipe.source,
            created_at: recipe.created_at,
          }
        : null,
      runs: runs
        .filter((run) => run.user_id === args.userId)
        .map((run) => toRunView(run, now)),
    };
  },
});

export const saveRecipeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    findingId: v.string(),
    chatId: v.optional(v.string()),
    expectedVersion: v.number(),
    recipe: v.any(),
    source: v.union(v.literal("user"), v.literal("agent")),
  },
  returns: v.union(
    v.object({ success: v.literal(true), version: v.number() }),
    v.object({
      success: v.literal(false),
      error: v.union(
        v.literal("not_found"),
        v.literal("validation"),
        v.literal("conflict"),
        v.literal("limit"),
      ),
      message: v.string(),
      current_version: v.optional(v.number()),
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
    if (!access)
      return {
        success: false as const,
        error: "not_found" as const,
        message: "This finding is not available.",
      };
    const parsed = parseHttpRetestRecipe(args.recipe);
    if (!parsed.success)
      return {
        success: false as const,
        error: "validation" as const,
        message: parsed.message,
      };
    if (httpRetestFindingOrigin(access.finding.target) !== parsed.recipe.origin)
      return {
        success: false as const,
        error: "validation" as const,
        message: "Use the HTTP origin of the saved finding.",
      };
    const latest = await latestRecipe(ctx, args.findingId);
    const currentVersion = latest?.version ?? 0;
    if (currentVersion !== args.expectedVersion)
      return {
        success: false as const,
        error: "conflict" as const,
        message: "The recipe changed. Reload it before saving again.",
        current_version: currentVersion,
      };
    if (currentVersion >= RETEST_MAX_RECIPE_VERSIONS)
      return {
        success: false as const,
        error: "limit" as const,
        message: "This finding has reached its recipe version limit.",
      };
    const version = currentVersion + 1;
    await ctx.db.insert("finding_retest_recipes", {
      user_id: args.userId,
      chat_id: access.chat.id,
      finding_id: args.findingId,
      version,
      recipe: parsed.recipe,
      source: args.source,
      created_at: Date.now(),
    });
    return { success: true as const, version };
  },
});

const startError = v.object({
  success: v.literal(false),
  error: v.union(
    v.literal("not_found"),
    v.literal("conflict"),
    v.literal("busy"),
    v.literal("rate_limited"),
    v.literal("validation"),
  ),
  message: v.string(),
});

export const startRunForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    findingId: v.string(),
    requestId: v.string(),
    recipeVersion: v.number(),
    reviewedSandbox: v.string(),
  },
  returns: v.union(
    startError,
    v.object({
      success: v.literal(true),
      duplicate: v.boolean(),
      run: httpRetestRunViewValidator,
      sandbox_preference: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(args.requestId))
      return {
        success: false as const,
        error: "validation" as const,
        message: "Invalid request ID.",
      };
    const access = await authorizeFinding(ctx, args.userId, args.findingId);
    if (!access)
      return {
        success: false as const,
        error: "not_found" as const,
        message: "This finding is not available.",
      };
    const now = Date.now();
    const sandboxPreference = access.chat.sandbox_type ?? "e2b";

    // Idempotent retry of the same deliberate run request.
    const existing = await ctx.db
      .query("finding_retest_runs")
      .withIndex("by_user_and_request", (q) =>
        q.eq("user_id", args.userId).eq("request_id", args.requestId),
      )
      .unique();
    if (existing) {
      if (existing.finding_id !== args.findingId)
        return {
          success: false as const,
          error: "validation" as const,
          message: "This request ID belongs to another run.",
        };
      return {
        success: true as const,
        duplicate: true,
        run: toRunView(existing, now),
        sandbox_preference: sandboxPreference,
      };
    }

    const recipe = await latestRecipe(ctx, args.findingId);
    if (
      !recipe ||
      recipe.version !== args.recipeVersion ||
      httpRetestFindingOrigin(access.finding.target) !== recipe.recipe.origin ||
      sandboxPreference !== args.reviewedSandbox
    )
      return {
        success: false as const,
        error: "conflict" as const,
        message: "The recipe, target, or computer changed. Review it again.",
      };

    // One active run per finding. An expired lease is finalized as interrupted
    // here, which also fences any late result from that execution.
    const active = await ctx.db
      .query("finding_retest_runs")
      .withIndex("by_finding_and_status", (q) =>
        q.eq("finding_id", args.findingId).eq("status", "running"),
      )
      .take(5);
    for (const run of active) {
      if (run.lease_expires_at > now)
        return {
          success: false as const,
          error: "busy" as const,
          message: "A retest is already running for this finding.",
        };
      await ctx.db.patch(run._id, {
        status: "finished",
        finished_at: run.lease_expires_at,
        outcome: "error",
        reason: "interrupted",
      });
    }

    const recent = await ctx.db
      .query("finding_retest_runs")
      .withIndex("by_user_and_started", (q) =>
        q.eq("user_id", args.userId).gte("started_at", now - HOUR_MS),
      )
      .take(RETEST_RUNS_PER_HOUR);
    if (recent.length >= RETEST_RUNS_PER_HOUR)
      return {
        success: false as const,
        error: "rate_limited" as const,
        message: "You've reached the hourly retest limit. Try again later.",
      };

    const runId = await ctx.db.insert("finding_retest_runs", {
      user_id: args.userId,
      chat_id: access.chat.id,
      finding_id: args.findingId,
      request_id: args.requestId,
      recipe_version: recipe.version,
      recipe: recipe.recipe,
      status: "running",
      started_at: now,
      lease_expires_at: now + RETEST_RUN_LEASE_MS,
    });
    const run = (await ctx.db.get(runId))!;
    return {
      success: true as const,
      duplicate: false,
      run: toRunView(run, now),
      sandbox_preference: sandboxPreference,
    };
  },
});

export const finishRunForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    runId: v.string(),
    requestId: v.string(),
    outcome: httpRetestOutcomeValidator,
    reason: httpRetestReasonValidator,
    steps: v.array(httpRetestStepValidator),
    environment: v.optional(httpRetestEnvironmentValidator),
    evidenceSha256: v.string(),
  },
  returns: v.union(
    v.object({ success: v.literal(true), run: httpRetestRunViewValidator }),
    v.object({
      success: v.literal(false),
      error: v.union(
        v.literal("not_found"),
        v.literal("stale"),
        v.literal("validation"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const id = ctx.db.normalizeId("finding_retest_runs", args.runId);
    const run = id ? await ctx.db.get(id) : null;
    if (
      !run ||
      run.user_id !== args.userId ||
      run.request_id !== args.requestId
    )
      return { success: false as const, error: "not_found" as const };
    // Finished runs are immutable, including late duplicate results.
    if (run.status !== "running")
      return { success: false as const, error: "stale" as const };
    const access = await authorizeFinding(ctx, args.userId, run.finding_id);
    if (!access)
      return { success: false as const, error: "not_found" as const };
    if (
      !/^[0-9a-f]{64}$/.test(args.evidenceSha256) ||
      args.steps.length > HTTP_RETEST_LIMITS.maxBaselines + 1 ||
      args.steps.some((step) => !httpRetestStepSchema.safeParse(step).success)
    )
      return { success: false as const, error: "validation" as const };
    const now = Date.now();
    if (run.lease_expires_at <= now) {
      await ctx.db.patch(run._id, {
        status: "finished",
        finished_at: run.lease_expires_at,
        outcome: "error",
        reason: "interrupted",
      });
      return { success: false as const, error: "stale" as const };
    }
    await ctx.db.patch(run._id, {
      status: "finished",
      finished_at: now,
      outcome: args.outcome,
      reason: args.reason,
      steps: args.steps,
      ...(args.environment && { environment: args.environment }),
      evidence_sha256: args.evidenceSha256,
    });
    return {
      success: true as const,
      run: toRunView((await ctx.db.get(run._id))!, now),
    };
  },
});

/**
 * Delete one batch of retest data for a chat. Returns true while rows remain,
 * so chat deletion can reschedule before removing the chat itself.
 */
export async function deleteFindingRetestsForChatBatch(
  ctx: MutationCtx,
  userId: string,
  chatId: string,
): Promise<boolean> {
  for (const table of [
    "finding_retest_runs",
    "finding_retest_recipes",
  ] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_user_and_chat", (q) =>
        q.eq("user_id", userId).eq("chat_id", chatId),
      )
      .take(DELETE_BATCH_SIZE + 1);
    for (const row of rows.slice(0, DELETE_BATCH_SIZE))
      await ctx.db.delete(row._id as Id<typeof table>);
    if (rows.length > DELETE_BATCH_SIZE) return true;
  }
  return false;
}

/** Continue cleanup of an individual deleted finding in bounded batches. */
export const deleteForFinding = internalMutation({
  args: { findingId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const recipes = await ctx.db
      .query("finding_retest_recipes")
      .withIndex("by_finding_and_version", (q) =>
        q.eq("finding_id", args.findingId),
      )
      .take(DELETE_BATCH_SIZE + 1);
    const runs = await ctx.db
      .query("finding_retest_runs")
      .withIndex("by_finding_and_started", (q) =>
        q.eq("finding_id", args.findingId),
      )
      .take(DELETE_BATCH_SIZE + 1);
    for (const row of [
      ...recipes.slice(0, DELETE_BATCH_SIZE),
      ...runs.slice(0, DELETE_BATCH_SIZE),
    ]) {
      if (row.user_id === args.userId) await ctx.db.delete(row._id);
    }
    if (recipes.length > DELETE_BATCH_SIZE || runs.length > DELETE_BATCH_SIZE)
      await ctx.scheduler.runAfter(
        0,
        internal.findingRetests.deleteForFinding,
        args,
      );
    return null;
  },
});
