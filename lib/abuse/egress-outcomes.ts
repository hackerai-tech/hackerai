// Closed vocabularies shared by the egress review worker and Convex. No Node
// imports: Convex validators are built from these lists.

export const REVIEW_REASONS = [
  "legitimate_corroborated",
  "attribution_unverified",
  "no_acquisition_link",
  "acquisition_incomplete",
  "subagent_unresolved",
  "evidence_unavailable",
  "multiple_runs",
  "account_runs_unverified",
  "no_matching_run",
  "observation_incomplete",
  "no_command_evidence",
  "privacy_guard",
  "classifier_unavailable",
  "classifier_invalid",
  "ambiguous",
  "legitimate_uncorroborated",
  "concerning_uncorroborated",
  "account_activity_concerning",
  "concerning_unauthorized",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const ENFORCEMENT_DECISIONS = [
  "keep_active",
  "block_applied",
  "enforcement_pending",
] as const;
export type EnforcementDecision = (typeof ENFORCEMENT_DECISIONS)[number];

export const ENFORCEMENT_REASONS = [
  /** The cited commands and complete context corroborate legitimate work. */
  "legitimate_corroborated",
  /** The run could not be pinned or read completely enough to decide. */
  "coverage_incomplete",
  /** Classification was unavailable, invalid or ambiguous. */
  "inconclusive",
  /** Concerning activity without confirmed, explicit harmful intent. */
  "intent_not_established",
  /** Only unlinked account history was available; it never blocks. */
  "unlinked_history",
  "harmful_intent_confirmed",
  "enforcement_disabled",
  /** The enforcement credential or backend was unavailable. */
  "enforcement_unavailable",
  /** The server refused: run, evidence, account or an existing case changed. */
  "enforcement_refused",
] as const;
export type EnforcementReason = (typeof ENFORCEMENT_REASONS)[number];

export const BLOCKABLE_INTENTS = [
  "service_disruption",
  "unauthorized_access",
  "credential_theft",
  "data_theft",
  "extortion",
] as const;
export type BlockableIntent = (typeof BLOCKABLE_INTENTS)[number];

export const EVIDENCE_MODES = [
  "exact_run",
  "account_activity",
  "none",
] as const;
export const REVIEW_COVERAGE = ["complete", "incomplete", "not_read"] as const;
export type ReviewCoverageState = (typeof REVIEW_COVERAGE)[number];

/** Why the server refused an automated block; nothing was changed. */
export const BLOCK_REFUSALS = [
  /** The Convex kill switch is off; nothing was read or written. */
  "enforcement_disabled",
  "case_exists",
  "stale_burst",
  "account_unavailable",
  "run_unverified",
  "run_active",
  "evidence_mismatch",
  "competing_case",
  "restriction_conflict",
] as const;
export type BlockRefusal = (typeof BLOCK_REFUSALS)[number];

export const NOTICE_RESULTS = [
  /** The matching message was independently verified in Sent. */
  "sent",
  /** Definitely not accepted (for example, connection failed before DATA). */
  "not_sent",
  /** Permanently rejected by the SMTP server. */
  "rejected",
  /** No single verified address for the exact account. */
  "recipient_unavailable",
  /** Submission may have been accepted; never resent automatically. */
  "uncertain",
] as const;
export type NoticeResult = (typeof NOTICE_RESULTS)[number];

export const ENFORCEMENT_POLICY_VERSION = "egress-enforcement-v1";
/** Audit actor of every automated block write; distinct from the reviewer. */
export const ENFORCEMENT_ACTOR = "egress_abuse_enforcement";
export const BLOCK_NOTICE_TEMPLATE_VERSION = "abuse-block-notice-v1";

// A distinct proof binds the verified review's complete enforcement request
// to its deployment. It is issued with the read-only review worker's key.
export const VERIFIED_EGRESS_BLOCK_SCOPE =
  "egressAbuseEnforcement:attestVerifiedBurst";

export async function egressEvidenceFingerprint(evidence: {
  runStart: number;
  runEnd: number | null;
  userMessages: { messageId: string; text: string; truncated: boolean }[];
  commands: {
    messageId: string;
    toolCallId: string;
    tool: string;
    text: string;
    truncated: boolean;
  }[];
}) {
  const input = JSON.stringify([
    evidence.runStart,
    evidence.runEnd,
    evidence.userMessages.map(({ messageId, text, truncated }) => [
      messageId,
      text,
      truncated,
    ]),
    evidence.commands.map(
      ({ messageId, toolCallId, tool, text, truncated }) => [
        messageId,
        toolCallId,
        tool,
        text,
        truncated,
      ],
    ),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
