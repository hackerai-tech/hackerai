import { v } from "convex/values";

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
