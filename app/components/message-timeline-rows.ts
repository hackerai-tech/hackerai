import type { ChatMessage, ChatStatus } from "@/types";
import {
  projectAgentWorkParts,
  splitWorkedForParts,
  type AgentWorkActivity,
} from "./worked-for-parts";

type BaseTimelineRow = {
  id: string;
  message: ChatMessage;
  messageIndex: number;
};

export type MessageTimelineRow = BaseTimelineRow & {
  kind: "message";
  workPresentation: "inline" | "timeline-shell";
};

export type AgentWorkHeaderTimelineRow = BaseTimelineRow & {
  kind: "agent-work-header";
  canToggle: boolean;
  durationMs?: number;
  expanded: boolean;
  isTiming: boolean;
  startedAt?: number;
};

export type AgentActivityTimelineRow = BaseTimelineRow &
  AgentWorkActivity & {
    kind: "agent-activity";
    isLastMessage: boolean;
    keepLatestReasoningOpenDuringStreaming: boolean;
    deferReasoningCollapseUntilParent: boolean;
    terminalChunksByToolCallId: Map<string, readonly string[]>;
  };

export type ChatTimelineRow =
  MessageTimelineRow | AgentWorkHeaderTimelineRow | AgentActivityTimelineRow;

export type DeriveChatTimelineRowsOptions = {
  messages: readonly ChatMessage[];
  status: ChatStatus;
  lastAssistantMessageIndex: number | undefined;
  expandedAgentMessageIds: ReadonlySet<string>;
};

export function deriveChatTimelineRows({
  messages,
  status,
  lastAssistantMessageIndex,
  expandedAgentMessageIds,
}: DeriveChatTimelineRowsOptions): ChatTimelineRow[] {
  const rows: ChatTimelineRow[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    const isAgentAssistant =
      message.role === "assistant" && message.metadata?.mode === "agent";

    if (!isAgentAssistant) {
      rows.push({
        kind: "message",
        id: `message:${message.id}`,
        message,
        messageIndex,
        workPresentation: "inline",
      });
      continue;
    }

    const { trailingTextParts, workPartIndexes } = splitWorkedForParts(
      message.parts,
    );
    const projection = projectAgentWorkParts(message.parts, workPartIndexes);

    if (projection.activities.length === 0) {
      rows.push({
        kind: "message",
        id: `message:${message.id}`,
        message,
        messageIndex,
        workPresentation: "inline",
      });
      continue;
    }

    const isLastAssistantMessage =
      lastAssistantMessageIndex !== undefined &&
      messageIndex === lastAssistantMessageIndex;
    const isTiming = status === "streaming" && isLastAssistantMessage;
    const hasFinalAnswer = trailingTextParts.length > 0;
    const canToggle = !isTiming && hasFinalAnswer;
    const expanded =
      isTiming || !hasFinalAnswer || expandedAgentMessageIds.has(message.id);

    rows.push({
      kind: "agent-work-header",
      id: `work-header:${message.id}`,
      message,
      messageIndex,
      canToggle,
      durationMs:
        typeof message.metadata?.generationTimeMs === "number"
          ? message.metadata.generationTimeMs
          : undefined,
      expanded,
      isTiming,
      startedAt:
        typeof message.metadata?.generationStartedAt === "number"
          ? message.metadata.generationStartedAt
          : undefined,
    });

    if (expanded) {
      for (const activity of projection.activities) {
        rows.push({
          kind: "agent-activity",
          message,
          messageIndex,
          ...activity,
          id: `work:${message.id}:${activity.id}`,
          isLastMessage: messageIndex === messages.length - 1,
          keepLatestReasoningOpenDuringStreaming: true,
          deferReasoningCollapseUntilParent: hasFinalAnswer,
          terminalChunksByToolCallId: projection.terminalChunksByToolCallId,
        });
      }
    }

    rows.push({
      kind: "message",
      id: `message:${message.id}`,
      message,
      messageIndex,
      workPresentation: "timeline-shell",
    });
  }

  return rows;
}

export function getChatTimelineRowType(row: ChatTimelineRow) {
  if (row.kind === "message") {
    return `message:${row.message.role}`;
  }
  return row.kind;
}
