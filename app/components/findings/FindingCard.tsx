"use client";

import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FindingSeverity } from "@/types/finding";

const severityClasses: Record<FindingSeverity, string> = {
  critical: "border-red-500/30 bg-red-500/10 text-red-500",
  high: "border-orange-500/30 bg-orange-500/10 text-orange-500",
  medium: "border-yellow-500/30 bg-yellow-500/10 text-yellow-500",
  low: "border-blue-500/30 bg-blue-500/10 text-blue-500",
  info: "border-slate-500/30 bg-slate-500/10 text-slate-500",
};

export const getFindingSeverityClasses = (severity: FindingSeverity) =>
  severityClasses[severity];

export function FindingCard({
  title,
  target,
  severity,
  cvssScore,
  onClick,
  className,
}: {
  title: string;
  target: string;
  severity: FindingSeverity;
  cvssScore: number;
  onClick?: () => void;
  className?: string;
}) {
  const content = (
    <>
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg border",
          severityClasses[severity],
        )}
      >
        <ShieldAlert className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm font-medium text-foreground">
          {title}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {target}
        </div>
      </div>
      <div
        className={cn(
          "shrink-0 rounded-md border px-2 py-1 text-[11px] font-semibold uppercase",
          severityClasses[severity],
        )}
      >
        {severity} · {cvssScore.toFixed(1)}
      </div>
    </>
  );

  const classes = cn(
    "flex w-full max-w-xl items-center gap-3 rounded-xl border border-border bg-muted/20 p-3",
    onClick &&
      "cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );

  return onClick ? (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      aria-label={`Open finding: ${title}`}
    >
      {content}
    </button>
  ) : (
    <div className={classes}>{content}</div>
  );
}
