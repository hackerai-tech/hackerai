import {
  UIMessage,
  generateText,
  convertToModelMessages,
  LanguageModel,
  ToolSet,
  ModelMessage,
} from "ai";
import { v4 as uuidv4 } from "uuid";
import {
  getMaxTokensForSubscription,
  countMessagesTokens,
  truncateContent,
  safeCountTokens,
} from "@/lib/token-utils";
import { saveChatSummary } from "@/lib/db/actions";
import { SubscriptionTier, ChatMode, Todo } from "@/types";
import type { Id } from "@/convex/_generated/dataModel";
import { createPromptSerializationTools } from "@/lib/ai/tools/prompt-serialization";

import {
  MESSAGES_TO_KEEP_UNSUMMARIZED,
  SUMMARY_INPUT_MAX_TOKENS,
  SUMMARY_OVERFLOW_TEXT_PART_MAX_TOKENS,
  SUMMARY_OVERFLOW_TOOL_OUTPUT_MAX_TOKENS,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_TODO_BLOCK_MAX_TOKENS,
  SUMMARY_TODO_CONTENT_MAX_TOKENS,
  SUMMARY_TODO_MAX_ITEMS,
  SUMMARY_TOOL_OUTPUT_MAX_TOKENS,
  getSummarizationThresholdTokens,
} from "./constants";
import {
  AGENT_SUMMARIZATION_PROMPT,
  ASK_SUMMARIZATION_PROMPT,
} from "./prompts";
import type { RetainedTailMetadata } from "./retained-tail";

export interface SummarizationUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCompactedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export interface SummaryPersistenceMetadata {
  reason: "token_threshold" | "provider_input_threshold" | "provider_pressure";
  promptVersion: string;
  model?: string;
  status: "completed";
  transcriptPath?: string;
  retainedTail?: RetainedTailMetadata;
}

export interface SummarizationResult {
  /** True only when summary generation was actually attempted. */
  summarizationAttempted: boolean;
  needsSummarization: boolean;
  summarizedMessages: UIMessage[];
  cutoffMessageId: string | null;
  summaryText: string | null;
  summarizationUsage?: SummarizationUsage;
}

export const NO_SUMMARIZATION = (
  messages: UIMessage[],
): SummarizationResult => ({
  summarizationAttempted: false,
  needsSummarization: false,
  summarizedMessages: messages,
  cutoffMessageId: null,
  summaryText: null,
});

export const getSummarizationPrompt = (mode: ChatMode): string =>
  mode === "agent" ? AGENT_SUMMARIZATION_PROMPT : ASK_SUMMARIZATION_PROMPT;

export const resolveSummarizationMaxTokens = (
  subscription: SubscriptionTier,
  maxTokensOverride?: number,
): number => {
  if (
    typeof maxTokensOverride === "number" &&
    Number.isFinite(maxTokensOverride) &&
    maxTokensOverride > 0
  ) {
    return maxTokensOverride;
  }

  return getMaxTokensForSubscription(subscription);
};

export const isAboveTokenThreshold = (
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  fileTokens: Record<Id<"files">, number>,
  systemPromptTokens: number = 0,
  providerInputTokens: number = 0,
  maxTokensOverride?: number,
): boolean => {
  const maxTokens = resolveSummarizationMaxTokens(
    subscription,
    maxTokensOverride,
  );
  const threshold = getSummarizationThresholdTokens(maxTokens);

  // If the provider already reported input tokens exceeding the threshold,
  // trust that over our local gpt-tokenizer estimate (which misses tool
  // schemas, formatting overhead, and uses a different tokenizer).
  if (providerInputTokens > threshold) {
    return true;
  }

  const totalTokens =
    countMessagesTokens(uiMessages, fileTokens) + systemPromptTokens;
  return totalTokens > threshold;
};

