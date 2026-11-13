import { z } from "zod";
import { containsLikelySecret } from "./agent-retest";

/**
 * A variant hunt records the Agent's own assessments of other surfaces that
 * might share a saved finding's root cause. Candidates are never findings:
 * they have no severity, never create reports and never change the seed.
 */
export const HUNT_CANDIDATE_OUTCOMES = [
  "reproduced",
  "ruled_out",
  "inconclusive",
  "not_examined",
] as const;
export type HuntCandidateOutcome = (typeof HUNT_CANDIDATE_OUTCOMES)[number];

/**
 * How an assessed candidate was checked. Independent of the outcome, and
 * deliberately separate from a saved finding's evidence_status: a runtime
 * check can rule a surface out as well as reproduce it.
 */
export const HUNT_EVIDENCE_BASES = [
  "source_review_only",
  "runtime_check",
] as const;
export type HuntEvidenceBasis = (typeof HUNT_EVIDENCE_BASES)[number];

/** Expanded-detail label; "reproduced" only when a runtime check reproduced it. */
export const huntEvidenceBasisLabel = (
  basis: HuntEvidenceBasis,
  outcome: HuntCandidateOutcome,
) =>
  basis === "source_review_only"
    ? "Source review only"
    : outcome === "reproduced"
      ? "Runtime reproduced"
      : "Runtime checked";

export const HUNT_LIMITS = {
  maxCandidates: 8,
  candidateKey: 80,
  surface: 300,
  rationale: 600,
  step: 400,
  maxSteps: 8,
  expected: 800,
  observed: 1_500,
  ref: 300,
  // 8 candidates x 5 references stays within the 40-reference evidence budget.
  maxRefs: 5,
  limitation: 400,
  maxLimitations: 6,
  summary: 800,
  maxSummaryLimitations: 8,
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (maxItem: number, maxItems: number) =>
  z.array(text(maxItem)).max(maxItems);

const SECRET_MESSAGE =
  "Remove tokens, cookies, keys and authorization header values. Describe them as [REDACTED] instead.";

/** Model-supplied candidate. Provenance, timing and environment are server-owned. */
export const huntCandidateSchema = z
  .object({
    candidate_key: z
      .string()
      .trim()
      .min(1)
      .max(HUNT_LIMITS.candidateKey)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
        "Use letters, digits, dot, underscore, colon or hyphen.",
      ),
    surface: text(HUNT_LIMITS.surface),
    rationale: text(HUNT_LIMITS.rationale),
    outcome: z.enum(HUNT_CANDIDATE_OUTCOMES),
    evidence_basis: z.enum(HUNT_EVIDENCE_BASES).optional(),
    // The Agent's claim that an authorized positive control reached the same
    // protected surface. Never inferred from prose or status codes.
    authorized_control_succeeded: z.boolean().optional(),
    reproduction_steps: list(HUNT_LIMITS.step, HUNT_LIMITS.maxSteps),
    expected_result: text(HUNT_LIMITS.expected).optional(),
    observed_result: text(HUNT_LIMITS.observed).optional(),
    evidence_refs: list(HUNT_LIMITS.ref, HUNT_LIMITS.maxRefs),
    limitations: list(HUNT_LIMITS.limitation, HUNT_LIMITS.maxLimitations),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const { outcome, evidence_basis: basis } = candidate;
    if (outcome === "not_examined") {
      if (basis !== undefined)
        issue(
          "evidence_basis",
          "A not_examined candidate was not assessed, so it has no evidence basis.",
        );
    } else {
      if (basis === undefined)
        issue(
          "evidence_basis",
          "State how you checked this surface: runtime_check or source_review_only.",
        );
      if (candidate.reproduction_steps.length === 0)
        issue("reproduction_steps", "List the checks you actually performed.");
      if (!candidate.observed_result)
        issue("observed_result", "Describe what you observed.");
    }
    if (outcome === "reproduced" && basis !== "runtime_check")
      issue(
        "evidence_basis",
        "Reproduced requires a runtime check. Source-only suspicion is inconclusive.",
      );
    // Identical denials for own and cross-account records prove only blocked
    // access, so a runtime ruled_out needs a working control on this surface.
    if (
      outcome === "ruled_out" &&
      basis === "runtime_check" &&
      candidate.authorized_control_succeeded !== true
    )
      issue(
        "authorized_control_succeeded",
        "A runtime ruled_out requires an authorized positive control that succeeded on this same surface. If your own and cross-account requests were both blocked (same 401/403, login redirect or missing role), access was blocked, not controlled: save this candidate as inconclusive.",
      );
    if (
      (outcome === "reproduced" || outcome === "ruled_out") &&
      !candidate.expected_result
    )
      issue("expected_result", "Describe what an unaffected surface would do.");
    if (outcome !== "reproduced" && candidate.limitations.length === 0)
      issue(
        "limitations",
        "State what was not covered or could not be accessed. Only reproduced candidates may omit limitations.",
      );
    const fields = [
      candidate.candidate_key,
      candidate.surface,
      candidate.rationale,
      candidate.expected_result ?? "",
      candidate.observed_result ?? "",
      ...candidate.reproduction_steps,
      ...candidate.evidence_refs,
      ...candidate.limitations,
    ];
    if (fields.some(containsLikelySecret))
      ctx.addIssue({ code: "custom", message: SECRET_MESSAGE });
  });
