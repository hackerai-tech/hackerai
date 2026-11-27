import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./lib/serviceFunctions";
import {
  collectCandidateRunEvidence,
  commandValidator,
  coverageValidator,
  ownedChat,
  unavailableReason,
  userMessageValidator,
} from "./egressAbuseReview";

// Internal reads for the advisory reassessment of one `multiple_runs` or
// `account_runs_unverified` egress review case. Only
// `egressAbuseReassessmentActions:readCaseEvidence` calls them, after its own
// authorization; the evidence scope comes from the decrypted case record,
// never from the caller. Nothing here changes a case, its status or revision,
// a restriction, a notice or a receipt: the only write is one audit `read`
// event with a fixed actor.

/** The fixed actor of the audit `read` event each reassessment adds. */
export const EGRESS_REASSESSMENT_ACTOR = "egress_abuse_reassessment";
/** The automated review that must have created the case. */
const REVIEW_ACTOR = "egress_abuse_review";
/** Only cases created this recently can be reassessed. */
export const REASSESSMENT_MAX_CASE_AGE_MS = 7 * 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;

/** Open, unresolved cases an operator has not started to contain. */
function eligible(row: Doc<"abuse_cases"> | null, now: number) {
  return (
    !!row &&
    row.kind === "abuse" &&
    (row.status === "new" || row.status === "reviewing") &&
    !!row.ciphertext &&
    row.erasureCursor === undefined &&
    !row.containment &&
    row.createdAt <= now + CLOCK_SKEW_MS &&
    now - row.createdAt <= REASSESSMENT_MAX_CASE_AGE_MS
  );
}

/**
 * Finds the exact case by reference and audits the evidence read. Returns its
 * ciphertext only for an eligible case that the automated review created.
 */
export const openedCase = v.union(
  v.object({
    status: v.literal("closed"),
    reason: v.union(
      v.literal("case_unavailable"),
      v.literal("source_mismatch"),
    ),
  }),
  v.object({
    status: v.literal("opened"),
    caseId: v.id("abuse_cases"),
    revision: v.number(),
    updatedAt: v.number(),
    createdAt: v.number(),
    digest: v.string(),
    ciphertext: v.string(),
  }),
);
export const openCase = internalMutation({
  args: { reference: v.string() },
  returns: openedCase,
  handler: async (ctx, { reference }) => {
    const now = Date.now();
    const row = await ctx.db
      .query("abuse_cases")
      .withIndex("by_reference", (q) => q.eq("reference", reference))
      .unique();
    if (!row || !eligible(row, now))
      return { status: "closed" as const, reason: "case_unavailable" as const };
    const received = await ctx.db
      .query("abuse_events")
      .withIndex("by_caseId_and_kind", (q) =>
        q.eq("caseId", row._id).eq("kind", "received"),
      )
      .take(2);
    if (received.length !== 1 || received[0].actor !== REVIEW_ACTOR)
      return { status: "closed" as const, reason: "source_mismatch" as const };
    await ctx.db.insert("abuse_events", {
      caseId: row._id,
      actor: EGRESS_REASSESSMENT_ACTOR,
      kind: "read",
      createdAt: now,
    });
    return {
      status: "opened" as const,
      caseId: row._id,
      revision: row.revision,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      digest: row.digest,
      ciphertext: row.ciphertext!,
    };
  },
});

export const candidateEvidence = v.union(
  v.object({
    status: v.literal("unavailable"),
    reason: v.union(unavailableReason, v.literal("candidate_unavailable")),
  }),
  v.object({
    status: v.literal("ok"),
    userMessages: v.array(userMessageValidator),
    commands: v.array(commandValidator),
    coverage: coverageValidator,
  }),
);

export const candidateRead = v.union(
  v.object({ status: v.literal("case_changed") }),
  candidateEvidence,
);

/**
 * Re-checks that the case is unchanged since the audited read, then reads the
 * retained candidate run's bounded evidence. Message and tool call IDs are
 * replaced by per-read placeholders, so no identifier leaves this query.
 */
export const readCandidateEvidence = internalQuery({
  args: {
    caseId: v.id("abuse_cases"),
    revision: v.number(),
    updatedAt: v.number(),
    userId: v.string(),
    chatId: v.string(),
    runId: v.string(),
    burstStart: v.number(),
    burstEnd: v.number(),
  },
  returns: candidateRead,
  handler: async (ctx, { caseId, revision, updatedAt, ...scope }) => {
    const row = await ctx.db.get(caseId);
    if (
      !row ||
      !eligible(row, Date.now()) ||
      row.revision !== revision ||
      row.updatedAt !== updatedAt
    )
      return { status: "case_changed" as const };
    if (!(await ownedChat(ctx, scope.userId, scope.chatId)))
      return {
        status: "unavailable" as const,
        reason: "candidate_unavailable" as const,
      };
    const read = await collectCandidateRunEvidence(ctx, scope);
    if (read.status === "unavailable") return read;
    const rows = new Map<string, string>();
    const placeholder = (id: string) => {
      if (!rows.has(id)) rows.set(id, `r${rows.size + 1}`);
      return rows.get(id)!;
    };
    return {
      status: "ok" as const,
      userMessages: read.userMessages.map((message) => ({
        ...message,
        messageId: placeholder(message.messageId),
      })),
      commands: read.commands.map((command, index) => ({
        ...command,
        messageId: placeholder(command.messageId),
        toolCallId: `c${index + 1}`,
      })),
      coverage: read.coverage,
    };
  },
});
