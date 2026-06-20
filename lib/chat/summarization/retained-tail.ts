import type { UIMessage } from "ai";
import type { Id } from "@/convex/_generated/dataModel";
import { safeCountTokens, truncateContent } from "@/lib/token-utils";

export const RETAINED_TAIL_STRATEGY = "token_budgeted_tail_v1" as const;
export const RETAINED_TAIL_MIN_TOKENS = 2_000;
export const RETAINED_TAIL_MAX_TOKENS = 8_000;
export const RETAINED_TAIL_BUDGET_PERCENTAGE = 0.25;

export interface RetainedTailMetadata {
  start_message_id: string;
  start_part_index: number;
  budget_tokens: number;
  retained_tokens: number;
  retained_message_count: number;
  retained_part_count: number;
  projected_part_count: number;
  strategy: typeof RETAINED_TAIL_STRATEGY;
}

export interface RetainedTailSelection {
  headMessages: UIMessage[];
  tailMessages: UIMessage[];
  retainedTail?: RetainedTailMetadata;
  cutoffMessageId: string | null;
}

type FileTokens = Record<Id<"files">, number>;

type ProjectedPart = {
  part: UIMessage["parts"][number];
  tokens: number;
  projected: boolean;
};

type TailProjection = {
  messages: UIMessage[];
  retainedTokens: number;
  retainedPartCount: number;
  projectedPartCount: number;
  startMessageIndex: number | null;
  startPartIndex: number;
};

const RETAINED_TAIL_OMITTED_PART_TYPES = new Set([
  "step-start",
  "reasoning",
  "redacted-reasoning",
  "data-summarization",
]);

const stringifyForTokens = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const fileTokenCount = (
  part: UIMessage["parts"][number],
  fileTokens: FileTokens,
): number | null => {
  const fileId = (part as { fileId?: Id<"files"> }).fileId;
  if (!fileId) return null;
  return fileTokens[fileId] ?? null;
};

const isUsefulTailPart = (part: UIMessage["parts"][number]): boolean => {
  if (!part || typeof part !== "object") return false;
  const type = (part as { type?: unknown }).type;
  if (typeof type !== "string") return true;
  if (RETAINED_TAIL_OMITTED_PART_TYPES.has(type)) return false;
  if (type.startsWith("data-")) return false;
  return true;
};

const estimatePartTokens = (
  part: UIMessage["parts"][number],
  fileTokens: FileTokens,
): number => {
  if (!isUsefulTailPart(part)) return 0;

  if (part.type === "text" && "text" in part) {
    return safeCountTokens((part as { text?: string }).text ?? "");
  }

  if (part.type === "file") {
    return (
      fileTokenCount(part, fileTokens) ??
      safeCountTokens(stringifyForTokens(part))
    );
  }

  return safeCountTokens(stringifyForTokens(part));
};

const estimatePartsTokens = (
  parts: UIMessage["parts"],
  fileTokens: FileTokens,
): number =>
  parts.reduce((sum, part) => sum + estimatePartTokens(part, fileTokens), 0);

const textPart = (text: string): UIMessage["parts"][number] =>
  ({ type: "text", text }) as UIMessage["parts"][number];

const compactFilePart = (
  part: UIMessage["parts"][number],
): UIMessage["parts"][number] => {
  const record = part as Record<string, unknown>;
  const mediaType =
    typeof record.mediaType === "string"
      ? record.mediaType
      : typeof record.mimeType === "string"
        ? record.mimeType
        : "file";
  const name =
    typeof record.filename === "string"
      ? record.filename
      : typeof record.name === "string"
        ? record.name
        : "file";
  return textPart(
    `[Attached ${mediaType}: ${name} omitted from retained tail]`,
  );
};

