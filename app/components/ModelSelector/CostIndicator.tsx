import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type CostTier = "low" | "medium" | "high" | "very-high" | "free";

const MODEL_COST_TIER: Record<string, CostTier> = {
  "gemini-3-flash": "low",
  "grok-4.1": "low",
  "sonnet-4.6": "high",
  "opus-4.6": "very-high",
  "opus-4.7": "very-high",
  "kimi-k2.5": "low",
};

export function getCostTier(modelId: string): CostTier {
  if (modelId.startsWith("codex-local")) return "free";
  return MODEL_COST_TIER[modelId] || "medium";
}

const COST_CONFIG: Record<
  CostTier,
  { count: number; label: string; activeClass: string; suffix?: string }
> = {
  free: {
    count: 0,
    label: "Your account",
    activeClass: "text-blue-600/80 dark:text-blue-400/80",
  },
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

  if (tier === "free") {
    return null;
  }

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
