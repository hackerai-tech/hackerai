"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEventHandler,
  MouseEventHandler,
  PointerEventHandler,
  TouchEventHandler,
} from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Eye,
  FileDown,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Radar,
  Search,
  StickyNote,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useScrollPreservation } from "@/components/ai-elements/worked-for";
import type { ChatMessage, ChatStatus } from "@/types";
import type { FileDetails } from "@/types/file";
import { AgentActivityRow } from "./AgentActivityRow";
import {
  getCompletedToolSummaryIconCategory,
  toolPartHasKnownFailure,
  type AgentWorkActivity,
  type CompletedToolSummaryIconCategory,
} from "./worked-for-parts";

const AUTO_COLLAPSE_DELAY_MS = 500;

const SUMMARY_ICONS: Record<CompletedToolSummaryIconCategory, LucideIcon> = {
  browse: Globe,
  command: Terminal,
  delete: Trash2,
  download: FileDown,
  edit: FilePen,
  mixed: Wrench,
  notes: StickyNote,
  proxy: Radar,
  read: FileText,
  request: Globe,
  search: Search,
  tasks: ListTodo,
  tool: Wrench,
  view: Eye,
};

type AgentToolGroupRowProps = {
  activities: AgentWorkActivity[];
  animateOnMount: boolean;
  groupId: string;
  isLastMessage: boolean;
  message: ChatMessage;
  onMount: (groupId: string) => void;
  sharedFileDetails?: FileDetails[];
  status: ChatStatus;
  summary: string;
  terminalChunksByToolCallId: Map<string, readonly string[]>;
};

/** Renders a completed tool step as an expandable summary row. */
export const AgentToolGroupRow = memo(function AgentToolGroupRow({
  activities,
  animateOnMount,
  groupId,
  isLastMessage,
  message,
  onMount,
  sharedFileDetails,
  status,
  summary,
  terminalChunksByToolCallId,
}: AgentToolGroupRowProps) {
  const [open, setOpen] = useState(animateOnMount);
  const autoCollapseTimeoutRef = useRef<number | null>(null);
  const shouldAnimateMountRef = useRef(animateOnMount);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const summaryIcon = getCompletedToolSummaryIconCategory(activities);
  const hasFailure = activities.some(({ part }) =>
    toolPartHasKnownFailure(part),
  );
  const SummaryIcon = SUMMARY_ICONS[summaryIcon];
  const ChevronIcon = open ? ChevronDownIcon : ChevronRightIcon;
  const { captureScrollPosition, preserveScrollPosition } =
    useScrollPreservation();

  const clearAutoCollapseTimeout = useCallback(() => {
    if (autoCollapseTimeoutRef.current === null) return;

    window.clearTimeout(autoCollapseTimeoutRef.current);
    autoCollapseTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    onMount(groupId);
    if (!shouldAnimateMountRef.current) return;

    clearAutoCollapseTimeout();
    autoCollapseTimeoutRef.current = window.setTimeout(() => {
      autoCollapseTimeoutRef.current = null;
      captureScrollPosition(triggerRef.current);
      preserveScrollPosition(() => setOpen(false), false);
    }, AUTO_COLLAPSE_DELAY_MS);

    return clearAutoCollapseTimeout;
  }, [
    captureScrollPosition,
    clearAutoCollapseTimeout,
    groupId,
    onMount,
    preserveScrollPosition,
  ]);

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
      data-outcome={hasFailure ? "error" : "success"}
      data-testid="agent-tool-group-row"
    >
      <CollapsibleTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${summary}. ${hasFailure ? "Some tools failed. " : ""}${open ? "Hide" : "Show"} tool details`}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onTouchStart={handleTouchStart}
          className="group flex w-full max-w-full items-center gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <SummaryIcon
            className="size-4 shrink-0"
            aria-hidden="true"
            data-summary-icon={summaryIcon}
          />
          <span className="min-w-0 truncate">{summary}</span>
          <ChevronIcon
            className="size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 touch-device:!opacity-100"
            aria-hidden="true"
            data-testid="agent-tool-group-chevron"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="agent-tool-group-content worked-for-content mt-2 space-y-3">
        {activities.map((activity) => (
          <AgentActivityRow
            key={activity.id}
            deferReasoningCollapseUntilParent={false}
            isLastMessage={isLastMessage}
            keepLatestReasoningOpenDuringStreaming={false}
            suppressReasoningAutoOpen={false}
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
