"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ComponentProps, ReactNode } from "react";

type ReasoningContextValue = {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  isStreaming: boolean;
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
};

export function Reasoning({
  className,
  isStreaming = false,
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
    setIsOpen(isStreaming);
  }, [isStreaming, setIsOpen]);

  const contextValue = useMemo(
    () => ({ isOpen: !!isOpen, setIsOpen, isStreaming }),
    [isOpen, setIsOpen, isStreaming],
  );

  return (
    <ReasoningContext.Provider value={contextValue}>
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className={cn("not-prose w-full space-y-2", className)}
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
  getThinkingMessage?: (isStreaming: boolean) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean): ReactNode =>
  isStreaming ? "Thinking..." : "Reasoning";

export function ReasoningTrigger({
  className,
  getThinkingMessage = defaultGetThinkingMessage,
  ...props
}: ReasoningTriggerProps) {
  const { isOpen, isStreaming } = useReasoning();

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
        className,
      )}
      {...props}
    >
      <BrainIcon className="size-4" />
      <span className="flex-1 text-left">
        {getThinkingMessage(isStreaming)}
      </span>
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
  );
}

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent>;

export function ReasoningContent({
  className,
  children,
  ...props
}: ReasoningContentProps) {
  const { isStreaming } = useReasoning();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [children, isStreaming]);

  return (
    <CollapsibleContent
      ref={contentRef}
      className={cn(
        "mt-2 space-y-3 text-muted-foreground max-h-60 overflow-y-auto",
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
