"use client";

import {
  CircleDashed,
  CircleHelp,
  FileSearch,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  findingEvidenceLabel,
  type FindingEvidenceStatus,
} from "@/lib/findings/evidence-status";

export const FINDING_EVIDENCE_BASIS_NOTE =
  "Agent-reported evidence basis. This is not independent verification.";

const evidenceIcons: Record<FindingEvidenceStatus, LucideIcon> = {
  source_review_only: FileSearch,
  runtime_reproduced: SquareTerminal,
  inconclusive: CircleHelp,
};

/**
 * Neutral by design: evidence basis must not read as severity or as a
 * verified/passed state, so it never uses status colors.
 */
export function FindingEvidenceBadge({
  status,
  className,
}: {
  status?: FindingEvidenceStatus;
  className?: string;
}) {
  const Icon = status ? evidenceIcons[status] : CircleDashed;

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground",
        className,
      )}
      title={FINDING_EVIDENCE_BASIS_NOTE}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">Evidence basis: </span>
      <span className="min-w-0 truncate">{findingEvidenceLabel(status)}</span>
    </span>
  );
}
