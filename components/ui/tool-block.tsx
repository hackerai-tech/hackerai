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
    "rounded-[15px] px-[10px] py-[3px] border border-border bg-muted/20 inline-flex max-w-full gap-[4px] items-center relative h-[28px] overflow-hidden";
  const clickableClasses = isClickable
    ? "cursor-pointer hover:bg-muted/40 transition-colors"
    : "";

  return (
    <div className="flex-1 min-w-0">
      <div
        className={`${baseClasses} ${clickableClasses}`}
        onClick={isClickable ? onClick : undefined}
        onKeyDown={isClickable ? onKeyDown : undefined}
        tabIndex={isClickable ? 0 : undefined}
        role={isClickable ? "button" : undefined}
        aria-label={
          isClickable && target ? `Open ${target} in sidebar` : undefined
        }
      >
        <div className="w-[21px] inline-flex items-center flex-shrink-0 text-foreground">
          {icon}
        </div>
        <div className="max-w-[100%] truncate text-muted-foreground relative top-[-1px]">
          <span className="text-[13px]">
            {isShimmer ? <ShimmerText>{action}</ShimmerText> : action}
          </span>
          {target && (
            <span className="text-[12px] font-mono ml-[6px] text-muted-foreground/70">
              {target}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default ToolBlock;
