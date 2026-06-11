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

import {
  MESSAGES_TO_KEEP_UNSUMMARIZED,
  SUMMARIZATION_THRESHOLD_PERCENTAGE,
  SUMMARY_TODO_BLOCK_MAX_TOKENS,
  SUMMARY_TODO_CONTENT_MAX_TOKENS,
  SUMMARY_TODO_MAX_ITEMS,
  SUMMARY_TOOL_OUTPUT_MAX_TOKENS,
} from "./constants";
import {
  AGENT_SUMMARIZATION_PROMPT,
  ASK_SUMMARIZATION_PROMPT,
} from "./prompts";

export interface SummarizationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export interface SummarizationResult {
  needsSummarization: boolean;
  summarizedMessages: UIMessage[];
  cutoffMessageId: string | null;
  summaryText: string | null;
  summarizationUsage?: SummarizationUsage;
}

export const NO_SUMMARIZATION = (
  messages: UIMessage[],
): SummarizationResult => ({
  needsSummarization: false,
  summarizedMessages: messages,
  cutoffMessageId: null,
  summaryText: null,
});

export const getSummarizationPrompt = (mode: ChatMode): string =>
  mode === "agent" ? AGENT_SUMMARIZATION_PROMPT : ASK_SUMMARIZATION_PROMPT;

export const isAboveTokenThreshold = (
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  fileTokens: Record<Id<"files">, number>,
  systemPromptTokens: number = 0,
  providerInputTokens: number = 0,
): boolean => {
  const maxTokens = getMaxTokensForSubscription(subscription);
  const threshold = Math.floor(maxTokens * SUMMARIZATION_THRESHOLD_PERCENTAGE);

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
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }

    let contentChanged = false;
    const content = message.content.map((part) => {
      const partAny = part as Record<string, unknown>;
      if (partAny.type !== "tool-result" || partAny.output == null) {
        return part;
      }

      const outputValue = unwrapModelToolOutput(partAny.output);
      const outputText = stringifyToolOutput(outputValue);
      const outputTokens = safeCountTokens(outputText);
      if (outputTokens <= maxToolOutputTokens) {
        return part;
      }

      contentChanged = true;
      const preview = truncateContent(
        outputText,
        "\n[Tool output shortened: middle omitted]\n",
        maxToolOutputTokens,
      );
      const toolName =
        typeof partAny.toolName === "string" ? partAny.toolName : "tool";

      return {
        ...partAny,
        output: toTextModelToolOutput(
          `[${toolName} output preview: shortened from ${outputTokens} tokens]\n${preview}`,
        ),
      } as typeof part;
    });

    if (!contentChanged) return message;
    changed = true;
    return { ...message, content } as T;
  });

  return changed ? compacted : messages;
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
    (await convertToModelMessages(messagesToSummarize, { tools }));
  const summaryModelMessages = compactModelMessagesForSummarization(
    sourceModelMessages as ModelMessage[],
  );

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
): Promise<void> => {
  if (!chatId) return;

  try {
    await saveChatSummary({
      chatId,
      summaryText,
      summaryUpToMessageId: cutoffMessageId,
    });
  } catch (error) {
    console.error("[Summarization] Failed to save summary:", error);
  }
};
