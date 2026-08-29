import { z } from "zod";

export const SECURITY_TASK_SUBAGENT_PROFILE = "security_task" as const;
export const SECURITY_VALIDATION_SUBAGENT_PROFILE =
  "security_validation" as const;
export const GENERAL_SUBAGENT_PROFILE = "general" as const;
/** @deprecated Prefer an explicit profile constant. */
export const SUBAGENT_PROFILE = SECURITY_VALIDATION_SUBAGENT_PROFILE;
export const subagentProfileSchema = z.enum([
  GENERAL_SUBAGENT_PROFILE,
  SECURITY_TASK_SUBAGENT_PROFILE,
  SECURITY_VALIDATION_SUBAGENT_PROFILE,
]);
export type SubagentProfile = z.infer<typeof subagentProfileSchema>;
export const MAX_SUBAGENT_CONTEXT_REFS = 8;
export const MAX_SUBAGENT_SKILLS = 5;
export const MAX_SUBAGENT_SUCCESS_CRITERIA = 8;
export const MAX_SUBAGENT_WAIT_SECONDS = 300;
export const MAX_SUBAGENTS_PER_PARENT_RUN = 4;
export const MAX_ACTIVE_SUBAGENTS_PER_PARENT_RUN = 2;
export const SUBAGENT_MAX_ACTIVE_SECONDS = 15 * 60;
export const SUBAGENT_RESULT_DEADLINE_SECONDS = 12 * 60;
export const SUBAGENT_MAX_DURATION_SECONDS = 17 * 60;
export const SUBAGENT_MAX_QUEUE_SECONDS = 5 * 60;
export const SUBAGENT_WATCHDOG_GRACE_SECONDS = 60;
export const SUBAGENT_MAX_STEPS = 50;
export const SUBAGENT_MAX_PROVIDER_RECOVERY_RETRIES = 2;
export const SUBAGENT_MAX_RESULT_RECOVERIES = 1;
export const SUBAGENT_MAX_RESULT_RECOVERY_FAILURE_RETRIES = 1;
export const SECURITY_VALIDATION_RESULT_MAX_BYTES = 8 * 1024;
export const SECURITY_TASK_RESULT_MAX_BYTES = 8 * 1024;
export const MAX_SECURITY_TASK_COVERAGE_ITEMS = 8;
export const MAX_SECURITY_TASK_COVERAGE_EVIDENCE_REFS = 4;
export const SUBAGENT_MAX_COST_DOLLARS = 1;
export const SUBAGENT_MAX_PARENT_COST_DOLLARS = 3;
export const SUBAGENT_PARENT_SYNTHESIS_RESERVE_DOLLARS = 1;
export const SUBAGENT_ORCHESTRATION_BUDGET_DOLLARS =
  SUBAGENT_MAX_PARENT_COST_DOLLARS + SUBAGENT_PARENT_SYNTHESIS_RESERVE_DOLLARS;

export const subagentCapabilityBundleSchema = z.enum([
  "code_read",
  "code_write",
  "web_research",
  "browser_qa",
  "terminal",
  "external_connectors",
]);
export type SubagentCapabilityBundle = z.infer<
  typeof subagentCapabilityBundleSchema
>;

export const subagentTaskComplexitySchema = z.enum(["low", "medium", "high"]);
export type SubagentTaskComplexity = z.infer<
  typeof subagentTaskComplexitySchema
>;

export const subagentOutputKindSchema = z.enum([
  "answer",
  "code_change",
  "research_notes",
  "qa_report",
  "artifact",
]);
export type SubagentOutputKind = z.infer<typeof subagentOutputKindSchema>;

export const subagentProgressEventTypeSchema = z.enum([
  "progress",
  "question",
  "blocker",
  "artifact",
  "result",
]);
export type SubagentProgressEventType = z.infer<
  typeof subagentProgressEventTypeSchema
>;

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

