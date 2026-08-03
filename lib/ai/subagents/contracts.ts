import { z } from "zod";

export const SUBAGENT_PROFILE = "security_validation" as const;
export const MAX_SUBAGENT_CONTEXT_REFS = 8;
export const MAX_SUBAGENTS_PER_PARENT_RUN = 3;
export const MAX_ACTIVE_SUBAGENTS_PER_PARENT_RUN = 1;
export const SUBAGENT_MAX_ACTIVE_SECONDS = 15 * 60;
export const SUBAGENT_MAX_DURATION_SECONDS = 17 * 60;
export const SUBAGENT_MAX_QUEUE_SECONDS = 5 * 60;
export const SUBAGENT_WATCHDOG_GRACE_SECONDS = 60;
export const SUBAGENT_MAX_STEPS = 50;
export const SUBAGENT_MAX_TRANSIENT_RETRIES = 2;
export const SUBAGENT_MAX_RESULT_RECOVERIES = 1;
export const SECURITY_VALIDATION_RESULT_MAX_BYTES = 8 * 1024;
export const SUBAGENT_MAX_COST_DOLLARS = 1;
export const SUBAGENT_MAX_PARENT_COST_DOLLARS = 3;

export const subagentStatusSchema = z.enum([
  "queued",
  "running",
  "finalizing",
  "completed",
  "failed",
  "canceled",
  "timed_out",
]);

export type SubagentStatus = z.infer<typeof subagentStatusSchema>;

export const subagentVerdictSchema = z.enum([
  "confirmed",
  "rejected",
  "inconclusive",
]);

export type SubagentVerdict = z.infer<typeof subagentVerdictSchema>;

export const validationConfidenceSchema = z.enum(["low", "medium", "high"]);
export type ValidationConfidence = z.infer<typeof validationConfidenceSchema>;

export const vulnerabilitySeveritySchema = z.enum([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);
export type VulnerabilitySeverity = z.infer<typeof vulnerabilitySeveritySchema>;

export const securityValidationCandidateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  affected_asset: z.string().trim().min(1).max(1_000),
  weakness_class: z.string().trim().min(1).max(160),
  claimed_impact: z.string().trim().min(1).max(2_000),
  reproduction_hint: z.string().trim().min(1).max(1_200).optional(),
});

export type SecurityValidationCandidate = z.infer<
  typeof securityValidationCandidateSchema
>;

const messagePartContextRefSchema = z.object({
  kind: z.literal("message_part"),
  message_id: z.string().trim().min(1).max(200),
  part_index: z.number().int().min(0).max(1_000),
});

const toolCallContextRefSchema = z.object({
  kind: z.literal("tool_call"),
  message_id: z.string().trim().min(1).max(200),
  tool_call_id: z.string().trim().min(1).max(200),
});

const sandboxFileContextRefSchema = z.object({
  kind: z.literal("sandbox_file"),
  path: z.string().trim().min(1).max(2_000),
  start_line: z.number().int().min(1).max(1_000_000).optional(),
  end_line: z.number().int().min(1).max(1_000_000).optional(),
});

const noteContextRefSchema = z.object({
  kind: z.literal("note"),
  note_id: z.string().trim().min(1).max(200),
});

export const subagentContextRefSchema = z.discriminatedUnion("kind", [
  messagePartContextRefSchema,
  toolCallContextRefSchema,
  sandboxFileContextRefSchema,
  noteContextRefSchema,
]);

export type SubagentContextRef = z.infer<typeof subagentContextRefSchema>;

export const delegateTaskInputSchema = z.object({
  objective: z.string().trim().min(1).max(1_200),
  profile: z.literal(SUBAGENT_PROFILE),
  profile_input: z.object({
    candidate: securityValidationCandidateSchema,
  }),
  context_refs: z
    .array(subagentContextRefSchema)
    .max(MAX_SUBAGENT_CONTEXT_REFS)
    .default([]),
  wait_behavior: z.literal("wait_for_result"),
});

export type DelegateTaskInput = z.infer<typeof delegateTaskInputSchema>;

export const securityValidationResultSchema = z
  .object({
    verdict: subagentVerdictSchema,
    confidence: validationConfidenceSchema,
    summary: z.string().trim().min(1).max(2_000),
    observed_impact: z.string().trim().max(2_000).optional(),
    reproduction_steps: z.array(z.string().trim().min(1).max(500)).max(12),
    evidence_refs: z.array(z.string().trim().min(1).max(500)).max(8),
    limitations: z.array(z.string().trim().min(1).max(500)).max(8),
    recommended_severity: vulnerabilitySeveritySchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.verdict === "confirmed" &&
      (value.reproduction_steps.length === 0 ||
        value.evidence_refs.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A confirmed validation requires at least one reproduction step and one evidence reference.",
      });
    }
  });

export type SecurityValidationResult = z.infer<
  typeof securityValidationResultSchema
>;

export const delegateTaskResultSchema = z.object({
  status: z.enum(["completed", "failed", "canceled", "timed_out"]),
  verdict: subagentVerdictSchema.nullable(),
  confidence: validationConfidenceSchema.nullable(),
  summary: z.string().max(2_000),
  observed_impact: z.string().max(2_000).optional(),
  reproduction_steps: z.array(z.string().max(500)).max(12).optional(),
  evidence_refs: z.array(z.string().max(500)).max(8),
  limitations: z.array(z.string().max(500)).max(8),
  recommended_severity: vulnerabilitySeveritySchema.nullable(),
});

export type DelegateTaskResult = z.infer<typeof delegateTaskResultSchema>;

export const subagentLifecycleDataSchema = z.object({
  subagent_id: z.string(),
  parent_trigger_run_id: z.string(),
  parent_tool_call_id: z.string(),
  trigger_run_id: z.string().nullable(),
  profile: z.literal(SUBAGENT_PROFILE),
  status: subagentStatusSchema,
  title: z.string().max(200),
  summary: z.string().max(2_000).optional(),
  verdict: subagentVerdictSchema.optional(),
  elapsed_ms: z.number().nonnegative().optional(),
});

export type SubagentLifecycleData = z.infer<typeof subagentLifecycleDataSchema>;

export const SUBAGENT_TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  "completed",
  "failed",
  "canceled",
  "timed_out",
]);

export const SUBAGENT_ACTIVE_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  "queued",
  "running",
  "finalizing",
]);
