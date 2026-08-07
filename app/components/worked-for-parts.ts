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
};

export type AgentWorkTimelineItem =
  | ({ kind: "activity" } & AgentWorkActivity)
  | {
      kind: "tool-group";
      id: string;
      activities: AgentWorkActivity[];
      summary: string;
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

const getPartType = (part: MessagePart) => (part as { type?: string }).type;

const isToolPart = (part: MessagePart) =>
  getPartType(part)?.startsWith("tool-") ?? false;

const hasKnownToolFailure = (part: MessagePart) => {
  const candidate = part as {
    errorText?: unknown;
    output?: unknown;
    state?: unknown;
  };

  if (
    candidate.state === "output-error" ||
    candidate.state === "output-denied"
  ) {
    return true;
  }
  if (typeof candidate.errorText === "string" && candidate.errorText.trim()) {
    return true;
  }
  if (!candidate.output || typeof candidate.output !== "object") {
    return false;
  }

  const output = candidate.output as Record<string, unknown>;
  const result =
    output.result && typeof output.result === "object"
      ? (output.result as Record<string, unknown>)
      : undefined;
  const exitCode =
    typeof output.exitCode === "number"
      ? output.exitCode
      : typeof result?.exitCode === "number"
        ? result.exitCode
        : undefined;
  const hasFailedFiles =
    Array.isArray(output.failedFiles) && output.failedFiles.length > 0;
  const hasFailedResult =
    Array.isArray(output.results) &&
    output.results.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        ((entry as Record<string, unknown>).success === false ||
          (entry as Record<string, unknown>).failed === true ||
          Boolean((entry as Record<string, unknown>).error)),
    );
  return (
    output.success === false ||
    output.failed === true ||
    Boolean(output.error) ||
    Boolean(result?.error) ||
    (exitCode !== undefined && exitCode !== 0) ||
    hasFailedFiles ||
    hasFailedResult
  );
};

const isSuccessfullyCompletedToolPart = (part: MessagePart) => {
  const state = (part as { state?: unknown }).state;
  return state === "output-available" && !hasKnownToolFailure(part);
};

type ToolSummaryCategory =
  | "command"
  | "edit"
  | "notes"
  | "proxy"
  | "read"
  | "request"
  | "search"
  | "tasks"
  | "tool";

const toolSummaryCategory = (part: MessagePart): ToolSummaryCategory => {
  switch (getPartType(part)) {
    case "tool-shell":
    case "tool-run_terminal_cmd":
    case "tool-interact_terminal_session":
      return "command";
    case "tool-read_file":
    case "tool-get_terminal_files":
      return "read";
    case "tool-write_file":
    case "tool-delete_file":
    case "tool-search_replace":
    case "tool-multi_edit":
      return "edit";
    case "tool-web_search":
    case "tool-open_url":
    case "tool-web":
      return "search";
    case "tool-http_request":
    case "tool-send_request":
      return "request";
    case "tool-todo_write":
      return "tasks";
    case "tool-create_note":
    case "tool-list_notes":
    case "tool-update_note":
    case "tool-delete_note":
      return "notes";
    case "tool-list_requests":
    case "tool-view_request":
    case "tool-scope_rules":
    case "tool-list_sitemap":
    case "tool-view_sitemap_entry":
      return "proxy";
    default:
      return "tool";
  }
};

const toolSummaryPhrase = (category: ToolSummaryCategory, count: number) => {
  const plural = count > 1;
  switch (category) {
    case "command":
      return plural ? "ran commands" : "ran a command";
    case "read":
      return plural ? "read files" : "read a file";
    case "edit":
      return plural ? "edited files" : "edited a file";
    case "search":
      return "searched the web";
    case "request":
      return plural ? "sent requests" : "sent a request";
    case "tasks":
      return "updated tasks";
    case "notes":
      return "updated notes";
    case "proxy":
      return "inspected proxy data";
    case "tool":
      return plural ? "used tools" : "used a tool";
  }
};

