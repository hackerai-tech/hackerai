"use client";

import { type LucideIcon, Lock } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export interface ModeOptionItemProps {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
  "data-testid"?: string;
  showLock?: boolean;
  showProBadge?: boolean;
}

export function ModeOptionItem({
  icon: Icon,
  title,
  description,
  onClick,
  "data-testid": testId,
  showLock = false,
  showProBadge = false,
}: ModeOptionItemProps) {
  return (
    <DropdownMenuItem
      onClick={onClick}
      className="cursor-pointer"
      data-testid={testId}
    >
      <Icon className="w-4 h-4 mr-2" />
      <div className="flex flex-col flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          {showLock && <Lock className="w-3 h-3 text-muted-foreground" />}
          {showProBadge && (
            <span className="flex items-center gap-1 rounded-full py-1 px-2 text-xs font-medium bg-premium-bg text-premium-text hover:bg-premium-hover border-0 transition-all duration-200">
              PRO
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
    </DropdownMenuItem>
  );
}
