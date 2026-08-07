"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEventHandler,
  MouseEventHandler,
  PointerEventHandler,
  TouchEventHandler,
} from "react";
import { ChevronDownIcon, ChevronRightIcon, WrenchIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useScrollPreservation } from "@/components/ai-elements/worked-for";
import type { ChatMessage, ChatStatus } from "@/types";
import type { FileDetails } from "@/types/file";
import { AgentActivityRow } from "./AgentActivityRow";
import type { AgentWorkActivity } from "./worked-for-parts";

const AUTO_COLLAPSE_DELAY_MS = 500;

type AgentToolGroupRowProps = {
  activities: AgentWorkActivity[];
  animateOnMount: boolean;
  isLastMessage: boolean;
  message: ChatMessage;
  sharedFileDetails?: FileDetails[];
  status: ChatStatus;
  summary: string;
  terminalChunksByToolCallId: Map<string, readonly string[]>;
};

export const AgentToolGroupRow = memo(function AgentToolGroupRow({
  activities,
  animateOnMount,
  isLastMessage,
  message,
  sharedFileDetails,
  status,
  summary,
  terminalChunksByToolCallId,
}: AgentToolGroupRowProps) {
  const [open, setOpen] = useState(animateOnMount);
  const autoCollapseTimeoutRef = useRef<number | null>(null);
  const { captureScrollPosition, preserveScrollPosition } =
    useScrollPreservation();

  const clearAutoCollapseTimeout = useCallback(() => {
    if (autoCollapseTimeoutRef.current === null) return;

    window.clearTimeout(autoCollapseTimeoutRef.current);
    autoCollapseTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    if (!animateOnMount) return;

    clearAutoCollapseTimeout();
    autoCollapseTimeoutRef.current = window.setTimeout(() => {
      autoCollapseTimeoutRef.current = null;
      setOpen(false);
    }, AUTO_COLLAPSE_DELAY_MS);

    return clearAutoCollapseTimeout;
  }, [animateOnMount, clearAutoCollapseTimeout]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      clearAutoCollapseTimeout();
      preserveScrollPosition(() => setOpen(nextOpen), nextOpen);
    },
    [clearAutoCollapseTimeout, preserveScrollPosition],
  );
  const handlePointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (!event.defaultPrevented) captureScrollPosition(event.currentTarget);
  };
  const handleTouchStart: TouchEventHandler<HTMLButtonElement> = (event) => {
    if (!event.defaultPrevented) captureScrollPosition(event.currentTarget);
  };
  const handleKeyDown: KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (
      !event.defaultPrevented &&
      (event.key === "Enter" || event.key === " ")
    ) {
      captureScrollPosition(event.currentTarget);
    }
  };
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (!event.defaultPrevented) captureScrollPosition(event.currentTarget);
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className="w-full"
      data-testid="agent-tool-group-row"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label={`${summary}. ${open ? "Hide" : "Show"} tool details`}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onTouchStart={handleTouchStart}
          className="flex w-full items-center gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <WrenchIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{summary}</span>
          {open ? (
            <ChevronDownIcon className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRightIcon className="size-4 shrink-0" aria-hidden="true" />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="worked-for-content mt-2 space-y-3">
        {activities.map((activity) => (
          <AgentActivityRow
            key={activity.id}
            deferReasoningCollapseUntilParent={false}
            isLastMessage={isLastMessage}
            keepLatestReasoningOpenDuringStreaming={false}
            message={message}
            part={activity.part}
            partIndex={activity.partIndex}
            sharedFileDetails={sharedFileDetails}
            status={status}
            terminalChunksByToolCallId={terminalChunksByToolCallId}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
});
