"use client";

import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FindingEvidenceStatus } from "@/lib/findings/evidence-status";
import {
  findingStatusLabel,
  type FindingDisposition,
} from "@/lib/findings/disposition";
import type { FindingSeverity, FindingStatus } from "@/types/finding";
import { FindingEvidenceBadge } from "./FindingEvidenceBadge";
import { FindingStatusPill } from "./FindingDecision";

const severityClasses: Record<FindingSeverity, string> = {
  critical: "border-red-500/30 bg-red-500/10 text-red-500",
  high: "border-orange-500/30 bg-orange-500/10 text-orange-500",
  medium: "border-yellow-500/30 bg-yellow-500/10 text-yellow-500",
  low: "border-blue-500/30 bg-blue-500/10 text-blue-500",
  info: "border-slate-500/30 bg-slate-500/10 text-slate-500",
};

const severityDotClasses: Record<FindingSeverity, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-500",
  info: "bg-slate-500",
};

export const getFindingSeverityClasses = (severity: FindingSeverity) =>
  severityClasses[severity];

export const getFindingSeverityDotClasses = (severity: FindingSeverity) =>
  severityDotClasses[severity];

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

export function FindingCard({
  title,
  target,
  severity,
  cvssScore,
  evidenceStatus,
  status,
  disposition,
  footer,
  onClick,
  className,
}: {
  title: string;
  target: string;
  severity: FindingSeverity;
  cvssScore: number;
  /**
   * `undefined` hides the badge (persisted record unknown); `null` means the
   * persisted record has no evidence basis and renders "Not recorded".
   */
  evidenceStatus?: FindingEvidenceStatus | null;
  /** Current saved lifecycle; omit while the persisted record is unknown. */
  status?: FindingStatus;
  disposition?: FindingDisposition;
  /** Rendered below the card header, outside the open-finding button. */
  footer?: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const closed = status === "closed";
  // A recorded decision or closure takes the header slot; severity moves to
  // the metadata row so it never reads as the decision.
  const showStatus = disposition !== undefined || closed;
  const severityLabel = `${severity} · ${cvssScore.toFixed(1)}`;
  const severityChip = (
    <span
      className={cn(
        "shrink-0 rounded-md border px-2 py-1 text-[11px] font-semibold uppercase leading-none",
        severityClasses[severity],
      )}
    >
      {severityLabel}
    </span>
  );

  const content = (
    <>
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg border",
          closed
            ? "border-border bg-muted/40 text-muted-foreground"
            : severityClasses[severity],
        )}
      >
        <ShieldAlert className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 text-left">
        <div
          className={cn(
            "line-clamp-2 break-words text-sm font-medium",
            closed ? "text-foreground/85" : "text-foreground",
          )}
        >
          {title}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {target}
        </div>
        {evidenceStatus !== undefined || showStatus ? (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {evidenceStatus !== undefined ? (
              <FindingEvidenceBadge status={evidenceStatus ?? undefined} />
            ) : null}
            {status === "active" && !disposition ? (
              <span className="text-xs text-muted-foreground">
                {findingStatusLabel({ status }, disposition)}
              </span>
            ) : null}
            {showStatus ? (
              closed ? (
                <span className="text-xs text-muted-foreground">
                  Reported {capitalize(severity)} · {cvssScore.toFixed(1)}
                </span>
              ) : (
                severityChip
              )
            ) : null}
          </div>
        ) : null}
      </div>
      {showStatus ? (
        <FindingStatusPill
          disposition={disposition}
          label={findingStatusLabel({ status }, disposition)}
        />
      ) : (
        severityChip
      )}
    </>
  );

  const headClasses = cn(
    "flex w-full items-start gap-3 p-3",
    !showStatus && evidenceStatus === undefined && "items-center",
    onClick &&
      "cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  );

  return (
    <div
      className={cn(
        "@container w-full max-w-xl overflow-hidden rounded-xl border border-border bg-muted/20",
        className,
      )}
    >
      {onClick ? (
        <button
          type="button"
          className={headClasses}
          onClick={onClick}
          aria-label={`Open finding: ${title}`}
        >
          {content}
        </button>
      ) : (
        <div className={headClasses}>{content}</div>
      )}
      {footer}
    </div>
  );
}
