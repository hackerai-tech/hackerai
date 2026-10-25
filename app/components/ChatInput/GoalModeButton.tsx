import { useIsMobile } from "@/hooks/use-mobile";
import { CircleX } from "lucide-react";
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
      <span aria-hidden="true" className="h-5 w-px bg-border" />
      <Tooltip open={isMobile ? false : undefined}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Exit goal mode"
            onClick={onClear}
            className={`group/goal flex min-h-9 shrink-0 items-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${compact ? "gap-1 px-1 text-xs" : "gap-1.5 px-2 text-sm"}`}
          >
            <span className="relative size-4 shrink-0" aria-hidden="true">
              <GoalTargetIcon className="size-4 group-hover/goal:opacity-0 group-focus-visible/goal:opacity-0" />
              <CircleX className="absolute inset-0 size-4 opacity-0 group-hover/goal:opacity-100 group-focus-visible/goal:opacity-100" />
            </span>
            Goal
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          Clear goal
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
