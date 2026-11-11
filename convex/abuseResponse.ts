import { v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./lib/serviceFunctions";
import type { Doc, Id } from "./_generated/dataModel";
import {
  abuseResponseDiscovery,
  abuseResponseSummary,
  abuseResponseTarget,
  abuseTransport,
} from "./lib/abuseValidators";
import {
  ABUSE_RESPONSE_LEASE_MS,
  ABUSE_RESPONSE_MAX_TARGETS,
  ABUSE_RESPONSE_PAGE_SIZE,
  abuseResponseError,
  assertAbuseOperator,
  assertReviewDates,
  boundedAbuseCiphertext,
  computeResponsePlan,
  invalidateLocalAccess,
  isAbuseOperatorId,
  summarizeResponse,
  type AbuseResponseScope,
} from "./lib/abuseResponse";

// Late or completed reports: restrict the verified account, revoke local
// access, and request cancellation of currently active owned work. This path
// never uses abuseCases.beginContainment, so its active-root guard is unchanged.

const operatorArgs = { serviceKey: v.string(), actor: v.string() };
const caseArgs = { ...operatorArgs, reference: v.string() };
const leaseArgs = { ...caseArgs, operationToken: v.string() };
const scopeArgs = {
  userId: v.string(),
  chatId: v.string(),
  runId: v.optional(v.string()),
  transport: abuseTransport,
  environmentId: v.optional(v.string()),
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NEXT_PHASE = {
  roots: "queued",
  queued: "running",
  running: "finalizing",
  finalizing: "done",
} as const;
const applyResult = v.object({
  outcome: v.union(
    v.literal("applied"),
    v.literal("resumed"),
    v.literal("in_progress"),
  ),
  operationToken: v.optional(v.string()),
  response: abuseResponseSummary,
});

async function findCase(ctx: QueryCtx | MutationCtx, reference: string) {
  const row = await ctx.db
    .query("abuse_cases")
    .withIndex("by_reference", (q) => q.eq("reference", reference))
    .unique();
  if (!row) throw abuseResponseError("ABUSE_CASE_UNAVAILABLE");
  return row;
}
function responseFor(ctx: QueryCtx | MutationCtx, caseId: Id<"abuse_cases">) {
  return ctx.db
    .query("abuse_responses")
    .withIndex("by_caseId", (q) => q.eq("caseId", caseId))
    .unique();
}
async function event(
  ctx: MutationCtx,
  caseId: Id<"abuse_cases">,
  actor: string,
  kind: Doc<"abuse_events">["kind"],
  ciphertext?: string,
) {
  await ctx.db.insert("abuse_events", {
    caseId,
    actor,
    kind,
    ...(ciphertext ? { ciphertext } : {}),
    createdAt: Date.now(),
  });
}
function scopeOf(args: AbuseResponseScope): AbuseResponseScope {
  return {
    userId: args.userId,
    chatId: args.chatId,
    transport: args.transport,
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.environmentId ? { environmentId: args.environmentId } : {}),
  };
}
async function summary(ctx: MutationCtx, caseId: Id<"abuse_cases">) {
  const row = (await ctx.db.get(caseId))!;
  return summarizeResponse(ctx, row, (await responseFor(ctx, caseId))!);
}

/**
 * Every recorded step renews the caller's exclusive lease. Steps that can lead
 * to further Trigger effects also require the recorded restriction to remain
 * active; only `finish` may release a lease after it was lifted.
 */
async function leased(
  ctx: MutationCtx,
  args: {
    serviceKey: string;
    actor: string;
    reference: string;
    operationToken: string;
  },
  requireActiveRestriction = true,
) {
  assertAbuseOperator(args.serviceKey, args.actor);
  const row = await findCase(ctx, args.reference);
  const response = await responseFor(ctx, row._id);
  if (
    !response ||
    row.status === "resolved" ||
    response.operationToken !== args.operationToken ||
    (response.operationExpiresAt ?? 0) <= Date.now()
  )
    throw abuseResponseError("ABUSE_RESPONSE_LEASE_LOST");
  if (requireActiveRestriction) {
    const suspension = await ctx.db.get(response.suspensionId);
    if (
      suspension?.status !== "active" ||
      suspension.user_id !== response.userId ||
      suspension.source_id !== response.sourceId
    )
      throw abuseResponseError("ABUSE_RESTRICTION_CONFLICT");
  }
  return { row, response };
}

/** A lost apply response and an explicit retry resume the same recorded response. */
async function resume(
  ctx: MutationCtx,
  row: Doc<"abuse_cases">,
  response: Doc<"abuse_responses">,
  actor: string,
  operationToken: string,
) {
  const now = Date.now();
  if (!["new", "reviewing", "needs_followup"].includes(row.status))
    throw abuseResponseError("ABUSE_CASE_UNAVAILABLE");
  const suspension = await ctx.db.get(response.suspensionId);
  if (suspension?.status !== "active")
    throw abuseResponseError("ABUSE_RESTRICTION_CONFLICT");
  if ((response.operationExpiresAt ?? 0) > now)
    return {
      outcome: "in_progress" as const,
      response: await summarizeResponse(ctx, row, response),
    };
  const local = await invalidateLocalAccess(
    ctx,
    response.userId,
    response.sourceId,
    now,
  );
  // New active work cannot start while restricted, but a queued run can become
  // active later. Every resume rescans from the first page.
  await ctx.db.patch(response._id, {
    connectionsDisconnected:
      response.connectionsDisconnected + local.disconnected,
    connectionsRemaining: local.remaining,
    discoveryPhase: "roots",
    discoveryCursor: undefined,
    operationToken,
    operationExpiresAt: now + ABUSE_RESPONSE_LEASE_MS,
    updatedAt: now,
  });
  await event(ctx, row._id, actor, "containment_started");
  await ctx.db.patch(row._id, { revision: row.revision + 1, updatedAt: now });
  return {
    outcome: "resumed" as const,
    operationToken,
    response: await summary(ctx, row._id),
  };
}

/** Import an emailed report as an operator-only case. Creates no restriction. */
export const importCase = mutation({
  args: {
    ...caseArgs,
    kind: v.union(v.literal("abuse"), v.literal("appeal")),
    ciphertext: v.string(),
    digests: v.array(v.string()),
  },
  returns: v.object({
    outcome: v.union(v.literal("created"), v.literal("existing")),
    revision: v.number(),
    // A retained queue receipt for the reference; content is not compared.
    intakeReceipt: v.union(v.literal("found"), v.literal("not_found")),
  }),
  handler: async (ctx, args) => {
    assertAbuseOperator(args.serviceKey, args.actor);
    if (
      !/^AB-[a-f0-9-]{36}$/.test(args.reference) ||
      args.digests.length < 1 ||
      args.digests.length > 5 ||
      !args.digests.every((digest) => DIGEST.test(digest))
    )
      throw abuseResponseError("ABUSE_INVALID_INPUT");
    boundedAbuseCiphertext(args.ciphertext, true);
    const receipt = await ctx.db
      .query("abuse_notifications")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .first();
    const intakeReceipt = receipt ? ("found" as const) : ("not_found" as const);
    const existing = await ctx.db
      .query("abuse_cases")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .unique();
    if (existing) {
      if (
        existing.kind !== args.kind ||
        !args.digests.includes(existing.digest)
      )
        throw abuseResponseError("ABUSE_IMPORT_CONFLICT");
      return {
        outcome: "existing" as const,
        revision: existing.revision,
        intakeReceipt,
      };
    }
    const now = Date.now();
    const caseId = await ctx.db.insert("abuse_cases", {
      reference: args.reference,
      digest: args.digests[0],
      kind: args.kind,
      ciphertext: args.ciphertext,
      status: "new",
      revision: 0,
      evidenceHold: true,
      createdAt: now,
      updatedAt: now,
    });
    await event(ctx, caseId, args.actor, "received");
    return { outcome: "created" as const, revision: 0, intakeReceipt };
  },
});

export const plan = query({
  args: { ...caseArgs, ...scopeArgs },
  returns: v.object({
    reference: v.string(),
    revision: v.number(),
    planDigest: v.string(),
    sourceId: v.string(),
    restriction: v.union(v.literal("create"), v.literal("adopt")),
    existingResponse: v.boolean(),
    localToken: v.union(
      v.literal("active"),
      v.literal("revoked"),
      v.literal("none"),
    ),
    connectedLocalConnections: v.number(),
    activeRootChats: v.number(),
    activeRootChatsTruncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertAbuseOperator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    const planned = await computeResponsePlan(ctx, row, scopeOf(args));
    const token = await ctx.db
      .query("local_sandbox_tokens")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();
    const connections = await ctx.db
      .query("local_sandbox_connections")
      .withIndex("by_user_and_status", (q) =>
        q.eq("user_id", args.userId).eq("status", "connected"),
      )
      .take(101);
    const roots = await ctx.db
      .query("chats")
      .withIndex("by_user_and_active_trigger_run", (q) =>
        q.eq("user_id", args.userId).gt("active_trigger_run_id", ""),
      )
      .take(ABUSE_RESPONSE_PAGE_SIZE + 1);
    return {
      reference: row.reference,
      revision: row.revision,
      planDigest: planned.digest,
      sourceId: planned.sourceId,
      restriction: planned.existing ? ("adopt" as const) : ("create" as const),
      existingResponse: (await responseFor(ctx, row._id)) !== null,
      localToken: !token
        ? ("none" as const)
        : token.revoked_at !== undefined
          ? ("revoked" as const)
          : ("active" as const),
      connectedLocalConnections: Math.min(connections.length, 100),
      activeRootChats: Math.min(roots.length, ABUSE_RESPONSE_PAGE_SIZE),
      activeRootChatsTruncated: roots.length > ABUSE_RESPONSE_PAGE_SIZE,
    };
  },
});

/**
 * The single reviewed action. One transaction records encrypted attribution
 * and decision, restricts the exact verified account, revokes local access,
 * and creates the response's durable receipts before any Trigger request.
 */
export const apply = mutation({
  args: {
    ...caseArgs,
    ...scopeArgs,
    planDigest: v.string(),
    requestId: v.string(),
    requestDigests: v.array(v.string()),
    reviewer: v.string(),
    reviewDate: v.string(),
    retentionReviewDate: v.string(),
    acknowledgeRestriction: v.literal(true),
    acknowledgeProcessUnconfirmed: v.literal(true),
    verifiedFacts: v.string(),
    decision: v.string(),
    operationToken: v.string(),
  },
  returns: applyResult,
  handler: async (ctx, args) => {
    assertAbuseOperator(args.serviceKey, args.actor);
    if (!isAbuseOperatorId(args.reviewer))
      throw abuseResponseError("ABUSE_REVIEW_REQUIRED");
    if (
      !UUID.test(args.requestId) ||
      !UUID.test(args.operationToken) ||
      args.requestDigests.length < 1 ||
      args.requestDigests.length > 5 ||
      !args.requestDigests.every((digest) => DIGEST.test(digest))
    )
      throw abuseResponseError("ABUSE_INVALID_INPUT");
    const now = Date.now();
    assertReviewDates(args.reviewDate, args.retentionReviewDate, now);
    const row = await findCase(ctx, args.reference);
    const existing = await responseFor(ctx, row._id);
    if (existing) {
      if (
        existing.requestId !== args.requestId ||
        !args.requestDigests.includes(existing.requestDigest)
      )
        throw abuseResponseError("ABUSE_RESPONSE_EXISTS");
      return resume(ctx, row, existing, args.actor, args.operationToken);
    }
    boundedAbuseCiphertext(args.verifiedFacts, true);
    boundedAbuseCiphertext(args.decision, true);
    const scope = scopeOf(args);
    const planned = await computeResponsePlan(ctx, row, scope);
    if (planned.digest !== args.planDigest)
      throw abuseResponseError("ABUSE_PLAN_CHANGED");
    // Immutable attribution and decision precede every restrictive write.
    await event(ctx, row._id, args.actor, "verified_fact", args.verifiedFacts);
    await event(ctx, row._id, args.actor, "decision", args.decision);
    const suspensionId =
      planned.existing?._id ??
      (await ctx.db.insert("user_suspensions", {
        user_id: scope.userId,
        status: "active",
        category: "security_abuse",
        source: "support",
        source_id: planned.sourceId,
        source_reason: "reviewed_abuse_case",
        created_at: now,
        updated_at: now,
        source_created_at: now,
      }));
    const local = await invalidateLocalAccess(
      ctx,
      scope.userId,
      planned.sourceId,
      now,
    );
    await ctx.db.insert("abuse_responses", {
      caseId: row._id,
      requestId: args.requestId,
      requestDigest: args.requestDigests[0],
      planDigest: planned.digest,
      actor: args.actor,
      reviewer: args.reviewer,
      reviewDate: args.reviewDate,
      retentionReviewDate: args.retentionReviewDate,
      ...scope,
      sourceId: planned.sourceId,
      suspensionId,
      restriction: planned.existing ? "adopted" : "created",
      localToken: local.token,
      connectionsDisconnected: local.disconnected,
      connectionsRemaining: local.remaining,
      discoveryPhase: "roots",
      targetOverflow: false,
      targets: [],
      operationToken: args.operationToken,
      operationExpiresAt: now + ABUSE_RESPONSE_LEASE_MS,
      appliedAt: now,
      updatedAt: now,
    });
    await event(ctx, row._id, args.actor, "containment_started");
    await ctx.db.patch(row._id, {
      status: "needs_followup",
      evidenceHold: true,
      activeContainmentUserId: scope.userId,
      revision: row.revision + 1,
      updatedAt: now,
    });
    return {
      outcome: "applied" as const,
      operationToken: args.operationToken,
      response: await summary(ctx, row._id),
    };
  },
});

export const retry = mutation({
  args: leaseArgs,
  returns: applyResult,
  handler: async (ctx, args) => {
    assertAbuseOperator(args.serviceKey, args.actor);
    if (!UUID.test(args.operationToken))
      throw abuseResponseError("ABUSE_INVALID_INPUT");
    const row = await findCase(ctx, args.reference);
    const response = await responseFor(ctx, row._id);
    if (!response) throw abuseResponseError("ABUSE_CASE_UNAVAILABLE");
    return resume(ctx, row, response, args.actor, args.operationToken);
  },
});

/** One bounded page per call: active owned roots, then active owned children. */
export const discover = mutation({
  args: leaseArgs,
  returns: v.object({
    phase: abuseResponseDiscovery,
    userId: v.string(),
    targets: v.array(abuseResponseTarget),
  }),
  handler: async (ctx, args) => {
    const { response } = await leased(ctx, args);
    const now = Date.now();
    const targets = [...response.targets];
    let overflow = response.targetOverflow;
    let phase = response.discoveryPhase;
    let cursor = response.discoveryCursor ?? null;
    const add = (
      target: Omit<
        Doc<"abuse_responses">["targets"][number],
        "state" | "attempts" | "updatedAt"
      >,
    ) => {
      if (targets.some((known) => known.runId === target.runId)) return;
      if (targets.length >= ABUSE_RESPONSE_MAX_TARGETS) {
        overflow = true;
        return;
      }
      targets.push({
        ...target,
        state: "pending",
        attempts: 0,
        updatedAt: now,
      });
    };
    if (phase !== "done") {
      const page = { cursor, numItems: ABUSE_RESPONSE_PAGE_SIZE };
      let result: { isDone: boolean; continueCursor: string };
      if (phase === "roots") {
        const chats = await ctx.db
          .query("chats")
          .withIndex("by_user_and_active_trigger_run", (q) =>
            q.eq("user_id", response.userId).gt("active_trigger_run_id", ""),
          )
          .paginate(page);
        for (const chat of chats.page) {
          if (!chat.active_trigger_run_id) continue;
          add({
            runId: chat.active_trigger_run_id,
            kind: "root",
            chatId: chat.id,
            ...(chat.active_agent_approval_session_id
              ? { approvalSessionId: chat.active_agent_approval_session_id }
              : {}),
          });
        }
        result = chats;
      } else {
        const status = phase;
        const children = await ctx.db
          .query("subagent_runs")
          .withIndex("by_user_and_status", (q) =>
            q.eq("user_id", response.userId).eq("status", status),
          )
          .paginate(page);
        for (const child of children.page) {
          if (!child.trigger_run_id) continue;
          add({
            runId: child.trigger_run_id,
            kind: "child",
            chatId: child.chat_id,
            subagentId: child.subagent_id,
          });
        }
        result = children;
      }
      if (result.isDone) {
        phase = NEXT_PHASE[phase];
        cursor = null;
      } else cursor = result.continueCursor;
    }
    await ctx.db.patch(response._id, {
      discoveryPhase: phase,
      discoveryCursor: cursor ?? undefined,
      targets,
      targetOverflow: overflow,
      operationExpiresAt: now + ABUSE_RESPONSE_LEASE_MS,
      updatedAt: now,
    });
    return { phase, userId: response.userId, targets };
  },
});

/** Durable per-target receipt. A terminal observation is never downgraded. */
export const recordTarget = mutation({
  args: {
    ...leaseArgs,
    runId: v.string(),
    state: v.union(
      v.literal("cancel_requested"),
      v.literal("terminal"),
      v.literal("identity_mismatch"),
      v.literal("unknown"),
    ),
    triggerStatus: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { response } = await leased(ctx, args);
    const now = Date.now();
    const index = response.targets.findIndex(
      (target) => target.runId === args.runId,
    );
    if (index < 0) throw abuseResponseError("ABUSE_INVALID_INPUT");
    const targets = [...response.targets];
    const { triggerStatus: _previousStatus, ...previous } = targets[index];
    if (previous.state !== "terminal")
      targets[index] = {
        ...previous,
        state: args.state,
        ...(args.triggerStatus && /^[A-Z_]{1,32}$/.test(args.triggerStatus)
          ? { triggerStatus: args.triggerStatus }
          : {}),
        attempts: previous.attempts + 1,
        updatedAt: now,
      };
    await ctx.db.patch(response._id, {
      targets,
      operationExpiresAt: now + ABUSE_RESPONSE_LEASE_MS,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Verify ownership immediately before an external Trigger effect and renew the
 * lease. The CLI dispatches only within its short budget after this succeeds.
 */
export const checkpoint = mutation({
  args: leaseArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const { response } = await leased(ctx, args);
    const now = Date.now();
    await ctx.db.patch(response._id, {
      operationExpiresAt: now + ABUSE_RESPONSE_LEASE_MS,
      updatedAt: now,
    });
    return null;
  },
});

export const finish = mutation({
  args: leaseArgs,
  returns: abuseResponseSummary,
  handler: async (ctx, args) => {
    const { row, response } = await leased(ctx, args, false);
    const now = Date.now();
    await ctx.db.patch(response._id, {
      operationToken: undefined,
      operationExpiresAt: undefined,
      updatedAt: now,
    });
    await event(ctx, row._id, args.actor, "containment_updated");
    await ctx.db.patch(row._id, { updatedAt: now });
    return summary(ctx, row._id);
  },
});

export const status = query({
  args: caseArgs,
  returns: v.union(abuseResponseSummary, v.null()),
  handler: async (ctx, args) => {
    assertAbuseOperator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    const response = await responseFor(ctx, row._id);
    return response ? summarizeResponse(ctx, row, response) : null;
  },
});
