import type { UIMessage } from "ai";
import { safeCountTokens } from "@/lib/token-utils";

/**
 * Default rolling token budget for tool outputs (protection window).
 * Tool outputs newer than this budget are kept intact; older ones are
 * replaced with compact one-line placeholders. 40 000 tokens ≈ ~30K words,
 * enough to keep the most recent tool interactions fully detailed.
 */
export const TOOL_OUTPUT_TOKEN_BUDGET = 40_000;

/**
 * Minimum token savings required to justify pruning.
 * If pruning would save fewer tokens than this, skip it entirely —
 * the overhead of replacing outputs isn't worth the small savings.
 * Matches OpenCode's PRUNE_MINIMUM threshold.
 */
const PRUNE_MINIMUM_SAVINGS = 20_000;

/**
 * Tools whose outputs should never be pruned. These contain state
 * or instructions that the agent needs to reference throughout the
 * conversation regardless of age.
 */
const PROTECTED_TOOLS = new Set([
  "todo_write",
  "create_note",
  "list_notes",
  "update_note",
  "delete_note",
]);

const TOOL_TYPE_PREFIX = "tool-";

export interface PruneResult {
  messages: UIMessage[];
  prunedCount: number;
  tokensSaved: number;
  /** Total tokens across all eligible (non-protected, non-pruned) tool outputs */
  totalToolOutputTokens: number;
  /** Number of tool output parts evaluated */
  toolOutputCount: number;
  /** Why pruning was skipped (null if pruning occurred) */
  skipReason:
    "no-tool-outputs" | "within-budget" | "below-minimum-savings" | null;
}

export interface StorageCompactionResult<T extends UIMessage = UIMessage> {
  message: T;
  compacted: boolean;
  beforeSizeBytes: number;
  afterSizeBytes: number;
  strippedUiOnlyFields: boolean;
  prunedCount: number;
}

const STORAGE_MESSAGE_SOFT_LIMIT_BYTES = 850 * 1024;
const STORAGE_TOOL_OUTPUT_TOKEN_BUDGET = 20_000;
const STORAGE_REASONING_CHAR_BUDGET = 32_000;
const STORAGE_REASONING_PART_CHAR_LIMIT = 8_000;
const STORAGE_TOOL_INPUT_STRING_LIMIT = 512;
const STORAGE_TOOL_INPUT_ARRAY_LIMIT = 20;
const STORAGE_TOOL_INPUT_OBJECT_KEY_LIMIT = 20;
const STORAGE_TOOL_INPUT_DEPTH_LIMIT = 3;
const STORAGE_NOTE_CONTENT_PREVIEW_LIMIT = 512;
const STORAGE_NOTE_TITLE_LIMIT = 200;
const STORAGE_NOTE_TAG_LIMIT = 20;
const STORAGE_COMPACTED_STRING_SUFFIX = "... [truncated for storage]";
const STORAGE_COMPACTED_REASONING_PREFIX =
  "[Earlier reasoning compacted for storage]\n\n";
const COMPACT_PLACEHOLDER_PATTERN =
  /^\[(Terminal|File|Match|Search|Files|URL|Tool): .+\]$/;

// ---------------------------------------------------------------------------
// Placeholder builders per tool type
// ---------------------------------------------------------------------------

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: any;
  output?: any;
}

/**
 * Builds a compact placeholder string given the tool name, its input args, and output.
 * Shared by both UIMessage and ModelMessage pruners.
 */
const buildPlaceholderFromParts = (
  toolName: string,
  input: any,
  output: any,
): string => {
  switch (toolName) {
    case "run_terminal_cmd": {
      const cmd = input?.command ?? "unknown";
      const shortCmd = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
      const exitCode =
        output?.exitCode ??
        output?.exit_code ??
        output?.result?.exitCode ??
        output?.result?.exit_code ??
        "?";
      return `[Terminal: ran '${shortCmd}', exit code ${exitCode}]`;
    }

    case "file": {
      const action = input?.action ?? "unknown";
      const path = input?.path ?? input?.file_path ?? "unknown";
      if (action === "read") {
        const content = output?.content ?? output ?? "";
        const lines =
          typeof content === "string" ? content.split("\n").length : "?";
        return `[File: read ${path} (${lines} lines)]`;
      }
      return `[File: ${action} ${path}]`;
    }

    case "match": {
      let count = "?";
      let files = "";
      if (Array.isArray(output)) {
        count = String(output.length);
        const fileSet = new Set(
          output
            .map((m: any) => m.file ?? m.path ?? m.filename)
            .filter(Boolean),
        );
        files =
          fileSet.size > 0 ? ` in ${[...fileSet].slice(0, 5).join(", ")}` : "";
        if (fileSet.size > 5) files += ` (+${fileSet.size - 5} more)`;
      } else if (output && typeof output === "object") {
        const results = output.results ?? output.matches ?? [];
        count = Array.isArray(results) ? String(results.length) : "?";
      }
      return `[Match: ${count} results${files}]`;
    }

    case "web_search":
    case "web": {
      const query = input?.query ?? "unknown";
      return `[Search: '${query}']`;
    }

    case "get_terminal_files": {
      const n = Array.isArray(output) ? output.length : "?";
      return `[Files: retrieved ${n} files]`;
    }

    case "open_url": {
      const url = input?.url ?? "unknown";
      return `[URL: opened ${url}]`;
    }

    default:
      return `[Tool: ${toolName} completed]`;
  }
};