export const splitMessages = (
  uiMessages: UIMessage[],
): { messagesToSummarize: UIMessage[]; lastMessages: UIMessage[] } => {
  if (MESSAGES_TO_KEEP_UNSUMMARIZED === 0) {
    return { messagesToSummarize: uiMessages, lastMessages: [] };
  }
  return {
    messagesToSummarize: uiMessages.slice(0, -MESSAGES_TO_KEEP_UNSUMMARIZED),
    lastMessages: uiMessages.slice(-MESSAGES_TO_KEEP_UNSUMMARIZED),
  };
};

export const isSummaryMessage = (message: UIMessage): boolean => {
  if (message.parts.length === 0) return false;
  const firstPart = message.parts[0];
  if (firstPart.type !== "text") return false;
  return (firstPart as { type: "text"; text: string }).text.includes(
    "<context_summary>",
  );
};

export const extractSummaryText = (message: UIMessage): string | null => {
  if (!isSummaryMessage(message)) return null;
  const text = (message.parts[0] as { type: "text"; text: string }).text;
  const match = text.match(
    /<context_summary>\n?([\s\S]*?)\n?<\/context_summary>/,
  );
  return match ? match[1] : null;
};

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

const stringifyToolOutput = (output: unknown): string => {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
};

const toTextModelToolOutput = (value: string) => ({
  type: "text" as const,
  value,
});

const toTextModelContentPart = (text: string) => ({
  type: "text" as const,
  text,
});

const DATA_URI_PATTERN = /^data:([^;,]+)(?:;[^,]*)?,/i;
const LONG_URL_LENGTH = 512;
const RAW_SNAPSHOT_PLACEHOLDER = "[rawSnapshot omitted for summary]";

const MEDIA_KEY_PATTERN =
  /^(image|images|screenshot|screenshots|attachment|attachments|media|file|files|blob|base64|data|url|uri)$/i;
const ALWAYS_OMIT_MEDIA_STRING_KEY_PATTERN = /^(base64|blob)$/i;

const getStringField = (
  value: Record<string, unknown>,
  keys: string[],
): string | undefined => {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) return field;
  }
  return undefined;
};

const describeDataUri = (value: string): string | null => {
  const match = value.match(DATA_URI_PATTERN);
  if (!match) return null;
  return `[Attached ${match[1] || "media"}: data URI omitted]`;
};

const describeAttachmentObject = (
  value: Record<string, unknown>,
  keyHint?: string,
): string | null => {
  const mime =
    getStringField(value, ["mime", "mimeType", "mediaType"]) ??
    (typeof value.type === "string" && value.type.includes("/")
      ? value.type
      : undefined);
  const filename =
    getStringField(value, ["filename", "fileName", "name", "path"]) ?? "file";
  const hasPayload = [
    "url",
    "uri",
    "image",
    "data",
    "base64",
    "content",
    "value",
  ].some((key) => value[key] != null && value[key] !== "");
  const keySuggestsMedia = keyHint ? MEDIA_KEY_PATTERN.test(keyHint) : false;
  const typeSuggestsMedia =
    typeof value.type === "string" && MEDIA_KEY_PATTERN.test(value.type);

  if ((mime || keySuggestsMedia || typeSuggestsMedia) && hasPayload) {
    return `[Attached ${mime ?? "media"}: ${filename}]`;
  }

  return null;
};

const sanitizeMediaPayloads = (
  value: unknown,
  keyHint?: string,
  seen = new WeakSet<object>(),
): { value: unknown; changed: boolean } => {
  if (typeof value === "string") {
    const dataUri = describeDataUri(value);
    if (dataUri) return { value: dataUri, changed: true };

    if (keyHint === "rawSnapshot") {
      return { value: RAW_SNAPSHOT_PLACEHOLDER, changed: true };
    }

    if (
      keyHint &&
      MEDIA_KEY_PATTERN.test(keyHint) &&
      (ALWAYS_OMIT_MEDIA_STRING_KEY_PATTERN.test(keyHint) ||
        value.length > LONG_URL_LENGTH)
    ) {
      return {
        value: `[${keyHint} omitted for summary: ${value.length} chars]`,
        changed: true,
      };
    }

    return { value, changed: false };
  }

  if (value === null || typeof value !== "object") {
    return { value, changed: false };
  }

  if (seen.has(value)) {
    return { value: "[circular payload omitted]", changed: true };
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      let changed = false;
      const items = value.map((item) => {
        const result = sanitizeMediaPayloads(item, keyHint, seen);
        changed ||= result.changed;
        return result.value;
      });
      return { value: changed ? items : value, changed };
    }

    const record = value as Record<string, unknown>;
    const attachment = describeAttachmentObject(record, keyHint);
    if (attachment) return { value: attachment, changed: true };

    let changed = false;
    const sanitized: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(record)) {
      if (key === "rawSnapshot") {
        sanitized[key] = RAW_SNAPSHOT_PLACEHOLDER;
        changed = true;
        continue;
      }

      const result = sanitizeMediaPayloads(childValue, key, seen);
      sanitized[key] = result.value;
      changed ||= result.changed;
    }

    return { value: changed ? sanitized : value, changed };
  } finally {
    seen.delete(value);
  }
};

