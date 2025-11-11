import React from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";

interface ToolBlockProps {
  icon: React.ReactNode;
  action: string;
  target?: string;
  isShimmer?: boolean;
  isClickable?: boolean;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

const ToolBlock: React.FC<ToolBlockProps> = ({
  icon,
  action,
  target,
  isShimmer = false,
  isClickable = false,
  onClick,
  onKeyDown,
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
        <div className="max-w-[100%] truncate text-muted-foreground relative top-[-1px]">
          <span className="text-[13px]">
            {isShimmer ? <Shimmer>{action}</Shimmer> : action}
          </span>
          {target && (
            <span className="text-[12px] font-mono ml-[6px] text-muted-foreground/70">
              {target}
            </span>
          )}
        </div>
      </button>
    </div>
  );
};

export default ToolBlock;