/** Builds a placeholder from a UIMessage ToolPart */
const buildPlaceholder = (part: ToolPart): string => {
  const toolName = part.type.slice(TOOL_TYPE_PREFIX.length);
  return buildPlaceholderFromParts(toolName, part.input, part.output);
};

const isCompactPlaceholderOutput = (output: unknown): output is string =>
  typeof output === "string" && COMPACT_PLACEHOLDER_PATTERN.test(output);

const isPrunableToolPart = (part: ToolPart): boolean => {
  const toolName = part.type?.startsWith(TOOL_TYPE_PREFIX)
    ? part.type.slice(TOOL_TYPE_PREFIX.length)
    : null;

  return Boolean(toolName && !PROTECTED_TOOLS.has(toolName));
};

const isCompletedPrunableToolPart = (part: ToolPart): boolean =>
  isPrunableToolPart(part) &&
  (part.state === "output-available" || part.state === "output-error") &&
  part.output != null;

const isCompletedToolPart = (part: ToolPart): boolean =>
  part.type?.startsWith(TOOL_TYPE_PREFIX) &&
  (part.state === "output-available" || part.state === "output-error") &&
  part.output != null;

const truncateStorageString = (
  value: string,
  maxLength = STORAGE_TOOL_INPUT_STRING_LIMIT,
): string => {
  if (value.length <= maxLength) return value;
  if (maxLength <= STORAGE_COMPACTED_STRING_SUFFIX.length) {
    return value.slice(0, maxLength);
  }

  const contentBudget = maxLength - STORAGE_COMPACTED_STRING_SUFFIX.length;
  const headBudget = Math.ceil(contentBudget * 0.65);
  const tailBudget = contentBudget - headBudget;

  return `${value.slice(0, headBudget)}${STORAGE_COMPACTED_STRING_SUFFIX}${
    tailBudget > 0 ? value.slice(-tailBudget) : ""
  }`;
};

const compactToolInputForStorage = (value: unknown, depth = 0): unknown => {
  if (value == null) return value;
  if (typeof value === "string") return truncateStorageString(value);
  if (typeof value !== "object") return value;

  if (depth >= STORAGE_TOOL_INPUT_DEPTH_LIMIT) {
    if (Array.isArray(value)) {
      return value.length > STORAGE_TOOL_INPUT_ARRAY_LIMIT
        ? {
            type: "array",
            length: value.length,
            truncated: true,
          }
        : value;
    }

    return {
      type: "object",
      keys: Object.keys(value as Record<string, unknown>).slice(
        0,
        STORAGE_TOOL_INPUT_ARRAY_LIMIT,
      ),
      truncated: true,
    };
  }

  if (Array.isArray(value)) {
    const compacted = value
      .slice(0, STORAGE_TOOL_INPUT_ARRAY_LIMIT)
      .map((item) => compactToolInputForStorage(item, depth + 1));
    if (value.length > STORAGE_TOOL_INPUT_ARRAY_LIMIT) {
      compacted.push({
        truncated: true,
        remaining: value.length - STORAGE_TOOL_INPUT_ARRAY_LIMIT,
      });
    }
    return compacted;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const compacted: Record<string, unknown> = {};
  for (const [key, childValue] of entries.slice(
    0,
    STORAGE_TOOL_INPUT_OBJECT_KEY_LIMIT,
  )) {
    compacted[key] = compactToolInputForStorage(childValue, depth + 1);
  }
  if (entries.length > STORAGE_TOOL_INPUT_OBJECT_KEY_LIMIT) {
    compacted.__hackeraiStorageTruncatedFields =
      entries.length - STORAGE_TOOL_INPUT_OBJECT_KEY_LIMIT;
  }

  return compacted;
};

const compactNoteForStorage = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return compactToolInputForStorage(value);
  }

  const note = value as Record<string, unknown>;
  return {
    note_id: note.note_id,
    title:
      typeof note.title === "string"
        ? truncateStorageString(note.title, STORAGE_NOTE_TITLE_LIMIT)
        : note.title,
    content:
      typeof note.content === "string"
        ? truncateStorageString(
            note.content,
            STORAGE_NOTE_CONTENT_PREVIEW_LIMIT,
          )
        : note.content,
    category: note.category,
    tags: Array.isArray(note.tags)
      ? note.tags
          .slice(0, STORAGE_NOTE_TAG_LIMIT)
          .map((tag) =>
            typeof tag === "string" ? truncateStorageString(tag, 100) : tag,
          )
      : note.tags,
    _creationTime: note._creationTime,
    updated_at: note.updated_at,
  };
};

