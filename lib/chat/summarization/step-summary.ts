import {
  generateText,
  LanguageModel,
  type ModelMessage as SDKModelMessage,
} from "ai";
import { STEP_SUMMARIZATION_PROMPT } from "./prompts";

// ModelMessage types - these are what prepareStep receives
// Using loose types since the AI SDK doesn't export ModelMessage directly
type ModelMessageRole = "system" | "user" | "assistant" | "tool";

interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
}

interface TextPart {
  type: "text";
  text: string;
}

type ContentPart = ToolCallPart | ToolResultPart | TextPart | { type: string };

interface ModelMessage {
  role: ModelMessageRole;
  content: string | ContentPart[];
}

const STEP_SUMMARY_TAG = "<step_summary>";
const STEP_SUMMARY_CLOSE_TAG = "</step_summary>";
const MIN_STEPS_TO_SUMMARIZE = 2;

/**
 * Find the index of a tool result message by toolCallId.
 */
export function findToolResultIndex(
  messages: ModelMessage[],
  toolCallId: string,
): number {
  return messages.findIndex(
    (msg) =>
      msg.role === "tool" &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (part) =>
          (part as ToolResultPart).type === "tool-result" &&
          (part as ToolResultPart).toolCallId === toolCallId,
      ),
  );
}

/**
 * Get all toolCallIds from messages in order.
 */
export function getAllToolCallIds(messages: ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ((part as ToolCallPart).type === "tool-call") {
          ids.push((part as ToolCallPart).toolCallId);
        }
      }
    }
  }
  return ids;
}

/**
 * Get the last toolCallId from messages.
 */
export function getLastToolCallId(messages: ModelMessage[]): string | null {
  const ids = getAllToolCallIds(messages);
  return ids.length > 0 ? ids[ids.length - 1] : null;
}

/**
 * Get the second-to-last toolCallId from messages.
 * Used as cutoff point — we keep the last step raw so the model has fresh context.
 */
export function getSecondToLastToolCallId(
  messages: ModelMessage[],
): string | null {
  const ids = getAllToolCallIds(messages);
  return ids.length >= 2 ? ids[ids.length - 2] : null;
}

/**
 * Count completed tool steps (assistant tool-call + tool result pairs).
 */
export function countCompletedToolSteps(messages: ModelMessage[]): number {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ((part as ToolCallPart).type === "tool-call") {
          toolCallIds.add((part as ToolCallPart).toolCallId);
        }
        if ((part as ToolResultPart).type === "tool-result") {
          toolResultIds.add((part as ToolResultPart).toolCallId);
        }
      }
    }
  }

  // A completed step has both a call and a result
  let count = 0;
  for (const id of toolCallIds) {
    if (toolResultIds.has(id)) count++;
  }
  return count;
}

/**
 * Detect if a message is a synthetic step summary message.
 */
export function isStepSummaryMessage(msg: ModelMessage): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") {
    return msg.content.startsWith(STEP_SUMMARY_TAG);
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const first = msg.content[0];
    return (
      (first as TextPart).type === "text" &&
      (first as TextPart).text.startsWith(STEP_SUMMARY_TAG)
    );
  }
  return false;
}

/**
 * Build a step summary user message.
 */
export function buildStepSummaryMessage(summaryText: string): ModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${STEP_SUMMARY_TAG}\n${summaryText}\n${STEP_SUMMARY_CLOSE_TAG}`,
      },
    ],
  };
}

/**
 * Inject step summary into messages, replacing completed tool steps
 * up to (and including) the tool result for upToToolCallId.
 *
 * Keeps:
 * - All pre-tool user messages (initial user query, context_summary, notes)
 * - Messages AFTER the cutoff tool result
 *
 * Replaces:
 * - All assistant+tool message pairs from the first tool call
 *   up to the tool result of upToToolCallId with a single step_summary message
 */
export function injectStepSummary(
  messages: ModelMessage[],
  summaryText: string,
  upToToolCallId: string,
): ModelMessage[] {
  const cutoffIndex = findToolResultIndex(messages, upToToolCallId);
  if (cutoffIndex < 0) {
    // toolCallId not found — return messages unchanged
    return messages;
  }

  // Find the first assistant message with a tool-call (start of tool steps)
  const firstToolStepIndex = messages.findIndex(
    (msg) =>
      msg.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.some((part) => (part as ToolCallPart).type === "tool-call"),
  );

  if (firstToolStepIndex < 0 || firstToolStepIndex > cutoffIndex) {
    return messages;
  }

  const preToolMessages = messages.slice(0, firstToolStepIndex);
  const postCutoffMessages = messages.slice(cutoffIndex + 1);
  const summaryMessage = buildStepSummaryMessage(summaryText);

  return [...preToolMessages, summaryMessage, ...postCutoffMessages];
}

/**
 * Generate step summary text by calling the LLM.
 *
 * If existingSummary is provided, performs incremental summarization
 * (merge old summary + new steps into unified summary).
 */
export async function generateStepSummaryText(
  messages: ModelMessage[],
  languageModel: LanguageModel,
  existingSummary?: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const basePrompt = STEP_SUMMARIZATION_PROMPT;
  const system = existingSummary
    ? `${basePrompt}\n\nIMPORTANT: You are performing an INCREMENTAL step summarization. A previous step summary exists below. Merge it with the NEW tool steps to produce a single, unified step summary.\n\n<previous_step_summary>\n${existingSummary}\n</previous_step_summary>`
    : basePrompt;

  const result = await generateText({
    model: languageModel,
    system,
    abortSignal,
    providerOptions: {
      xai: { store: false },
    },
    messages: [
      ...(messages.filter((msg) => msg.role !== "system") as SDKModelMessage[]),
      {
        role: "user" as const,
        content:
          "Summarize the above tool call steps using the structured format specified in your instructions. Output ONLY the step summary.",
      },
    ],
  });

  return result.text;
}

/**
 * Extract messages that represent tool steps to summarize.
 * Returns messages from the first tool step to the cutoff point.
 */
export function extractStepsToSummarize(
  messages: ModelMessage[],
  upToToolCallId: string,
): ModelMessage[] {
  const cutoffIndex = findToolResultIndex(messages, upToToolCallId);
  if (cutoffIndex < 0) return [];

  const firstToolStepIndex = messages.findIndex(
    (msg) =>
      msg.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.some((part) => (part as ToolCallPart).type === "tool-call"),
  );

  if (firstToolStepIndex < 0 || firstToolStepIndex > cutoffIndex) return [];

  return messages.slice(firstToolStepIndex, cutoffIndex + 1);
}

export { MIN_STEPS_TO_SUMMARIZE };
