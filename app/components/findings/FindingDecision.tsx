"use client";

import { PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FindingDisposition } from "@/lib/findings/disposition";
import { FindingDiscoveredAt } from "./FindingTime";

/** Neutral by design: a saved decision is not severity or verification. */
export function FindingStatusPill({
  disposition,
  label,
  className,
}: {
  disposition?: Pick<FindingDisposition, "kind">;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-semibold leading-4 text-foreground",
        className,
      )}
    >
      {disposition?.kind === "corrected" ? (
        <PencilLine className="size-3" aria-hidden="true" />
      ) : (
        <span
          className="size-1.5 rounded-full bg-muted-foreground/70"
          aria-hidden="true"
        />
      )}
      {label}
    </span>
  );
}

const DECIDED_VERB: Record<FindingDisposition["kind"], string> = {
  dismissed: "Closed",
  closed: "Closed",
  corrected: "Corrected",
};

/**
 * Card footer: the exact saved reason for a decision, and an optional action.
 * Stacks on narrow cards; the action sits on the right once there is room.
 */
export function FindingDecisionFooter({
  disposition,
  action,
}: {
  disposition?: FindingDisposition;
  action?: React.ReactNode;
}) {
  if (!disposition && !action) return null;
  return (
    <div className="flex flex-col items-start gap-2.5 border-t border-border/70 bg-background/40 px-3 py-2.5 @min-[28rem]:flex-row @min-[28rem]:items-center @min-[28rem]:gap-3 @min-[28rem]:pl-[3.75rem]">
      {disposition ? (
        <div className="min-w-0 flex-1">
          <p className="sr-only">{disposition.label} reason:</p>
          <p className="line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground">
            {disposition.reason}
          </p>
          {disposition.decided_at ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {DECIDED_VERB[disposition.kind]}{" "}
              <FindingDiscoveredAt timestamp={disposition.decided_at} />
            </p>
          ) : null}
        </div>
      ) : (
        <div className="hidden flex-1 @min-[28rem]:block" />
      )}
      {action}
    </div>
  );
}