export type HuntCandidate = z.infer<typeof huntCandidateSchema>;

export const huntCompletionSchema = z
  .object({
    summary: text(HUNT_LIMITS.summary),
    limitations: list(
      HUNT_LIMITS.limitation,
      HUNT_LIMITS.maxSummaryLimitations,
    ).min(1, "State what this hunt did not cover. A hunt is never exhaustive."),
  })
  .strict()
  .superRefine((completion, ctx) => {
    if (
      [completion.summary, ...completion.limitations].some(containsLikelySecret)
    )
      ctx.addIssue({ code: "custom", message: SECRET_MESSAGE });
  });
export type HuntCompletion = z.infer<typeof huntCompletionSchema>;

type Parsed<T> =
  { success: true; value: T } | { success: false; message: string };

function parseWith<T>(schema: z.ZodType<T>, value: unknown): Parsed<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { success: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".");
  return {
    success: false,
    message: `${path ? `${path}: ` : ""}${issue?.message ?? "Invalid hunt input."}`,
  };
}

export const parseHuntCandidate = (value: unknown) =>
  parseWith(huntCandidateSchema, value);
export const parseHuntCompletion = (value: unknown) =>
  parseWith(huntCompletionSchema, value);

/**
 * Stable comparison for an idempotent candidate retry. Evidence is compared as
 * the set of submitted references, independent of later file availability.
 */
export function huntCandidateKey(candidate: HuntCandidate): string {
  return JSON.stringify([
    candidate.candidate_key,
    candidate.surface,
    candidate.rationale,
    candidate.outcome,
    candidate.evidence_basis ?? null,
    candidate.reproduction_steps,
    candidate.expected_result ?? null,
    candidate.observed_result ?? null,
    [...new Set(candidate.evidence_refs)].sort(),
    candidate.limitations,
    // Appended only when stated, so keys saved before this field still match.
    ...(candidate.authorized_control_succeeded === undefined
      ? []
      : [candidate.authorized_control_succeeded]),
  ]);
}

export const huntCompletionKey = (completion: HuntCompletion) =>
  JSON.stringify([completion.summary, completion.limitations]);

export type HuntOutcomeCounts = Record<HuntCandidateOutcome, number>;

/** Counts are always derived from saved candidates, never from model claims. */
export function countHuntOutcomes(
  candidates: ReadonlyArray<{ outcome: HuntCandidateOutcome }>,
): HuntOutcomeCounts {
  const counts: HuntOutcomeCounts = {
    reproduced: 0,
    ruled_out: 0,
    inconclusive: 0,
    not_examined: 0,
  };
  for (const candidate of candidates) counts[candidate.outcome] += 1;
  return counts;
}
