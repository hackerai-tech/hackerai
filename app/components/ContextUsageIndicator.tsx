"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SUMMARIZATION_THRESHOLD_PERCENTAGE } from "@/lib/chat/summarization/constants";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

export interface ContextUsageData {
  usedTokens: number;
  maxTokens: number;
}

interface ContextUsageIndicatorProps extends ContextUsageData {
  variant?: "tooltip" | "compact-popover";
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    if (m >= 10) return `${Math.round(m)}M`;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

function formatExactTokenCount(n: number): string {
  return Math.round(n).toLocaleString();
}

const AUTO_COMPACT_PERCENT = Math.round(
  SUMMARIZATION_THRESHOLD_PERCENTAGE * 100,
);

const CIRCLE_SIZE = 16;
const STROKE_WIDTH = 2.5;
const RADIUS = (CIRCLE_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function ContextUsageCircle({ dashOffset }: { dashOffset: number }) {
  return (
    <svg
      width={CIRCLE_SIZE}
      height={CIRCLE_SIZE}
      viewBox={`0 0 ${CIRCLE_SIZE} ${CIRCLE_SIZE}`}
      className="shrink-0 -rotate-90"
      data-testid="context-usage-circle"
    >
      <circle
        cx={CIRCLE_SIZE / 2}
        cy={CIRCLE_SIZE / 2}
        r={RADIUS}
        fill="none"
        className="stroke-muted"
        strokeWidth={STROKE_WIDTH}
      />
      <circle
        cx={CIRCLE_SIZE / 2}
        cy={CIRCLE_SIZE / 2}
        r={RADIUS}
        fill="none"
        className="transition-all duration-300 stroke-foreground"
        strokeWidth={STROKE_WIDTH}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
      />
    </svg>
  );
}

const ContextUsageHoverTrigger = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div"> & ContextUsageData & { dashOffset: number }
>(({ usedTokens, maxTokens, dashOffset, ...props }, ref) => (
  <div
    ref={ref}
    tabIndex={0}
    className="flex items-center h-7 px-1 cursor-default rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    aria-label={`Context usage: ${formatTokenCount(usedTokens)} of ${formatTokenCount(maxTokens)} tokens`}
    data-testid="context-usage-indicator"
    {...props}
  >
    <ContextUsageCircle dashOffset={dashOffset} />
  </div>
));
ContextUsageHoverTrigger.displayName = "ContextUsageHoverTrigger";

const ContextUsageButtonTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & ContextUsageData & { dashOffset: number }
>(({ usedTokens, maxTokens, dashOffset, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className="flex items-center justify-center h-7 w-7 cursor-pointer rounded-full p-0 text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    aria-label={`Context usage: ${formatTokenCount(usedTokens)} of ${formatTokenCount(maxTokens)} tokens`}
    data-testid="context-usage-indicator"
    {...props}
  >
    <ContextUsageCircle dashOffset={dashOffset} />
  </button>
));
ContextUsageButtonTrigger.displayName = "ContextUsageButtonTrigger";

export const ContextUsageIndicator = ({
  usedTokens,
  maxTokens,
  variant = "tooltip",
}: ContextUsageIndicatorProps) => {
  if (usedTokens === 0 || maxTokens === 0) return null;
  const percent = Math.min((usedTokens / maxTokens) * 100, 100);
  const remaining = Math.max(0, 100 - Math.round(percent));
  const autoCompactTokens = Math.floor(
    maxTokens * SUMMARIZATION_THRESHOLD_PERCENTAGE,
  );
  const tokensUntilAutoCompact = Math.max(0, autoCompactTokens - usedTokens);
  const dashOffset = CIRCUMFERENCE - (percent / 100) * CIRCUMFERENCE;

  if (variant === "compact-popover") {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <ContextUsageButtonTrigger
            usedTokens={usedTokens}
            maxTokens={maxTokens}
            dashOffset={dashOffset}
          />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          className="w-auto max-w-[240px] px-3 py-2.5 text-center"
        >
          <div className="font-medium text-xs">Context window:</div>
          <div className="text-xs tabular-nums">
            {remaining}% left ({formatExactTokenCount(usedTokens)} used /{" "}
            {formatExactTokenCount(maxTokens)})
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ContextUsageHoverTrigger
          usedTokens={usedTokens}
          maxTokens={maxTokens}
          dashOffset={dashOffset}
        />
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        sideOffset={8}
        className="max-w-[200px] px-3 py-2.5 text-center space-y-0.5"
      >
        <div className="font-medium text-xs">Context window:</div>
        <div className="text-xs">
          {Math.round(percent)}% used ({remaining}% left)
        </div>
        <div className="text-xs tabular-nums">
          {formatTokenCount(usedTokens)} / {formatTokenCount(maxTokens)} tokens
          used
        </div>
        <div className="text-xs text-muted-foreground pt-1">
          Auto-compact starts at {formatExactTokenCount(autoCompactTokens)}{" "}
          tokens ({AUTO_COMPACT_PERCENT}%).
        </div>
        <div className="text-xs text-muted-foreground">
          {tokensUntilAutoCompact > 0
            ? `${formatExactTokenCount(tokensUntilAutoCompact)} tokens until auto-compact`
            : "Auto-compact threshold reached"}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};
