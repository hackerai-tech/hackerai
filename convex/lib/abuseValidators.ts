import { v } from "convex/values";
import {
  BLOCK_REFUSALS,
  BLOCKABLE_INTENTS,
  ENFORCEMENT_DECISIONS,
  ENFORCEMENT_REASONS,
  EVIDENCE_MODES,
  NOTICE_RESULTS,
  REVIEW_COVERAGE,
  REVIEW_REASONS,
} from "../../lib/abuse/egress-outcomes";

export const abuseStatus = v.union(
  v.literal("new"),
  v.literal("reviewing"),
  v.literal("containing"),
  v.literal("contained"),
  v.literal("needs_followup"),
  v.literal("resolved"),
);
export const abuseTransport = v.union(
  v.literal("cloud"),
  v.literal("local"),
  v.literal("desktop"),
);
export const abuseContainment = v.object({
  userId: v.string(),
  chatId: v.string(),
  runId: v.string(),
  transport: abuseTransport,
  childRunIds: v.array(v.string()),
  approvalSessionId: v.optional(v.string()),
  sandboxId: v.optional(v.string()),
  region: v.optional(v.string()),
  snapshotId: v.optional(v.string()),
  snapshotRequested: v.boolean(),
  snapshotName: v.optional(v.string()),
  snapshotReviewPending: v.boolean(),
  processState: v.union(
    v.literal("unconfirmed"),
    v.literal("provider_stopped"),
    v.literal("operator_confirmed"),
  ),
  triggerState: v.union(v.literal("unconfirmed"), v.literal("stopped")),
  workspaceState: v.union(
    v.literal("unconfirmed"),
    v.literal("released"),
    v.literal("restored"),
    v.literal("not_applicable"),
  ),
});
export const abuseCaseFields = {
  reference: v.string(),
  digest: v.string(),
  kind: v.union(v.literal("abuse"), v.literal("appeal")),
  ciphertext: v.optional(v.string()),
  status: abuseStatus,
  revision: v.number(),
  evidenceHold: v.boolean(),
  operationToken: v.optional(v.string()),
  operationExpiresAt: v.optional(v.number()),
  erasureCursor: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  containment: v.optional(abuseContainment),
  activeContainmentUserId: v.optional(v.string()),
};
export const abuseCase = v.object({
  _id: v.id("abuse_cases"),
  _creationTime: v.number(),
  ...abuseCaseFields,
});
export const abuseEventFields = {
  caseId: v.id("abuse_cases"),
  actor: v.string(),
  kind: v.union(
    v.literal("received"),
    v.literal("read"),
    v.literal("allegation"),
    v.literal("verified_fact"),
    v.literal("decision"),
    v.literal("containment_started"),
    v.literal("containment_updated"),
    v.literal("resolved"),
    v.literal("hold_changed"),
    v.literal("evidence_deleted"),
  ),
  ciphertext: v.optional(v.string()),
  createdAt: v.number(),
};
export const abuseEvent = v.object({
  _id: v.id("abuse_events"),
  _creationTime: v.number(),
  ...abuseEventFields,
});