const compactProtectedToolOutputForStorage = (
  toolName: string,
  output: unknown,
): unknown => {
  if (
    toolName !== "list_notes" ||
    !output ||
    typeof output !== "object" ||
    Array.isArray(output)
  ) {
    return compactToolInputForStorage(output);
  }

  const listOutput = output as Record<string, unknown>;
  return {
    success: listOutput.success,
    notes: Array.isArray(listOutput.notes)
      ? listOutput.notes.map(compactNoteForStorage)
      : listOutput.notes,
    total_count: listOutput.total_count,
    message: listOutput.message,
    error: listOutput.error,
    __hackeraiStorageCompacted: true,
  };
};

const compactToolPartForStorage = (
  part: ToolPart,
  { includeProtectedTools = false }: { includeProtectedTools?: boolean } = {},
): ToolPart => {
  const toolName = part.type?.startsWith(TOOL_TYPE_PREFIX)
    ? part.type.slice(TOOL_TYPE_PREFIX.length)
    : null;
  if (!toolName || (!includeProtectedTools && PROTECTED_TOOLS.has(toolName))) {
    return part;
  }

  return {
    ...part,
    input: compactToolInputForStorage(part.input),
    output: PROTECTED_TOOLS.has(toolName)
      ? compactProtectedToolOutputForStorage(toolName, part.output)
      : isCompactPlaceholderOutput(part.output)
        ? part.output
        : buildPlaceholder(part),
  };
};

// ---------------------------------------------------------------------------
// Token counting for a tool output
// ---------------------------------------------------------------------------

const countOutputTokens = (output: unknown): number => {
  if (output == null) return 0;
  if (typeof output === "string") return safeCountTokens(output);
  return safeCountTokens(JSON.stringify(output));
};

export const estimateSerializedSizeBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const stripBulkyOutputFields = (part: ToolPart): ToolPart => {
  if (!part || typeof part !== "object") return part;
  const output = part.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return part;
  }

  if (part.type === "tool-file") {
    const { originalContent, modifiedContent, ...restOutput } =
      output as Record<string, unknown>;

    if (originalContent !== undefined || modifiedContent !== undefined) {
      return { ...part, output: restOutput };
    }
  }

  if (part.type === "tool-update_note") {
    const { original, modified, ...restOutput } = output as Record<
      string,
      unknown
    >;

    if (original !== undefined || modified !== undefined) {
      return { ...part, output: restOutput };
    }
  }

  if (
    part.type === "tool-run_terminal_cmd" ||
    part.type === "tool-interact_terminal_session"
  ) {
    const { rawSnapshot, ...restOutput } = output as Record<string, unknown>;

    if (rawSnapshot !== undefined) {
      return { ...part, output: restOutput };
    }
  }

  return part;
};

const compactReasoningParts = (
  parts: UIMessage["parts"],
): UIMessage["parts"] => {
  let remainingReasoningChars = STORAGE_REASONING_CHAR_BUDGET;

  const compacted = parts
    .slice()
    .reverse()
    .map((part) => {
      if (part?.type !== "reasoning") return part;

      const text = typeof part.text === "string" ? part.text : "";
      if (!text.trim()) return null;
      if (remainingReasoningChars <= 0) return null;

      const charLimit = Math.min(
        remainingReasoningChars,
        STORAGE_REASONING_PART_CHAR_LIMIT,
      );
      remainingReasoningChars -= Math.min(text.length, charLimit);

      if (text.length <= charLimit) return part;

      const prefixBudget = Math.min(
        STORAGE_COMPACTED_REASONING_PREFIX.length,
        charLimit,
      );
      const tailBudget = Math.max(0, charLimit - prefixBudget);

      return {
        ...part,
        text: `${STORAGE_COMPACTED_REASONING_PREFIX.slice(
          0,
          prefixBudget,
        )}${tailBudget > 0 ? text.slice(-tailBudget) : ""}`,
      };
    })
    .filter((part): part is UIMessage["parts"][number] => part !== null)
    .reverse();

  return compacted;
};

const stripStorageOnlyParts = (parts: UIMessage["parts"]): UIMessage["parts"] =>
  parts.filter(
    (part) =>
      part?.type !== "step-start" && part?.type !== "data-summarization",
  );

const compactToolPartsToByteLimit = (
  parts: UIMessage["parts"],
  softLimitBytes: number,
  { includeProtectedTools = false }: { includeProtectedTools?: boolean } = {},
): {
  parts: UIMessage["parts"];
  compactedCount: number;
  afterSizeBytes: number;
} => {
  let afterSizeBytes = estimateSerializedSizeBytes(parts);
  if (afterSizeBytes <= softLimitBytes) {
    return { parts, compactedCount: 0, afterSizeBytes };
  }

  let compactedCount = 0;
  let compactedParts = parts;

  for (
    let index = 0;
    index < compactedParts.length && afterSizeBytes > softLimitBytes;
    index++
  ) {
    const part = compactedParts[index] as ToolPart;
    if (
      !(includeProtectedTools
        ? isCompletedToolPart(part)
        : isCompletedPrunableToolPart(part))
    ) {
      continue;
    }

    const compactedPart = compactToolPartForStorage(part, {
      includeProtectedTools,
    });
    if (
      estimateSerializedSizeBytes(compactedPart) >=
      estimateSerializedSizeBytes(part)
    ) {
      continue;
    }

    compactedParts = compactedParts.map((currentPart, partIndex) =>
      partIndex === index
        ? (compactedPart as UIMessage["parts"][number])
        : currentPart,
    );
    compactedCount++;
    afterSizeBytes = estimateSerializedSizeBytes(compactedParts);
  }

  return {
    parts: compactedParts,
    compactedCount,
    afterSizeBytes,
  };
};

