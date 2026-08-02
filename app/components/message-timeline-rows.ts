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

export type StableChatTimelineRowsState = {
  byId: ReadonlyMap<string, ChatTimelineRow>;
  result: ChatTimelineRow[];
};

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

export function createStableChatTimelineRowsState(): StableChatTimelineRowsState {
  return { byId: new Map(), result: [] };
}

/**
 * Reuses row objects whose rendered inputs did not change. LegendList can then
 * skip settled rows while the active assistant message continues streaming.
 */
export function stabilizeChatTimelineRows(
  rows: ChatTimelineRow[],
  previous: StableChatTimelineRowsState,
): StableChatTimelineRowsState {
  const byId = new Map<string, ChatTimelineRow>();
  let anyChanged = rows.length !== previous.result.length;

  const result = rows.map((row, index) => {
    const previousRow = previous.byId.get(row.id);
    const stableRow =
      previousRow && isChatTimelineRowUnchanged(previousRow, row)
        ? previousRow
        : row;

    byId.set(row.id, stableRow);
    if (!anyChanged && previous.result[index] !== stableRow) {
      anyChanged = true;
    }
    return stableRow;
  });

  return anyChanged ? { byId, result } : previous;
}

function isChatTimelineRowUnchanged(
  previous: ChatTimelineRow,
  next: ChatTimelineRow,
): boolean {
  if (
    previous.kind !== next.kind ||
    previous.id !== next.id ||
    previous.messageIndex !== next.messageIndex
  ) {
    return false;
  }

  if (previous.kind === "message" && next.kind === "message") {
    return (
      previous.message === next.message &&
      previous.workPresentation === next.workPresentation
    );
  }

  if (
    previous.kind === "agent-work-header" &&
    next.kind === "agent-work-header"
  ) {
    return (
      previous.message === next.message &&
      previous.canToggle === next.canToggle &&
      previous.durationMs === next.durationMs &&
      previous.expanded === next.expanded &&
      previous.isTiming === next.isTiming &&
      previous.startedAt === next.startedAt
    );
  }

  if (previous.kind === "agent-activity" && next.kind === "agent-activity") {
    // terminalChunksByToolCallId is derived from message.parts. When the
    // immutable message reference is unchanged, the derived terminal data is
    // unchanged too even though the Map instance was rebuilt.
    return (
      previous.message === next.message &&
      previous.part === next.part &&
      previous.partIndex === next.partIndex &&
      previous.isLastMessage === next.isLastMessage &&
      previous.keepLatestReasoningOpenDuringStreaming ===
        next.keepLatestReasoningOpenDuringStreaming &&
      previous.deferReasoningCollapseUntilParent ===
        next.deferReasoningCollapseUntilParent
    );
  }

  return false;
}

export function getChatTimelineRowType(row: ChatTimelineRow) {
  if (row.kind === "message") {
    return `message:${row.message.role}`;
  }
  return row.kind;
}
