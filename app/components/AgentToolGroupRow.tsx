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

/**
 * Time the settled run stays expanded before folding, so the final state of
 * the last tool registers before the summary takes over.
 */
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
  isLastMessage: boolean;
  message: ChatMessage;
  /** Restored streams fold settled runs immediately instead of after the delay. */
  restored?: boolean;
  /** True once every tool in the run is terminal and the step has closed. */
  settled: boolean;
  sharedFileDetails?: FileDetails[];
  status: ChatStatus;
  summary: string;
  terminalChunksByToolCallId: Map<string, readonly string[]>;
};

/**
 * Renders one run of consecutive tool calls as a single timeline row.
 *
 * The row exists from the first tool call: while the run is live every tool
 * renders expanded in place, and when the run settles the summary header
 * slides in and the details fold beneath it. Because the row and its child
 * activities keep their identity across that transition, the collapse is an
 * in-place animation rather than a virtualized row swap. Single-tool runs
 * never fold; the lone tool simply stays visible.
 */
export const AgentToolGroupRow = memo(function AgentToolGroupRow({
  activities,
  isLastMessage,
  message,
  restored = false,
  settled,
  sharedFileDetails,
  status,
  summary,
  terminalChunksByToolCallId,
}: AgentToolGroupRowProps) {
  const collapsible = settled && activities.length > 1;
  // Runs observed live stay expanded until they settle; runs that mount
  // already settled (history, reload, replay) start folded.
  const [open, setOpen] = useState(!settled);
  // Open animations only make sense after a fold. A live run must not replay
  // the grow-in animation for content that is already on screen.
  const [hasFolded, setHasFolded] = useState(collapsible);
  // Only a header that appears after a live run animates in; historical rows
  // render their header statically.
  const [headerEntering, setHeaderEntering] = useState(false);
  const [awaitingFold, setAwaitingFold] = useState(false);
  const [previousSettled, setPreviousSettled] = useState(settled);
  // A manual toggle opts the row out of auto-folding for good.
  const [userToggled, setUserToggled] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const summaryIcon = getCompletedToolSummaryIconCategory(activities);
  const hasFailure = activities.some(({ part }) =>
    toolPartHasKnownFailure(part),
  );
  const SummaryIcon = SUMMARY_ICONS[summaryIcon];
  const isOpen = collapsible ? open : true;
  const ChevronIcon = isOpen ? ChevronDownIcon : ChevronRightIcon;
  const { captureScrollPosition, preserveScrollPosition } =
    useScrollPreservation();

  // Adjust state for the live <-> settled transition during render so the
  // header and fold state land in the same commit as the settled details.
  if (settled !== previousSettled) {
    setPreviousSettled(settled);
    if (!settled) {
      // A run reopened (for example a tool re-entered a pending state); keep
      // its details visible until it settles again.
      setAwaitingFold(false);
      setOpen(true);
    } else {
      setHeaderEntering(true);
      const shouldAutoFold = collapsible && !userToggled;
      if (shouldAutoFold && restored) {
        // Replayed history is not being watched; skip the delay and the
        // scroll preservation that only a visible fold needs.
        setHasFolded(true);
        setOpen(false);
      } else if (shouldAutoFold) {
        setAwaitingFold(true);
      }
    }
  }

  const fold = useCallback(() => {
    captureScrollPosition(triggerRef.current);
    preserveScrollPosition(() => {
      setHasFolded(true);
      setOpen(false);
    }, false);
  }, [captureScrollPosition, preserveScrollPosition]);

  useEffect(() => {
    if (!awaitingFold) return;

    const timeout = window.setTimeout(() => {
      setAwaitingFold(false);
      fold();
    }, AUTO_COLLAPSE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [awaitingFold, fold]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setUserToggled(true);
      setAwaitingFold(false);
      preserveScrollPosition(() => {
        if (!nextOpen) setHasFolded(true);
        setOpen(nextOpen);
      }, nextOpen);
    },
    [preserveScrollPosition],
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
      open={isOpen}
      onOpenChange={collapsible ? handleOpenChange : undefined}
      className="w-full"
      data-outcome={hasFailure ? "error" : "success"}
      data-phase={settled ? "settled" : "live"}
      data-testid="agent-tool-group-row"
    >
      {collapsible ? (
        <CollapsibleTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`${summary}. ${hasFailure ? "Some tools failed. " : ""}${isOpen ? "Hide" : "Show"} tool details`}
            data-entering={headerEntering ? "true" : undefined}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            onPointerDown={handlePointerDown}
            onTouchStart={handleTouchStart}
            className="agent-tool-group-header group flex h-5 w-full max-w-full items-center gap-2 overflow-hidden text-left text-sm leading-5 text-muted-foreground transition-colors hover:text-foreground"
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
      ) : null}
      <CollapsibleContent
        className="agent-tool-group-content space-y-3"
        data-animate-open={hasFolded ? "true" : undefined}
      >
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
