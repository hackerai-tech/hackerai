"use client";

import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

interface TokenBreakdownTooltipProps {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
};

const TokenBreakdownTooltip = ({
  totalTokens,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
}: TokenBreakdownTooltipProps) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="cursor-default border-b border-dotted border-muted-foreground/40"
          tabIndex={0}
          aria-label={`Token breakdown for ${formatTokenCount(totalTokens)} tokens`}
        >
          {formatTokenCount(totalTokens)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="p-0">
        <table className="text-xs tabular-nums">
          <tbody>
            <tr className="border-b border-border/50">
              <td className="px-3 py-1.5 text-muted-foreground">Cache Read</td>
              <td className="px-3 py-1.5 text-right font-medium">
                {(cacheReadTokens ?? 0).toLocaleString()}
              </td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="px-3 py-1.5 text-muted-foreground">Cache Write</td>
              <td className="px-3 py-1.5 text-right font-medium">
                {(cacheWriteTokens ?? 0).toLocaleString()}
              </td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="px-3 py-1.5 text-muted-foreground">Input</td>
              <td className="px-3 py-1.5 text-right font-medium">
                {inputTokens.toLocaleString()}
              </td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="px-3 py-1.5 text-muted-foreground">Output</td>
              <td className="px-3 py-1.5 text-right font-medium">
                {outputTokens.toLocaleString()}
              </td>
            </tr>
            <tr>
              <td className="px-3 py-1.5 font-medium">Total</td>
              <td className="px-3 py-1.5 text-right font-semibold">
                {totalTokens.toLocaleString()}
              </td>
            </tr>
          </tbody>
        </table>
      </TooltipContent>
    </Tooltip>
  );
};

export { TokenBreakdownTooltip, formatTokenCount };