const compactNonCompletedPartForStorage = (
  part: UIMessage["parts"][number],
): UIMessage["parts"][number] => {
  const toolPart = part as ToolPart;
  if (toolPart.type?.startsWith(TOOL_TYPE_PREFIX)) {
    return {
      ...toolPart,
      input: compactToolInputForStorage(toolPart.input),
    } as UIMessage["parts"][number];
  }

  if ("data" in part) {
    return {
      ...part,
      data: compactToolInputForStorage(part.data),
    } as UIMessage["parts"][number];
  }

  return part;
};

const fitSinglePartToByteLimit = (
  part: UIMessage["parts"][number],
  byteLimit: number,
): UIMessage["parts"][number] | null => {
  if (
    (part.type === "text" || part.type === "reasoning") &&
    typeof part.text === "string"
  ) {
    let low = 0;
    let high = part.text.length;
    let best: UIMessage["parts"][number] | null = null;

    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const candidate = {
        ...part,
        text: truncateStorageString(part.text, midpoint),
      } as UIMessage["parts"][number];
      if (estimateSerializedSizeBytes([candidate]) <= byteLimit) {
        best = candidate;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }

    return best;
  }

  const toolPart = part as ToolPart;
  if (toolPart.type?.startsWith(TOOL_TYPE_PREFIX)) {
    const minimalToolPart = {
      type: toolPart.type,
      toolCallId: toolPart.toolCallId,
      state: toolPart.state,
      input: { __hackeraiStorageTruncated: true },
      ...(isCompletedToolPart(toolPart)
        ? {
            output: compactProtectedToolOutputForStorage(
              toolPart.type.slice(TOOL_TYPE_PREFIX.length),
              toolPart.output,
            ),
          }
        : {}),
    } as UIMessage["parts"][number];
    if (estimateSerializedSizeBytes([minimalToolPart]) <= byteLimit) {
      return minimalToolPart;
    }

    return null;
  }

  const minimalPart = { type: part.type } as UIMessage["parts"][number];
  return estimateSerializedSizeBytes([minimalPart]) <= byteLimit
    ? minimalPart
    : null;
};

const enforceStorageByteLimit = (
  parts: UIMessage["parts"],
  byteLimit: number,
): {
  parts: UIMessage["parts"];
  compactedCount: number;
  afterSizeBytes: number;
} => {
  const protectedCompaction = compactToolPartsToByteLimit(parts, byteLimit, {
    includeProtectedTools: true,
  });
  let compactedParts = protectedCompaction.parts;
  let compactedCount = protectedCompaction.compactedCount;
  let afterSizeBytes = protectedCompaction.afterSizeBytes;

  for (
    let index = 0;
    index < compactedParts.length && afterSizeBytes > byteLimit;
    index++
  ) {
    const currentPart = compactedParts[index];
    const compactedPart = compactNonCompletedPartForStorage(currentPart);
    if (
      estimateSerializedSizeBytes(compactedPart) >=
      estimateSerializedSizeBytes(currentPart)
    ) {
      continue;
    }

    compactedParts = compactedParts.map((part, partIndex) =>
      partIndex === index ? compactedPart : part,
    );
    compactedCount++;
    afterSizeBytes = estimateSerializedSizeBytes(compactedParts);
  }

  while (compactedParts.length > 1 && afterSizeBytes > byteLimit) {
    compactedParts = compactedParts.slice(1);
    compactedCount++;
    afterSizeBytes = estimateSerializedSizeBytes(compactedParts);
  }

  if (compactedParts.length === 1 && afterSizeBytes > byteLimit) {
    const fittedPart = fitSinglePartToByteLimit(compactedParts[0], byteLimit);
    compactedParts = fittedPart ? [fittedPart] : [];
    compactedCount++;
    afterSizeBytes = estimateSerializedSizeBytes(compactedParts);
  }

  return { parts: compactedParts, compactedCount, afterSizeBytes };
};

/**
 * Compacts a single assistant UIMessage before database storage.
 *
 * Convex documents are capped at 1 MiB, so long agent runs can fail when a
 * single assistant message accumulates many tool outputs. This preserves normal
 * messages, then progressively removes UI-only bulk and old tool output detail
 * once the serialized parts payload approaches the document limit.
 */
