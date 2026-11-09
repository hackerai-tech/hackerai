import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";
import {
  abuseCase,
  abuseContainment,
  abuseEvent,
  abuseStatus,
  abuseTransport,
} from "./lib/abuseValidators";
import type { Doc } from "./_generated/dataModel";
import { MAX_SUBAGENTS_PER_PARENT_RUN } from "../lib/ai/subagents/contracts";

const operatorArgs = { serviceKey: v.string(), actor: v.string() };
const caseArgs = { ...operatorArgs, reference: v.string() };
const revisionArgs = { ...caseArgs, expectedRevision: v.number() };
// The HTTP operation has a five-minute hard runtime limit. A longer lease lets
// an interrupted operation be retried without overlapping its previous owner.
const OPERATION_LEASE_MS = 10 * 60_000;

function operator(serviceKey: string, actor: string) {
  validateServiceKey(serviceKey);
  const allowed = (process.env.ABUSE_OPERATOR_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!allowed.includes(actor)) throw new Error("Abuse operator access denied");
}
function boundedCiphertext(value: string) {
  if (
    !/^v1\.[a-zA-Z0-9_-]{1,32}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(
      value,
    ) ||
    value.length > 128 * 1024
  ) {
    throw new Error("Invalid encrypted evidence");
  }
}
async function findCase(ctx: QueryCtx | MutationCtx, reference: string) {
  const row = await ctx.db
    .query("abuse_cases")
    .withIndex("by_reference", (q) => q.eq("reference", reference))
    .unique();
  if (!row) throw new Error("Abuse case unavailable");
  return row;
}
function current(row: Doc<"abuse_cases">, revision: number) {
  if (row.revision !== revision)
    throw new Error("Abuse case changed; reload before acting");
}
async function event(
  ctx: MutationCtx,
  row: Doc<"abuse_cases">,
  actor: string,
  kind: Doc<"abuse_events">["kind"],
  ciphertext?: string,
) {
  if (ciphertext !== undefined) boundedCiphertext(ciphertext);
  await ctx.db.insert("abuse_events", {
    caseId: row._id,
    actor,
    kind,
    ...(ciphertext ? { ciphertext } : {}),
    createdAt: Date.now(),
  });
}

export const receive = mutation({
  args: {
    serviceKey: v.string(),
    reference: v.string(),
    digests: v.array(v.string()),
    kind: v.union(v.literal("abuse"), v.literal("appeal")),
    ciphertext: v.string(),
    sourceHashes: v.array(v.string()),
    emailHashes: v.array(v.string()),
  },
  returns: v.object({
    outcome: v.union(
      v.literal("received"),
      v.literal("rate_limited"),
      v.literal("conflict"),
    ),
    reference: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (process.env.ABUSE_INTAKE_ENABLED !== "true")
      throw new Error("Abuse intake unavailable");
    if (
      !/^AB-[a-f0-9-]{36}$/.test(args.reference) ||
      ![args.digests, args.sourceHashes, args.emailHashes].every(
        (values) =>
          values.length >= 1 &&
          values.length <= 5 &&
          values.every((value) => /^[a-f0-9]{64}$/.test(value)),
      )
    )
      throw new Error("Invalid intake metadata");
    boundedCiphertext(args.ciphertext);
    const existing = await ctx.db
      .query("abuse_cases")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .unique();
    if (existing)
      return args.digests.includes(existing.digest)
        ? { outcome: "received" as const, reference: existing.reference }
        : { outcome: "conflict" as const };
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000);
    const buckets = [
      ...args.sourceHashes.map(
        (hash) => [`source:${hash}:${hour}`, 5] as const,
      ),
      ...args.emailHashes.map((hash) => [`email:${hash}:${hour}`, 3] as const),
    ] as const;
    const limits = await Promise.all(
      buckets.map(async ([bucket, maximum]) => ({
        bucket,
        maximum,
        row: await ctx.db
          .query("abuse_rate_limits")
          .withIndex("by_bucket", (q) => q.eq("bucket", bucket))
          .unique(),
      })),
    );
    if (limits.some(({ row, maximum }) => row && row.count >= maximum))
      return { outcome: "rate_limited" as const };
    for (const { bucket, row } of limits) {
      if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
      else
        await ctx.db.insert("abuse_rate_limits", {
          bucket,
          count: 1,
          expiresAt: (hour + 2) * 3_600_000,
        });
    }
    // Only transient limiter hashes expire; case evidence has no automatic purge.
    const expired = await ctx.db
      .query("abuse_rate_limits")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const row of expired) await ctx.db.delete(row._id);
    const caseId = await ctx.db.insert("abuse_cases", {
      reference: args.reference,
      digest: args.digests[0],
      kind: args.kind,
      ciphertext: args.ciphertext,
      status: "new",
      revision: 0,
      evidenceHold: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("abuse_events", {
      caseId,
      actor: "public_intake",
      kind: "received",
      createdAt: now,
    });
    return { outcome: "received" as const, reference: args.reference };
  },
});

export const list = query({
  args: {
    ...operatorArgs,
    status: abuseStatus,
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        reference: v.string(),
        kind: v.union(v.literal("abuse"), v.literal("appeal")),
        status: abuseStatus,
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const result = await ctx.db
      .query("abuse_cases")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems: Math.min(50, Math.max(1, args.paginationOpts.numItems)),
      });
    return {
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      page: result.page.map(
        ({ reference, kind, status, createdAt, updatedAt }) => ({
          reference,
          kind,
          status,
          createdAt,
          updatedAt,
        }),
      ),
    };
  },
});

