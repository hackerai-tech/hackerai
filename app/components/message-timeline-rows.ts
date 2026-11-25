import type { ChatMessage, ChatStatus } from "@/types";
import { isAgentSteerPart } from "@/lib/chat/agent-steer";
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
  isLastMessage: boolean;
  /** Restored streams settle without the live collapse delay. */
  restored: boolean;
  settled: boolean;
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
  restoredAgentMessageIds?: ReadonlySet<string>;
};

const EMPTY_MESSAGE_IDS: ReadonlySet<string> = new Set();

type FileCardProjection = { keptKey: string; message: ChatMessage };

// Reusing the projected message while its source and kept files are unchanged
// keeps row identity stable, so settled rows are not re-rendered per derive.
const fileCardProjections = new WeakMap<ChatMessage, FileCardProjection>();

/**
 * Saved Agent checkpoints and the response that resumes them can both store
 * the same generated file. Shows each stored file ID once per user turn by
 * dropping repeats from later message cards. Stored messages are not changed.
 */
function projectGeneratedFileCards(
  message: ChatMessage,
  shownFileIds: Set<string>,
): ChatMessage {
  const fileDetails = message.fileDetails;
  if (!fileDetails || fileDetails.length === 0) return message;

  const keptIndexes: number[] = [];
  fileDetails.forEach((file, index) => {
    if (shownFileIds.has(file.fileId)) return;
    shownFileIds.add(file.fileId);
    keptIndexes.push(index);
  });
  if (keptIndexes.length === fileDetails.length) return message;

  const keptKey = keptIndexes.join(",");
  const cached = fileCardProjections.get(message);
  if (cached?.keptKey === keptKey) return cached.message;

  // An empty array is intentional: MessageItem treats a missing value as a
  // cue to use temporary file details, which could restore the duplicate.
  const projected: ChatMessage = {
    ...message,
    fileDetails: keptIndexes.map((index) => fileDetails[index]),
  };
  fileCardProjections.set(message, { keptKey, message: projected });
  return projected;
}

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

export function findActiveTimelineAnchorMessageId(
  messages: readonly ChatMessage[],
  status: ChatStatus,
): string | null {
  // Settled histories rely on initialScrollAtEnd. Retaining the turn anchor
  // lets delayed row measurements overwrite that completed-chat position.
  if (status !== "submitted" && status !== "streaming") {
    return null;
  }

  return findLatestTimelineAnchorMessageId(messages);
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
  restoredAgentMessageIds = EMPTY_MESSAGE_IDS,
}: DeriveChatTimelineRowsOptions): ChatTimelineRow[] {
  const rows: ChatTimelineRow[] = [];
  // Generated file IDs already shown since the latest explicit user turn.
  // Hidden auto-continue prompts belong to the same uninterrupted response.
  let shownFileIds = new Set<string>();

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    const isAgentAssistant =
      message.role === "assistant" && message.metadata?.mode === "agent";

    if (message.role === "user" && !message.metadata?.isAutoContinue) {
      shownFileIds = new Set();
    }

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

    // Only the message card renders generated file cards. Activity rows keep
    // the stored message so in-place tool file links still resolve.
    const cardMessage = projectGeneratedFileCards(message, shownFileIds);

    if (projection.activities.length === 0) {
      rows.push({
        kind: "message",
        id: `message:${message.id}`,
        message: cardMessage,
        messageIndex,
        workPresentation: "inline",
      });
      continue;
    }

    const isLastAssistantMessage =
      lastAssistantMessageIndex !== undefined &&
      messageIndex === lastAssistantMessageIndex;
    const isTiming = status === "streaming" && isLastAssistantMessage;
    const isRestored = restoredAgentMessageIds.has(message.id);
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

    // Steers are the user's own words, so they stay visible after a finished
    // run collapses its work, between Worked for and the answer.
    const visibleItems = expanded
      ? timelineItems
      : timelineItems.filter(
          (item) => item.kind === "activity" && isAgentSteerPart(item.part),
        );
    for (const item of visibleItems) {
      if (item.kind === "tool-group") {
        rows.push({
          kind: "agent-tool-group",
          id: `work:${message.id}:${item.id}`,
          message,
          messageIndex,
          activities: item.activities,
          isLastMessage: messageIndex === messages.length - 1,
          restored: isRestored,
          settled: item.settled,
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
        suppressReasoningAutoOpen: isRestored,
        deferReasoningCollapseUntilParent: hasFinalAnswer,
        terminalChunksByToolCallId: projection.terminalChunksByToolCallId,
      });
    }

    rows.push({
      kind: "message",
      id: `message:${message.id}`,
      message: cardMessage,
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
      previous.isLastMessage === next.isLastMessage &&
      previous.restored === next.restored &&
      previous.settled === next.settled &&
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