const joinSummaryPhrases = (phrases: readonly string[]) => {
  if (phrases.length === 1) return phrases[0] ?? "used tools";
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
};

/** Builds the compact, deterministic label shown for a completed tool step. */
export function summarizeCompletedToolActivities(
  activities: readonly AgentWorkActivity[],
): string {
  const counts = new Map<ToolSummaryCategory, number>();
  for (const activity of activities) {
    const category = toolSummaryCategory(activity.part);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const summary = joinSummaryPhrases(
    [...counts].map(([category, count]) => toolSummaryPhrase(category, count)),
  );
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

function firstSeenExplicitStepByActivityId(
  parts: ChatMessage["parts"],
  workPartIndexes: readonly number[],
) {
  const stepByActivityId = new Map<string, number>();
  let currentStep = -1;
  let highestStep = -1;

  for (const partIndex of workPartIndexes) {
    const part = parts[partIndex];
    if (!part) continue;

    if (getPartType(part) === "step-start") {
      currentStep += 1;
      highestStep = currentStep;
      continue;
    }
    if (!isToolPart(part) || currentStep < 0) continue;

    const toolCallId = getToolCallId(part);
    const activityId = toolCallId ? `tool:${toolCallId}` : `part:${partIndex}`;
    if (!stepByActivityId.has(activityId)) {
      stepByActivityId.set(activityId, currentStep);
    }
  }

  return { highestStep, stepByActivityId };
}

/**
 * Collapses only closed, fully successful multi-tool runs. In-flight, failed,
 * denied, and stopped tools remain independent rows so their state is never
 * hidden. `step-start` is the preferred boundary; consecutive tools are the
 * compatibility fallback for older messages without step markers.
 */
export function projectAgentWorkTimelineItems({
  activities,
  messageSettled,
  parts,
  workPartIndexes,
}: {
  activities: readonly AgentWorkActivity[];
  messageSettled: boolean;
  parts: ChatMessage["parts"];
  workPartIndexes: readonly number[];
}): AgentWorkTimelineItem[] {
  const { highestStep, stepByActivityId } = firstSeenExplicitStepByActivityId(
    parts,
    workPartIndexes,
  );
  const items: AgentWorkTimelineItem[] = [];

  for (let index = 0; index < activities.length; index += 1) {
    const first = activities[index];
    if (!first || !isToolPart(first.part)) {
      if (first) items.push({ kind: "activity", ...first });
      continue;
    }

    const explicitStep = stepByActivityId.get(first.id);
    const run = [first];
    let cursor = index + 1;
    while (cursor < activities.length) {
      const next = activities[cursor];
      if (!next || !isToolPart(next.part)) break;

      const nextExplicitStep = stepByActivityId.get(next.id);
      if (explicitStep !== undefined && nextExplicitStep !== explicitStep) {
        break;
      }
      if (explicitStep === undefined && nextExplicitStep !== undefined) {
        break;
      }

      run.push(next);
      cursor += 1;
    }

    const hasLaterBoundary =
      cursor < activities.length ||
      (explicitStep !== undefined && explicitStep < highestStep);
    const canCollapse =
      run.length > 1 &&
      (messageSettled || hasLaterBoundary) &&
      run.every(({ part }) => isSuccessfullyCompletedToolPart(part));

    if (canCollapse) {
      items.push({
        kind: "tool-group",
        id: `tool-group:${explicitStep ?? "legacy"}:${run[0]?.id}`,
        activities: run,
        summary: summarizeCompletedToolActivities(run),
      });
    } else {
      items.push(
        ...run.map((activity) => ({ kind: "activity" as const, ...activity })),
      );
    }

    index = cursor - 1;
  }

  return items;
}

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
    if (type === "step-start") {
      previousProjectedType = undefined;
      continue;
    }
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

  return {
    activities,
    hasExpandableWork: activities.some(({ part }) =>
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
