"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import {
  ArrowLeft,
  Ban,
  Bot,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import type { UIMessage } from "ai";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type {
  ChatMessage,
  ChatStatus,
  SidebarSubagentOrigin,
  SidebarSubagents,
} from "@/types/chat";
import { ToolSidebarOriginProvider } from "@/app/contexts/ToolSidebarOriginContext";
import { AgentActivityRow } from "./AgentActivityRow";
import { AgentToolGroupRow } from "./AgentToolGroupRow";
import { FeedbackInput } from "./FeedbackInput";
import { MessageActions } from "./MessageActions";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { SubagentSkillBadges } from "./SubagentSkillBadges";
import { useSubagentRealtime } from "@/app/hooks/useSubagentRealtime";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  SUBAGENT_ACTIVE_STATUSES,
  type SubagentProfile,
  type SubagentStatus,
} from "@/lib/ai/subagents/contracts";
import { toSubagentHandle } from "@/lib/ai/subagents/agent-handle";
import { extractMessageText } from "@/lib/utils/message-utils";
import {
  projectAgentWorkParts,
  projectAgentWorkTimelineItems,
} from "./worked-for-parts";

type ChildSummary = {
  subagent_id: string;
  parent_message_id: string;
  parent_trigger_run_id: string;
  parent_tool_call_id: string;
  trigger_run_id?: string;
  profile: SubagentProfile;
  status: SubagentStatus;
  name?: string;
  objective?: string;
  skills?: string[];
  title?: string;
  subtitle?: string;
  candidate?: { title: string; affected_asset: string };
  summary?: string;
  verdict?: "confirmed" | "rejected" | "inconclusive";
  confidence?: "low" | "medium" | "high";
  failure_code?: string;
  failure_reason?: string;
  cancel_reason?: string;
  cost_dollars?: number;
  step_count?: number;
  created_at: number;
  started_at?: number;
  completed_at?: number;
};

type TranscriptMessage = UIMessage & {
  persistedMessageId?: Id<"subagent_messages">;
  feedbackType?: "positive" | "negative";
  createdAt?: number;
  messageSource?: "parent_update";
  messageType?: "query" | "instruction" | "information";
  priority?: "low" | "normal" | "high" | "urgent";
};

const ignoreToolGroupMount = () => undefined;

const isActive = (status: SubagentStatus) =>
  SUBAGENT_ACTIVE_STATUSES.has(status);

const formatElapsed = (start: number, end: number): string => {
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
};

const statusLabel = (child: ChildSummary): string =>
  ({
    queued: "Queued",
    running: "Working",
    finalizing: "Finishing",
    completed: "Done",
    failed: "Failed",
    canceled: "Canceled",
    timed_out: "Timed out",
  })[child.status];

const outcomeLabel = (child: ChildSummary): string | null =>
  child.verdict
    ? child.verdict.charAt(0).toUpperCase() + child.verdict.slice(1)
    : null;

const childRowStatusLabel = (child: ChildSummary): string =>
  outcomeLabel(child) ?? statusLabel(child);

const childTitle = (child: ChildSummary): string =>
  child.name ?? child.title ?? child.candidate?.title ?? "Subagent";

const childSubtitle = (child: ChildSummary): string | undefined =>
  child.subtitle ?? child.candidate?.affected_asset;

const cancellationDescription = (child: ChildSummary): string | undefined => {
  switch (child.cancel_reason) {
    case "parent_requested":
      return "Canceled by the parent agent.";
    case "user_canceled_child":
      return "Canceled by you.";
    case "parent_run_ended":
    case "agent-run-ended":
      return "Canceled when the parent Agent run ended.";
    case "parent_canceled":
      return "Canceled when the parent Agent run was canceled.";
    case "parent_run_failed":
      return "Canceled when the parent Agent run failed.";
    case "chat_deleted":
      return "Canceled because the chat was deleted.";
    case "all_chats_deleted":
      return "Canceled because all chats were deleted.";
    case "account_deleted":
      return "Canceled during account deletion.";
    default:
      return child.status === "canceled" ? "Subagent was canceled." : undefined;
  }
};

const childDescription = (child: ChildSummary): string =>
  child.summary ??
  (child.status === "canceled"
    ? cancellationDescription(child)
    : child.failure_reason) ??
  childSubtitle(child) ??
  child.objective ??
  "No task summary yet";

