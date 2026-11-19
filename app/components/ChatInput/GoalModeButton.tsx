import { useIsMobile } from "@/hooks/use-mobile";
import { X } from "lucide-react";
import { GoalTargetIcon } from "@/components/icons/goal-target";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function GoalModeButton({
  onClear,
  compact = false,
}: {
  onClear: () => void;
  compact?: boolean;
}) {
  const isMobile = useIsMobile();
  return (
    <div
      className={`flex shrink-0 items-center ${compact ? "gap-1.5" : "gap-2"}`}
    >
      <span
        aria-hidden="true"
        className="h-5 w-px bg-border max-[359px]:hidden"
      />
      <span
        className={`flex items-center text-muted-foreground ${compact ? "gap-1 text-xs" : "gap-1.5 pl-2 text-sm"}`}
      >
        <GoalTargetIcon className="size-4 shrink-0" aria-hidden="true" />
        Goal
      </span>
      <Tooltip open={isMobile ? false : undefined}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Exit goal mode"
            onClick={onClear}
            className={`flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${compact ? "size-9" : "size-7"}`}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          Exit goal mode
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
