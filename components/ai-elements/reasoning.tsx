"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { createContext, memo, useContext, useEffect } from "react";
import type { ComponentProps } from "react";

type ReasoningContextValue = {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  isStreaming: boolean;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

const useReasoningContext = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<"div"> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });

    useEffect(() => {
      if (isStreaming === true) {
        setIsOpen(true);
      } else if (isStreaming === false) {
        setIsOpen(false);
      }
    }, [isStreaming, setIsOpen]);

    return (
      <ReasoningContext.Provider
        value={{ isOpen: !!isOpen, setIsOpen, isStreaming }}
      >
        <div
          className={cn("not-prose max-w-prose space-y-2", className)}
          {...props}
        >
          {children}
        </div>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  title?: string;
};

export const ReasoningTrigger = memo(
  ({ className, title = "Reasoning", ...props }: ReasoningTriggerProps) => {
    const { isOpen, setIsOpen, isStreaming } = useReasoningContext();

    return (
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger
          className={cn(
            "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
            className,
          )}
          aria-label={title}
          {...props}
        >
          <BrainIcon className="size-4" />
          <span className="flex-1 text-left">{title}</span>
          {isStreaming && (
            <span className="relative flex items-center">
              <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-foreground/50 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-foreground" />
            </span>
          )}
          <ChevronDownIcon
            className={cn(
              "size-4 transition-transform",
              isOpen ? "rotate-180" : "rotate-0",
            )}
          />
        </CollapsibleTrigger>
      </Collapsible>
    );
  },
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent>;

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    const { isOpen } = useReasoningContext();
    return (
      <Collapsible open={isOpen}>
        <CollapsibleContent
          className={cn(
            "mt-2 space-y-3",
            "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
            className,
          )}
          {...props}
        >
          {children}
        </CollapsibleContent>
      </Collapsible>
    );
  },
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
