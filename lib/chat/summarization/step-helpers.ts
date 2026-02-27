import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { myProvider } from "@/lib/ai/providers";
import { STEP_SUMMARIZATION_PROMPT } from "./prompts";

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
          "Summarize the above agent steps using the structured format specified in your instructions. Output ONLY the summary — do not continue the conversation or produce tool calls.",
      },
    ],
  });

  return result.text;
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
  };
}
