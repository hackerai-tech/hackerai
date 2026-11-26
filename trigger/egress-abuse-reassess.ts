import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { logger, runs, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { egressAbuseReviewGate } from "@/lib/abuse/egress-review-context";
import {
  decideRetainedCandidate,
  EGRESS_RETAINED_CANDIDATE_PROMPT_VERSION,
  prepareReview,
  type EgressReviewClassification,
} from "@/lib/abuse/egress-review";
import {
  CASE_REFERENCE,
  type ReassessmentClosedReason,
} from "@/lib/abuse/egress-reassessment";
import { USER_RESEARCH_MODEL_KEY } from "@/lib/research/user-research";
import {
  classifyEvidence,
  observationGaps,
  passesPrivacyGuard,
  reviewClient,
  type ObservationGap,
} from "./egress-abuse-review";

// On-demand advisory reassessment of one existing `multiple_runs` egress
// review case, started by an operator with only its reference. It reads the
// one candidate run the case retained, through the same scrubber, privacy
// guard, classifier and policy as the review, and reports closed enums about
// that run only. The other runs that may have been active, and which activity
// caused the burst, stay unverified. It never blocks or unblocks an account,
// grants a cooldown, drafts or sends mail, or changes the case or its
// decision; its only write is the audit `read` event Convex adds for the read.

export const egressAbuseReassessPayloadSchema = z
  .object({ reference: z.string().regex(CASE_REFERENCE) })
  .strict();
export type EgressAbuseReassessPayload = z.infer<
  typeof egressAbuseReassessPayloadSchema
>;

export type ReassessmentReason =
  // The candidate's evidence could not be read.
  | "candidate_unavailable"
  | "run_mismatch"
  | "evidence_incomplete"
  | "subagent_overlap"
  | "concurrent_run"
  // Read, but not assessable.
  | "candidate_completion_unverified"
  | "no_command_evidence"
  | "evidence_gaps"
  | "privacy_guard"
  | "classifier_unavailable"
  | "classifier_invalid"
  // Classified complete evidence.
  | ReturnType<typeof decideRetainedCandidate>["reason"];

export type EgressAbuseReassessResult =
  | { status: "disabled" }
  | { status: "closed"; reason: ReassessmentClosedReason }
  | {
      status: "completed";
      /** Only the one candidate run the case retained was read. */
      scope: "retained_candidate_only";
      /** Whether this run caused the burst is not established. */
      attribution: "unverified";
      /** Other runs that may have been active were not read. */
      otherCandidates: "unverified";
      /** Never a verdict on the burst, and never acted on. */
      determination: "advisory_only";
      coverage: "complete" | "incomplete" | "unavailable";
      advisory: "neutral" | "concern" | "inconclusive";
      reason: ReassessmentReason;
      gaps?: ObservationGap[];
      /** Set only when the advisory finding is grounded in cited evidence. */
      classification?: Pick<
        EgressReviewClassification,
        "activity" | "authorization"
      >;
      model?: { key: string; promptVersion: string };
    };

type Completed = Extract<EgressAbuseReassessResult, { status: "completed" }>;
const completed = (
  details: Pick<Completed, "coverage" | "advisory" | "reason"> &
    Partial<Completed>,
): Completed => ({
  status: "completed",
  scope: "retained_candidate_only",
  attribution: "unverified",
  otherCandidates: "unverified",
  determination: "advisory_only",
  ...details,
});

// Trigger and the worker measure timestamps on different hosts.
const COMPLETION_CLOCK_SKEW_MS = 60_000;

async function candidateFinishedBeforeRead(
  runId: string,
  readStartedAt: number,
) {
  try {
    // The SDK traces run identifiers by default. Use only its timing and
    // lifecycle fields, without logging the lookup result.
    const run = await context.with(suppressTracing(context.active()), () =>
      runs.retrieve(runId, { retry: { maxAttempts: 1 } }),
    );
    return (
      run.id === runId &&
      run.taskIdentifier === "agent-long" &&
      run.status === "COMPLETED" &&
      (run.finishedAt?.getTime() ?? Infinity) <=
        readStartedAt - COMPLETION_CLOCK_SKEW_MS
    );
  } catch {
    return false;
  }
}

export async function runEgressAbuseReassessment(
  payload: EgressAbuseReassessPayload,
): Promise<EgressAbuseReassessResult> {
  if (egressAbuseReviewGate() !== "on") return { status: "disabled" };
  const { reference } = egressAbuseReassessPayloadSchema.parse(payload);
  const { client, serviceKey } = reviewClient();
  const readStartedAt = Date.now();
  const read = await client.action(
    api.egressAbuseReassessmentActions.readCaseEvidence,
    { serviceKey, reference },
  );
  if (read.status === "closed")
    return { status: "closed", reason: read.reason };
  const { evidence } = read;
  if (evidence.status === "unavailable")
    return completed({
      coverage: "unavailable",
      advisory: "inconclusive",
      reason:
        evidence.reason === "incomplete"
          ? "evidence_incomplete"
          : evidence.reason,
    });
  // The chat marker can be replaced while the original run is still writing.
  // Completion after the snapshot started cannot validate that snapshot.
  if (!(await candidateFinishedBeforeRead(read.candidateRunId, readStartedAt)))
    return completed({
      coverage: "incomplete",
      advisory: "inconclusive",
      reason: "candidate_completion_unverified",
    });
  const unprepared = observationGaps(evidence, {
    itemsTruncated: false,
    itemsOmitted: false,
  });
  if (!evidence.commands.length)
    return completed({
      coverage: unprepared.length ? "incomplete" : "complete",
      advisory: "inconclusive",
      reason: "no_command_evidence",
      ...(unprepared.length ? { gaps: unprepared } : {}),
    });

  const prepared = prepareReview(
    evidence,
    { start: read.burstStart, end: read.burstEnd },
    "retained_candidate",
  );
  // Partial evidence is never classified, so it cannot become a finding.
  const gaps = observationGaps(evidence, prepared);
  if (gaps.length)
    return completed({
      coverage: "incomplete",
      advisory: "inconclusive",
      reason: "evidence_gaps",
      gaps,
    });
  if (!passesPrivacyGuard(prepared.prompt))
    return completed({
      coverage: "complete",
      advisory: "inconclusive",
      reason: "privacy_guard",
    });
  const model = {
    key: USER_RESEARCH_MODEL_KEY,
    promptVersion: EGRESS_RETAINED_CANDIDATE_PROMPT_VERSION,
  };
  const classification = await classifyEvidence(prepared.prompt);
  if (typeof classification === "string")
    return completed({
      coverage: "complete",
      advisory: "inconclusive",
      reason: classification,
      model,
    });
  const { advisory, reason } = decideRetainedCandidate(
    classification,
    evidence,
    prepared,
  );
  return completed({
    coverage: "complete",
    advisory,
    reason,
    model,
    ...(advisory === "inconclusive"
      ? {}
      : {
          classification: {
            activity: classification.activity,
            authorization: classification.authorization,
          },
        }),
  });
}

export const egressAbuseReassessTask = schemaTask({
  id: "egress-abuse-reassess",
  schema: egressAbuseReassessPayloadSchema,
  machine: { preset: "small-1x" },
  maxDuration: 5 * 60,
  // Each attempt adds an audit read; an operator reruns it instead.
  retry: { maxAttempts: 1 },
  queue: { name: "egress-abuse-reassess", concurrencyLimit: 1 },
  run: async (payload) => {
    const result = await runEgressAbuseReassessment(payload);
    // The result holds closed enums only.
    logger.info("Egress abuse reassessment finished", result);
    return result;
  },
});
