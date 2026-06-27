import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type CostTier = "low" | "medium" | "high" | "very-high";

// Cost tier per HackerAI tier id. Standard stays low cost in both modes;
// Pro and Max intentionally surface the higher-cost model choices.
export function getCostTier(modelId: string): CostTier {
  switch (modelId) {
    case "hackerai-standard":
      return "low";
    case "hackerai-pro":
      return "high";
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

export function CostIndicator({ modelId }: { modelId: string }) {
  const tier = getCostTier(modelId);
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
