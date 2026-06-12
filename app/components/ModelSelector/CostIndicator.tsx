import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ChatMode } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";

type CostTier = "low" | "medium" | "high" | "very-high";

// Cost tier per HackerAI tier id. Standard and Pro are mode-aware in ask;
// Agent keeps the higher-cost coding/automation models.
export function getCostTier(modelId: string, mode?: ChatMode): CostTier {
  switch (modelId) {
    case "hackerai-standard":
      return mode && isAgentMode(mode) ? "medium" : "low";
    case "hackerai-pro":
      return mode && isAgentMode(mode) ? "high" : "medium";
    case "hackerai-max":
      return "very-high";
    default:
      return "medium";
  }
}

const COST_CONFIG: Record<
  CostTier,
  { count: number; label: string; activeClass: string; suffix?: string }
> = {
  low: {
    count: 1,
    label: "Low cost",
    activeClass: "text-emerald-600/80 dark:text-emerald-400/80",
  },
  medium: {
    count: 2,
    label: "Medium cost",
    activeClass: "text-amber-600/80 dark:text-amber-400/80",
  },
  high: {
    count: 3,
    label: "High cost",
    activeClass: "text-orange-600/80 dark:text-orange-400/80",
  },
  "very-high": {
    count: 3,
    label: "Very high cost",
    activeClass: "text-red-600/80 dark:text-red-400/80",
    suffix: "+",
  },
};

const MAX_DOLLARS = 3;

export function CostIndicator({
  modelId,
  mode,
}: {
  modelId: string;
  mode?: ChatMode;
}) {
  const tier = getCostTier(modelId, mode);
  const config = COST_CONFIG[tier];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Cost: ${config.label}`}
          className="inline-flex items-center gap-0 font-semibold tracking-tight text-xs cursor-default"
        >
          {Array.from({ length: MAX_DOLLARS }, (_, i) => (
            <span
              key={i}
              aria-hidden="true"
              className={
                i < config.count
                  ? config.activeClass
                  : "text-muted-foreground/30"
              }
            >
              $
            </span>
          ))}
          {config.suffix && (
            <span aria-hidden="true" className={config.activeClass}>
              {config.suffix}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={4} className="text-xs px-2 py-1">
        {config.label}
      </TooltipContent>
    </Tooltip>
  );
}