export function compactMessageForStorage<T extends UIMessage>(
  message: T,
  {
    softLimitBytes = STORAGE_MESSAGE_SOFT_LIMIT_BYTES,
    toolOutputTokenBudget = STORAGE_TOOL_OUTPUT_TOKEN_BUDGET,
  }: {
    softLimitBytes?: number;
    toolOutputTokenBudget?: number;
  } = {},
): StorageCompactionResult<T> {
  const beforeSizeBytes = estimateSerializedSizeBytes(message.parts);

  if (message.role !== "assistant" || beforeSizeBytes <= softLimitBytes) {
    return {
      message,
      compacted: false,
      beforeSizeBytes,
      afterSizeBytes: beforeSizeBytes,
      strippedUiOnlyFields: false,
      prunedCount: 0,
    };
  }

  let strippedUiOnlyFields = false;
  let parts = message.parts.map((part) => {
    const stripped = stripBulkyOutputFields(part as ToolPart);
    if (stripped !== part) strippedUiOnlyFields = true;
    return stripped as UIMessage["parts"][number];
  });

  let afterSizeBytes = estimateSerializedSizeBytes(parts);
  let prunedCount = 0;

  if (afterSizeBytes > softLimitBytes) {
    const pruneResult = pruneToolOutputs(
      [{ ...message, parts }],
      toolOutputTokenBudget,
      0,
    );
    parts = pruneResult.messages[0]?.parts ?? parts;
    prunedCount += pruneResult.prunedCount;
    afterSizeBytes = estimateSerializedSizeBytes(parts);
  }

  if (afterSizeBytes > softLimitBytes) {
    const pruneResult = pruneToolOutputs([{ ...message, parts }], 0, 0);
    parts = pruneResult.messages[0]?.parts ?? parts;
    prunedCount += pruneResult.prunedCount;
    afterSizeBytes = estimateSerializedSizeBytes(parts);
  }

  if (afterSizeBytes > softLimitBytes) {
    parts = compactReasoningParts(parts);
    afterSizeBytes = estimateSerializedSizeBytes(parts);
  }

  if (afterSizeBytes > softLimitBytes) {
    parts = stripStorageOnlyParts(parts);
    afterSizeBytes = estimateSerializedSizeBytes(parts);
  }

  if (afterSizeBytes > softLimitBytes) {
    const byteCompactionResult = compactToolPartsToByteLimit(
      parts,
      softLimitBytes,
    );
    parts = byteCompactionResult.parts;
    prunedCount += byteCompactionResult.compactedCount;
    afterSizeBytes = byteCompactionResult.afterSizeBytes;
  }

  if (afterSizeBytes > softLimitBytes) {
    const hardLimitResult = enforceStorageByteLimit(parts, softLimitBytes);
    parts = hardLimitResult.parts;
    prunedCount += hardLimitResult.compactedCount;
    afterSizeBytes = hardLimitResult.afterSizeBytes;
  }

  const compacted =
    strippedUiOnlyFields || prunedCount > 0 || afterSizeBytes < beforeSizeBytes;

  return {
    message: compacted ? ({ ...message, parts } as T) : message,
    compacted,
    beforeSizeBytes,
    afterSizeBytes,
    strippedUiOnlyFields,
    prunedCount,
  };
}

// ---------------------------------------------------------------------------
// Main pruning function
// ---------------------------------------------------------------------------

/**
 * Prunes old tool outputs to stay within a rolling token budget.
 *
 * Walks messages from newest to oldest. For each tool part with
 * `state === "output-available"`, the output tokens are counted against
 * the remaining budget. Once the budget is exhausted, older tool outputs
 * are replaced with compact one-line placeholders.
 *
 * Returns a shallow copy of the messages array with pruned parts.
 * The original messages are not mutated.
 */
export function pruneToolOutputs(
  messages: UIMessage[],
  budget: number = TOOL_OUTPUT_TOKEN_BUDGET,
  minimumSavings: number = PRUNE_MINIMUM_SAVINGS,
): PruneResult {
  let remainingBudget = budget;
  let prunedCount = 0;
  let tokensSaved = 0;

  // Collect all tool parts newest→oldest with their locations
  const toolEntries: Array<{
    msgIdx: number;
    partIdx: number;
    part: ToolPart;
    tokens: number;
  }> = [];

  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    // Walk parts in reverse so newest tool calls within a message come first
    for (let pi = msg.parts.length - 1; pi >= 0; pi--) {
      const part = msg.parts[pi] as ToolPart;
      const toolName = part.type?.startsWith(TOOL_TYPE_PREFIX)
        ? part.type.slice(TOOL_TYPE_PREFIX.length)
        : null;
      if (
        toolName &&
        !PROTECTED_TOOLS.has(toolName) &&
        (part.state === "output-available" || part.state === "output-error") &&
        part.output != null &&
        !isCompactPlaceholderOutput(part.output)
      ) {
        toolEntries.push({
          msgIdx: mi,
          partIdx: pi,
          part,
          tokens: countOutputTokens(part.output),
        });
      }
    }
  }

  // Nothing to prune
  if (toolEntries.length === 0) {
    return {
      messages,
      prunedCount: 0,
      tokensSaved: 0,
      totalToolOutputTokens: 0,
      toolOutputCount: 0,
      skipReason: "no-tool-outputs",
    };
  }

  const totalToolOutputTokens = toolEntries.reduce((s, e) => s + e.tokens, 0);

  // Determine which entries to prune (beyond budget)
  const toPrune = new Set<string>(); // "msgIdx:partIdx"

  for (const entry of toolEntries) {
    // Budget already exhausted by previous entries — prune this one
    if (remainingBudget <= 0) {
      toPrune.add(`${entry.msgIdx}:${entry.partIdx}`);
      prunedCount++;
      const placeholderTokens = safeCountTokens(buildPlaceholder(entry.part));
      tokensSaved += entry.tokens - placeholderTokens;
      continue;
    }
    // Deduct from budget; if this entry causes overshoot, keep it but
    // subsequent entries will be pruned
    remainingBudget -= entry.tokens;
  }

  if (prunedCount === 0 || tokensSaved < minimumSavings) {
    return {
      messages,
      prunedCount: 0,
      tokensSaved: 0,
      totalToolOutputTokens,
      toolOutputCount: toolEntries.length,
      skipReason: prunedCount === 0 ? "within-budget" : "below-minimum-savings",
    };
  }

  // Build new messages array with pruned parts
  const newMessages: UIMessage[] = messages.map((msg, mi) => {
    // Check if any parts in this message need pruning
    const hasPartsToPrune = msg.parts.some((_, pi) =>
      toPrune.has(`${mi}:${pi}`),
    );
    if (!hasPartsToPrune) return msg;

    const newParts = msg.parts.map((part, pi) => {
      if (!toPrune.has(`${mi}:${pi}`)) return part;

      const toolPart = part as ToolPart;
      const placeholder = buildPlaceholder(toolPart);

      return {
        ...toolPart,
        output: placeholder,
      } as typeof part;
    });

    return { ...msg, parts: newParts } as typeof msg;
  });

  return {
    messages: newMessages,
    prunedCount,
    tokensSaved,
    totalToolOutputTokens,
    toolOutputCount: toolEntries.length,
    skipReason: null,
  };
}

