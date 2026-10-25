import { v } from "convex/values";
export const goalState = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("paused"),
  v.literal("needs_input"),
  v.literal("needs_approval"),
  v.literal("blocked"),
  v.literal("failed"),
  v.literal("canceled"),
  v.literal("usage_exhausted"),
  v.literal("budget_exhausted"),
  v.literal("achieved"),
);
export const goalEvidence = v.object({
  criterion: v.number(),
  runId: v.string(),
  messageId: v.optional(v.string()),
  toolCallId: v.string(),
  explanation: v.string(),
});
export const goalCheckpoint = v.object({
  outcome: v.union(
    v.literal("continue"),
    v.literal("achieved"),
    v.literal("needs_input"),
    v.literal("blocked"),
    v.literal("wait"),
  ),
  progress: v.string(),
  evidence: v.array(goalEvidence),
  waitSeconds: v.optional(v.number()),
});
export const goalContractFields = {
  verificationCommand: v.optional(v.string()),
  constraints: v.optional(v.string()),
  boundaries: v.optional(v.string()),
  stopWhen: v.optional(v.string()),
};
export const goalJudgment = v.object({
  verdict: v.union(
    v.literal("done"),
    v.literal("continue"),
    v.literal("blocked"),
  ),
  reason: v.string(),
});
export const goalFields = {
  ...goalContractFields,
  chatId: v.string(),
  userId: v.string(),
  objective: v.string(),
  criteria: v.array(v.string()),
  state: goalState,
  sandboxPreference: v.string(),
  permissionMode: v.string(),
  selectedModel: v.string(),
  generation: v.number(),
  runs: v.number(),
  maxRuns: v.number(),
  noProgressRuns: v.number(),
  progress: v.string(),
  reason: v.string(),
  evidence: v.array(goalEvidence),
  activeRunId: v.optional(v.string()),
  dispatchId: v.optional(v.string()),
  continuationSourceRunId: v.optional(v.string()),
  checkpoint: v.optional(goalCheckpoint),
  deletedAt: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  achievedAt: v.optional(v.number()),
  updatedAt: v.number(),
  waitUntil: v.optional(v.number()),
  judgment: v.optional(goalJudgment),
};
export const goalDoc = v.object({
  _id: v.id("agent_goals"),
  _creationTime: v.number(),
  ...goalFields,
});