export const read = mutation({
  args: { ...caseArgs, paginationOpts: paginationOptsValidator },
  returns: v.object({
    case: abuseCase,
    restrictionStatus: v.union(
      v.literal("active"),
      v.literal("resolved"),
      v.null(),
    ),
    events: v.array(abuseEvent),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    const restriction = row.containment
      ? await ctx.db
          .query("user_suspensions")
          .withIndex("by_user_and_source", (q) =>
            q
              .eq("user_id", row.containment!.userId)
              .eq("source_id", `abuse:${row.reference}`),
          )
          .unique()
      : null;
    const events = await ctx.db
      .query("abuse_events")
      .withIndex("by_caseId", (q) => q.eq("caseId", row._id))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(50, Math.max(1, args.paginationOpts.numItems)),
      });
    await event(ctx, row, args.actor, "read");
    return {
      case: row,
      restrictionStatus:
        restriction?.category === "security_abuse" &&
        restriction.source === "support"
          ? restriction.status
          : null,
      events: events.page,
      isDone: events.isDone,
      continueCursor: events.continueCursor,
    };
  },
});

export const annotate = mutation({
  args: {
    ...revisionArgs,
    kind: v.union(
      v.literal("allegation"),
      v.literal("verified_fact"),
      v.literal("decision"),
    ),
    ciphertext: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    current(row, args.expectedRevision);
    if (!row.ciphertext) throw new Error("Case evidence has been deleted");
    await event(ctx, row, args.actor, args.kind, args.ciphertext);
    await ctx.db.patch(row._id, {
      revision: row.revision + 1,
      status: row.status === "new" ? "reviewing" : row.status,
      updatedAt: Date.now(),
    });
    return row.revision + 1;
  },
});

export const beginContainment = mutation({
  args: {
    ...revisionArgs,
    userId: v.string(),
    chatId: v.string(),
    runId: v.string(),
    transport: abuseTransport,
    preserveSnapshot: v.boolean(),
    sandboxId: v.optional(v.string()),
    region: v.optional(v.string()),
    decision: v.string(),
    operationToken: v.string(),
  },
  returns: abuseCase,
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    current(row, args.expectedRevision);
    if (
      !["new", "reviewing", "needs_followup"].includes(row.status) ||
      row.containment
    )
      throw new Error(
        "Containment already recorded; inspect or retry the existing operation",
      );
    const verified = await ctx.db
      .query("abuse_events")
      .withIndex("by_caseId_and_kind", (q) =>
        q.eq("caseId", row._id).eq("kind", "verified_fact"),
      )
      .first();
    if (!verified)
      throw new Error("Record verified attribution facts before containment");
    const competingCase = await ctx.db
      .query("abuse_cases")
      .withIndex("by_active_containment_user", (q) =>
        q.eq("activeContainmentUserId", args.userId),
      )
      .first();
    if (competingCase)
      throw new Error(
        "Review the existing active containment case for this account",
      );
    const chat = await ctx.db
      .query("chats")
      .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
      .unique();
    if (
      !chat ||
      chat.user_id !== args.userId ||
      chat.active_trigger_run_id !== args.runId ||
      chat.deletion_started_at
    )
      throw new ConvexError({
        code: "ABUSE_ACTIVE_ROOT_CHANGED",
        message: "Run ownership changed; inspect before acting",
      });
    if (args.transport === "cloud" && (!args.sandboxId || !args.region))
      throw new Error("Cloud workspace identity required");
    const children = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.runId),
      )
      .take(MAX_SUBAGENTS_PER_PARENT_RUN + 1);
    if (children.length > MAX_SUBAGENTS_PER_PARENT_RUN)
      throw new Error("Child scope exceeds the supported bound");
    const now = Date.now();
    const containment = {
      userId: args.userId,
      chatId: args.chatId,
      runId: args.runId,
      transport: args.transport,
      snapshotRequested: args.transport === "cloud" && args.preserveSnapshot,
      snapshotReviewPending:
        args.transport === "cloud" && args.preserveSnapshot,
      ...(args.transport === "cloud" && args.preserveSnapshot
        ? { snapshotName: `abuse-${row.reference.toLowerCase()}` }
        : {}),
      childRunIds: children.flatMap((child) =>
        child.trigger_run_id ? [child.trigger_run_id] : [],
      ),
      ...(chat.active_agent_approval_session_id
        ? { approvalSessionId: chat.active_agent_approval_session_id }
        : {}),
      ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
      ...(args.region ? { region: args.region } : {}),
      processState: "unconfirmed" as const,
      triggerState: "unconfirmed" as const,
      workspaceState:
        args.transport === "cloud"
          ? ("unconfirmed" as const)
          : ("not_applicable" as const),
    };
    await ctx.db.insert("user_suspensions", {
      user_id: args.userId,
      status: "active",
      category: "security_abuse",
      source: "support",
      source_id: `abuse:${row.reference}`,
      source_reason: "reviewed_abuse_case",
      created_at: now,
      updated_at: now,
      source_created_at: now,
    });
    for (const child of children) {
      if (["queued", "running", "finalizing"].includes(child.status))
        await ctx.db.patch(child._id, {
          status: "canceled",
          cancel_reason: "reviewed_security_abuse",
          completed_at: now,
          updated_at: now,
        });
    }
    await event(ctx, row, args.actor, "containment_started", args.decision);
    await ctx.db.patch(row._id, {
      containment,
      activeContainmentUserId: args.userId,
      status: "containing",
      evidenceHold: true,
      operationToken: args.operationToken,
      operationExpiresAt: now + OPERATION_LEASE_MS,
      revision: row.revision + 1,
      updatedAt: now,
    });
    return (await ctx.db.get(row._id))!;
  },
});

