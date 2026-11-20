"use client";

import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  formatTokenCount,
  getContextPressurePercent,
  type ContextPressureSnapshot,
} from "@/lib/chat/context-pressure";

export type ContextMeterData = {
  /** The chat the snapshot and count were read from. */
  chatId: string;
  /** Last measured Agent request in this chat; no meter exists before one. */
  snapshot: ContextPressureSnapshot;
  /** Undefined when this chat's compactions were never recorded. */
  completedCompactions?: number;
};

const isKnownCount = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;

/** At or above this share of the threshold the ring brightens. */
const NEAR_THRESHOLD_PERCENT = 85;
const RING_RADIUS = 6.25;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ContextRing({ snapshot }: { snapshot: ContextPressureSnapshot }) {
  // The actual ratio, capped for drawing only; text keeps the true percent.
  const fill = Math.min(
    1,
    snapshot.usedTokens / snapshot.compactionThresholdTokens,
  );
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      className="size-4 shrink-0"
      data-testid="context-meter-ring"
      data-fill={fill.toFixed(2)}
    >
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        strokeWidth={2.5}
        className="stroke-muted-foreground/30"
        transform="rotate(-90 8 8)"
      />
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        strokeWidth={2.5}
        className={
          fill * 100 >= NEAR_THRESHOLD_PERCENT
            ? "stroke-foreground/90"
            : "stroke-muted-foreground"
        }
        strokeDasharray={`${fill * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

const formatTokens = (snapshot: ContextPressureSnapshot) =>
  `${formatTokenCount(snapshot.usedTokens)} / ${formatTokenCount(
    snapshot.compactionThresholdTokens,
  )} tokens`;

/** Accessible name of the trigger and the spoken tooltip text. */
function getSummary(snapshot: ContextPressureSnapshot) {
  return `Context: ${getContextPressurePercent(snapshot)}% of compaction threshold, ${formatTokens(snapshot)}`;
}

/** Percent of the compaction threshold, the primary line on both surfaces. */
function ThresholdLine({
  snapshot,
  className,
}: {
  snapshot: ContextPressureSnapshot;
  className?: string;
}) {
  return (
    <p className={className}>
      <span className="font-semibold tabular-nums">
        {getContextPressurePercent(snapshot)}%
      </span>{" "}
      of compaction threshold
    </p>
  );
}

/**
 * Composer context meter. Hover or focus previews percent and tokens; click,
 * tap, Enter or Space adds the completed compaction count. Shows only the
 * provider-measured input of the last Agent request.
 */
export function ChatContextDetails({
  snapshot,
  completedCompactions,
}: Omit<ContextMeterData, "chatId">) {
  const [open, setOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const summary = getSummary(snapshot);
  const countKnown = isKnownCount(completedCompactions);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setHintOpen(false);
      }}
    >
      <Tooltip
        delayDuration={200}
        open={hintOpen && !open}
        onOpenChange={setHintOpen}
      >
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={summary}
              data-testid="context-details-trigger"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors outline-none hover:bg-muted/30 focus-visible:ring-[3px] focus-visible:ring-ring/50 md:size-7",
                open && "bg-muted/30",
              )}
            >
              <ContextRing snapshot={snapshot} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {/* The label is what assistive tech reads; the lines are visual. */}
        <TooltipContent side="top" sideOffset={6} aria-label={summary}>
          <div className="text-center">
            <ThresholdLine snapshot={snapshot} />
            <p className="text-primary-foreground/70 tabular-nums">
              {formatTokens(snapshot)}
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Agent context"
        className="flex w-auto min-w-48 max-w-[calc(100vw-24px)] flex-col gap-2.5 rounded-xl px-3.5 py-3"
      >
        <div className="flex flex-col gap-0.5">
          <ThresholdLine
            snapshot={snapshot}
            className="text-[13px] leading-[18px]"
          />
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatTokens(snapshot)} · last request
          </p>
        </div>
        <dl
          aria-live="polite"
          aria-atomic="true"
          className="flex items-baseline justify-between gap-3 border-t pt-2.5 text-xs text-muted-foreground"
        >
          <dt>Completed compactions</dt>
          <dd
            className={cn(
              countKnown &&
                "text-[13px] font-medium text-foreground tabular-nums",
            )}
          >
            {countKnown ? completedCompactions : "Unavailable"}
          </dd>
        </dl>
      </PopoverContent>
    </Popover>
  );
}