// ---------------------------------------------------------------------------
// Model-level (ModelMessage) pruning — runs during the agentic loop
// ---------------------------------------------------------------------------

/**
 * A tool-result content part inside a ModelMessage with role "tool".
 * Shape: { type: "tool-result", toolCallId, toolName, output, providerOptions? }
 */
interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
  providerOptions?: unknown;
}

const isModelToolOutput = (
  output: unknown,
): output is { type: string; value?: unknown } =>
  typeof output === "object" &&
  output !== null &&
  !Array.isArray(output) &&
  typeof (output as { type?: unknown }).type === "string";

const unwrapModelToolOutput = (output: unknown): unknown =>
  isModelToolOutput(output) && Object.hasOwn(output, "value")
    ? output.value
    : output;

const toTextModelToolOutput = (value: string) => ({
  type: "text" as const,
  value,
});

export const MODEL_IMAGE_TOOL_RESULT_LIMIT = 3;
export const ELIDED_IMAGE_TOOL_RESULT_MESSAGE =
  "[Older image tool result omitted to bound Agent context. Re-run the view action if visual inspection is still needed.]";

export interface ModelImageToolResultLimit {
  messages: Array<Record<string, unknown>>;
  totalImageCount: number;
  elidedImageCount: number;
}

/** Identifies image blocks supported by AI SDK model tool-result content. */
const isModelImageOutputPart = (part: unknown): boolean =>
  typeof part === "object" &&
  part !== null &&
  ((part as { type?: unknown }).type === "image-data" ||
    (part as { type?: unknown }).type === "image" ||
    (part as { type?: unknown }).type === "image-url");

/** Preserves an AI SDK output wrapper while replacing its underlying value. */
const replaceModelToolOutputValue = (
  output: unknown,
  value: unknown,
): unknown =>
  isModelToolOutput(output) && Object.hasOwn(output, "value")
    ? { ...output, value }
    : value;

/**
 * Keeps only the newest image blocks returned by tools during an agentic loop.
 *
 * Image payloads are much heavier than their token estimate suggests and can
 * otherwise accumulate across consecutive file view calls. Text blocks in the
 * same result are preserved so paths, dimensions, and other evidence remain
 * available to the model.
 */
export function limitModelImageToolResults(
  messages: Array<Record<string, unknown>>,
  maxImages: number = MODEL_IMAGE_TOOL_RESULT_LIMIT,
): ModelImageToolResultLimit {
  const normalizedMaxImages = Math.max(0, Math.floor(maxImages));
  let totalImageCount = 0;
  const imagePartsToElide = new Set<string>();

  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const message = messages[mi];
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;

    for (let pi = message.content.length - 1; pi >= 0; pi--) {
      const part = message.content[pi] as ToolResultPart;
      if (part.type !== "tool-result") continue;

      const outputValue = unwrapModelToolOutput(part.output);
      if (!Array.isArray(outputValue)) continue;

      for (let oi = outputValue.length - 1; oi >= 0; oi--) {
        if (!isModelImageOutputPart(outputValue[oi])) continue;
        totalImageCount++;
        if (totalImageCount > normalizedMaxImages) {
          imagePartsToElide.add(`${mi}:${pi}:${oi}`);
        }
      }
    }
  }

  if (imagePartsToElide.size === 0) {
    return {
      messages,
      totalImageCount,
      elidedImageCount: 0,
    };
  }

  const limitedMessages = messages.map((message, mi) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }

    let messageChanged = false;
    const content = message.content.map((rawPart, pi) => {
      const part = rawPart as ToolResultPart;
      if (part.type !== "tool-result") return rawPart;

      const outputValue = unwrapModelToolOutput(part.output);
      if (!Array.isArray(outputValue)) return rawPart;

      let outputChanged = false;
      const limitedOutput = outputValue.map((outputPart, oi) => {
        if (!imagePartsToElide.has(`${mi}:${pi}:${oi}`)) return outputPart;
        outputChanged = true;
        return {
          type: "text" as const,
          text: ELIDED_IMAGE_TOOL_RESULT_MESSAGE,
        };
      });

      if (!outputChanged) return rawPart;
      messageChanged = true;
      return {
        ...part,
        output: replaceModelToolOutputValue(part.output, limitedOutput),
      };
    });

    return messageChanged ? { ...message, content } : message;
  });

  return {
    messages: limitedMessages,
    totalImageCount,
    elidedImageCount: imagePartsToElide.size,
  };
}