const sanitizeModelContentPart = (
  part: unknown,
): { value: unknown; changed: boolean } => {
  if (part === null || typeof part !== "object") {
    return sanitizeMediaPayloads(part);
  }

  const attachment = describeAttachmentObject(part as Record<string, unknown>);
  if (attachment) {
    return { value: toTextModelContentPart(attachment), changed: true };
  }

  const sanitized = sanitizeMediaPayloads(part);
  if (typeof sanitized.value === "string") {
    return { value: toTextModelContentPart(sanitized.value), changed: true };
  }
  return sanitized;
};

/**
 * Build a summarization-only projection of model messages.
 *
 * This keeps tool-call/tool-result structure intact while bounding individual
 * tool outputs. The full raw transcript can still be persisted separately; the
 * summarizer only needs enough head/tail detail to preserve important facts.
 */
export const compactModelMessagesForSummarization = <T extends ModelMessage>(
  messages: T[],
  maxToolOutputTokens: number = SUMMARY_TOOL_OUTPUT_MAX_TOKENS,
): T[] => {
  let changed = false;

  const compacted = messages.map((message) => {
    if (!Array.isArray(message.content)) {
      const sanitizedContent = sanitizeMediaPayloads(message.content);
      if (!sanitizedContent.changed) return message;

      changed = true;
      return { ...message, content: sanitizedContent.value } as T;
    }

    let contentChanged = false;
    const content = message.content.map((part) => {
      const partAny = part as Record<string, unknown>;
      if (
        message.role !== "tool" ||
        partAny.type !== "tool-result" ||
        partAny.output == null
      ) {
        const sanitizedPart = sanitizeModelContentPart(part);
        if (sanitizedPart.changed) {
          contentChanged = true;
          return sanitizedPart.value as typeof part;
        }
        return part;
      }

      const outputValue = unwrapModelToolOutput(partAny.output);
      const sanitizedOutput = sanitizeMediaPayloads(outputValue);
      const outputText = stringifyToolOutput(sanitizedOutput.value);
      const outputTokens = safeCountTokens(outputText);
      if (!sanitizedOutput.changed && outputTokens <= maxToolOutputTokens) {
        return part;
      }

      contentChanged = true;
      const preview =
        outputTokens > maxToolOutputTokens
          ? truncateContent(
              outputText,
              "\n[Tool output shortened: middle omitted]\n",
              maxToolOutputTokens,
            )
          : outputText;
      const toolName =
        typeof partAny.toolName === "string" ? partAny.toolName : "tool";
      const prefix = sanitizedOutput.changed
        ? `[${toolName} output preview: media payloads omitted`
        : `[${toolName} output preview: shortened from ${outputTokens} tokens`;

      return {
        ...partAny,
        output: toTextModelToolOutput(
          `${prefix}${outputTokens > maxToolOutputTokens ? `; shortened from ${outputTokens} tokens` : ""}]\n${preview}`,
        ),
      } as typeof part;
    });

    if (!contentChanged) return message;
    changed = true;
    return { ...message, content } as T;
  });

  return changed ? compacted : messages;
};