const StatusIcon = ({ child }: { child: ChildSummary }) => {
  if (isActive(child.status)) {
    return (
      <LoaderCircle
        className="h-5 w-5 animate-spin text-foreground motion-reduce:animate-none"
        aria-hidden
      />
    );
  }
  if (child.status === "completed") {
    return <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden />;
  }
  if (child.status === "canceled") {
    return <Ban className="h-5 w-5 text-muted-foreground" aria-hidden />;
  }
  return <CircleAlert className="h-5 w-5 text-destructive" aria-hidden />;
};

const ChildRow = ({
  child,
  now,
  onOpen,
}: {
  child: ChildSummary;
  now: number;
  onOpen: () => void;
}) => (
  <button
    type="button"
    onClick={onOpen}
    className="flex w-full items-center gap-3 rounded-lg px-1 py-3 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    aria-label={`Open ${childTitle(child)}, ${childRowStatusLabel(child)}`}
  >
    <div className="flex h-9 w-9 shrink-0 items-center justify-center">
      <StatusIcon child={child} />
    </div>
    <div className="min-w-0 flex-1">
      <div
        className="truncate text-[15px] font-medium text-foreground"
        title={childTitle(child)}
      >
        {childTitle(child)}
      </div>
      <p
        className="mt-1 truncate text-sm text-muted-foreground"
        title={childDescription(child)}
      >
        {childDescription(child)}
      </p>
    </div>
    <div className="ml-2 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
      <div>{childRowStatusLabel(child)}</div>
      <div className="mt-1">
        {formatElapsed(
          child.started_at ?? child.created_at,
          child.completed_at ?? now,
        )}
      </div>
    </div>
  </button>
);

const feedbackErrorMessage = (error: unknown): string => {
  if (error instanceof ConvexError) {
    return (
      (error.data as { message?: string })?.message ??
      error.message ??
      "Failed to save feedback"
    );
  }
  return error instanceof Error
    ? error.message
    : "Failed to save feedback. Please try again.";
};

const COMPLETION_ANNOUNCEMENT_PATTERN =
  /^(?:the )?(?:validation|task|work) is (?:complete|completed|finished)\.(?:\s+(?:the )?(?:finding|result|task) is (?:confirmed|rejected|inconclusive|complete|completed)(?: with (?:low|medium|high) confidence)?\.)?$/i;

const normalizeCompletionAnnouncement = (value: string): string =>
  value.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

const getVisibleAssistantParts = (
  parts: UIMessage["parts"],
  completed: boolean,
): UIMessage["parts"] => {
  if (!completed) return parts;

  const visibleParts: UIMessage["parts"] = [];
  parts.forEach((part, index) => {
    if (part.type !== "text") {
      visibleParts.push(part);
      return;
    }

    const paragraphs = part.text.trim().split(/\n\s*\n/);
    if (
      paragraphs.length === 0 ||
      !COMPLETION_ANNOUNCEMENT_PATTERN.test(
        normalizeCompletionAnnouncement(paragraphs[0] ?? ""),
      )
    ) {
      visibleParts.push(part);
      return;
    }

    const remainingText = paragraphs.slice(1).join("\n\n").trim();
    if (remainingText) {
      visibleParts.push({ ...part, text: remainingText });
      return;
    }

    const hasLaterText = parts
      .slice(index + 1)
      .some((candidate) => candidate.type === "text" && candidate.text.trim());
    if (!hasLaterText) visibleParts.push(part);
  });
  return visibleParts;
};

const hasRenderableTranscriptParts = (parts: UIMessage["parts"]): boolean =>
  parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return part.text.trim().length > 0;
    }
    return part.type === "data-summarization" || part.type.startsWith("tool-");
  });

const emptyActivityDescription = (child: ChildSummary): string => {
  switch (child.status) {
    case "canceled":
      return "Canceled before any activity was recorded.";
    case "completed":
      return "Finished without recorded activity.";
    case "failed":
      return "Stopped before any activity was recorded.";
    case "timed_out":
      return "Timed out before any activity was recorded.";
    default:
      return "Waiting for activity…";
  }
};

