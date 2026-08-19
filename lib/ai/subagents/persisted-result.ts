import {
  agentValidationResultSchema,
  SUBAGENT_TERMINAL_STATUSES,
  subagentVerdictSchema,
  validationConfidenceSchema,
  vulnerabilitySeveritySchema,
  type AgentValidationResult,
  type SubagentStatus,
} from "./contracts";

type PersistedResultSource = {
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
): AgentValidationResult => {
  const result = asRecord(row.structured_result);
  const terminalStatus: AgentValidationResult["status"] =
    SUBAGENT_TERMINAL_STATUSES.has(row.status)
      ? (row.status as AgentValidationResult["status"])
      : "failed";
  const verdict = subagentVerdictSchema.safeParse(
    result.verdict ?? row.verdict,
  );
  const confidence = validationConfidenceSchema.safeParse(
    result.confidence ?? row.confidence,
  );
  const recommendedSeverity = vulnerabilitySeveritySchema.safeParse(
    result.recommended_severity,
  );
  const summary =
    boundedString(result.summary, 2_000) ??
    boundedString(row.summary, 2_000) ??
    "Independent validation did not finish.";
  const observedImpact = boundedString(result.observed_impact, 2_000);
  const reproductionSteps = boundedStringArray(
    result.reproduction_steps,
    12,
    500,
  );
  const candidate = {
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
    status: terminalStatus,
    verdict: null,
    confidence: null,
    summary: "Independent validation result could not be read.",
    evidence_refs: [],
    limitations: [],
    recommended_severity: null,
  };
};