const getToolPartIds = (
  message: ModelMessage,
  partType: "tool-call" | "tool-result",
): string[] => {
  if (!Array.isArray(message.content)) return [];

  return message.content.flatMap((part) => {
    const partRecord = part as Record<string, unknown>;
    return partRecord.type === partType &&
      typeof partRecord.toolCallId === "string"
      ? [partRecord.toolCallId]
      : [];
  });
};

/**
 * Return the newest complete assistant tool-call plus matching tool-result
 * transaction. Keeping this structure beside a generated summary prevents a
 * model from repeating successful work when the summary omits its completion.
 */
export const getLatestCompletedToolTransaction = (
  messages: ModelMessage[],
): ModelMessage[] => {
  for (
    let assistantIndex = messages.length - 1;
    assistantIndex >= 0;
    assistantIndex--
  ) {
    const assistantMessage = messages[assistantIndex];
    if (assistantMessage.role !== "assistant") continue;

    const toolCallIds = getToolPartIds(assistantMessage, "tool-call");
    if (toolCallIds.length === 0) continue;

    const expectedToolCallIds = new Set(toolCallIds);
    const completedToolCallIds = new Set<string>();
    const toolMessages: ModelMessage[] = [];

    for (
      let messageIndex = assistantIndex + 1;
      messageIndex < messages.length;
      messageIndex++
    ) {
      const message = messages[messageIndex];
      if (message.role !== "tool") break;

      const resultIds = getToolPartIds(message, "tool-result");
      if (resultIds.length === 0) continue;
      if (
        resultIds.some((toolCallId) => !expectedToolCallIds.has(toolCallId))
      ) {
        return [];
      }

      resultIds.forEach((toolCallId) => completedToolCallIds.add(toolCallId));
      toolMessages.push(message);
    }

    if (
      toolMessages.length === 0 ||
      toolCallIds.some((toolCallId) => !completedToolCallIds.has(toolCallId))
    ) {
      return [];
    }

    return compactModelMessagesForSummarization([
      assistantMessage,
      ...toolMessages,
    ]);
  }

  return [];
};

const stringifySummaryMessages = (messages: ModelMessage[]): string => {
  try {
    return JSON.stringify(messages);
  } catch {
    return String(messages);
  }
};

export const estimateSummaryInputTokens = (messages: ModelMessage[]): number =>
  safeCountTokens(stringifySummaryMessages(messages));

const truncateSummaryText = (text: string, maxTokens: number): string =>
  safeCountTokens(text) > maxTokens
    ? truncateContent(
        text,
        "\n[Summary input shortened: middle omitted]\n",
        maxTokens,
      )
    : text;

const compactContentPartForSummaryBudget = (
  part: unknown,
  maxTextPartTokens: number,
): { value: unknown; changed: boolean } => {
  if (part === null || typeof part !== "object") {
    return { value: part, changed: false };
  }

  const record = part as Record<string, unknown>;

  if (record.type === "text" && typeof record.text === "string") {
    const text = truncateSummaryText(record.text, maxTextPartTokens);
    return {
      value: text === record.text ? part : { ...record, text },
      changed: text !== record.text,
    };
  }

  if (record.type === "tool-call" && record.input != null) {
    const inputText = stringifyToolOutput(record.input);
    if (safeCountTokens(inputText) <= maxTextPartTokens) {
      return { value: part, changed: false };
    }
    const toolName =
      typeof record.toolName === "string" ? record.toolName : "tool";
    return {
      value: {
        ...record,
        input: {
          summary: `[${toolName} input omitted to fit summary budget: ${inputText.length} chars]`,
        },
      },
      changed: true,
    };
  }

  return { value: part, changed: false };
};

