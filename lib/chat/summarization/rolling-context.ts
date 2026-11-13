import {
  asSchema,
  convertToModelMessages,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { createPromptSerializationTools } from "@/lib/ai/tools/prompt-serialization";
import { safeCountTokens } from "@/lib/token-utils";
import {
  COMPACTION_ESTIMATE_RECOVERY_RATIO,
  MAX_UNPRODUCTIVE_CONTEXT_COMPACTIONS_PER_STREAM,
  ROLLING_COMPACTION_MAX_SIZE_RATIO,
  SUMMARY_RECENT_MODEL_TAIL_MAX_TOKENS,
} from "./constants";
import { getRecentCompleteModelTail } from "./helpers";
import type { InRunModelCompactionResult } from "./index";

export type RollingModelContextCheckpoint = {
  /** Latest compacted provider context, excluding later raw SDK responses. */
  baseMessages: ModelMessage[];
  /** Number of raw SDK messages covered by baseMessages. */
  rawMessageCursor: number;
};

/**
 * AI SDK prepareStep overrides apply to one request only. Rebase its cumulative
 * raw history onto our latest compacted checkpoint for every later request.
 */
export const buildRollingModelMessages = (
  rawMessages: ModelMessage[],
  checkpoint?: RollingModelContextCheckpoint,
): ModelMessage[] => {
  if (!checkpoint) return rawMessages;
  const cursor = Math.min(checkpoint.rawMessageCursor, rawMessages.length);
  return [...checkpoint.baseMessages, ...rawMessages.slice(cursor)];
};

const getSerializedBytes = (value: unknown): number | undefined => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
};

export const isRollingCompactionEffective = (
  previousMessages: ModelMessage[],
  compactedMessages: ModelMessage[],
): boolean => {
  const previousBytes = getSerializedBytes(previousMessages);
  const compactedBytes = getSerializedBytes(compactedMessages);
  if (previousBytes === undefined || compactedBytes === undefined) return true;
  return compactedBytes < previousBytes * ROLLING_COMPACTION_MAX_SIZE_RATIO;
};

/** Tool definitions are sent with every tool-enabled request. Unplannable schemas fail closed. */
export const estimateToolSchemaTokens = async (
  tools: ToolSet,
): Promise<number> => {
  try {
    const schemas = await Promise.all(
      Object.entries(tools).map(async ([name, tool]) => ({
        name,
        description: tool.description,
        schema: await asSchema(tool.inputSchema).jsonSchema,
        providerOptions: tool.providerOptions,
      })),
    );
    return safeCountTokens(JSON.stringify(schemas));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * Bounds consecutive compactions whose next provider prompt remains over the
 * threshold. Fixed system/tool overhead can make message-only savings
 * misleading, so a compaction is productive only after the next provider
 * request is measured (or, without usage, estimated) below the threshold.
 */
export class RollingCompactionAttempts {
  attemptCount = 0;
  unproductiveCount = 0;
  /** Set until the next provider step reports whether the compaction helped. */
  pendingVerdict = false;
  /** Complete prepared-request estimate for providers that omit input usage. */
  pendingInputEstimate = 0;
  /** Raw history length at the latest attempt; one attempt per raw cursor. */
  lastRawMessageCount = -1;

  canCompact(): boolean {
    return (
      this.unproductiveCount < MAX_UNPRODUCTIVE_CONTEXT_COMPACTIONS_PER_STREAM
    );
  }

  record(rawMessageCount?: number): void {
    this.attemptCount++;
    this.unproductiveCount++;
    this.pendingVerdict = true;
    this.pendingInputEstimate = 0;
    if (rawMessageCount !== undefined)
      this.lastRawMessageCount = rawMessageCount;
  }

  confirm(inputTokens: number | undefined, thresholdTokens: number): void {
    if (!this.pendingVerdict) return;
    this.pendingVerdict = false;
    const providerTokens =
      typeof inputTokens === "number" &&
      Number.isFinite(inputTokens) &&
      inputTokens > 0
        ? inputTokens
        : undefined;
    const recovered =
      providerTokens !== undefined
        ? providerTokens < thresholdTokens
        : this.pendingInputEstimate > 0 &&
          this.pendingInputEstimate <
            thresholdTokens * COMPACTION_ESTIMATE_RECOVERY_RATIO;
    if (recovered) this.unproductiveCount = 0;
  }
}

/**
 * Builds the next rolling base from an in-run summary: summary, pinned runtime
 * instructions, the newest complete tool-call tail, then continuation messages.
 * Pinned messages are matched by identity and kept verbatim rather than in the tail.
 */
export const buildCompactedRollingBase = async ({
  compaction,
  sourceMessages,
  tools,
  pinnedMessages = [],
  trailingMessages,
}: {
  compaction: Pick<
    InRunModelCompactionResult,
    "summaryMessage" | "userMessageContextTokens" | "runtimeContextTokens"
  >;
  /** The rolling projection that was summarized. */
  sourceMessages: ModelMessage[];
  tools: ToolSet;
  pinnedMessages?: readonly ModelMessage[];
  trailingMessages: ModelMessage[];
}): Promise<{
  baseMessages: ModelMessage[];
  summaryMessageCount: number;
  retainedTail: ModelMessage[];
  effective: boolean;
}> => {
  const summaryMessages = await convertToModelMessages(
    [compaction.summaryMessage],
    { tools: createPromptSerializationTools(tools) },
  );
  const pinned = new Set(pinnedMessages);
  const retainedTail = getRecentCompleteModelTail(
    pinned.size > 0
      ? sourceMessages.filter((message) => !pinned.has(message))
      : sourceMessages,
    Math.max(
      0,
      SUMMARY_RECENT_MODEL_TAIL_MAX_TOKENS -
        (compaction.userMessageContextTokens ?? 0) -
        (compaction.runtimeContextTokens ?? 0),
    ),
  );
  const baseMessages: ModelMessage[] = [
    ...summaryMessages,
    ...pinnedMessages,
    ...retainedTail,
    ...trailingMessages,
  ];
  return {
    baseMessages,
    summaryMessageCount: summaryMessages.length,
    retainedTail,
    effective: isRollingCompactionEffective(sourceMessages, baseMessages),
  };
};