const SubagentMessageActions = memo(function SubagentMessageActions({
  messageId,
  messageText,
  createdAt,
  existingFeedback,
  isHovered,
}: {
  messageId: Id<"subagent_messages">;
  messageText: string;
  createdAt?: number;
  existingFeedback?: "positive" | "negative";
  isHovered: boolean;
}) {
  const saveFeedback = useMutation(api.subagents.setMessageFeedback);
  const [feedback, setFeedback] = useState<"positive" | "negative" | null>(
    existingFeedback ?? null,
  );
  const [isAwaitingDetails, setIsAwaitingDetails] = useState(false);
  const saveInFlight = useRef(false);

  const handleFeedback = async (type: "positive" | "negative") => {
    if (saveInFlight.current) return;
    if (type === "positive" && feedback === "positive") return;
    if (type === "negative" && feedback === "negative") {
      setIsAwaitingDetails(true);
      return;
    }

    saveInFlight.current = true;
    try {
      const result = await saveFeedback({
        messageId,
        feedbackType: type,
      });
      if (result === "not_found") {
        toast.error("That subagent message is no longer available.");
        return;
      }
      setFeedback(type);
      if (type === "positive") {
        setIsAwaitingDetails(false);
        toast.success("Thank you for your feedback!");
      } else {
        setIsAwaitingDetails(true);
      }
    } catch (error) {
      console.error("Failed to save subagent feedback:", error);
      toast.error(feedbackErrorMessage(error));
    } finally {
      saveInFlight.current = false;
    }
  };

  const handleFeedbackSubmit = async (details: string) => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    try {
      const result = await saveFeedback({
        messageId,
        feedbackType: "negative",
        feedbackDetails: details,
      });
      if (result === "not_found") {
        toast.error("That subagent message is no longer available.");
        return;
      }
      setFeedback("negative");
      setIsAwaitingDetails(false);
      toast.success("Thank you for your feedback!");
    } catch (error) {
      console.error("Failed to save subagent feedback details:", error);
      toast.error(feedbackErrorMessage(error));
    } finally {
      saveInFlight.current = false;
    }
  };

  return (
    <div className="mt-2">
      <MessageActions
        messageText={messageText}
        isUser={false}
        isLastAssistantMessage
        canRegenerate={false}
        onRegenerate={() => undefined}
        onEdit={() => undefined}
        canEdit={false}
        isHovered={isHovered}
        isEditing={false}
        messageCreatedAt={createdAt}
        status="ready"
        onFeedback={(type) => void handleFeedback(type)}
        existingFeedback={feedback}
        isAwaitingFeedbackDetails={isAwaitingDetails}
      />
      {isAwaitingDetails && (
        <FeedbackInput
          onSend={handleFeedbackSubmit}
          onCancel={() => setIsAwaitingDetails(false)}
        />
      )}
    </div>
  );
});

const SubagentTranscriptParts = memo(function SubagentTranscriptParts({
  active,
  isLastMessage,
  message,
  parts,
}: {
  active: boolean;
  isLastMessage: boolean;
  message: TranscriptMessage;
  parts: UIMessage["parts"];
}) {
  const visibleMessage = useMemo(
    () => ({ ...message, parts }) as ChatMessage,
    [message, parts],
  );
  const partIndexes = useMemo(() => parts.map((_, index) => index), [parts]);
  const projection = useMemo(
    () => projectAgentWorkParts(visibleMessage.parts, partIndexes),
    [partIndexes, visibleMessage.parts],
  );
  const timelineItems = useMemo(
    () =>
      projectAgentWorkTimelineItems({
        activities: projection.activities,
        messageSettled: !active || !isLastMessage,
        parts: visibleMessage.parts,
        workPartIndexes: partIndexes,
      }),
    [
      active,
      isLastMessage,
      partIndexes,
      projection.activities,
      visibleMessage.parts,
    ],
  );
  const status: ChatStatus = active && isLastMessage ? "streaming" : "ready";

  return timelineItems.map((item) => {
    if (item.kind === "tool-group") {
      return (
        <AgentToolGroupRow
          key={item.id}
          activities={item.activities}
          animateOnMount={false}
          groupId={`${message.id}:${item.id}`}
          isLastMessage={isLastMessage}
          message={visibleMessage}
          onMount={ignoreToolGroupMount}
          status={status}
          summary={item.summary}
          terminalChunksByToolCallId={projection.terminalChunksByToolCallId}
        />
      );
    }

    return (
      <AgentActivityRow
        key={item.id}
        deferReasoningCollapseUntilParent={false}
        isLastMessage={isLastMessage}
        keepLatestReasoningOpenDuringStreaming
        suppressReasoningAutoOpen={false}
        message={visibleMessage}
        part={item.part}
        partIndex={item.partIndex}
        status={status}
        terminalChunksByToolCallId={projection.terminalChunksByToolCallId}
      />
    );
  });
});