const compactToolPart = (
  part: UIMessage["parts"][number],
  maxTokens: number,
): UIMessage["parts"][number] => {
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "tool";
  const toolName = type.startsWith("tool-") ? type.slice("tool-".length) : type;
  const output = record.output;
  const outputText =
    output == null
      ? ""
      : truncateContent(
          stringifyForTokens(output),
          "\n[Tool output shortened for retained tail]\n",
          Math.max(1, maxTokens - 64),
        );

  const compacted = {
    ...record,
    output:
      outputText.length > 0
        ? `[${toolName} output preview for retained tail]\n${outputText}`
        : `[${toolName} output omitted for retained tail]`,
  } as UIMessage["parts"][number];

  if (safeCountTokens(stringifyForTokens(compacted)) <= maxTokens) {
    return compacted;
  }

  return textPart(
    `[Tool: ${toolName} completed; details omitted from retained tail]`,
  );
};

const projectPartToBudget = (
  part: UIMessage["parts"][number],
  maxTokens: number,
  fileTokens: FileTokens,
): ProjectedPart | null => {
  if (maxTokens <= 0 || !isUsefulTailPart(part)) return null;

  const currentTokens = estimatePartTokens(part, fileTokens);
  if (currentTokens <= maxTokens) {
    return { part, tokens: currentTokens, projected: false };
  }

  let projected: UIMessage["parts"][number];
  if (part.type === "text" && "text" in part) {
    projected = {
      ...part,
      text: truncateContent(
        (part as { text?: string }).text ?? "",
        "\n[Retained tail text shortened]\n",
        maxTokens,
      ),
    } as UIMessage["parts"][number];
  } else if (part.type === "file") {
    projected = compactFilePart(part);
  } else if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    projected = compactToolPart(part, maxTokens);
  } else {
    projected = textPart(
      `[${part.type || "message part"} omitted from retained tail: ${currentTokens} tokens]`,
    );
  }

  let projectedTokens = estimatePartTokens(projected, fileTokens);
  if (
    projectedTokens > maxTokens &&
    projected.type === "text" &&
    "text" in projected
  ) {
    projected = {
      ...projected,
      text: truncateContent(
        (projected as { text?: string }).text ?? "",
        "\n[Retained tail placeholder shortened]\n",
        maxTokens,
      ),
    } as UIMessage["parts"][number];
    projectedTokens = estimatePartTokens(projected, fileTokens);
  }

  if (projectedTokens > maxTokens) {
    return null;
  }

  return { part: projected, tokens: projectedTokens, projected: true };
};

const projectNewestTail = (
  messages: UIMessage[],
  budgetTokens: number,
  fileTokens: FileTokens,
): TailProjection => {
  let remaining = Math.max(0, Math.floor(budgetTokens));
  let retainedTokens = 0;
  let retainedPartCount = 0;
  let projectedPartCount = 0;
  let startMessageIndex: number | null = null;
  let startPartIndex = 0;
  const reversedTail: UIMessage[] = [];

  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    if (remaining <= 0) break;

    const message = messages[messageIndex];
    const usefulParts = message.parts.filter(isUsefulTailPart);
    if (usefulParts.length === 0) continue;

    const wholeTokens = estimatePartsTokens(usefulParts, fileTokens);
    if (wholeTokens <= remaining) {
      reversedTail.push({ ...message, parts: usefulParts });
      retainedTokens += wholeTokens;
      retainedPartCount += usefulParts.length;
      remaining -= wholeTokens;
      startMessageIndex = messageIndex;
      startPartIndex = 0;
      continue;
    }

    const retainedParts: UIMessage["parts"] = [];
    let partialStartPartIndex: number | null = null;

    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex--
    ) {
      if (remaining <= 0) break;

      const part = message.parts[partIndex];
      if (!isUsefulTailPart(part)) continue;

      const projected = projectPartToBudget(part, remaining, fileTokens);
      if (!projected) continue;

      retainedParts.unshift(projected.part);
      retainedTokens += projected.tokens;
      retainedPartCount++;
      if (projected.projected) projectedPartCount++;
      remaining -= projected.tokens;
      partialStartPartIndex = partIndex;
    }

    if (retainedParts.length > 0 && partialStartPartIndex !== null) {
      reversedTail.push({ ...message, parts: retainedParts });
      startMessageIndex = messageIndex;
      startPartIndex = partialStartPartIndex;
    }
    break;
  }

  return {
    messages: reversedTail.reverse(),
    retainedTokens,
    retainedPartCount,
    projectedPartCount,
    startMessageIndex,
    startPartIndex,
  };
};

