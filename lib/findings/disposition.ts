import {
  FINDING_CLOSURE_REASON_LABELS,
  type FindingClosureReason,
  type FindingStatus,
} from "./lifecycle";

/**
 * The saved decision shown beside a finding: an explicit closure with its
 * context, or the latest material correction of an active report. Separate
 * from evidence basis, severity and usefulness feedback.
 */
export type FindingDisposition = {
  kind: "dismissed" | "closed" | "corrected";
  label: string;
  /** The exact saved closure context or correction reason. */
  reason: string;
  decided_at?: number;
};

export type FindingDispositionSource = {
  status?: FindingStatus;
  closure_reason?: FindingClosureReason;
  closure_context?: string;
  closed_at?: number;
  correction_history?: ReadonlyArray<{
    updated_at: number;
    reason: string;
    changed_fields: readonly string[];
  }>;
};

/**
 * Derived only from authoritative lifecycle and correction fields. A closure
 * takes precedence over earlier corrections; an update that changed no saved
 * field is not a correction. Returns undefined when no decision was recorded,
 * so callers can show that the active report is unreviewed.
 */
export function getFindingDisposition(
  finding: FindingDispositionSource,
): FindingDisposition | undefined {
  if (finding.status === "closed") {
    const reason = finding.closure_context?.trim();
    if (!finding.closure_reason || !reason) return undefined;
    const dismissed = finding.closure_reason === "false_positive";
    return {
      kind: dismissed ? "dismissed" : "closed",
      label: dismissed
        ? "Dismissed"
        : FINDING_CLOSURE_REASON_LABELS[finding.closure_reason],
      reason,
      ...(finding.closed_at ? { decided_at: finding.closed_at } : {}),
    };
  }
  const history = finding.correction_history ?? [];
  for (let index = history.length - 1; index >= 0; index--) {
    const revision = history[index];
    const reason = revision.reason.trim();
    if (revision.changed_fields.length > 0 && reason)
      return {
        kind: "corrected",
        label: "Corrected",
        reason,
        decided_at: revision.updated_at,
      };
  }
  return undefined;
}

/** Unreviewed means there is no saved correction or closure decision. */
export const findingStatusLabel = (
  finding: { status?: FindingStatus },
  disposition: Pick<FindingDisposition, "label"> | undefined,
) =>
  disposition?.label ?? (finding.status === "closed" ? "Closed" : "Unreviewed");
