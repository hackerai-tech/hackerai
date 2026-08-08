import type { ChatMessage } from "@/types";
import type { FilePart } from "@/types/file";

type MessagePart = ChatMessage["parts"][number];

const TRAILING_METADATA_PART_TYPES = new Set([
  "data-agent-heartbeat",
  "data-appendMessage",
  "data-auto-continue",
  "data-context-usage",
  "data-diff",
  "data-file-metadata",
  "data-rate-limit-warning",
  "data-sandbox-fallback",
  "data-title",
  "data-upload-status",
  "finish-step",
  "step-start",
]);

const EXPANDABLE_WORK_PART_TYPES = new Set(["data-terminal"]);

export type WorkedForParts = {
  fileParts: FilePart[];
  nonFileParts: MessagePart[];
  workParts: MessagePart[];
  workPartIndexes: number[];
  trailingTextParts: MessagePart[];
};

export type AgentWorkActivity = {
  id: string;
  part: MessagePart;
  partIndex: number;
  groupedParts?: AgentWorkActivityPart[];
};

export type AgentWorkActivityPart = {
  part: MessagePart;
  partIndex: number;
};

export type AgentWorkProjection = {
  activities: AgentWorkActivity[];
  hasExpandableWork: boolean;
  terminalChunksByToolCallId: Map<string, readonly string[]>;
};

const isTrailingMetadataPart = (part: MessagePart) => {
  const type = (part as { type?: string }).type;
  return !!type && TRAILING_METADATA_PART_TYPES.has(type);
};

export const isExpandableWorkedForPart = (part: MessagePart) => {
  const type = (part as { type?: string }).type;
  return (
    !!type && (type.startsWith("tool-") || EXPANDABLE_WORK_PART_TYPES.has(type))
  );
};

const shouldProjectWorkPart = (part: MessagePart) => {
  const type = (part as { type?: string }).type;
  return (
    type === "text" ||
    type === "reasoning" ||
    type === "data-summarization" ||
    Boolean(type?.startsWith("tool-"))
  );
};

const getToolCallId = (part: MessagePart) => {
  const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
  return typeof toolCallId === "string" && toolCallId.length > 0
    ? toolCallId
    : null;
};

const getSubagentLifecycleGroupKey = (part: MessagePart) => {
  const candidate = part as {
    type?: string;
    state?: string;
    output?: {
      success?: boolean;
      wait_outcome?: string;
      result?: { status?: string };
    };
  };

  if (
    candidate.state !== "output-available" ||
    candidate.output?.success !== true
  ) {
    return null;
  }

  if (candidate.type === "tool-create_agent") {
    return "subagent:started";
  }
  if (candidate.type === "tool-send_message_to_agent") {
    return "subagent:updated";
  }
  if (
    candidate.type === "tool-wait_for_agents" &&
    candidate.output.wait_outcome === "agent_finished"
  ) {
    return `subagent:finished:${candidate.output.result?.status ?? "completed"}`;
  }

  return null;
};

/**
 * Combines adjacent successful child lifecycle events into one visual row.
 * Each part remains independently clickable and keeps its original tool-call
 * identity; only the presentation row is shared.
 */
const groupAdjacentSubagentActivities = (
  activities: AgentWorkActivity[],
): AgentWorkActivity[] => {
  const grouped: AgentWorkActivity[] = [];

  for (let index = 0; index < activities.length;) {
    const first = activities[index];
    const groupKey = getSubagentLifecycleGroupKey(first.part);
    if (!groupKey) {
      grouped.push(first);
      index += 1;
      continue;
    }

    const groupedParts: AgentWorkActivityPart[] = [
      { part: first.part, partIndex: first.partIndex },
    ];
    let nextIndex = index + 1;
    while (
      nextIndex < activities.length &&
      getSubagentLifecycleGroupKey(activities[nextIndex].part) === groupKey
    ) {
      groupedParts.push({
        part: activities[nextIndex].part,
        partIndex: activities[nextIndex].partIndex,
      });
      nextIndex += 1;
    }

    grouped.push({ ...first, groupedParts });
    index = nextIndex;
  }

  return grouped;
};

