import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { myProvider } from "@/lib/ai/providers";
import { STEP_SUMMARIZATION_PROMPT } from "./prompts";
import { stripAnalysisTags } from "./helpers";

export type PersistedStepSummary = {
  text: string;
  upToToolCallId: string;
};

/**
 * Splits model messages into three partitions: initial messages, steps to
 * summarize, and recent steps to keep. The split boundary is determined solely
 * by counting assistant-role messages (each assistant message = one step
 * boundary). If fewer than `stepsToKeep` assistant messages exist in the
 * response portion, nothing is marked for summarization.
 *
 * Invariant: `[...initial, ...toSummarize, ...toKeep]` reconstructs the
 * original `messages` array.
 */
export function splitStepMessages(
  messages: ModelMessage[],
  initialMsgCount: number,
  stepsToKeep: number,
): {
  initialMessages: ModelMessage[];
  stepsToSummarizeMessages: ModelMessage[];
  stepsToKeepMessages: ModelMessage[];
} {
  const initialMessages = messages.slice(0, initialMsgCount);
  const responseMessages = messages.slice(initialMsgCount);

  // Count assistant messages as step boundaries. Each step begins with an
  // assistant message, which may be followed by zero or more tool result messages.
  const stepBoundaries: number[] = [];
  for (let i = 0; i < responseMessages.length; i++) {
    if (responseMessages[i].role === "assistant") {
      stepBoundaries.push(i);
    }
  }

  const keepFromStep = stepBoundaries.length - stepsToKeep;
  if (keepFromStep <= 0) {
    return {
      initialMessages,
      stepsToSummarizeMessages: [],
      stepsToKeepMessages: responseMessages,
    };
  }

  const splitIndex =
    keepFromStep < stepBoundaries.length
      ? stepBoundaries[keepFromStep]
      : responseMessages.length;
  const stepsToSummarizeMessages = responseMessages.slice(0, splitIndex);
  const stepsToKeepMessages = responseMessages.slice(splitIndex);

  return {
    initialMessages,
    stepsToSummarizeMessages,
    stepsToKeepMessages,
  };
}

export async function generateStepSummaryText(
  stepMessages: ModelMessage[],
  existingSummary?: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (stepMessages.length === 0 && existingSummary) {
    return existingSummary;
  }

  if (stepMessages.length === 0 && !existingSummary) {
    return "";
  }

  let system = STEP_SUMMARIZATION_PROMPT;

  if (existingSummary) {
    system +=
      "\n\nIMPORTANT: You are performing an INCREMENTAL summarization. A previous summary of earlier steps exists below. " +
      "Your job is to produce a single, unified summary that merges the previous summary with the NEW step messages provided. " +
      "Do NOT summarize the summary — instead, integrate new information into a comprehensive updated summary.\n\n" +
      `<previous_step_summary>\n${existingSummary}\n</previous_step_summary>`;
  }

  const result = await generateText({
    model: myProvider.languageModel("summarization-model"),
    system,
    abortSignal,
    providerOptions: {
      xai: { store: false },
    },
    messages: [
      ...stepMessages,
      {
        role: "user",
        content:
          "Summarize the above agent steps using the structured format specified in your instructions. First analyze the steps chronologically in <analysis> tags, then output the structured summary. Do not continue the conversation or produce tool calls.",
      },
    ],
  });

  return stripAnalysisTags(result.text);
}

/**
 * Wraps a step summary string in a synthetic `user` ModelMessage with
 * `<step_summary>` tags.  We use `role: "user"` because most LLMs ignore
 * injected assistant messages during continuation — a user message ensures
 * the summary is attended to.
 */