const buildHeadMessages = (
  messages: UIMessage[],
  startMessageIndex: number,
  startPartIndex: number,
): UIMessage[] => {
  if (startPartIndex <= 0) return messages.slice(0, startMessageIndex);

  const partialHeadParts = messages[startMessageIndex].parts.slice(
    0,
    startPartIndex,
  );
  return [
    ...messages.slice(0, startMessageIndex),
    ...(partialHeadParts.length > 0
      ? [{ ...messages[startMessageIndex], parts: partialHeadParts }]
      : []),
  ];
};

const buildMetadata = (
  tail: TailProjection,
  budgetTokens: number,
  sourceMessages: UIMessage[],
): RetainedTailMetadata | undefined => {
  if (tail.startMessageIndex === null || tail.messages.length === 0)
    return undefined;

  return {
    start_message_id: sourceMessages[tail.startMessageIndex].id,
    start_part_index: tail.startPartIndex,
    budget_tokens: Math.floor(budgetTokens),
    retained_tokens: tail.retainedTokens,
    retained_message_count: tail.messages.length,
    retained_part_count: tail.retainedPartCount,
    projected_part_count: tail.projectedPartCount,
    strategy: RETAINED_TAIL_STRATEGY,
  };
};

export const getRetainedTailBudgetTokens = (thresholdTokens: number): number =>
  Math.min(
    RETAINED_TAIL_MAX_TOKENS,
    Math.max(
      RETAINED_TAIL_MIN_TOKENS,
      Math.floor(
        Math.max(0, thresholdTokens) * RETAINED_TAIL_BUDGET_PERCENTAGE,
      ),
    ),
  );

export const selectRetainedTailForSummarization = (
  messages: UIMessage[],
  {
    budgetTokens,
    fileTokens = {} as FileTokens,
  }: {
    budgetTokens: number;
    fileTokens?: FileTokens;
  },
): RetainedTailSelection => {
  const tail = projectNewestTail(messages, budgetTokens, fileTokens);
  const retainedTail = buildMetadata(tail, budgetTokens, messages);

  if (tail.startMessageIndex === null || !retainedTail) {
    return {
      headMessages: messages,
      tailMessages: [],
      cutoffMessageId: messages.at(-1)?.id ?? null,
    };
  }

  const headMessages = buildHeadMessages(
    messages,
    tail.startMessageIndex,
    tail.startPartIndex,
  );
  const cutoffMessageId =
    headMessages.at(-1)?.id ??
    (tail.projectedPartCount > 0 ? retainedTail.start_message_id : null);

  return {
    headMessages,
    tailMessages: tail.messages,
    retainedTail,
    cutoffMessageId,
  };
};

export const projectMessagesToTokenBudget = (
  messages: UIMessage[],
  {
    budgetTokens,
    fileTokens = {} as FileTokens,
  }: {
    budgetTokens: number;
    fileTokens?: FileTokens;
  },
): UIMessage[] =>
  projectNewestTail(messages, budgetTokens, fileTokens).messages;

export const projectRetainedTailFromMessages = (
  messages: UIMessage[],
  retainedTail: RetainedTailMetadata,
  {
    budgetTokens = retainedTail.budget_tokens,
    fileTokens = {} as FileTokens,
  }: {
    budgetTokens?: number;
    fileTokens?: FileTokens;
  } = {},
): UIMessage[] => {
  if (retainedTail.strategy !== RETAINED_TAIL_STRATEGY) return [];

  const startIndex = messages.findIndex(
    (message) => message.id === retainedTail.start_message_id,
  );
  if (startIndex < 0) return [];

  const firstMessage = messages[startIndex];
  const startPartIndex = Math.max(
    0,
    Math.min(retainedTail.start_part_index, firstMessage.parts.length),
  );
  const candidates = [
    { ...firstMessage, parts: firstMessage.parts.slice(startPartIndex) },
    ...messages.slice(startIndex + 1),
  ].filter((message) => message.parts.length > 0);

  return projectMessagesToTokenBudget(candidates, {
    budgetTokens,
    fileTokens,
  });
};
