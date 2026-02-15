"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface ContextUsageData {
  messagesTokens: number;
  summaryTokens: number;
  systemTokens: number;
  maxTokens: number;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

function getBarColor(percent: number): string {
  if (percent > 80) return "bg-red-500";
  if (percent > 50) return "bg-yellow-500";
  return "bg-green-500";
}

const CATEGORY_COLORS = {
  system: "bg-blue-500",
  summary: "bg-purple-500",
  messages: "bg-green-500",
} as const;

export const ContextUsageIndicator = ({
  messagesTokens,
  summaryTokens,
  systemTokens,
  maxTokens,
}: ContextUsageData) => {
  const totalTokens = messagesTokens + summaryTokens + systemTokens;
  const percent =
    maxTokens > 0 ? Math.min((totalTokens / maxTokens) * 100, 100) : 0;

  const categories = [
    { label: "System", tokens: systemTokens, color: CATEGORY_COLORS.system },
    { label: "Summary", tokens: summaryTokens, color: CATEGORY_COLORS.summary },
    {
      label: "Messages",
      tokens: messagesTokens,
      color: CATEGORY_COLORS.messages,
    },
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-muted-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          aria-label={`Context usage: ${formatTokenCount(totalTokens)} of ${formatTokenCount(maxTokens)} tokens`}
          data-testid="context-usage-indicator"
        >
          <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${getBarColor(percent)}`}
              style={{ width: `${percent}%` }}
              data-testid="context-usage-bar"
            />
          </div>
          <span className="tabular-nums whitespace-nowrap">
            {formatTokenCount(totalTokens)} / {formatTokenCount(maxTokens)}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-64 p-3"
      >
        <div className="space-y-2.5">
          <div className="flex justify-between items-center text-xs font-medium">
            <span>Context Usage</span>
            <span className="text-muted-foreground tabular-nums">
              {Math.round(percent)}%
            </span>
          </div>

          <div className="w-full h-2 rounded-full bg-muted overflow-hidden flex">
            {categories.map(
              (cat) =>
                cat.tokens > 0 && (
                  <div
                    key={cat.label}
                    className={`h-full ${cat.color} transition-all duration-300`}
                    style={{
                      width: `${maxTokens > 0 ? (cat.tokens / maxTokens) * 100 : 0}%`,
                    }}
                  />
                ),
            )}
          </div>

          <div className="space-y-1.5">
            {categories.map((cat) => (
              <div
                key={cat.label}
                className="flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${cat.color}`} />
                  <span className="text-muted-foreground">{cat.label}</span>
                </div>
                <span className="tabular-nums">
                  {formatTokenCount(cat.tokens)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
