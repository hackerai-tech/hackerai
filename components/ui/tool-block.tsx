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
  ariaLabel?: string;
}

const ToolBlock: React.FC<ToolBlockProps> = ({
  icon,
  action,
  target,
  isShimmer = false,
  isClickable = false,
  onClick,
  onKeyDown,
  ariaLabel,
}) => {
  const baseClasses =
    "rounded-[15px] px-[10px] py-[6px] border border-border bg-muted/20 inline-flex max-w-full gap-[4px] items-center relative h-[36px] overflow-hidden";
  const clickableClasses = isClickable
    ? "cursor-pointer hover:bg-muted/40 transition-colors"
    : "";

  const content = (
    <>
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
    </>
  );

  return (
    <div className="flex-1 min-w-0">
      {isClickable ? (
        <button
          type="button"
          className={`${baseClasses} ${clickableClasses}`}
          onClick={onClick}
          onKeyDown={onKeyDown}
          aria-label={
            ariaLabel || (target ? `Open ${target} in sidebar` : undefined)
          }
        >
          {content}
        </button>
      ) : (
        <div className={baseClasses}>{content}</div>
      )}
    </div>
  );
};

export default ToolBlock;