export const createAgentInputSchema = z
  .object({
    profile: subagentProfileSchema.optional(),
    name: z.string().trim().min(1).max(120),
    task: z.string().trim().min(1).max(4_000),
    success_criteria: z
      .array(z.string().trim().min(1).max(500))
      .max(MAX_SUBAGENT_SUCCESS_CRITERIA)
      .default([]),
    inherit_context: z.boolean().default(true),
    context_refs: z
      .array(subagentContextRefSchema)
      .max(MAX_SUBAGENT_CONTEXT_REFS)
      .nullable()
      .default(null),
    // security_task accepts server-reviewed catalog ids. The legacy
    // security_validation marker still selects the independent validator when
    // profile is omitted.
    skills: z
      .array(z.string().trim().min(1).max(80))
      .max(MAX_SUBAGENT_SKILLS)
      .nullable()
      .default(null),
  })
  .strict();

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const delegateTaskInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    task: z.string().trim().min(1).max(4_000),
    success_criteria: z
      .array(z.string().trim().min(1).max(500))
      .max(MAX_SUBAGENT_SUCCESS_CRITERIA)
      .default([]),
    inherit_context: z.boolean().default(true),
    context_refs: z
      .array(subagentContextRefSchema)
      .max(MAX_SUBAGENT_CONTEXT_REFS)
      .nullable()
      .default(null),
    skills: z
      .array(z.string().trim().min(1).max(80))
      .max(MAX_SUBAGENT_SKILLS)
      .nullable()
      .default(null),
    capabilities: z
      .array(subagentCapabilityBundleSchema)
      .min(1)
      .max(6)
      .default(["code_read"]),
    complexity: subagentTaskComplexitySchema.default("medium"),
    expected_duration_minutes: z.number().int().min(1).max(15).default(8),
    output_kind: subagentOutputKindSchema.default("answer"),
  })
  .strict();
export type DelegateTaskInput = z.infer<typeof delegateTaskInputSchema>;

export const continueAgentInputSchema = z
  .object({
    target_agent_id: z.string().trim().min(1).max(100),
    follow_up: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const reportToParentInputSchema = z
  .object({
    event_type: subagentProgressEventTypeSchema,
    message: z.string().trim().min(1).max(2_000),
    refs: z.array(z.string().trim().min(1).max(1_000)).max(8).default([]),
  })
  .strict();

export const subagentMessageTypeSchema = z.enum([
  "query",
  "instruction",
  "information",
]);
export type SubagentMessageType = z.infer<typeof subagentMessageTypeSchema>;

export const subagentMessagePrioritySchema = z.enum([
  "low",
  "normal",
  "high",
  "urgent",
]);
export type SubagentMessagePriority = z.infer<
  typeof subagentMessagePrioritySchema
>;

export const sendMessageToAgentInputSchema = z
  .object({
    target_agent_id: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(4_000),
    message_type: subagentMessageTypeSchema.default("information"),
    priority: subagentMessagePrioritySchema.default("normal"),
  })
  .strict();

export type SendMessageToAgentInput = z.infer<
  typeof sendMessageToAgentInputSchema
>;

export const waitForAgentsInputSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .default("Waiting for messages from other agents"),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_SUBAGENT_WAIT_SECONDS)
      .default(300),
    target_agent_ids: z
      .array(z.string().trim().min(1).max(100))
      .max(MAX_SUBAGENTS_PER_PARENT_RUN)
      .nullable()
      .default(null),
  })
  .strict();

export type WaitForAgentsInput = z.infer<typeof waitForAgentsInputSchema>;

export const listAgentsInputSchema = z.object({}).strict();
export type ListAgentsInput = z.infer<typeof listAgentsInputSchema>;

export const cancelAgentInputSchema = z
  .object({
    target_agent_id: z.string().trim().min(1).max(100),
  })
  .strict();
export type CancelAgentInput = z.infer<typeof cancelAgentInputSchema>;

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

export const securityTaskStatusSchema = z.enum([
  "completed",
  "partial",
  "blocked",
]);
export type SecurityTaskStatus = z.infer<typeof securityTaskStatusSchema>;

export const securityTaskArtifactSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  description: z.string().trim().min(1).max(500).optional(),
});

export const updateWorkLedgerInputSchema = z
  .object({
    status: z.enum(["pending", "in_progress", "blocked", "completed"]),
    dependencies: z.array(z.string().trim().min(1).max(100)).max(8).default([]),
    refs: z.array(z.string().trim().min(1).max(1_000)).max(16).default([]),
    claims: z
      .array(
        z.object({
          claim: z.string().trim().min(1).max(1_000),
          provenance: z.string().trim().min(1).max(1_000),
        }),
      )
      .max(16)
      .default([]),
    assessed_scope: z
      .array(z.string().trim().min(1).max(500))
      .max(16)
      .default([]),
    unassessed_scope: z
      .array(z.string().trim().min(1).max(500))
      .max(16)
      .default([]),
    artifacts: z.array(securityTaskArtifactSchema).max(8).default([]),
  })
  .strict();

export const securityTaskCoverageEntrySchema = z.object({
  surface: z.string().trim().min(1).max(200),
  risk_area: z.string().trim().min(1).max(200),
  outcome: z.string().trim().min(1).max(500),
  evidence_refs: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(MAX_SECURITY_TASK_COVERAGE_EVIDENCE_REFS),
});
export type SecurityTaskCoverageEntry = z.infer<
  typeof securityTaskCoverageEntrySchema
