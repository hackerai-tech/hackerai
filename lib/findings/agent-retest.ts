import { z } from "zod";

/**
 * Agent retests record the Agent's own judgment of one reproduction attempt.
 * They are never independent or deterministic certification, and they never
 * change a finding's status, confidence or evidence badge.
 */
export const AGENT_RETEST_OUTCOMES = [
  "reproduced",
  "not_reproduced",
  "inconclusive",
] as const;
export type AgentRetestOutcome = (typeof AGENT_RETEST_OUTCOMES)[number];

export const AGENT_RETEST_LIMITS = {
  summary: 600,
  step: 500,
  maxSteps: 12,
  expected: 1_000,
  observed: 2_000,
  ref: 500,
  maxRefs: 8,
  limitation: 500,
  maxLimitations: 8,
} as const;

// Values must be redacted before saving. A labelled redaction marker is fine.
const REDACTED = String.raw`(?!\[?redacted|<redacted|\*{3})`;
const SECRET_PATTERNS = [
  new RegExp(
    String.raw`\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*:\s*${REDACTED}\S{8,}`,
    "i",
  ),
  new RegExp(String.raw`\bbearer\s+${REDACTED}[A-Za-z0-9\-._~+/]{20,}`, "i"),
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const containsLikelySecret = (value: string) =>
  SECRET_PATTERNS.some((pattern) => pattern.test(value));

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (maxItem: number, maxItems: number) =>
  z.array(text(maxItem)).max(maxItems);

/** Model-supplied assessment. Provenance, timing and environment are server-owned. */
export const agentRetestResultSchema = z
  .object({
    outcome: z.enum(AGENT_RETEST_OUTCOMES),
    summary: text(AGENT_RETEST_LIMITS.summary),
    reproduction_steps: list(
      AGENT_RETEST_LIMITS.step,
      AGENT_RETEST_LIMITS.maxSteps,
    ).min(1),
    expected_result: text(AGENT_RETEST_LIMITS.expected),
    observed_result: text(AGENT_RETEST_LIMITS.observed),
    evidence_refs: list(AGENT_RETEST_LIMITS.ref, AGENT_RETEST_LIMITS.maxRefs),
    limitations: list(
      AGENT_RETEST_LIMITS.limitation,
      AGENT_RETEST_LIMITS.maxLimitations,
    ),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.outcome !== "reproduced" && result.limitations.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["limitations"],
        message:
          "State what this retest could not cover. Not reproduced and inconclusive results need at least one limitation.",
      });
    const fields = [
      result.summary,
      result.expected_result,
      result.observed_result,
      ...result.reproduction_steps,
      ...result.evidence_refs,
      ...result.limitations,
    ];
    if (fields.some(containsLikelySecret))
      ctx.addIssue({
        code: "custom",
        message:
          "Remove tokens, cookies, keys and authorization header values. Describe them as [REDACTED] instead.",
      });
  });
export type AgentRetestResult = z.infer<typeof agentRetestResultSchema>;

export function parseAgentRetestResult(
  value: unknown,
):
  | { success: true; result: AgentRetestResult }
  | { success: false; message: string } {
  const parsed = agentRetestResultSchema.safeParse(value);
  if (parsed.success) return { success: true, result: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".");
  return {
    success: false,
    message: `${path ? `${path}: ` : ""}${issue?.message ?? "Invalid retest result."}`,
  };
}

/**
 * Stable comparison for an idempotent completion retry. Evidence is compared
 * as the set of submitted references, independent of later file availability.
 */
export function agentRetestResultKey(
  result: Omit<AgentRetestResult, "evidence_refs">,
  evidenceRefs: readonly string[],
): string {
  return JSON.stringify([
    result.outcome,
    result.summary,
    result.reproduction_steps,
    result.expected_result,
    result.observed_result,
    result.limitations,
    [...new Set(evidenceRefs)].sort(),
  ]);
}
