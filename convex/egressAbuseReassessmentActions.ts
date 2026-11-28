"use node";

import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./lib/serviceFunctions";
import { literals } from "./lib/abuseValidators";
import { authorizeEgressReview } from "./lib/egressReviewAuth";
import {
  burstActivityEvidence,
  burstActivityRead,
  candidateEvidence,
  candidateRead,
  openedCase,
} from "./egressAbuseReassessment";
import { decryptAbuseEvidence } from "../lib/abuse/evidence-crypto";
import {
  BURST_ACTIVITY_CLOSED_REASONS,
  CASE_REFERENCE,
  parseBurstActivityCase,
  parseRetainedCandidateCase,
  REASSESSMENT_CLOSED_REASONS,
  selectedMinuteStart,
  type BurstActivityClosedReason,
  type ReassessmentClosedReason,
} from "../lib/abuse/egress-reassessment";

/**
 * Advisory reassessment input for one existing `multiple_runs` or
 * `account_runs_unverified` egress review case, by reference only. Authorized
 * by the dedicated review key, which serviceFunctions scopes to this one
 * action outside the review module. It audits the read, decrypts and validates the stored record, and returns the
 * bounded evidence of the one candidate run that record retained, with
 * placeholder locators. The trusted worker gets the candidate run ID only
 * to verify its completion. No case, account or enforcement state changes.
 */
const caseEvidence = v.union(
  v.object({
    status: v.literal("closed"),
    reason: literals(REASSESSMENT_CLOSED_REASONS),
  }),
  v.object({
    status: v.literal("read"),
    candidateRunId: v.string(),
    burstStart: v.number(),
    burstEnd: v.number(),
    evidence: candidateEvidence,
  }),
);

export const readCaseEvidence = action({
  args: { serviceKey: v.string(), reference: v.string() },
  returns: caseEvidence,
  handler: async (
    ctx,
    { serviceKey, reference },
  ): Promise<Infer<typeof caseEvidence>> => {
    authorizeEgressReview(serviceKey);
    if (!CASE_REFERENCE.test(reference))
      throw new Error("Invalid review case identity");
    const closed = (reason: ReassessmentClosedReason) => ({
      status: "closed" as const,
      reason,
    });
    const opened: Infer<typeof openedCase> = await ctx.runMutation(
      internal.egressAbuseReassessment.openCase,
      { reference },
    );
    if (opened.status === "closed") return closed(opened.reason);
    let record: unknown;
    try {
      record = decryptAbuseEvidence(reference, opened.ciphertext);
    } catch {
      return closed("record_invalid");
    }
    const parsed = parseRetainedCandidateCase(record, {
      reference,
      digest: opened.digest,
      createdAt: opened.createdAt,
    });
    if (!parsed.ok) return closed(parsed.reason);
    const evidence: Infer<typeof candidateRead> = await ctx.runQuery(
      internal.egressAbuseReassessment.readCandidateEvidence,
      {
        caseId: opened.caseId,
        revision: opened.revision,
        updatedAt: opened.updatedAt,
        ...parsed.scope,
      },
    );
    if (evidence.status === "case_changed") return closed("case_changed");
    return {
      status: "read" as const,
      candidateRunId: parsed.scope.runId,
      burstStart: parsed.scope.burstStart,
      burstEnd: parsed.scope.burstEnd,
      evidence,
    };
  },
});

/**
 * Advisory burst-activity input for one existing v3 `manual_review` or
 * `authorization_request` egress review case without a recorded enforcement
 * decision, by reference only. Authorized like `readCaseEvidence`. It audits
 * the read, decrypts and binds the stored record, and returns the verified
 * account's bounded burst-mode activity: at most one candidate run whose
 * persisted timing overlaps the burst, with placeholder locators. The trusted
 * worker gets the candidate run ID only to verify its completion. No case,
 * account or enforcement state changes.
 *
 * `activityMinuteUtc` reads one complete UTC minute an operator selected
 * inside the record's 30-minute window instead of its saved burst minute,
 * such as the minute of an archived alert verified out of band. It is
 * checked before the audited read for its format and completion, and after
 * decryption against the window; the account still comes only from the
 * record, and the selection proves nothing about that minute's telemetry.
 */
const burstEvidence = v.union(
  v.object({
    status: v.literal("closed"),
    reason: literals(BURST_ACTIVITY_CLOSED_REASONS),
  }),
  v.object({
    status: v.literal("read"),
    burstStart: v.number(),
    burstEnd: v.number(),
    minuteBasis: v.union(
      v.literal("saved_case"),
      v.literal("operator_selected"),
    ),
    evidence: burstActivityEvidence,
  }),
);

export const readBurstActivityEvidence = action({
  args: {
    serviceKey: v.string(),
    reference: v.string(),
    activityMinuteUtc: v.optional(v.string()),
  },
  returns: burstEvidence,
  handler: async (
    ctx,
    { serviceKey, reference, activityMinuteUtc },
  ): Promise<Infer<typeof burstEvidence>> => {
    authorizeEgressReview(serviceKey);
    if (!CASE_REFERENCE.test(reference))
      throw new Error("Invalid review case identity");
    const selectedMinute =
      activityMinuteUtc === undefined
        ? undefined
        : selectedMinuteStart(activityMinuteUtc, Date.now());
    if (selectedMinute === null) throw new Error("Invalid activity minute");
    const closed = (reason: BurstActivityClosedReason) => ({
      status: "closed" as const,
      reason,
    });
    const opened: Infer<typeof openedCase> = await ctx.runMutation(
      internal.egressAbuseReassessment.openCase,
      { reference },
    );
    if (opened.status === "closed") return closed(opened.reason);
    let record: unknown;
    try {
      record = decryptAbuseEvidence(reference, opened.ciphertext);
    } catch {
      return closed("record_invalid");
    }
    const parsed = parseBurstActivityCase(
      record,
      {
        reference,
        digest: opened.digest,
        createdAt: opened.createdAt,
      },
      selectedMinute,
    );
    if (!parsed.ok) return closed(parsed.reason);
    const evidence: Infer<typeof burstActivityRead> = await ctx.runQuery(
      internal.egressAbuseReassessment.readBurstActivity,
      {
        caseId: opened.caseId,
        revision: opened.revision,
        updatedAt: opened.updatedAt,
        ...parsed.scope,
      },
    );
    if (evidence.status === "case_changed") return closed("case_changed");
    return {
      status: "read" as const,
      burstStart: parsed.scope.burstStart,
      burstEnd: parsed.scope.burstEnd,
      minuteBasis: parsed.minuteBasis,
      evidence,
    };
  },
});
