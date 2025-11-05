import React from "react";
import { ShimmerText } from "@/app/components/ShimmerText";

interface ToolBlockProps {
  icon: React.ReactNode;
  action: string;
  target?: string;
  isShimmer?: boolean;
  isClickable?: boolean;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  statusBadge?: "running" | "completed" | null;
  onKill?: () => void;
  isKilling?: boolean;
}

const ToolBlock: React.FC<ToolBlockProps> = ({
  icon,
  action,
  target,
  isShimmer = false,
  isClickable = false,
  onClick,
  onKeyDown,
  statusBadge = null,
  onKill,
  isKilling = false,
}) => {
  const baseClasses =
    "rounded-[15px] px-[10px] py-[6px] border border-border bg-muted/20 inline-flex max-w-full gap-[4px] items-center relative h-[36px] overflow-hidden";
  const clickableClasses = isClickable
    ? "cursor-pointer hover:bg-muted/40 transition-colors"
    : "";

  return (
    <div className="flex-1 min-w-0">
      <button
        className={`${baseClasses} ${clickableClasses}`}
        onClick={isClickable ? onClick : undefined}
        onKeyDown={isClickable ? onKeyDown : undefined}
        tabIndex={isClickable ? 0 : undefined}
        role={isClickable ? "button" : undefined}
        aria-label={
          isClickable && target ? `Open ${target} in sidebar` : undefined
        }
      >
        <div className="w-[21px] inline-flex items-center flex-shrink-0 text-foreground [&>svg]:h-4 [&>svg]:w-4">
          {icon}
        </div>
        <div className="max-w-[100%] truncate text-muted-foreground relative top-[-1px] flex items-center gap-2">
          <div className="truncate">
            <span className="text-[13px]">
              {isShimmer ? <ShimmerText>{action}</ShimmerText> : action}
            </span>
            {target && (
              <span className="text-[12px] font-mono ml-[6px] text-muted-foreground/70">
                {target}
              </span>
            )}
          </div>
          {statusBadge === "running" && (
            <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 flex-shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-green-600 dark:bg-green-400 animate-pulse"></span>
              {isKilling ? "Killing..." : "Running"}
              {onKill && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isKilling) onKill();
                  }}
                  className={`w-4 h-4 bg-red-500 hover:bg-red-600 rounded-sm flex items-center justify-center transition-all cursor-pointer ml-0.5 ${
                    isKilling ? "opacity-50 cursor-not-allowed" : ""
                  }`}
                  title={isKilling ? "Killing process..." : "Kill process"}
                  role="button"
                  aria-label={isKilling ? "Killing process..." : "Kill process"}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && !isKilling) {
                      e.preventDefault();
                      e.stopPropagation();
                      onKill();
                    }
                  }}
                >
                  {isKilling ? (
                    <span className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                  ) : (
                    <span className="text-white text-[10px] font-bold leading-none">×</span>
                  )}
                </span>
              )}
            </span>
          )}
        </div>
      </button>
    </div>
  );
};

export default ToolBlock;