const Transcript = memo(function Transcript({
  child,
  sidebarContent,
}: {
  child: ChildSummary;
  sidebarContent: SidebarSubagents;
}) {
  const transcriptOpenedAt = useRef(0);
  const resolvedTelemetrySent = useRef(false);
  const failureTelemetryCategories = useRef(new Set<string>());
  const persisted = useQuery(api.subagents.getMessagesOwned, {
    subagentId: child.subagent_id,
  });
  const active = isActive(child.status);
  const hasPersistedAssistant = persisted?.some(
    (message) => message.role === "assistant",
  );
  const shouldReplayTerminalStream =
    child.status !== "canceled" &&
    persisted !== undefined &&
    !hasPersistedAssistant;
  const {
    message: liveMessage,
    state,
    retry,
  } = useSubagentRealtime({
    subagentId: child.subagent_id,
    enabled: !!child.trigger_run_id && (active || shouldReplayTerminalStream),
  });

  const messages = useMemo(() => {
    const saved = (persisted ?? []).map((message): TranscriptMessage => ({
      id: `${child.subagent_id}-${message.sequence}`,
      role: message.role,
      parts: message.parts as UIMessage["parts"],
      persistedMessageId: message.message_id,
      feedbackType: message.feedback_type,
      createdAt: message.created_at,
      messageSource: message.message_source,
      messageType: message.message_type,
      priority: message.priority,
    }));
    return liveMessage && !hasPersistedAssistant
      ? [...saved, liveMessage as TranscriptMessage]
      : saved;
  }, [child.subagent_id, hasPersistedAssistant, liveMessage, persisted]);
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          hasRenderableTranscriptParts(message.parts) &&
          (message.role === "assistant" ||
            (message.role === "user" &&
              message.messageSource === "parent_update")),
      ),
    [messages],
  );
  const toolSidebarOrigin = useMemo<SidebarSubagentOrigin>(
    () => ({
      kind: "subagent",
      subagentId: child.subagent_id,
      returnContent: {
        ...sidebarContent,
        selectedSubagentId: child.subagent_id,
      },
    }),
    [child.subagent_id, sidebarContent],
  );
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);

  useEffect(() => {
    transcriptOpenedAt.current = Date.now();
    resolvedTelemetrySent.current = false;
    failureTelemetryCategories.current.clear();
  }, [child.subagent_id]);

  useEffect(() => {
    if (persisted !== undefined) return;
    const timeout = window.setTimeout(() => {
      if (failureTelemetryCategories.current.has("persisted_load_timeout")) {
        return;
      }
      failureTelemetryCategories.current.add("persisted_load_timeout");
      captureAuthenticatedEvent("subagent_transcript_failed", {
        subagent_id: child.subagent_id,
        parent_trigger_run_id: child.parent_trigger_run_id,
        profile: child.profile,
        status: child.status,
        error_category: "persisted_load_timeout",
        active,
        load_latency_ms: Date.now() - transcriptOpenedAt.current,
      });
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [
    active,
    child.parent_trigger_run_id,
    child.profile,
    child.status,
    child.subagent_id,
    persisted,
  ]);

  useEffect(() => {
    if (state !== "error") return;
    const errorCategory = "realtime_disconnected";
    if (failureTelemetryCategories.current.has(errorCategory)) return;
    failureTelemetryCategories.current.add(errorCategory);
    captureAuthenticatedEvent("subagent_transcript_failed", {
      subagent_id: child.subagent_id,
      parent_trigger_run_id: child.parent_trigger_run_id,
      profile: child.profile,
      status: child.status,
      error_category: errorCategory,
      active,
      has_persisted_activity: visibleMessages.length > 0,
      activity_message_count: visibleMessages.length,
      load_latency_ms: Date.now() - transcriptOpenedAt.current,
    });
  }, [
    active,
    child.parent_trigger_run_id,
    child.profile,
    child.status,
    child.subagent_id,
    state,
    visibleMessages.length,
  ]);

  useEffect(() => {
    if (persisted === undefined || resolvedTelemetrySent.current) return;
    const hasActivity = visibleMessages.length > 0;
    const source = hasActivity
      ? hasPersistedAssistant
        ? "persisted"
        : liveMessage
          ? "live"
          : "persisted"
      : state === "error"
        ? "error_fallback"
        : active
          ? state === "live" || state === "complete"
            ? "live_empty"
            : null
          : "empty_terminal";
    if (!source) return;

    const reportResolved = () => {
      if (resolvedTelemetrySent.current) return;
      resolvedTelemetrySent.current = true;
      captureAuthenticatedEvent("subagent_transcript_resolved", {
        subagent_id: child.subagent_id,
        parent_trigger_run_id: child.parent_trigger_run_id,
        profile: child.profile,
        status: child.status,
        source,
        active,
        has_activity: hasActivity,
        activity_message_count: visibleMessages.length,
        realtime_state: state,
        load_latency_ms: Date.now() - transcriptOpenedAt.current,
      });
    };

    if (source === "empty_terminal") {
      const timeout = window.setTimeout(reportResolved, 1_500);
      return () => window.clearTimeout(timeout);
    }
    reportResolved();
  }, [
    active,
    child.parent_trigger_run_id,
    child.profile,
    child.status,
    child.subagent_id,
    hasPersistedAssistant,
    liveMessage,
    persisted,
    state,
    visibleMessages.length,
  ]);

  if (persisted === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading transcript…
      </div>
    );
  }

  return (
    <ToolSidebarOriginProvider origin={toolSidebarOrigin}>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
        aria-live={active ? "polite" : "off"}
        aria-label="Subagent transcript and tool activity"
      >
        <div className="space-y-5">
          <section className="min-w-0">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Task
            </div>
            <div className="break-words text-sm text-foreground">
              <MemoizedMarkdown
                content={child.objective ?? childTitle(child)}
              />
            </div>
          </section>
          <SubagentSkillBadges skills={child.skills} />
          {visibleMessages.length === 0 && state !== "error" && (
            <section className="min-w-0">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Activity
              </div>
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                {(active || state === "connecting") && (
                  <LoaderCircle
                    className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                )}
                {state === "connecting"
                  ? "Connecting to activity…"
                  : emptyActivityDescription(child)}
              </p>
            </section>
          )}
          {state === "error" && active && (
            <section className="min-w-0 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p className="text-destructive">Live activity disconnected.</p>
              <button
                type="button"
                onClick={retry}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Reconnect
              </button>
            </section>
          )}
          {state === "error" && !active && visibleMessages.length === 0 && (
            <section className="min-w-0">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Activity
              </div>
              <p className="text-sm text-muted-foreground">
                Activity is unavailable. The final status above is still
                authoritative.
              </p>
            </section>
          )}
          {visibleMessages.map((message) => {
            const isParentUpdate = message.messageSource === "parent_update";
            const visibleParts = isParentUpdate
              ? message.parts
              : getVisibleAssistantParts(
                  message.parts,
                  child.status === "completed",
                );
            const messageText = extractMessageText(visibleParts);
            const isLastMessage =
              message === visibleMessages[visibleMessages.length - 1];
            return (
              <section
                key={message.id}
                className="min-w-0"
                onMouseEnter={() => setHoveredMessageId(message.id)}
                onMouseLeave={() =>
                  setHoveredMessageId((current) =>
                    current === message.id ? null : current,
                  )
                }
              >
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {isParentUpdate
                    ? `Parent update${message.priority && message.priority !== "normal" ? ` · ${message.priority}` : ""}`
                    : "Subagent"}
                </div>
                <div className="min-w-0 space-y-2 overflow-hidden text-sm text-foreground">
                  <SubagentTranscriptParts
                    active={active}
                    isLastMessage={isLastMessage}
                    message={message}
                    parts={visibleParts}
                  />
                </div>
                {!isParentUpdate &&
                  message.persistedMessageId &&
                  messageText.trim().length > 0 && (
                    <SubagentMessageActions
                      messageId={message.persistedMessageId}
                      messageText={messageText}
                      createdAt={message.createdAt}
                      existingFeedback={message.feedbackType}
                      isHovered={hoveredMessageId === message.id}
                    />
                  )}
              </section>
            );
          })}
        </div>
      </div>
    </ToolSidebarOriginProvider>
  );
});