export interface ModelPruneResult {
  messages: Array<Record<string, unknown>>;
  prunedCount: number;
  tokensSaved: number;
  totalToolOutputTokens: number;
  toolOutputCount: number;
  skipReason:
    "no-tool-outputs" | "within-budget" | "below-minimum-savings" | null;
}

/**
 * Prunes old tool-result outputs in ModelMessage[] (model-level messages).
 *
 * This runs inside prepareStep to prune tool outputs that accumulate
 * during the agentic loop (up to 100 tool calls per streamText invocation).
 *
 * ModelMessage format:
 *   assistant: { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] }
 *   tool:      { role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output }] }
 *
 * To build rich placeholders, we first index tool-call input by toolCallId
 * from assistant messages, then correlate with tool-result outputs.
 */
export function pruneModelMessages(
  messages: Array<Record<string, unknown>>,
  budget: number = TOOL_OUTPUT_TOKEN_BUDGET,
  minimumSavings: number = PRUNE_MINIMUM_SAVINGS,
): ModelPruneResult {
  // Step 1: Index tool-call args by toolCallId for placeholder building
  const argsById = new Map<string, unknown>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (p.type === "tool-call" && typeof p.toolCallId === "string") {
        argsById.set(p.toolCallId, p.input ?? p.args);
      }
    }
  }

  // Step 2: Collect tool-result entries newest→oldest
  let remainingBudget = budget;
  const toolEntries: Array<{
    msgIdx: number;
    partIdx: number;
    toolName: string;
    toolCallId: string;
    output: unknown;
    tokens: number;
  }> = [];

  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    if (msg.role !== "tool") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (let pi = (content as unknown[]).length - 1; pi >= 0; pi--) {
      const part = (content as unknown[])[pi] as ToolResultPart;
      if (
        part.type !== "tool-result" ||
        !part.toolName ||
        PROTECTED_TOOLS.has(part.toolName)
      )
        continue;

      const modelOutputValue = unwrapModelToolOutput(part.output);

      // Skip compact placeholders, but allow natural string outputs to prune.
      if (isCompactPlaceholderOutput(modelOutputValue)) continue;
      if (part.output == null) continue;

      const tokens = countOutputTokens(modelOutputValue);
      toolEntries.push({
        msgIdx: mi,
        partIdx: pi,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        output: modelOutputValue,
        tokens,
      });
    }
  }

  if (toolEntries.length === 0) {
    return {
      messages,
      prunedCount: 0,
      tokensSaved: 0,
      totalToolOutputTokens: 0,
      toolOutputCount: 0,
      skipReason: "no-tool-outputs",
    };
  }

  const totalToolOutputTokens = toolEntries.reduce((s, e) => s + e.tokens, 0);

  // Step 3: Determine which to prune
  let prunedCount = 0;
  let tokensSaved = 0;
  const toPrune = new Set<string>();

  for (const entry of toolEntries) {
    if (remainingBudget <= 0) {
      toPrune.add(`${entry.msgIdx}:${entry.partIdx}`);
      prunedCount++;
      const args = argsById.get(entry.toolCallId);
      const placeholder = buildPlaceholderFromParts(
        entry.toolName,
        args,
        entry.output,
      );
      tokensSaved += entry.tokens - safeCountTokens(placeholder);
      continue;
    }
    remainingBudget -= entry.tokens;
  }

  if (prunedCount === 0 || tokensSaved < minimumSavings) {
    return {
      messages,
      prunedCount: 0,
      tokensSaved: 0,
      totalToolOutputTokens,
      toolOutputCount: toolEntries.length,
      skipReason: prunedCount === 0 ? "within-budget" : "below-minimum-savings",
    };
  }

  // Step 4: Build new messages with pruned tool-result outputs
  const newMessages = messages.map((msg, mi) => {
    if (msg.role !== "tool") return msg;
    const content = msg.content as unknown[];
    if (!Array.isArray(content)) return msg;

    const hasPartsToPrune = content.some((_, pi) => toPrune.has(`${mi}:${pi}`));
    if (!hasPartsToPrune) return msg;

    const newContent = content.map((part, pi) => {
      if (!toPrune.has(`${mi}:${pi}`)) return part;

      const resultPart = part as ToolResultPart;
      const args = argsById.get(resultPart.toolCallId);
      const placeholder = buildPlaceholderFromParts(
        resultPart.toolName,
        args,
        unwrapModelToolOutput(resultPart.output),
      );

      return { ...resultPart, output: toTextModelToolOutput(placeholder) };
    });

    return { ...msg, content: newContent };
  });

  return {
    messages: newMessages,
    prunedCount,
    tokensSaved,
    totalToolOutputTokens,
    toolOutputCount: toolEntries.length,
    skipReason: null,
  };
}

