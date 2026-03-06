/**
 * Chat Stream Helpers
 *
 * Utility functions extracted from chat-handler to keep it clean and focused.
 */

import type {
  LanguageModel,
  ModelMessage,
  UIMessage,
  UIMessageStreamWriter,
} from "ai";
import type { ChatMode, SubscriptionTier, Todo } from "@/types";
import type { ContextUsageData } from "@/app/components/ContextUsageIndicator";
import type { Id } from "@/convex/_generated/dataModel";
import {
  writeRateLimitWarning,
  writeStepSummarizationStarted,
  writeStepSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";
import { countMessagesTokens } from "@/lib/token-utils";
import {
  checkAndSummarizeIfNeeded,
  type EnsureSandbox,
} from "@/lib/chat/summarization";
import { getNotes } from "@/lib/db/actions";
import { generateNotesSection } from "@/lib/system-prompt/notes";
import { logger } from "@/lib/logger";
import {
  injectStepSummary,
  generateStepSummaryText,
  getSecondToLastToolCallId,
  countCompletedToolSteps,
  isStepSummaryMessage,
  extractStepsToSummarize,
  MIN_STEPS_TO_SUMMARIZE,
} from "@/lib/chat/summarization/step-summary";

/**
 * Check if messages contain file attachments
 */
export function hasFileAttachments(
  messages: Array<{ parts?: Array<{ type?: string }> }>,
): boolean {
  return messages.some((msg) =>
    msg.parts?.some((part) => part.type === "file"),
  );
}

/**
 * Count total file attachments and how many are images
 */
export function countFileAttachments(
  messages: Array<{ parts?: Array<{ type?: string; mediaType?: string }> }>,
): { totalFiles: number; imageCount: number } {
  let totalFiles = 0;
  let imageCount = 0;

  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.type !== "file") continue;
      totalFiles++;
      if ((part.mediaType ?? "").startsWith("image/")) {
        imageCount++;
      }
    }
  }

  return { totalFiles, imageCount };
}

/**
 * Send rate limit warnings based on subscription and rate limit info
 */
export function sendRateLimitWarnings(
  writer: UIMessageStreamWriter,
  options: {
    subscription: SubscriptionTier;
    mode: ChatMode;
    rateLimitInfo: {
      remaining: number;
      resetTime: Date;
      session?: { remaining: number; limit: number; resetTime: Date };
      weekly?: { remaining: number; limit: number; resetTime: Date };
      extraUsagePointsDeducted?: number;
    };
  },
): void {
  const { subscription, mode, rateLimitInfo } = options;

  if (subscription === "free") {
    // Free users: sliding window (remaining count)
    if (rateLimitInfo.remaining <= 5) {
      writeRateLimitWarning(writer, {
        warningType: "sliding-window",
        remaining: rateLimitInfo.remaining,
        resetTime: rateLimitInfo.resetTime.toISOString(),
        mode,
        subscription,
      });
    }
  } else if (rateLimitInfo.session && rateLimitInfo.weekly) {
    // Paid users with extra usage: warn when extra usage is being used
    if (
      rateLimitInfo.extraUsagePointsDeducted &&
      rateLimitInfo.extraUsagePointsDeducted > 0
    ) {
      const bucketType =
        rateLimitInfo.session.remaining <= rateLimitInfo.weekly.remaining
          ? "session"
          : "weekly";
      const resetTime =
        bucketType === "session"
          ? rateLimitInfo.session.resetTime
          : rateLimitInfo.weekly.resetTime;

      writeRateLimitWarning(writer, {
        warningType: "extra-usage-active",
        bucketType,
        resetTime: resetTime.toISOString(),
        subscription,
      });
    } else {
      // Paid users without extra usage: token bucket (remaining percentage at 10%)
      const sessionPercent =
        (rateLimitInfo.session.remaining / rateLimitInfo.session.limit) * 100;
      const weeklyPercent =
        (rateLimitInfo.weekly.remaining / rateLimitInfo.weekly.limit) * 100;

      if (sessionPercent <= 10) {
        writeRateLimitWarning(writer, {
          warningType: "token-bucket",
          bucketType: "session",
          remainingPercent: Math.round(sessionPercent),
          resetTime: rateLimitInfo.session.resetTime.toISOString(),
          subscription,
        });
      }

      if (weeklyPercent <= 10) {
        writeRateLimitWarning(writer, {
          warningType: "token-bucket",
          bucketType: "weekly",
          remainingPercent: Math.round(weeklyPercent),
          resetTime: rateLimitInfo.weekly.resetTime.toISOString(),
          subscription,
        });
      }
    }
  }
}

