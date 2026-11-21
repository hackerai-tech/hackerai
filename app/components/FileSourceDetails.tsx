"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function FileSourceDetails({
  label,
  name,
  children,
}: {
  label: string;
  name: string;
  children: ReactNode;
}) {
  return (
    <Popover modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={name}
          title={label}
          className="inline-flex max-w-full shrink-0 self-start items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">{label}</span>
          <Info size={13} className="shrink-0" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={name}
        className="space-y-2 text-xs"
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
