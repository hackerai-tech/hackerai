import {
  agentSecurityTaskResultSchema,
  agentGeneralTaskResultSchema,
  agentValidationResultSchema,
  MAX_SECURITY_TASK_COVERAGE_ITEMS,
  securityTaskArtifactSchema,
  securityTaskCoverageEntrySchema,
  securityTaskStatusSchema,
  SUBAGENT_TERMINAL_STATUSES,
  subagentVerdictSchema,
  validationConfidenceSchema,
  vulnerabilitySeveritySchema,
  type AgentSubagentResult,
  type SubagentProfile,
  type SubagentStatus,
} from "./contracts";

type PersistedResultSource = {
  profile: SubagentProfile;
  status: SubagentStatus;
  summary?: unknown;
  verdict?: unknown;
  confidence?: unknown;
  structured_result?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const boundedString = (
  value: unknown,
  maxLength: number,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
};

const boundedStringArray = (
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] =>
  Array.isArray(value)
    ? value
        .flatMap((item) => {
          const normalized = boundedString(item, maxLength);
          return normalized ? [normalized] : [];
        })
        .slice(0, maxItems)
    : [];

/** Converts untrusted persisted child data into a bounded parent-visible result. */
export const resultFromPersistedSubagent = (
  row: PersistedResultSource,
): AgentSubagentResult => {
  const result = asRecord(row.structured_result);
  const terminalStatus = SUBAGENT_TERMINAL_STATUSES.has(row.status)
    ? (row.status as "completed" | "failed" | "canceled" | "timed_out")
    : "failed";
  const summary =
    boundedString(result.summary, 2_000) ??
    boundedString(row.summary, 2_000) ??
    "Subagent did not finish.";

  if (row.profile !== "security_validation") {
    const taskStatus = securityTaskStatusSchema.safeParse(result.task_status);
    const artifacts = Array.isArray(result.artifacts)
      ? result.artifacts
          .flatMap((item) => {
            const parsed = securityTaskArtifactSchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          })
          .slice(0, 8)
      : [];
    const coverage = Array.isArray(result.coverage)
      ? result.coverage
          .flatMap((item) => {
            const parsed = securityTaskCoverageEntrySchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          })
          .slice(0, MAX_SECURITY_TASK_COVERAGE_ITEMS)
      : [];
    const candidate = {
      profile: row.profile,
      status: terminalStatus,
      task_status: taskStatus.success ? taskStatus.data : null,
      summary,
      evidence_refs: boundedStringArray(result.evidence_refs, 8, 500),
      artifacts,
      limitations: boundedStringArray(result.limitations, 8, 500),
      next_steps: boundedStringArray(result.next_steps, 8, 500),
      ...(coverage.length > 0 ? { coverage } : {}),
    };
    const parsed =
      row.profile === "general"
        ? agentGeneralTaskResultSchema.safeParse(candidate)
        : agentSecurityTaskResultSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    return {
      profile: row.profile,
      status: terminalStatus,
      task_status: null,
      summary:
        row.profile === "general"
          ? "Task result could not be read."
          : "Security task result could not be read.",
      evidence_refs: [],
      artifacts: [],
      limitations: [],
      next_steps: [],
    };
  }

  const verdict = subagentVerdictSchema.safeParse(
    result.verdict ?? row.verdict,
  );
  const confidence = validationConfidenceSchema.safeParse(
    result.confidence ?? row.confidence,
  );
  const recommendedSeverity = vulnerabilitySeveritySchema.safeParse(
    result.recommended_severity,
  );
  const observedImpact = boundedString(result.observed_impact, 2_000);
  const reproductionSteps = boundedStringArray(
    result.reproduction_steps,
    12,
    500,
  );
  const candidate = {
    profile: "security_validation" as const,
    status: terminalStatus,
    verdict: verdict.success ? verdict.data : null,
    confidence: confidence.success ? confidence.data : null,
    summary,
    ...(observedImpact ? { observed_impact: observedImpact } : {}),
    ...(reproductionSteps.length > 0
      ? { reproduction_steps: reproductionSteps }
      : {}),
    evidence_refs: boundedStringArray(result.evidence_refs, 8, 500),
    limitations: boundedStringArray(result.limitations, 8, 500),
    recommended_severity: recommendedSeverity.success
      ? recommendedSeverity.data
      : null,
  };
  const parsed = agentValidationResultSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  return {
    profile: "security_validation",
    status: terminalStatus,
    verdict: null,
    confidence: null,
    summary: "Independent validation result could not be read.",
    evidence_refs: [],
    limitations: [],
    recommended_severity: null,
  };
};