/**
 * Check if an error is an xAI safety check error (403 from api.x.ai)
 * These are false positives that should be suppressed from logging
 */
export function isXaiSafetyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  // Handle both direct errors (from generateText) and wrapped errors (from streamText onError)
  const apiError =
    "error" in error && error.error instanceof Error
      ? (error.error as Error & {
          statusCode?: number;
          url?: string;
          responseBody?: string;
        })
      : (error as Error & {
          statusCode?: number;
          url?: string;
          responseBody?: string;
        });

  return (
    apiError.statusCode === 403 &&
    typeof apiError.url === "string" &&
    apiError.url.includes("api.x.ai") &&
    typeof apiError.responseBody === "string"
  );
}

/**
 * Check if an error is a provider API error that should trigger fallback
 * Specifically targets Google/Gemini INVALID_ARGUMENT errors
 */
export function isProviderApiError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as {
    statusCode?: number;
    responseBody?: string;
    data?: {
      error?: {
        code?: number;
        message?: string;
        metadata?: { raw?: string; provider_name?: string };
      };
    };
  };

  // Must be a 400 error
  if (err.statusCode !== 400 && err.data?.error?.code !== 400) return false;

  // Check for INVALID_ARGUMENT in response body or nested metadata
  const responseBody = err.responseBody || "";
  const rawMetadata = err.data?.error?.metadata?.raw || "";
  const combined = responseBody + rawMetadata;

  return combined.includes("INVALID_ARGUMENT");
}

/**
 * Compute context usage breakdown from messages, separating summary from regular messages.
 */
export function computeContextUsage(
  messages: UIMessage[],
  fileTokens: Record<Id<"files">, number>,
  systemTokens: number,
  maxTokens: number,
): ContextUsageData {
  const summaryMsg = messages.find((m) =>
    m.parts?.some(
      (p: { type?: string; text?: string }) =>
        p.type === "text" &&
        typeof p.text === "string" &&
        p.text.startsWith("<context_summary>"),
    ),
  );
  const summaryTokens = summaryMsg
    ? countMessagesTokens([summaryMsg], fileTokens)
    : 0;
  const nonSummaryMessages = summaryMsg
    ? messages.filter((m) => m !== summaryMsg)
    : messages;
  const messagesTokens = countMessagesTokens(nonSummaryMessages, fileTokens);

  return { systemTokens, summaryTokens, messagesTokens, maxTokens };
}

export const contextUsageEnabled =
  process.env.NEXT_PUBLIC_ENABLE_CONTEXT_USAGE === "true";

/**
 * Write a context usage data stream part to the client.
 */
export function writeContextUsage(
  writer: UIMessageStreamWriter,
  usage: ContextUsageData,
): void {
  writer.write({ type: "data-context-usage", data: usage });
}

/**
 * Build an updated ContextUsageData by estimating messagesTokens from
 * provider-reported input tokens (preferred) or falling back to
 * base messages + accumulated output tokens.
 */
export function buildStepContextUsage(
  base: ContextUsageData,
  providerInputTokens: number,
  accumulatedOutputTokens: number,
): ContextUsageData {
  const messagesTokens =
    providerInputTokens > 0
      ? Math.max(
          0,
          providerInputTokens - base.systemTokens - base.summaryTokens,
        )
      : base.messagesTokens + accumulatedOutputTokens;
  return { ...base, messagesTokens };
}

export interface SummarizationStepResult {
  needsSummarization: boolean;
  summarizedMessages?: UIMessage[];
  contextUsage?: ContextUsageData;
}