export function buildStepSummaryModelMessage(
  summaryText: string,
): ModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<step_summary>\n${summaryText}\n</step_summary>`,
      },
    ],
  };
}

/**
 * Scans messages backward to find the toolCallId of the last tool-result part.
 * Returns null if no tool results exist.
 */
export function extractLastToolCallId(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "tool-result" &&
        "toolCallId" in part &&
        typeof part.toolCallId === "string"
      ) {
        return part.toolCallId;
      }
    }
  }
  return null;
}

/**
 * Replaces raw tool-call messages covered by a persisted step summary with
 * a synthetic summary message. Returns null if the cutoff tool-call ID is
 * not found or no tool-call assistant messages exist.
 *
 * Scans for:
 *  - The first assistant message whose content contains a `tool-call` part
 *    (marks the beginning of tool-call messages)
 *  - The tool-result message whose `toolCallId` matches `upToToolCallId`
 *    (marks the end of the summarized range)
 *
 * Everything from `firstToolCallIndex` through `cutoffIndex` (inclusive) is
 * replaced with the step summary message.
 */
export function injectPersistedStepSummary(
  messages: ModelMessage[],
  stepSummaryText: string,
  upToToolCallId: string,
): ModelMessage[] | null {
  let firstToolCallIndex = -1;
  let cutoffIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (
      firstToolCallIndex === -1 &&
      msg.role === "assistant" &&
      Array.isArray(msg.content)
    ) {
      const hasToolCall = msg.content.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "tool-call",
      );
      if (hasToolCall) {
        firstToolCallIndex = i;
      }
    }

    if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "tool-result" &&
          "toolCallId" in part &&
          part.toolCallId === upToToolCallId
        ) {
          cutoffIndex = i;
          break;
        }
      }
      if (cutoffIndex !== -1) break;
    }
  }

  if (firstToolCallIndex === -1 || cutoffIndex === -1) {
    return null;
  }

  const summaryMsg = buildStepSummaryModelMessage(stepSummaryText);
  return [
    ...messages.slice(0, firstToolCallIndex),
    summaryMsg,
    ...messages.slice(cutoffIndex + 1),
  ];
}

/**
 * Result of a step-level summarization attempt.
 * - `summarized: true` → caller should use `messages` as the replacement.
 * - `summarized: false` → nothing to do, caller should fall through.
 */
export type StepSummarizationResult =
  | {
      summarized: true;
      messages: ModelMessage[];
      stepSummaryText: string;
      lastSummarizedStepCount: number;
      lastToolCallId: string | null;
    }
  | { summarized: false };

/**
 * Orchestrates one round of step-level summarization: splits messages,
 * generates (or incrementally updates) a summary, and returns the
 * reconstituted message array.
 *
 * This is the single source of truth for the split → summarize → rebuild
 * pipeline, called from both `agent-task.ts` and `chat-handler.ts`.
 */
export async function summarizeSteps(opts: {
  messages: ModelMessage[];
  initialModelMessageCount: number;
  stepsLength: number;
  stepsToKeep: number;
  lastSummarizedStepCount: number;
  existingStepSummary: string | null;
  abortSignal?: AbortSignal;
  /** When message-level summarization also fired, pass the already-compressed
   *  initial messages so they replace the originals in the output. */
  summarizedInitialMessages?: ModelMessage[];
}): Promise<StepSummarizationResult> {
  if (
    opts.stepsLength <= opts.stepsToKeep ||
    opts.stepsLength <= opts.lastSummarizedStepCount
  ) {
    return { summarized: false };
  }

  const { stepsToSummarizeMessages, stepsToKeepMessages } = splitStepMessages(
    opts.messages,
    opts.initialModelMessageCount,
    opts.stepsToKeep,
  );

  if (stepsToSummarizeMessages.length === 0) {
    return { summarized: false };
  }

  const initialMsgs =
    opts.summarizedInitialMessages ??
    opts.messages.slice(0, opts.initialModelMessageCount);

  const stepSummaryText = await generateStepSummaryText(
    stepsToSummarizeMessages,
    opts.existingStepSummary ?? undefined,
    opts.abortSignal,
  );

  const stepSummaryMsg = buildStepSummaryModelMessage(stepSummaryText);

  return {
    summarized: true,
    messages: [...initialMsgs, stepSummaryMsg, ...stepsToKeepMessages],
    stepSummaryText,
    lastSummarizedStepCount: opts.stepsLength,
    lastToolCallId: extractLastToolCallId(stepsToSummarizeMessages),
  };
}
