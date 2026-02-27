import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { myProvider } from "@/lib/ai/providers";
import { STEP_SUMMARIZATION_PROMPT } from "./prompts";

export function splitStepMessages(
  messages: ModelMessage[],
  initialMsgCount: number,
  stepsCompleted: number,
  stepsToKeep: number,
): {
  initialMessages: ModelMessage[];
  stepsToSummarizeMessages: ModelMessage[];
  stepsToKeepMessages: ModelMessage[];
} {
  const initialMessages = messages.slice(0, initialMsgCount);
  const responseMessages = messages.slice(initialMsgCount);

  if (stepsCompleted <= stepsToKeep) {
    return {
      initialMessages,
      stepsToSummarizeMessages: [],
      stepsToKeepMessages: responseMessages,
    };
  }

  // Walk responseMessages counting assistant messages as step boundaries.
  // Each step starts with an assistant message, optionally followed by a tool message.
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

  const splitIndex = stepBoundaries[keepFromStep];
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