/**
 * Filters out assistant messages with empty or whitespace-only content.
 *
 * convertToModelMessages() splits multi-step UIMessages at step-start boundaries.
 * When a step contains only reasoning (no text or tool calls), it produces an
 * assistant ModelMessage with content: [] — which strict providers like Moonshot AI
 * reject with "must not be empty" errors.
 *
 * Safe to remove (not patch) because reasoning-only steps have no tool calls,
 * so removing them won't orphan any subsequent tool messages.
 */
export function filterEmptyAssistantMessages<T extends Record<string, unknown>>(
  messages: T[],
): T[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const content = msg.content;
    // Handle non-array content: empty string, null, undefined are all empty
    if (!Array.isArray(content)) {
      if (content == null) return false;
      if (typeof content === "string") return !!content.trim();
      return true;
    }
    if (content.length === 0) return false;
    return content.some((part: any) => {
      if (part.type === "text") return !!part.text?.trim();
      // Reasoning parts are stripped by the AI SDK before the HTTP request,
      // so they don't count as substantive content for the provider.
      if (part.type === "reasoning" || part.type === "redacted-reasoning")
        return false;
      return true; // tool-call, file, etc. are substantive
    });
  });
}

const ANTHROPIC_CONTINUE_MESSAGE = {
  role: "user",
  content:
    "Continue from the previous assistant message. Do not repeat completed work.",
} as const;

export type PromptMessage = Record<string, unknown> & {
  role?: unknown;
  content?: unknown;
};

export type AnthropicPromptRepairAction =
  "none" | "appended_continue" | "trimmed";

export type AnthropicPromptRepairReason =
  | "not_trailing_assistant"
  | "useful_assistant_tail"
  | "no_useful_content"
  | "dangling_tool_call";

export type AppliedAnthropicPromptRepairReason = Exclude<
  AnthropicPromptRepairReason,
  "not_trailing_assistant"
>;

export interface AppliedAnthropicPromptRepair {
  messages: PromptMessage[];
  action: Exclude<AnthropicPromptRepairAction, "none">;
  reason: AppliedAnthropicPromptRepairReason;
  trailingAssistantContentTypes?: string[];
}

export interface NoAnthropicPromptRepair {
  messages: PromptMessage[];
  action: "none";
  reason: "not_trailing_assistant";
}

export type AnthropicPromptRepairTelemetry =
  AppliedAnthropicPromptRepair | NoAnthropicPromptRepair;

const getContentTypes = (content: unknown): string[] | undefined => {
  if (typeof content === "string") return ["text"];
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part: any) => part?.type)
    .filter((type: unknown): type is string => typeof type === "string");
};

const hasDanglingAssistantToolCall = (content: unknown): boolean => {
  if (!Array.isArray(content)) return false;
  return content.some((part: any) => part?.type === "tool-call");
};

const hasUsefulAssistantContent = (content: unknown): boolean => {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return content != null;

  return content.some((part: any) => {
    if (part?.type === "text") return !!part.text?.trim();
    if (part?.type === "reasoning" || part?.type === "redacted-reasoning") {
      return false;
    }
    if (part?.type === "tool-call") return false;
    return true;
  });
};

/**
 * Anthropic treats a final assistant message in the prompt as an assistant
 * prefill. Claude Opus 4.6 / Sonnet 4.6 reject prefill, so before calling an
 * Anthropic model we ensure the prompt does not end with assistant content.
 *
 * When the trailing assistant message has useful non-tool context, preserve it
 * and append a provider-only user continuation. If it is empty/reasoning-only
 * or contains a dangling tool call, trim it to avoid follow-up provider errors.
 */
export function repairAnthropicModelMessagesWithTelemetry(
  messages: PromptMessage[],
): AnthropicPromptRepairTelemetry {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "assistant") {
    return {
      messages,
      action: "none",
      reason: "not_trailing_assistant",
    };
  }

  const trailingAssistantContentTypes = getContentTypes(lastMessage.content);

  if (hasDanglingAssistantToolCall(lastMessage.content)) {
    return {
      messages: messages.slice(0, -1),
      action: "trimmed",
      reason: "dangling_tool_call",
      trailingAssistantContentTypes,
    };
  }

  if (hasUsefulAssistantContent(lastMessage.content)) {
    return {
      messages: [...messages, ANTHROPIC_CONTINUE_MESSAGE],
      action: "appended_continue",
      reason: "useful_assistant_tail",
      trailingAssistantContentTypes,
    };
  }

  return {
    messages: messages.slice(0, -1),
    action: "trimmed",
    reason: "no_useful_content",
    trailingAssistantContentTypes,
  };
}

export function repairAnthropicModelMessages(
  messages: PromptMessage[],
): PromptMessage[] {
  return repairAnthropicModelMessagesWithTelemetry(messages).messages;
}
