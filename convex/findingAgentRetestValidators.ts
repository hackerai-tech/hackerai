import { v } from "convex/values";

// Storage shapes for Agent retest assessments. Length bounds, outcome rules and
// the secret guard live in lib/findings/agent-retest.ts and run before writes.

export const agentRetestOutcomeValidator = v.union(
  v.literal("reproduced"),
  v.literal("not_reproduced"),
  v.literal("inconclusive"),
);

export const agentRetestEnvironmentValidator = v.object({
  kind: v.union(v.literal("cloud"), v.literal("local"), v.literal("desktop")),
  name: v.optional(v.string()),
});

export const agentRetestEvidenceVerificationValidator = v.object({
  checked_refs: v.array(v.string()),
  unavailable_refs: v.array(v.string()),
  warning: v.optional(v.string()),
});

export const agentRetestResultValidator = v.object({
  outcome: agentRetestOutcomeValidator,
  summary: v.string(),
  reproduction_steps: v.array(v.string()),
  expected_result: v.string(),
  observed_result: v.string(),
  evidence_refs: v.array(v.string()),
  limitations: v.array(v.string()),
});

export const agentRetestViewValidator = v.object({
  retest_id: v.string(),
  chat_id: v.string(),
  assistant_message_id: v.string(),
  status: v.union(v.literal("running"), v.literal("finished")),
  started_at: v.number(),
  finished_at: v.optional(v.number()),
  outcome: v.optional(agentRetestOutcomeValidator),
  interrupted: v.optional(v.boolean()),
  summary: v.optional(v.string()),
  reproduction_steps: v.optional(v.array(v.string())),
  expected_result: v.optional(v.string()),
  observed_result: v.optional(v.string()),
  evidence_refs: v.optional(v.array(v.string())),
  evidence_verification: v.optional(agentRetestEvidenceVerificationValidator),
  limitations: v.optional(v.array(v.string())),
  environment: v.optional(agentRetestEnvironmentValidator),
});
