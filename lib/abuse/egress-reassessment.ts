import { z } from "zod";
import {
  REVIEW_WINDOW_MINUTES,
  reviewCaseKey,
  reviewDigest,
  reviewReference,
} from "./egress-case-identity";

// Validation for the on-demand, advisory reassessment of one existing
// `multiple_runs` or `account_runs_unverified` egress review case. The stored
// record is the only source of the evidence scope: nothing here accepts a
// user, chat, run or window from the caller. Relative imports only: the Convex
// action bundles this module.

/** The automated review that must have created the case. */
const EGRESS_REVIEW_SOURCE = "egress_abuse_review";
/** The `AB-` reference format of every abuse case. */
export const CASE_REFERENCE =
  /^AB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** A review verifies its minute from short-lived telemetry soon after it. */
const MAX_REVIEW_DELAY_MS = 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const MINUTE_MS = 60_000;
const WINDOW_MS = REVIEW_WINDOW_MINUTES * MINUTE_MS;

export const REASSESSMENT_CLOSED_REASONS = [
  /** Missing, not an egress review case, too old, resolved or erased. */
  "case_unavailable",
  /** Not created by the automated egress review. */
  "source_mismatch",
  /** The record could not be decrypted, parsed or bound to the case. */
  "record_invalid",
  /** Not a manual `multiple_runs` or `account_runs_unverified` case. */
  "not_overlap_case",
  /** The case kept no candidate chat and run. */
  "no_candidate",
  /** The case changed between the audited read and the evidence read. */
  "case_changed",
] as const;
export type ReassessmentClosedReason =
  (typeof REASSESSMENT_CLOSED_REASONS)[number];

export type RetainedCandidateScope = {
  userId: string;
  chatId: string;
  runId: string;
  burstStart: number;
  burstEnd: number;
};

const identifier = (max: number) => z.string().min(1).max(max);
const utc = z.string().refine((value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
});
/**
 * Manual cases whose review kept one candidate run but read none of its
 * evidence because other root runs of the account were active or could not
 * be ruled out (for example, Trigger history beyond the page limit). The
 * record does not say which; neither attributes the burst to the candidate.
 */
const RETAINED_CANDIDATE_REASONS = [
  "multiple_runs",
  "account_runs_unverified",
] as const;

const emptyLocators = z
  .object({ commands: z.tuple([]), messages: z.tuple([]) })
  .strict();

/**
 * The exact v3 record the review writes for these manual cases: no evidence
 * was read, so it holds no coverage, classification, locators, model, account
 * activity, enforcement or draft.
 */
const overlapCaseSchema = z
  .object({
    source: z.literal(EGRESS_REVIEW_SOURCE),
    version: z.literal(3),
    reviewedAt: utc,
    outcome: z.literal("manual_review"),
    reason: z.enum(RETAINED_CANDIDATE_REASONS),
    rationale: z.string().max(1_000),
    evidenceMode: z.literal("none"),
    observation: z
      .object({
        region: z.enum(["us", "eu"]),
        ownerRef: z.string().regex(/^[0-9a-f]{32}$/),
        burstMinuteUtc: utc,
        windowStartUtc: utc,
        windowEndUtc: utc,
        connections: z.number().int().positive(),
        workspacesCounted: z.literal(1),
        caveat: z.string().max(1_000),
      })
      .strict(),
    account: z
      .object({
        verifiedUserId: identifier(256),
        sandboxIds: z.array(identifier(128)).length(1),
      })
      .strict(),
    run: z
      .object({
        chatId: identifier(128),
        runId: identifier(128),
        runStartUtc: utc.nullable(),
        runEndUtc: utc.nullable(),
      })
      .strict()
      .nullable(),
    coverage: z.null(),
    classification: z.null(),
    evidenceLocators: emptyLocators,
    model: z.null(),
    accountActivity: z.null(),
    enforcement: z.null(),
    draft: z.null(),
  })
  .strict();

type Parsed =
  | { ok: true; scope: RetainedCandidateScope }
  | {
      ok: false;
      reason: Extract<
        ReassessmentClosedReason,
        | "source_mismatch"
        | "record_invalid"
        | "not_overlap_case"
        | "no_candidate"
      >;
    };

/**
 * Derives the evidence scope from one decrypted case record. The record must
 * be a positive, single-workspace retained-candidate case with one retained
 * candidate, a consistent window, and a region, owner and window that hash to
 * this case's reference and stored digest.
 */
export function parseRetainedCandidateCase(
  record: unknown,
  stored: { reference: string; digest: string; createdAt: number },
): Parsed {
  const head = record as Record<string, unknown> | null;
  if (!head || typeof head !== "object" || Array.isArray(head))
    return { ok: false, reason: "record_invalid" };
  if (head.source !== EGRESS_REVIEW_SOURCE)
    return { ok: false, reason: "source_mismatch" };
  if (
    head.outcome !== "manual_review" ||
    !(RETAINED_CANDIDATE_REASONS as readonly unknown[]).includes(head.reason)
  )
    return { ok: false, reason: "not_overlap_case" };
  const parsed = overlapCaseSchema.safeParse(record);
  if (!parsed.success) return { ok: false, reason: "record_invalid" };
  const { observation, account, run, reviewedAt } = parsed.data;

  const windowStart = Date.parse(observation.windowStartUtc);
  const burstStart = Date.parse(observation.burstMinuteUtc);
  const burstEnd = burstStart + MINUTE_MS;
  const caseKey = reviewCaseKey(
    observation.region,
    observation.ownerRef,
    windowStart / MINUTE_MS,
  );
  if (
    windowStart % WINDOW_MS !== 0 ||
    Date.parse(observation.windowEndUtc) !== windowStart + WINDOW_MS ||
    burstStart % MINUTE_MS !== 0 ||
    burstStart < windowStart ||
    burstEnd > windowStart + WINDOW_MS ||
    Date.parse(reviewedAt) < burstEnd ||
    Date.parse(reviewedAt) > stored.createdAt + CLOCK_SKEW_MS ||
    burstStart < stored.createdAt - MAX_REVIEW_DELAY_MS ||
    reviewReference(caseKey) !== stored.reference ||
    reviewDigest(caseKey) !== stored.digest
  )
    return { ok: false, reason: "record_invalid" };
  // A bound record without a candidate is a valid case that cannot be read.
  if (!run) return { ok: false, reason: "no_candidate" };
  return {
    ok: true,
    scope: {
      userId: account.verifiedUserId,
      chatId: run.chatId,
      runId: run.runId,
      burstStart,
      burstEnd,
    },
  };
}