const compactTextPartsForSummaryBudget = <T extends ModelMessage>(
  messages: T[],
  maxTextPartTokens: number,
): T[] => {
  let changed = false;

  const compacted = messages.map((message) => {
    if (typeof message.content === "string") {
      const content = truncateSummaryText(message.content, maxTextPartTokens);
      if (content === message.content) return message;
      changed = true;
      return { ...message, content } as T;
    }

    if (!Array.isArray(message.content)) return message;

    let contentChanged = false;
    const content = message.content.map((part) => {
      const compactedPart = compactContentPartForSummaryBudget(
        part,
        maxTextPartTokens,
      );
      if (compactedPart.changed) {
        contentChanged = true;
        return compactedPart.value as typeof part;
      }
      return part;
    });

    if (!contentChanged) return message;
    changed = true;
    return { ...message, content } as T;
  });

  return changed ? compacted : messages;
};

const fallbackSummaryInputMessages = (
  messages: ModelMessage[],
  maxInputTokens: number,
): ModelMessage[] => {
  const transcript = truncateContent(
    stringifySummaryMessages(messages),
    "\n[Summary input transcript shortened: middle omitted]\n",
    Math.max(1, maxInputTokens - 256),
  );

  return [
    {
      role: "user",
      content: `[Summary input transcript was too large after compaction; sanitized transcript follows.]\n${transcript}`,
    },
  ] as ModelMessage[];
};

export const boundModelMessagesForSummarization = (
  messages: ModelMessage[],
  {
    maxInputTokens = SUMMARY_INPUT_MAX_TOKENS,
    overflowToolOutputMaxTokens = SUMMARY_OVERFLOW_TOOL_OUTPUT_MAX_TOKENS,
    overflowTextPartMaxTokens = SUMMARY_OVERFLOW_TEXT_PART_MAX_TOKENS,
  }: {
    maxInputTokens?: number;
    overflowToolOutputMaxTokens?: number;
    overflowTextPartMaxTokens?: number;
  } = {},
): ModelMessage[] => {
  if (maxInputTokens <= 0) return fallbackSummaryInputMessages(messages, 1);
  if (estimateSummaryInputTokens(messages) <= maxInputTokens) return messages;

  let compacted = compactModelMessagesForSummarization(
    messages,
    overflowToolOutputMaxTokens,
  );
  compacted = compactTextPartsForSummaryBudget(
    compacted,
    overflowTextPartMaxTokens,
  );
  if (estimateSummaryInputTokens(compacted) <= maxInputTokens) {
    return compacted;
  }

  compacted = compactTextPartsForSummaryBudget(compacted, 128);
  if (estimateSummaryInputTokens(compacted) <= maxInputTokens) {
    return compacted;
  }

  return fallbackSummaryInputMessages(compacted, maxInputTokens);
};

const getLanguageModelIdentifier = (
  languageModel: LanguageModel,
): string | undefined => {
  const record = languageModel as unknown as Record<string, unknown>;
  for (const key of ["modelId", "modelID", "id"] as const) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
};

