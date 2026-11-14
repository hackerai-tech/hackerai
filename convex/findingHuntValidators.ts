import { v } from "convex/values";
import {
  agentRetestEnvironmentValidator,
  agentRetestEvidenceVerificationValidator,
} from "./findingAgentRetestValidators";

// Storage shapes for variant hunts. Length bounds, outcome rules and the secret
// guard live in lib/findings/variant-hunt.ts and run before every write.

export const huntCandidateOutcomeValidator = v.union(
  v.literal("reproduced"),
  v.literal("ruled_out"),
  v.literal("inconclusive"),
  v.literal("not_examined"),
);

// How a candidate was checked; independent of its outcome and of the seed
// finding's evidence_status vocabulary.
export const huntEvidenceBasisValidator = v.union(
  v.literal("source_review_only"),
  v.literal("runtime_check"),
);

export const huntEnvironmentValidator = agentRetestEnvironmentValidator;
export const huntEvidenceVerificationValidator =
  agentRetestEvidenceVerificationValidator;

/** Model-supplied candidate fields, validated again server-side. */
export const huntCandidateInputValidator = v.object({
  candidate_key: v.string(),
  surface: v.string(),
  rationale: v.string(),
  outcome: huntCandidateOutcomeValidator,
  evidence_basis: v.optional(huntEvidenceBasisValidator),
  authorized_control_succeeded: v.optional(v.boolean()),
  reproduction_steps: v.array(v.string()),
  expected_result: v.optional(v.string()),
  observed_result: v.optional(v.string()),
  evidence_refs: v.array(v.string()),
  limitations: v.array(v.string()),
});

const candidateFields = {
  candidate_key: v.string(),
  surface: v.string(),
  rationale: v.string(),
  outcome: huntCandidateOutcomeValidator,
  evidence_basis: v.optional(huntEvidenceBasisValidator),
  // Optional for rows saved before the field; required by the domain parser
  // for every new runtime ruled_out write.
  authorized_control_succeeded: v.optional(v.boolean()),
  reproduction_steps: v.array(v.string()),
  expected_result: v.optional(v.string()),
  observed_result: v.optional(v.string()),
  // Only references retained after evidence preparation are stored.
  evidence_refs: v.array(v.string()),
  evidence_verification: v.optional(huntEvidenceVerificationValidator),
  limitations: v.array(v.string()),
  recorded_at: v.number(),
};

/** One immutable, individually saved candidate assessment. */
export const huntStoredCandidateValidator = v.object({
  ...candidateFields,
  // Idempotency key over the submitted content, never shown.
  content_key: v.string(),
});

export const huntCandidateViewValidator = v.object(candidateFields);

export const huntViewValidator = v.object({
  hunt_id: v.string(),
  chat_id: v.string(),
  assistant_message_id: v.string(),
  status: v.union(v.literal("running"), v.literal("finished")),
  started_at: v.number(),
  finished_at: v.optional(v.number()),
  interrupted: v.optional(v.boolean()),
  summary: v.optional(v.string()),
  limitations: v.optional(v.array(v.string())),
  environment: v.optional(huntEnvironmentValidator),
  candidates: v.array(huntCandidateViewValidator),
});
