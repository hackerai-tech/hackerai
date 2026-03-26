"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface ContextUsageData {
  usedTokens: number;
  maxTokens: number;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

const CIRCLE_SIZE = 16;
const STROKE_WIDTH = 2.5;
const RADIUS = (CIRCLE_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const ContextUsageIndicator = ({
  usedTokens,
  maxTokens,
}: ContextUsageData) => {
  if (usedTokens === 0 || maxTokens === 0) return null;
  const percent = Math.min((usedTokens / maxTokens) * 100, 100);
  const remaining = Math.max(0, 100 - Math.round(percent));
  const dashOffset = CIRCUMFERENCE - (percent / 100) * CIRCUMFERENCE;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex items-center h-7 px-1 cursor-default"
          aria-label={`Context usage: ${formatTokenCount(usedTokens)} of ${formatTokenCount(maxTokens)} tokens`}
          data-testid="context-usage-indicator"
        >
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
        </div>
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
          HackerAI automatically compacts its context
        </div>
      </TooltipContent>
    </Tooltip>
  );
};