/** Every durable step precedes the next provider mutation; retry never loses a snapshot. */
export const recordContainment = mutation({
  args: {
    ...caseArgs,
    operationToken: v.string(),
    containment: abuseContainment,
    finished: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    const before = row.containment;
    const next = args.containment;
    if (
      row.operationToken !== args.operationToken ||
      (row.operationExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Containment operation expired; reload before retrying");
    if (
      !before ||
      !["containing", "needs_followup"].includes(row.status) ||
      before.userId !== next.userId ||
      before.runId !== next.runId ||
      before.chatId !== next.chatId ||
      before.transport !== next.transport ||
      before.sandboxId !== next.sandboxId ||
      before.region !== next.region ||
      before.snapshotRequested !== next.snapshotRequested ||
      before.snapshotName !== next.snapshotName ||
      JSON.stringify(before.childRunIds) !== JSON.stringify(next.childRunIds) ||
      before.approvalSessionId !== next.approvalSessionId ||
      (before.snapshotId && before.snapshotId !== next.snapshotId)
    )
      throw new Error("Containment scope cannot change");
    const confirmed =
      next.processState !== "unconfirmed" &&
      next.triggerState === "stopped" &&
      next.workspaceState !== "unconfirmed";
    await ctx.db.patch(row._id, {
      containment: next,
      ...(args.finished
        ? { operationToken: undefined, operationExpiresAt: undefined }
        : {}),
      status: args.finished
        ? confirmed
          ? "contained"
          : "needs_followup"
        : "containing",
      revision: row.revision + 1,
      updatedAt: Date.now(),
    });
    await event(ctx, row, args.actor, "containment_updated");
    return null;
  },
});

export const resolve = mutation({
  args: { ...revisionArgs, decision: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    current(row, args.expectedRevision);
    if (row.status === "containing")
      throw new Error("Containment is still in progress");
    if (!row.ciphertext || row.status === "resolved")
      throw new Error("Case already resolved or evidence deleted");
    if (
      row.containment?.transport === "cloud" &&
      !["released", "restored"].includes(row.containment.workspaceState)
    )
      throw new Error(
        "Finish workspace recovery before resolving the restriction",
      );
    if (row.containment) {
      const suspension = await ctx.db
        .query("user_suspensions")
        .withIndex("by_user_and_source", (q) =>
          q
            .eq("user_id", row.containment!.userId)
            .eq("source_id", `abuse:${row.reference}`),
        )
        .unique();
      if (
        suspension?.category === "security_abuse" &&
        suspension.source === "support"
      )
        await ctx.db.patch(suspension._id, {
          status: "resolved",
          resolved_at: Date.now(),
          resolved_reason: "case_review_completed",
          updated_at: Date.now(),
        });
    }
    await event(ctx, row, args.actor, "resolved", args.decision);
    await ctx.db.patch(row._id, {
      status: "resolved",
      activeContainmentUserId: undefined,
      revision: row.revision + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const setEvidenceHold = mutation({
  args: { ...revisionArgs, hold: v.boolean(), decision: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    current(row, args.expectedRevision);
    if (!args.hold && row.containment?.snapshotReviewPending)
      throw new Error(
        "Reconcile possible provider snapshot before releasing preservation",
      );
    if (!args.hold && row.status !== "resolved")
      throw new Error("Resolve the case before releasing preservation");
    if (!row.ciphertext) throw new Error("Case evidence has been deleted");
    await event(ctx, row, args.actor, "hold_changed", args.decision);
    await ctx.db.patch(row._id, {
      evidenceHold: args.hold,
      revision: row.revision + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const retryContainment = mutation({
  args: {
    ...revisionArgs,
    operationToken: v.string(),
    emergencyDecision: v.optional(v.string()),
  },
  returns: abuseCase,
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    current(row, args.expectedRevision);
    if (
      !row.containment ||
      !["containing", "needs_followup"].includes(row.status) ||
      (row.operationExpiresAt ?? 0) > Date.now()
    )
      throw new Error("Containment cannot be retried yet");
    if (args.emergencyDecision) {
      if (
        row.containment.transport !== "cloud" ||
        row.containment.snapshotId ||
        !row.containment.snapshotRequested
      )
        throw new Error(
          "Emergency stop is only for unconfirmed snapshot preservation",
        );
      await event(ctx, row, args.actor, "decision", args.emergencyDecision);
    }
    await ctx.db.patch(row._id, {
      status: "containing",
      ...(args.emergencyDecision
        ? { containment: { ...row.containment, snapshotRequested: false } }
        : {}),
      operationToken: args.operationToken,
      operationExpiresAt: Date.now() + OPERATION_LEASE_MS,
      revision: row.revision + 1,
      updatedAt: Date.now(),
    });
    await event(ctx, row, args.actor, "containment_started");
    return (await ctx.db.get(row._id))!;
  },
});

export const confirmLocalProcessStop = mutation({
  args: { ...revisionArgs, decision: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    current(row, args.expectedRevision);
    if (
      row.status !== "needs_followup" ||
      !row.containment ||
      row.containment.transport === "cloud"
    )
      throw new Error(
        "Manual confirmation is only for local or Desktop follow-up",
      );
    await event(ctx, row, args.actor, "verified_fact", args.decision);
    await ctx.db.patch(row._id, {
      containment: { ...row.containment, processState: "operator_confirmed" },
      status:
        row.containment.triggerState === "stopped"
          ? "contained"
          : "needs_followup",
      revision: row.revision + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Deliberate, bounded deletion of report/notes; audit metadata and snapshot references remain. */
export const eraseEvidence = mutation({
  args: { ...revisionArgs, confirmation: v.string() },
  returns: v.object({ more: v.boolean(), revision: v.number() }),
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    current(row, args.expectedRevision);
    if (
      row.status !== "resolved" ||
      row.evidenceHold ||
      args.confirmation !== row.reference
    )
      throw new Error(
        "Resolve and release preservation before deleting evidence",
      );
    const events = await ctx.db
      .query("abuse_events")
      .withIndex("by_caseId", (q) => q.eq("caseId", row._id))
      .paginate({ cursor: row.erasureCursor ?? null, numItems: 100 });
    for (const entry of events.page) {
      if (entry.ciphertext)
        await ctx.db.patch(entry._id, { ciphertext: undefined });
    }
    await ctx.db.patch(row._id, {
      ciphertext: undefined,
      erasureCursor: events.isDone ? undefined : events.continueCursor,
      revision: row.revision + 1,
      updatedAt: Date.now(),
    });
    if (events.isDone) await event(ctx, row, args.actor, "evidence_deleted");
    return { more: !events.isDone, revision: row.revision + 1 };
  },
});

export const reconcileSnapshot = mutation({
  args: { ...revisionArgs, snapshotId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    operator(args.serviceKey, args.actor);
    const row = await findCase(ctx, args.reference);
    current(row, args.expectedRevision);
    if (
      !row.containment?.snapshotName ||
      row.status === "containing" ||
      (row.containment.snapshotId &&
        row.containment.snapshotId !== args.snapshotId)
    )
      throw new Error("Snapshot reconciliation unavailable");
    await ctx.db.patch(row._id, {
      containment: {
        ...row.containment,
        snapshotId: args.snapshotId,
        snapshotReviewPending: false,
      },
      revision: row.revision + 1,
      updatedAt: Date.now(),
    });
    await event(ctx, row, args.actor, "containment_updated");
    return null;
  },
});