export async function runSummarizationStep(options: {
  messages: UIMessage[];
  subscription: SubscriptionTier;
  languageModel: LanguageModel;
  mode: ChatMode;
  writer: UIMessageStreamWriter;
  chatId: string | null;
  fileTokens: Record<Id<"files">, number>;
  todos: Todo[];
  abortSignal?: AbortSignal;
  ensureSandbox?: EnsureSandbox;
  systemPromptTokens: number;
  ctxSystemTokens: number;
  ctxMaxTokens: number;
  providerInputTokens?: number;
}): Promise<SummarizationStepResult> {
  const { needsSummarization, summarizedMessages } =
    await checkAndSummarizeIfNeeded(
      options.messages,
      options.subscription,
      options.languageModel,
      options.mode,
      options.writer,
      options.chatId,
      options.fileTokens,
      options.todos,
      options.abortSignal,
      options.ensureSandbox,
      options.systemPromptTokens,
      options.providerInputTokens ?? 0,
    );

  if (!needsSummarization) {
    return { needsSummarization: false };
  }

  const contextUsage = contextUsageEnabled
    ? computeContextUsage(
        summarizedMessages,
        options.fileTokens,
        options.ctxSystemTokens,
        options.ctxMaxTokens,
      )
    : undefined;

  if (contextUsage) {
    writeContextUsage(options.writer, contextUsage);
  }

  return { needsSummarization: true, summarizedMessages, contextUsage };
}

export interface StepSummarizationState {
  stepSummaryText: string | null;
  upToToolCallId: string | null;
}

export interface StepSummarizationCheckResult {
  needsSummarization: boolean;
  messages: ModelMessage[];
  summaryText: string | null;
  upToToolCallId: string | null;
}

/**
 * Check if step summarization is needed and perform it.
 * This runs on every prepareStep call AFTER main summary has been created.
 *
 * It checks if the current messages (after re-injecting any existing step summary)
 * exceed the token threshold. If so, it generates a new step summary that compresses
 * completed tool steps.
 */
export async function runStepSummarizationCheck(options: {
  messages: ModelMessage[];
  languageModel: LanguageModel;
  existingSummary: string | null;
  lastStepInputTokens: number;
  lastStepOutputTokens: number;
  maxTokens: number;
  thresholdPercentage: number;
  abortSignal?: AbortSignal;
  writer?: UIMessageStreamWriter;
}): Promise<StepSummarizationCheckResult> {
  const {
    messages,
    languageModel,
    existingSummary,
    lastStepInputTokens,
    lastStepOutputTokens,
    maxTokens,
    thresholdPercentage,
    abortSignal,
    writer,
  } = options;

  const threshold = Math.floor(maxTokens * thresholdPercentage);

  // Estimate current input tokens: previous step's input + its output
  // (tool results from the previous step are now part of this step's input)
  const estimatedInputTokens = lastStepInputTokens + lastStepOutputTokens;

  if (estimatedInputTokens <= threshold) {
    return {
      needsSummarization: false,
      messages,
      summaryText: existingSummary,
      upToToolCallId: null,
    };
  }

  // Need enough completed steps to make summarization worthwhile
  // Filter out existing step summary messages for counting
  const nonSummaryMessages = messages.filter((m) => !isStepSummaryMessage(m));
  const completedSteps = countCompletedToolSteps(nonSummaryMessages);

  if (completedSteps < MIN_STEPS_TO_SUMMARIZE) {
    return {
      needsSummarization: false,
      messages,
      summaryText: existingSummary,
      upToToolCallId: null,
    };
  }

  // Get cutoff: second-to-last toolCallId (keep last step raw)
  const cutoffToolCallId = getSecondToLastToolCallId(nonSummaryMessages);
  if (!cutoffToolCallId) {
    return {
      needsSummarization: false,
      messages,
      summaryText: existingSummary,
      upToToolCallId: null,
    };
  }

  try {
    // Extract steps to summarize for the LLM
    const stepsToSummarize = extractStepsToSummarize(
      nonSummaryMessages,
      cutoffToolCallId,
    );

    if (stepsToSummarize.length === 0) {
      return {
        needsSummarization: false,
        messages,
        summaryText: existingSummary,
        upToToolCallId: null,
      };
    }

    try {
      if (writer) {
        writeStepSummarizationStarted(writer);
      }

      const summaryText = await generateStepSummaryText(
        stepsToSummarize,
        languageModel,
        existingSummary ?? undefined,
        abortSignal,
      );

      const injectedMessages = injectStepSummary(
        nonSummaryMessages,
        summaryText,
        cutoffToolCallId,
      );

      if (writer && !abortSignal?.aborted) {
        writeStepSummarizationCompleted(writer);
      }

      return {
        needsSummarization: true,
        messages: injectedMessages,
        summaryText,
        upToToolCallId: cutoffToolCallId,
      };
    } catch (innerError) {
      if (writer && !abortSignal?.aborted) {
        console.log("[StepSummarization] Failed, clearing UI indicator");
        writeStepSummarizationCompleted(writer);
      }
      throw innerError;
    }
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    console.log(
      "[StepSummarization] Failed:",
      error instanceof Error ? error.message : String(error),
    );
    return {
      needsSummarization: false,
      messages,
      summaryText: existingSummary,
      upToToolCallId: null,
    };
  }
}