// Late-report response: account restriction plus cancellation requests for
// server-recorded active work. Trigger states are requests/observations, never
// process-stop evidence.
export const abuseResponseTargetState = v.union(
  v.literal("pending"),
  v.literal("cancel_requested"),
  v.literal("terminal"),
  v.literal("identity_mismatch"),
  v.literal("unknown"),
);
export const abuseResponseTarget = v.object({
  runId: v.string(),
  kind: v.union(v.literal("root"), v.literal("child")),
  chatId: v.string(),
  subagentId: v.optional(v.string()),
  approvalSessionId: v.optional(v.string()),
  state: abuseResponseTargetState,
  triggerStatus: v.optional(v.string()),
  attempts: v.number(),
  updatedAt: v.number(),
});
export const abuseResponseDiscovery = v.union(
  v.literal("roots"),
  v.literal("queued"),
  v.literal("running"),
  v.literal("finalizing"),
  v.literal("done"),
);
export const abuseResponseTokenResult = v.union(
  v.literal("revoked"),
  v.literal("already_revoked"),
  v.literal("none_issued"),
);
export const abuseResponseFields = {
  caseId: v.id("abuse_cases"),
  requestId: v.string(),
  requestDigest: v.string(),
  planDigest: v.string(),
  actor: v.string(),
  reviewer: v.string(),
  reviewDate: v.string(),
  retentionReviewDate: v.string(),
  userId: v.string(),
  chatId: v.string(),
  runId: v.optional(v.string()),
  transport: abuseTransport,
  environmentId: v.optional(v.string()),
  sourceId: v.string(),
  suspensionId: v.id("user_suspensions"),
  restriction: v.union(v.literal("created"), v.literal("adopted")),
  localToken: abuseResponseTokenResult,
  connectionsDisconnected: v.number(),
  connectionsRemaining: v.boolean(),
  discoveryPhase: abuseResponseDiscovery,
  discoveryCursor: v.optional(v.string()),
  targetOverflow: v.boolean(),
  targets: v.array(abuseResponseTarget),
  operationToken: v.optional(v.string()),
  operationExpiresAt: v.optional(v.number()),
  appliedAt: v.number(),
  updatedAt: v.number(),
};
export const abuseResponseSummary = v.object({
  reference: v.string(),
  requestId: v.string(),
  sourceId: v.string(),
  userId: v.string(),
  chatId: v.string(),
  runId: v.optional(v.string()),
  transport: abuseTransport,
  environmentId: v.optional(v.string()),
  actor: v.string(),
  reviewer: v.string(),
  reviewDate: v.string(),
  retentionReviewDate: v.string(),
  appliedAt: v.number(),
  caseStatus: abuseStatus,
  restriction: v.object({
    result: v.union(v.literal("created"), v.literal("adopted")),
    status: v.union(
      v.literal("active"),
      v.literal("resolved"),
      v.literal("missing"),
    ),
  }),
  localToken: abuseResponseTokenResult,
  localConnections: v.object({
    disconnected: v.number(),
    remaining: v.boolean(),
  }),
  discovery: v.object({ phase: abuseResponseDiscovery, overflow: v.boolean() }),
  cancellations: v.array(
    v.object({
      runId: v.string(),
      kind: v.union(v.literal("root"), v.literal("child")),
      chatId: v.string(),
      state: abuseResponseTargetState,
      triggerStatus: v.optional(v.string()),
      attempts: v.number(),
    }),
  ),
  cloudProvider: v.union(
    v.literal("not_attempted"),
    v.literal("not_applicable"),
  ),
  processStop: v.literal("unconfirmed"),
  contained: v.literal(false),
  inProgress: v.boolean(),
  outstanding: v.array(v.string()),
});

// Automated egress enforcement. Closed vocabularies only; never evidence text,
// recipients or model payloads.
const literals = <T extends string>(values: readonly T[]) =>
  v.union(...values.map((value) => v.literal(value)));
export const enforcementDecision = literals(ENFORCEMENT_DECISIONS);
export const enforcementReason = literals(ENFORCEMENT_REASONS);
export const reviewReason = literals(REVIEW_REASONS);
export const blockableIntent = literals(BLOCKABLE_INTENTS);
export const blockRefusal = literals(BLOCK_REFUSALS);
export const noticeResult = literals(NOTICE_RESULTS);
export const egressReviewReceiptFields = {
  /** The review case digest; one receipt per case window, first write wins. */
  digest: v.string(),
  /** Stored only when the receipt is an action an owner must follow up. */
  reference: v.optional(v.string()),
  decision: enforcementDecision,
  reason: enforcementReason,
  reviewReason,
  evidenceMode: literals(EVIDENCE_MODES),
  coverage: literals(REVIEW_COVERAGE),
  caseOutcome: v.union(
    v.literal("created"),
    v.literal("existing"),
    v.literal("none"),
  ),
  refusal: v.optional(blockRefusal),
  intentKind: v.optional(blockableIntent),
  createdAt: v.number(),
  expiresAt: v.number(),
};
export const blockNoticeStatus = v.union(
  v.literal("pending"),
  v.literal("sending"),
  v.literal("sent"),
  // Possibly accepted; reconciled by an operator, never resent automatically.
  v.literal("uncertain"),
  v.literal("failed"),
  // The block was lifted or replaced before any send attempt.
  v.literal("cancelled"),
  // Another notice already covers this account's active block.
  v.literal("deduplicated"),
);
export const blockNoticeFailure = v.union(
  v.literal("rejected"),
  v.literal("recipient_unavailable"),
  v.literal("attempts_exhausted"),
  v.literal("restriction_inactive"),
);
export const blockNoticeFields = {
  caseId: v.id("abuse_cases"),
  reference: v.string(),
  userId: v.string(),
  suspensionId: v.id("user_suspensions"),
  /** The case revision the block wrote; a later operator note clears review. */
  blockRevision: v.number(),
  templateVersion: v.string(),
  messageId: v.string(),
  status: blockNoticeStatus,
  failure: v.optional(blockNoticeFailure),
  attempts: v.number(),
  nextAttemptAt: v.number(),
  leaseToken: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
  blockedAt: v.number(),
  sentAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
};