export const generateSummaryText = async (
  messagesToSummarize: UIMessage[],
  languageModel: LanguageModel,
  mode: ChatMode,
  chatSystemPrompt: string,
  hasExistingSummary: boolean,
  tools?: ToolSet,
  providerOptions?: Record<string, Record<string, unknown>>,
  abortSignal?: AbortSignal,
  modelMessages?: ModelMessage[],
  summaryInputMaxTokens: number = SUMMARY_INPUT_MAX_TOKENS,
): Promise<{ text: string; usage: SummarizationUsage }> => {
  const summarizationPrompt = getSummarizationPrompt(mode);

  const incrementalNote = hasExistingSummary
    ? `\n\nIMPORTANT: You are performing an INCREMENTAL summarization. The conversation above contains a <context_summary> message with a previous summary of earlier conversation. Produce a single, unified summary that merges the previous summary with the NEW messages that follow it. Do NOT summarize the summary — integrate new information into a comprehensive updated summary.`
    : "";

  // Tools are included solely to match the main streamText prefix for provider
  // cache-hits. Execute functions are replaced with no-ops so that if the model
  // attempts a tool call it gets an empty result and continues with text.
  const nopTools = tools
    ? Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [
          name,
          {
            ...tool,
            execute: async () =>
              "Tool calls are not allowed during summarization.",
          },
        ]),
      )
    : undefined;

  const sourceModelMessages =
    modelMessages ??
    (await convertToModelMessages(messagesToSummarize, {
      tools: tools ? createPromptSerializationTools(tools) : undefined,
    }));
  const compactedModelMessages = compactModelMessagesForSummarization(
    sourceModelMessages as ModelMessage[],
  );
  const summaryModelMessages = boundModelMessagesForSummarization(
    compactedModelMessages,
    { maxInputTokens: summaryInputMaxTokens },
  );
  const estimatedCompactedInputTokens =
    estimateSummaryInputTokens(summaryModelMessages);

  const result = await generateText({
    model: languageModel,
    system: chatSystemPrompt,
    tools: nopTools,
    abortSignal,

    providerOptions: providerOptions as any,
    messages: [
      ...summaryModelMessages,
      {
        role: "user" as const,
        content: `${summarizationPrompt}${incrementalNote}\n\nSummarize the above conversation using the structured format. Output ONLY the summary — do not continue the conversation or role-play as the assistant.`,
      },
    ],
  });

  const providerCost = (result.usage as { raw?: { cost?: number } })?.raw?.cost;
  const details = (
    result.usage as {
      inputTokenDetails?: {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    }
  )?.inputTokenDetails;
  return {
    text: result.text,
    usage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      estimatedCompactedInputTokens,
      ...(details?.cacheReadTokens
        ? { cacheReadTokens: details.cacheReadTokens }
        : undefined),
      ...(details?.cacheWriteTokens
        ? { cacheWriteTokens: details.cacheWriteTokens }
        : undefined),
      ...(providerCost ? { cost: providerCost } : undefined),
    },
  };
};

export const buildSummaryPersistenceMetadata = ({
  providerInputTokens,
  threshold,
  languageModel,
  transcriptPath,
  retainedTail,
  reason,
}: {
  providerInputTokens: number;
  threshold: number;
  languageModel: LanguageModel;
  transcriptPath?: string | null;
  retainedTail?: RetainedTailMetadata;
  reason?: SummaryPersistenceMetadata["reason"];
}): SummaryPersistenceMetadata => ({
  reason:
    reason ??
    (providerInputTokens > threshold
      ? "provider_input_threshold"
      : "token_threshold"),
  promptVersion: SUMMARY_PROMPT_VERSION,
  model: getLanguageModelIdentifier(languageModel),
  status: "completed",
  transcriptPath: transcriptPath ?? undefined,
  retainedTail,
});

export const buildSummaryMessage = (
  summaryText: string,
  todos: Todo[] = [],
): UIMessage => {
  let text = `<context_summary>\n${summaryText}\n</context_summary>`;

  if (todos.length > 0) {
    const visibleTodos = todos.slice(0, SUMMARY_TODO_MAX_ITEMS);
    const omittedCount = todos.length - visibleTodos.length;
    const todoLines = visibleTodos
      .map((todo) => {
        const content = truncateContent(
          todo.content,
          " [... truncated]",
          SUMMARY_TODO_CONTENT_MAX_TOKENS,
        );
        return `- [${todo.status}] ${content}`;
      })
      .concat(
        omittedCount > 0
          ? [`- [... ${omittedCount} additional todos omitted ...]`]
          : [],
      )
      .join("\n");
    const boundedTodoLines = truncateContent(
      todoLines,
      "\n[... current_todos truncated ...]",
      SUMMARY_TODO_BLOCK_MAX_TOKENS,
    );
    text += `\n<current_todos>\n${boundedTodoLines}\n</current_todos>`;
  }

  return {
    id: uuidv4(),
    role: "user",
    parts: [{ type: "text", text }],
  };
};

export const persistSummary = async (
  chatId: string | null,
  summaryText: string,
  cutoffMessageId: string,
  metadata?: SummaryPersistenceMetadata,
): Promise<void> => {
  if (!chatId) return;

  try {
    await saveChatSummary({
      chatId,
      summaryText,
      summaryUpToMessageId: cutoffMessageId,
      metadata,
    });
  } catch (error) {
    console.error("[Summarization] Failed to save summary:", error);
  }
};