/**
 * Builds the lightweight rows used by the Agent activity timeline.
 *
 * Terminal stream chunks remain available to their owning tool row without
 * becoming hundreds of independent UI rows. Repeated lifecycle snapshots for
 * the same tool call also keep one stable row and use the newest snapshot.
 */
export function projectAgentWorkParts(
  parts: ChatMessage["parts"],
  workPartIndexes: readonly number[],
): AgentWorkProjection {
  const activities: AgentWorkActivity[] = [];
  const activityIndexByToolCallId = new Map<string, number>();
  const terminalChunksByToolCallId = new Map<string, string[]>();
  let previousProjectedType: string | undefined;

  for (const partIndex of workPartIndexes) {
    const part = parts[partIndex];
    if (!part) continue;

    const type = (part as { type?: string }).type;
    if (type === "data-terminal") {
      const data = (
        part as {
          data?: { terminal?: unknown; toolCallId?: unknown };
        }
      ).data;
      if (
        typeof data?.toolCallId === "string" &&
        typeof data.terminal === "string"
      ) {
        const existing = terminalChunksByToolCallId.get(data.toolCallId);
        if (existing) {
          existing.push(data.terminal);
        } else {
          terminalChunksByToolCallId.set(data.toolCallId, [data.terminal]);
        }
      }
      continue;
    }

    if (!shouldProjectWorkPart(part)) continue;

    // A contiguous reasoning block is rendered as one logical activity. The
    // ReasoningHandler reads the remaining fragments from the source message.
    if (type === "reasoning" && previousProjectedType === "reasoning") {
      continue;
    }

    const toolCallId = getToolCallId(part);
    if (toolCallId) {
      const existingIndex = activityIndexByToolCallId.get(toolCallId);
      if (existingIndex !== undefined) {
        activities[existingIndex] = {
          id: `tool:${toolCallId}`,
          part,
          partIndex,
        };
        previousProjectedType = type;
        continue;
      }
      activityIndexByToolCallId.set(toolCallId, activities.length);
    }

    activities.push({
      id: toolCallId ? `tool:${toolCallId}` : `part:${partIndex}`,
      part,
      partIndex,
    });
    previousProjectedType = type;
  }

  const groupedActivities = groupAdjacentSubagentActivities(activities);

  return {
    activities: groupedActivities,
    hasExpandableWork: groupedActivities.some(({ part }) =>
      isExpandableWorkedForPart(part),
    ),
    terminalChunksByToolCallId,
  };
}

export function splitWorkedForParts(
  parts: ChatMessage["parts"],
): WorkedForParts {
  const fileParts: FilePart[] = [];
  const indexedNonFileParts: Array<{ part: MessagePart; partIndex: number }> =
    [];

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    if (part.type === "file") {
      fileParts.push(part as FilePart);
    } else {
      indexedNonFileParts.push({ part, partIndex });
    }
  }

  const nonFileParts = indexedNonFileParts.map(({ part }) => part);

  let trailingEnd = nonFileParts.length;
  while (
    trailingEnd > 0 &&
    isTrailingMetadataPart(nonFileParts[trailingEnd - 1])
  ) {
    trailingEnd -= 1;
  }

  let trailingStart = trailingEnd;
  for (let i = trailingEnd - 1; i >= 0; i--) {
    if ((nonFileParts[i] as { type?: string }).type === "text") {
      trailingStart = i;
    } else {
      break;
    }
  }

  return {
    fileParts,
    nonFileParts,
    workParts: nonFileParts.slice(0, trailingStart),
    workPartIndexes: indexedNonFileParts
      .slice(0, trailingStart)
      .map(({ partIndex }) => partIndex),
    trailingTextParts: nonFileParts.slice(trailingStart, trailingEnd),
  };
}