/**
 * Build provider options for streamText
 */
export function buildProviderOptions(
  isReasoningModel: boolean,
  subscription: SubscriptionTier,
  userId?: string,
) {
  return {
    xai: {
      // Disable storing the conversation in XAI's database
      store: false,
    },
    openrouter: {
      ...(isReasoningModel
        ? { reasoning: { enabled: true } }
        : { reasoning: { enabled: false } }),
      ...(userId && { user: userId }),
      provider: {
        ...(subscription === "free" ? { sort: "price" } : { sort: "latency" }),
      },
    },
  } as const;
}

/**
 * Appends a <system-reminder> block to the last user message's text part.
 * Returns a new array (does not mutate input).
 */
export function appendSystemReminderToLastUserMessage(
  messages: UIMessage[],
  reminderContent: string,
): UIMessage[] {
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user") {
      const parts = [...(result[i].parts || [])];
      const textPartIndex = parts.findIndex((p) => p.type === "text");

      if (textPartIndex >= 0) {
        const textPart = parts[textPartIndex] as { type: "text"; text: string };
        parts[textPartIndex] = {
          ...textPart,
          text: `${textPart.text}\n\n<system-reminder>\n${reminderContent}\n</system-reminder>`,
        };
      } else {
        parts.push({
          type: "text" as const,
          text: `<system-reminder>\n${reminderContent}\n</system-reminder>`,
        });
      }

      result[i] = { ...result[i], parts };
      break;
    }
  }
  return result;
}

/**
 * Fetches user notes and injects them into messages via <system-reminder>.
 * Returns the (possibly updated) messages array.
 */
