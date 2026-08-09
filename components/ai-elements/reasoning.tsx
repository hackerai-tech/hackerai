"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ComponentProps, ReactNode } from "react";

type ReasoningContextValue = {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  isStreaming: boolean;
  isActive: boolean;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  isActive?: boolean;
  collapseWhenInactive?: boolean;
};

export function Reasoning({
  className,
  isStreaming = false,
  isActive = isStreaming,
  collapseWhenInactive = true,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: ReasoningProps) {
  const [isOpen, setIsOpen] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });

  useEffect(() => {
    if (isStreaming) {
      setIsOpen(true);
    } else if (collapseWhenInactive) {
      setIsOpen(false);
    }
  }, [collapseWhenInactive, isStreaming, setIsOpen]);

  const contextValue = useMemo(
    () => ({ isOpen: !!isOpen, setIsOpen, isStreaming, isActive }),
    [isOpen, setIsOpen, isStreaming, isActive],
  );

  return (
    <ReasoningContext.Provider value={contextValue}>
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className={cn("not-prose w-full min-w-0 max-w-full", className)}
        {...props}
      >
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
}

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isActive: boolean) => ReactNode;
};

const defaultGetThinkingMessage = (isActive: boolean): ReactNode =>
  isActive ? "Thinking..." : "Reasoning";

export function ReasoningTrigger({
  className,
  getThinkingMessage = defaultGetThinkingMessage,
  ...props
}: ReasoningTriggerProps) {
  const { isOpen, isActive } = useReasoning();
  const ChevronIcon = isOpen ? ChevronDownIcon : ChevronRightIcon;
  const thinkingMessage = getThinkingMessage(isActive);

  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full max-w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
        className,
      )}
      {...props}
    >
      <BrainIcon className="size-4 shrink-0" />
      {isActive && typeof thinkingMessage === "string" ? (
        <Shimmer
          as="span"
          className="min-w-0 truncate text-left text-sm leading-5"
        >
          {thinkingMessage}
        </Shimmer>
      ) : (
        <span className="min-w-0 truncate text-left">{thinkingMessage}</span>
      )}
      <ChevronIcon
        className="size-4 shrink-0 opacity-100 transition-opacity desktop:opacity-0 desktop:group-hover:opacity-100 desktop:group-focus-visible:opacity-100 touch-device:!opacity-100"
        data-testid="reasoning-chevron"
      />
    </CollapsibleTrigger>
  );
}

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent>;

export function ReasoningContent({
  className,
  children,
  ...props
}: ReasoningContentProps) {
  const { isActive } = useReasoning();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [children, isActive]);

  return (
    <CollapsibleContent
      ref={contentRef}
      className={cn(
        "mt-2 space-y-3 text-muted-foreground max-h-60 min-w-0 max-w-full overflow-x-hidden overflow-y-auto break-words",
        "[overflow-wrap:anywhere]",
        "[&_pre]:max-w-full [&_pre]:overflow-x-auto",
        "data-[state=closed]:animate-out data-[state=open]:animate-in",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2",
        className,
      )}
      {...props}
    >
      {children}
    </CollapsibleContent>
  );
}

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
