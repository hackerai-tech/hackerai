import type { ChatMessage, ChatStatus } from "@/types";
import {
  projectAgentWorkParts,
  projectAgentWorkTimelineItems,
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
    suppressReasoningAutoOpen: boolean;
    deferReasoningCollapseUntilParent: boolean;
    terminalChunksByToolCallId: Map<string, readonly string[]>;
  };

export type AgentToolGroupTimelineRow = BaseTimelineRow & {
  kind: "agent-tool-group";
  activities: AgentWorkActivity[];
  animateOnMount: boolean;
  isLastMessage: boolean;
  summary: string;
  terminalChunksByToolCallId: Map<string, readonly string[]>;
};

export type ChatTimelineRow =
  | MessageTimelineRow
  | AgentWorkHeaderTimelineRow
  | AgentActivityTimelineRow
  | AgentToolGroupTimelineRow;

export type StableChatTimelineRowsState = {
  byId: ReadonlyMap<string, ChatTimelineRow>;
  result: ChatTimelineRow[];
};

export type DeriveChatTimelineRowsOptions = {
  messages: readonly ChatMessage[];
  status: ChatStatus;
  lastAssistantMessageIndex: number | undefined;
  expandedAgentMessageIds: ReadonlySet<string>;
  animateNewToolGroups?: boolean;
  seenAgentMessageIds?: ReadonlySet<string>;
  seenToolGroupIds?: ReadonlySet<string>;
  restoredAgentMessageIds?: ReadonlySet<string>;
};

const EMPTY_TOOL_GROUP_IDS: ReadonlySet<string> = new Set();
const EMPTY_MESSAGE_IDS: ReadonlySet<string> = new Set();

export function findLatestTimelineAnchorMessageId(
  messages: readonly ChatMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && !message.metadata?.isAutoContinue) {
      return message.id;
    }
  }

  return null;
}

export function findMessageTimelineAnchorIndex(
  rows: readonly ChatTimelineRow[],
  messageId: string | null,
): number | undefined {
  if (!messageId) return undefined;

  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row?.kind === "message" && row.message.id === messageId) {
      return index;
    }
  }

  return undefined;
}

export function deriveChatTimelineRows({
  messages,
  status,
  lastAssistantMessageIndex,
  expandedAgentMessageIds,
  animateNewToolGroups = true,
  seenAgentMessageIds,
  seenToolGroupIds = EMPTY_TOOL_GROUP_IDS,
  restoredAgentMessageIds = EMPTY_MESSAGE_IDS,
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

    const { fileParts, trailingTextParts, workPartIndexes } =
      splitWorkedForParts(message.parts);
    const projection = projectAgentWorkParts(message.parts, workPartIndexes);
    const isPendingEmptyAgentMessage =
      messageIndex === lastAssistantMessageIndex &&
      (status === "submitted" || status === "streaming") &&
      fileParts.length === 0 &&
      projection.activities.length === 0 &&
      !trailingTextParts.some(
        (part) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.trim().length > 0,
      );

    // The loading indicator already represents this state in the fixed-height
    // timeline footer. Keeping an empty virtualized row here adds its own
    // spacing before any Trigger activity arrives, visibly moving the loader.
    if (isPendingEmptyAgentMessage) continue;

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
    const canAnimateNewToolGroups =
      animateNewToolGroups &&
      !restoredAgentMessageIds.has(message.id) &&
      (seenAgentMessageIds === undefined ||
        seenAgentMessageIds.has(message.id));
    const hasFinalAnswer = trailingTextParts.length > 0;
    const canToggle = !isTiming && hasFinalAnswer;
    const expanded =
      isTiming || !hasFinalAnswer || expandedAgentMessageIds.has(message.id);
    const timelineItems = projectAgentWorkTimelineItems({
      activities: projection.activities,
      messageSettled: !isTiming,
      parts: message.parts,
      workPartIndexes,
    });

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
      for (const item of timelineItems) {
        if (item.kind === "tool-group") {
          const rowId = `work:${message.id}:${item.id}`;
          rows.push({
            kind: "agent-tool-group",
            id: rowId,
            message,
            messageIndex,
            activities: item.activities,
            animateOnMount:
              isTiming &&
              canAnimateNewToolGroups &&
              !seenToolGroupIds.has(rowId),
            isLastMessage: messageIndex === messages.length - 1,
            summary: item.summary,
            terminalChunksByToolCallId: projection.terminalChunksByToolCallId,
          });
          continue;
        }

        const { kind: _kind, ...activity } = item;
        rows.push({
          kind: "agent-activity",
          message,
          messageIndex,
          ...activity,
          id: `work:${message.id}:${activity.id}`,
          isLastMessage: messageIndex === messages.length - 1,
          keepLatestReasoningOpenDuringStreaming: true,
          suppressReasoningAutoOpen: restoredAgentMessageIds.has(message.id),
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
      previous.suppressReasoningAutoOpen === next.suppressReasoningAutoOpen &&
      previous.deferReasoningCollapseUntilParent ===
        next.deferReasoningCollapseUntilParent
    );
  }

  if (
    previous.kind === "agent-tool-group" &&
    next.kind === "agent-tool-group"
  ) {
    return (
      previous.message === next.message &&
      previous.animateOnMount === next.animateOnMount &&
      previous.isLastMessage === next.isLastMessage &&
      previous.summary === next.summary &&
      previous.activities.length === next.activities.length &&
      previous.activities.every((activity, index) => {
        const nextActivity = next.activities[index];
        return (
          activity.id === nextActivity?.id &&
          activity.part === nextActivity.part &&
          activity.partIndex === nextActivity.partIndex
        );
      })
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