>;

export const securityTaskResultSchema = z.object({
  task_status: securityTaskStatusSchema,
  summary: z.string().trim().min(1).max(2_000),
  evidence_refs: z.array(z.string().trim().min(1).max(500)).max(8),
  artifacts: z.array(securityTaskArtifactSchema).max(8),
  limitations: z.array(z.string().trim().min(1).max(500)).max(8),
  next_steps: z.array(z.string().trim().min(1).max(500)).max(8),
  coverage: z
    .array(securityTaskCoverageEntrySchema)
    .max(MAX_SECURITY_TASK_COVERAGE_ITEMS)
    .optional(),
});
export type SecurityTaskResult = z.infer<typeof securityTaskResultSchema>;
export type SubagentStructuredResult =
  SecurityValidationResult | SecurityTaskResult;

export const agentValidationResultSchema = z.object({
  profile: z.literal(SECURITY_VALIDATION_SUBAGENT_PROFILE),
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

export type AgentValidationResult = z.infer<typeof agentValidationResultSchema>;

export const agentSecurityTaskResultSchema = z.object({
  profile: z.literal(SECURITY_TASK_SUBAGENT_PROFILE),
  status: z.enum(["completed", "failed", "canceled", "timed_out"]),
  task_status: securityTaskStatusSchema.nullable(),
  summary: z.string().max(2_000),
  evidence_refs: z.array(z.string().max(500)).max(8),
  artifacts: z.array(securityTaskArtifactSchema).max(8),
  limitations: z.array(z.string().max(500)).max(8),
  next_steps: z.array(z.string().max(500)).max(8),
  coverage: z
    .array(securityTaskCoverageEntrySchema)
    .max(MAX_SECURITY_TASK_COVERAGE_ITEMS)
    .optional(),
});
export type AgentSecurityTaskResult = z.infer<
  typeof agentSecurityTaskResultSchema
>;

export const agentGeneralTaskResultSchema =
  agentSecurityTaskResultSchema.extend({
    profile: z.literal(GENERAL_SUBAGENT_PROFILE),
  });

export const agentSubagentResultSchema = z.discriminatedUnion("profile", [
  agentValidationResultSchema,
  agentSecurityTaskResultSchema,
  agentGeneralTaskResultSchema,
]);
export type AgentSubagentResult = z.infer<typeof agentSubagentResultSchema>;

export const createAgentResultSchema = z.object({
  success: z.boolean(),
  agent_id: z.string().optional(),
  name: z.string().optional(),
  status: subagentStatusSchema.optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

export const sendMessageToAgentResultSchema = z.object({
  success: z.boolean(),
  target_agent_id: z.string().optional(),
  target_agent_name: z.string().optional(),
  delivery_status: z.literal("delivered").optional(),
  error: z.string().optional(),
});

export const waitForAgentsResultSchema = z.object({
  success: z.boolean(),
  wait_outcome: z.enum([
    "agent_finished",
    "progress",
    "timeout",
    "no_active_agents",
    "targets_not_found",
  ]),
  reason: z.string(),
  target_agent_ids: z.array(z.string()).optional(),
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
  result: agentSubagentResultSchema.optional(),
  active_agents: z
    .array(
      z.object({
        agent_id: z.string(),
        name: z.string(),
        status: subagentStatusSchema,
      }),
    )
    .optional(),
  events: z
    .array(
      z.object({
        agent_id: z.string(),
        agent_name: z.string(),
        event_type: subagentProgressEventTypeSchema,
        message: z.string(),
        refs: z.array(z.string()),
        created_at: z.number(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

export const listAgentsResultSchema = z.object({
  success: z.boolean(),
  agents: z.array(
    z.object({
      agent_id: z.string(),
      name: z.string(),
      profile: subagentProfileSchema,
      status: subagentStatusSchema,
      result_available: z.boolean(),
    }),
  ),
  error: z.string().optional(),
});

export const cancelAgentResultSchema = z.object({
  success: z.boolean(),
  target_agent_id: z.string(),
  target_agent_name: z.string().optional(),
  status: subagentStatusSchema.optional(),
  error: z.string().optional(),
});

export const continueAgentResultSchema = createAgentResultSchema;

export const subagentLifecycleDataSchema = z.object({
  subagent_id: z.string(),
  parent_message_id: z.string(),
  parent_tool_call_id: z.string(),
  agent_name: z.string().max(120),
  event: z.enum(["started", "updated", "finished"]),
  status: subagentStatusSchema,
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