export async function injectNotesIntoMessages(
  messages: UIMessage[],
  opts: {
    userId: string;
    subscription: SubscriptionTier;
    shouldIncludeNotes: boolean;
    isTemporary?: boolean;
  },
): Promise<UIMessage[]> {
  if (!opts.shouldIncludeNotes || opts.isTemporary) return messages;

  try {
    const notes = await getNotes({
      userId: opts.userId,
      subscription: opts.subscription,
    });
    const notesContent = generateNotesSection(notes);
    if (!notesContent) return messages;

    logger.warn("Notes injected via system-reminder", {
      userId: opts.userId,
      noteCount: notes?.length ?? 0,
    });

    return appendSystemReminderToLastUserMessage(messages, notesContent);
  } catch (error) {
    logger.warn("Failed to fetch notes, continuing without them", {
      userId: opts.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return messages;
  }
}

// Regex to match a system-reminder block that contains <notes>.
// Uses \s* instead of literal \n so it stays in sync even if the
// template strings in appendSystemReminderToLastUserMessage or
// generateNotesSection change their whitespace slightly.
const NOTES_REMINDER_REGEX =
  /<system-reminder>\s*<notes>[\s\S]*?<\/notes>\s*<\/system-reminder>/;

/**
 * Replaces the notes <system-reminder> block inside a text string.
 * Returns the original string unchanged if no notes block is found.
 */
export function replaceNotesBlock(
  text: string,
  newNotesContent: string,
): string {
  if (NOTES_REMINDER_REGEX.test(text)) {
    return newNotesContent
      ? text.replace(
          NOTES_REMINDER_REGEX,
          `<system-reminder>\n${newNotesContent}\n</system-reminder>`,
        )
      : text.replace(NOTES_REMINDER_REGEX, "");
  }
  return text;
}

/**
 * Updates the notes in model messages (CoreMessage[]) from prepareStep.
 * Preserves full conversation history (tool calls, results, assistant messages).
 *
 * The AI SDK does NOT preserve `<system-reminder>` text that was injected into
 * user messages via `appendSystemReminderToLastUserMessage`. So on subsequent
 * agentic steps, the notes block will be missing from prepareStep's messages.
 *
 * Strategy:
 * 1. Try to find and replace an existing `<notes>` block (in case the SDK
 *    does preserve it in some path).
 * 2. If no block is found, append the notes as a new `<system-reminder>` to
 *    the last user message — this ensures the model always sees fresh notes.
 */
export async function refreshNotesInModelMessages(
  messages: Array<Record<string, unknown>>,
  opts: {
    userId: string;
    subscription: SubscriptionTier;
    shouldIncludeNotes: boolean;
    isTemporary?: boolean;
  },
): Promise<Array<Record<string, unknown>>> {
  if (!opts.shouldIncludeNotes || opts.isTemporary) return messages;

  try {
    const notes = await getNotes({
      userId: opts.userId,
      subscription: opts.subscription,
    });
    const newNotesContent = generateNotesSection(notes);

    logger.warn("Notes refreshed in model messages (prepareStep)", {
      userId: opts.userId,
      noteCount: notes?.length ?? 0,
    });

    // First pass: try to replace (or remove) an existing notes block.
    // replaceNotesBlock handles empty newNotesContent by removing the block.
    const result = [...messages];
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      if (msg.role !== "user") continue;

      const content = msg.content;

      if (typeof content === "string") {
        const updated = replaceNotesBlock(content, newNotesContent);
        if (updated !== content) {
          result[i] = { ...msg, content: updated };
          return result;
        }
      } else if (Array.isArray(content)) {
        const parts = [...(content as Array<Record<string, unknown>>)];
        for (let j = 0; j < parts.length; j++) {
          if (parts[j].type !== "text") continue;
          const text = parts[j].text as string;
          const updated = replaceNotesBlock(text, newNotesContent);
          if (updated !== text) {
            parts[j] = { ...parts[j], text: updated };
            result[i] = { ...msg, content: parts };
            return result;
          }
        }
      }
    }

    // Nothing to append if user has no notes (and no existing block to remove)
    if (!newNotesContent) return messages;

    const reminder = `<system-reminder>\n${newNotesContent}\n</system-reminder>`;

    // No existing notes block found (AI SDK strips <system-reminder> from its
    // internal message state). Append the notes to the last user message.
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      if (msg.role !== "user") continue;

      const content = msg.content;

      if (typeof content === "string") {
        result[i] = { ...msg, content: `${content}\n\n${reminder}` };
        return result;
      } else if (Array.isArray(content)) {
        const parts = [...(content as Array<Record<string, unknown>>)];
        const textIdx = parts.findIndex((p) => p.type === "text");
        if (textIdx >= 0) {
          const textPart = parts[textIdx];
          parts[textIdx] = {
            ...textPart,
            text: `${textPart.text as string}\n\n${reminder}`,
          };
        } else {
          parts.push({ type: "text", text: reminder });
        }
        result[i] = { ...msg, content: parts };
        return result;
      }
    }

    return messages;
  } catch (error) {
    logger.warn("Failed to refresh notes in prepareStep, continuing without", {
      userId: opts.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return messages;
  }
}