export const SubagentsSidebar = ({
  content,
  closeSidebar,
}: {
  content: SidebarSubagents;
  closeSidebar: () => void;
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(
    content.selectedSubagentId ?? null,
  );
  const [resolvedParentMessageId, setResolvedParentMessageId] = useState(
    content.parentMessageId,
  );
  const selectedById = useQuery(
    api.subagents.getOwned,
    selectedId ? { subagentId: selectedId } : "skip",
  ) as ChildSummary | null | undefined;
  const persistedSelected = selectedId ? selectedById : null;
  const effectiveParentMessageId =
    persistedSelected?.parent_message_id ?? resolvedParentMessageId;
  const selectedOriginResolved = !selectedId || selectedById !== undefined;
  const runs = useQuery(api.subagents.listForParentMessage, {
    parentMessageId: effectiveParentMessageId,
  }) as ChildSummary[] | undefined;
  const [now, setNow] = useState(() => Date.now());
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const openedChildren = useRef(new Set<string>());
  const selectedForCleanup = useRef<ChildSummary | null>(null);
  const selectedOpenedAt = useRef<{ id: string; at: number } | null>(null);

  useEffect(() => {
    if (selectedById?.parent_message_id) {
      setResolvedParentMessageId(selectedById.parent_message_id);
    }
  }, [selectedById?.parent_message_id]);

  const selectedFromRuns = useMemo(() => {
    if (!runs || !selectedId) return null;
    const exact = runs.find((child) => child.subagent_id === selectedId);
    if (exact) return exact;
    const handleMatches = runs.filter(
      (child) => toSubagentHandle(child.subagent_id) === selectedId,
    );
    return handleMatches.length === 1 ? handleMatches[0] : null;
  }, [runs, selectedId]);
  const selected = selectedFromRuns ?? persistedSelected ?? null;
  const active = runs?.filter((child) => isActive(child.status)) ?? [];
  const done = runs?.filter((child) => !isActive(child.status)) ?? [];

  useEffect(() => {
    selectedForCleanup.current = selected;
  }, [selected]);

  useEffect(() => {
    if (!selectedOriginResolved) return;
    captureAuthenticatedEvent("subagent_sidebar_opened", {
      parent_message_id: effectiveParentMessageId,
      view: "list",
    });
  }, [effectiveParentMessageId, selectedOriginResolved]);

  useEffect(() => {
    return () => {
      const child = selectedForCleanup.current;
      if (child && isActive(child.status)) {
        const openedAt = selectedOpenedAt.current;
        captureAuthenticatedEvent("subagent_abandoned", {
          subagent_id: child.subagent_id,
          parent_trigger_run_id: child.parent_trigger_run_id,
          profile: child.profile,
          status: child.status,
          open_duration_ms:
            Date.now() -
            (openedAt?.id === child.subagent_id
              ? openedAt.at
              : child.created_at),
        });
      }
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    if (selectedOpenedAt.current?.id !== selected.subagent_id) {
      selectedOpenedAt.current = { id: selected.subagent_id, at: Date.now() };
    }
    if (openedChildren.current.has(selected.subagent_id)) return;
    openedChildren.current.add(selected.subagent_id);
    captureAuthenticatedEvent("subagent_opened", {
      subagent_id: selected.subagent_id,
      parent_trigger_run_id: selected.parent_trigger_run_id,
      profile: selected.profile,
      status: selected.status,
      open_latency_ms: Date.now() - selected.created_at,
    });
  }, [selected]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selectedId) {
        if (selected?.parent_message_id) {
          setResolvedParentMessageId(selected.parent_message_id);
        }
        setSelectedId(null);
      } else {
        closeSidebar();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeSidebar, selected, selectedId]);

  useEffect(() => {
    if (!runs?.some((child) => isActive(child.status))) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [runs]);

  const cancelSelected = async () => {
    if (!selected || !isActive(selected.status)) return;
    setCanceling(true);
    setCancelError(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(
        `/api/subagents/${encodeURIComponent(selected.subagent_id)}/cancel`,
        { method: "POST", signal: controller.signal },
      );
      if (!response.ok) throw new Error("Cancel failed");
    } catch {
      setCancelError("Could not cancel this subagent. Try again.");
    } finally {
      window.clearTimeout(timeout);
      setCanceling(false);
    }
  };

  return (
    <aside
      className="fixed left-0 top-0 z-50 h-full w-full shrink-0 desktop:relative desktop:left-auto desktop:top-auto desktop:mr-4 desktop:h-full"
      aria-label="Subagents"
    >
      <div className="h-full w-full">
        <div className="flex h-full w-full rounded-[22px] border border-border/20 bg-background shadow-[0px_0px_8px_0px_rgba(0,0,0,0.02)] dark:border-border">
          <div className="flex h-full min-w-0 flex-1 flex-col p-4">
            <header className="flex items-center gap-2 border-b border-border/30 pb-3">
              {selected && (
                <button
                  type="button"
                  onClick={() => {
                    if (selected.parent_message_id) {
                      setResolvedParentMessageId(selected.parent_message_id);
                    }
                    setSelectedId(null);
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Back to subagent list"
                >
                  <ArrowLeft className="h-5 w-5" aria-hidden />
                </button>
              )}
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {!selected && (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                    <Bot className="h-5 w-5" aria-hidden />
                  </div>
                )}
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">
                    {selected ? childTitle(selected) : "Subagents"}
                  </h2>
                  {(selected ? childSubtitle(selected) : "Delegated tasks") && (
                    <p className="truncate text-xs text-muted-foreground">
                      {selected ? childSubtitle(selected) : "Delegated tasks"}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={closeSidebar}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Minimize subagents sidebar"
              >
                <Minimize2 className="h-5 w-5" aria-hidden />
              </button>
            </header>

            {!selected ? (
              <div
                className="mt-5 min-h-0 flex-1 overflow-y-auto"
                aria-live="polite"
              >
                {runs === undefined ? (
                  <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                    Loading subagents…
                  </div>
                ) : (
                  <div className="space-y-9">
                    <section aria-labelledby="active-subagents-heading">
                      <h3
                        id="active-subagents-heading"
                        aria-label={`Active · ${active.length}`}
                        className="text-sm font-medium text-muted-foreground"
                      >
                        Active <span aria-hidden>·</span>{" "}
                        <span className="tabular-nums">{active.length}</span>
                      </h3>
                      <div className="mt-4 space-y-1">
                        {active.length > 0 ? (
                          active.map((child) => (
                            <ChildRow
                              key={child.subagent_id}
                              child={child}
                              now={now}
                              onOpen={() => setSelectedId(child.subagent_id)}
                            />
                          ))
                        ) : (
                          <p className="px-1 text-sm text-muted-foreground">
                            No active subagents
                          </p>
                        )}
                      </div>
                    </section>
                    <section aria-labelledby="done-subagents-heading">
                      <h3
                        id="done-subagents-heading"
                        aria-label={`Done · ${done.length}`}
                        className="text-sm font-medium text-muted-foreground"
                      >
                        Done <span aria-hidden>·</span>{" "}
                        <span className="tabular-nums">{done.length}</span>
                      </h3>
                      <div className="mt-4 space-y-1">
                        {done.length > 0 ? (
                          done.map((child) => (
                            <ChildRow
                              key={child.subagent_id}
                              child={child}
                              now={now}
                              onOpen={() => setSelectedId(child.subagent_id)}
                            />
                          ))
                        ) : (
                          <p className="px-1 text-sm text-muted-foreground">
                            Completed subagents will appear here
                          </p>
                        )}
                      </div>
                    </section>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="border-b border-border/30 px-1 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      <StatusIcon child={selected} />
                      <span className="font-medium">
                        {statusLabel(selected)}
                      </span>
                      <span className="text-muted-foreground">·</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatElapsed(
                          selected.started_at ?? selected.created_at,
                          selected.completed_at ?? now,
                        )}
                      </span>
                      {outcomeLabel(selected) && (
                        <>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground">
                            {outcomeLabel(selected)}
                          </span>
                        </>
                      )}
                    </div>
                    {isActive(selected.status) && (
                      <button
                        type="button"
                        onClick={cancelSelected}
                        disabled={canceling}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Ban className="h-3.5 w-3.5" aria-hidden />
                        {canceling ? "Canceling…" : "Cancel"}
                      </button>
                    )}
                  </div>
                  {selected.status === "canceled" ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {cancellationDescription(selected)}
                    </p>
                  ) : selected.failure_reason ? (
                    <p className="mt-2 text-xs text-destructive">
                      {selected.failure_reason}
                    </p>
                  ) : null}
                  {cancelError && (
                    <p className="mt-2 text-xs text-destructive">
                      {cancelError}
                    </p>
                  )}
                </div>
                <Transcript child={selected} sidebarContent={content} />
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
};
