import "server-only";

import {
  UIMessage,
  UIMessageStreamWriter,
  LanguageModel,
  ToolSet,
  ModelMessage,
} from "ai";
import { v4 as uuidv4 } from "uuid";
import { SubscriptionTier, ChatMode, Todo, AnySandbox } from "@/types";
import {
  writeSummarizationStarted,
  writeSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";
import { isE2BSandbox } from "@/lib/ai/tools/utils/sandbox-types";
import type { Id } from "@/convex/_generated/dataModel";

import { MESSAGES_TO_KEEP_UNSUMMARIZED } from "./constants";
import {
  NO_SUMMARIZATION,
  isAboveTokenThreshold,
  splitMessages,
  generateSummaryText,
  buildSummaryMessage,
  persistSummary,
  isSummaryMessage,
  extractSummaryText,
} from "./helpers";
import type { SummarizationResult } from "./helpers";

export type { SummarizationResult, SummarizationUsage } from "./helpers";

export type EnsureSandbox = () => Promise<AnySandbox>;

/**
 * Builds the instructional notice appended to summaryText pointing the agent
 * to the saved transcript file on the sandbox filesystem.
 */
const buildTranscriptNotice = (path: string): string => `

Transcript location:
   This is the full JSON transcript of your past conversation with the user (pre- and post-summary): ${path}

   If anything about the task or current state is unclear (missing context, ambiguous requirements, uncertain decisions, exact wording, IDs/paths, errors/logs, tool inputs/outputs), you should consult this transcript rather than guessing.

   How to use it:
   - Search first for relevant keywords (task name, filenames, IDs, errors, tool names).
   - Then read a small window around the matching lines to reconstruct intent and state.
   - Avoid reading the entire file; it can be very large.

   Format:
   - JSON array of messages, each with "role" and "parts" (or "content" for model messages)
   - Tool calls: parts with type "tool-<name>" containing "input" and "output" fields
   - Tool results (model format): separate role "tool" messages with "tool-result" content
   - Text: parts with type "text"
   - Reasoning: parts with type "reasoning"`;

/**
 * Writes a JSON transcript of the summarized messages to the sandbox.
 * E2B (cloud) persists to ~/agent-transcripts/, local Docker to /tmp/agent-transcripts/.
 *
 * Content is written as a Buffer (not a string) so that ConvexSandbox's binary
 * chunking path is used, avoiding the shell argument size limits that occur when
 * large strings are embedded in heredoc commands.
 *
 * Returns the file path if saved, or null on failure.
 */
const saveTranscriptToSandbox = async (
  messages: UIMessage[],
  sandbox: AnySandbox,
  modelMessages?: ModelMessage[],
): Promise<string | null> => {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const transcriptId = uuidv4();
      const dir = isE2BSandbox(sandbox)
        ? "/home/user/agent-transcripts"
        : "/tmp/agent-transcripts";
      const path = `${dir}/${transcriptId}.json`;

      // E2B needs an explicit mkdir since its files.write doesn't create parents.
      // CentrifugoSandbox's files.write already calls ensureDirectory internally
      // with proper Windows path/shell handling, so skip the raw mkdir for it.
      if (isE2BSandbox(sandbox)) {
        await sandbox.commands.run(`mkdir -p ${dir}`, { timeoutMs: 5000 });
      }

      // Save as structured JSON — model messages (mid-stream, with separate
      // tool-call/tool-result parts) when available, otherwise UI messages
      const content = JSON.stringify(modelMessages ?? messages, null, 2);
      if (isE2BSandbox(sandbox)) {
        // E2B uploads via HTTP — no shell argument limits, string is fine
        await sandbox.files.write(path, content);
      } else {
        // ConvexSandbox/TauriSandbox: pass as ArrayBuffer to trigger binary
        // chunking in ConvexSandbox, avoiding shell argument size limits that
        // occur when large strings are embedded in heredoc commands.
        const buf = new TextEncoder().encode(content);
        await sandbox.files.write(path, buf.buffer as ArrayBuffer);
      }

      return path;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isPublishError = errorMsg.includes("Failed to publish");
      const isUnrecoverable =
        errorMsg.includes("connection closed") ||
        errorMsg.includes("connection lost") ||
        errorMsg.includes("program not found");
      if (isPublishError && !isUnrecoverable && attempt < maxRetries) {
        console.warn(
          `[Summarization] Transcript save failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`,
          error,
        );
        // Brief delay before retry to allow connection recovery
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      console.warn("[Summarization] Failed to save transcript:", error);
      return null;
    }
  }
  return null;
};

export const checkAndSummarizeIfNeeded = async (
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  languageModel: LanguageModel,
  mode: ChatMode,
  writer: UIMessageStreamWriter,
  chatId: string | null,
  fileTokens: Record<Id<"files">, number> = {},
  todos: Todo[] = [],
  abortSignal?: AbortSignal,
  ensureSandbox?: EnsureSandbox,
  systemPromptTokens: number = 0,
  providerInputTokens: number = 0,
  chatSystemPrompt: string = "",
  tools?: ToolSet,
  providerOptions?: Record<string, Record<string, unknown>>,
  modelMessages?: ModelMessage[],
): Promise<SummarizationResult> => {
  // Detect and separate synthetic summary message from real messages
  let realMessages: UIMessage[];
  let existingSummaryText: string | null = null;

  if (uiMessages.length > 0 && isSummaryMessage(uiMessages[0])) {
    realMessages = uiMessages.slice(1);
    existingSummaryText = extractSummaryText(uiMessages[0]);
  } else {
    realMessages = uiMessages;
  }

  // Guard: need enough real messages to split
  if (realMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return NO_SUMMARIZATION(uiMessages);
  }

  // Check token threshold on full messages (including summary) to determine need
  if (
    !isAboveTokenThreshold(
      uiMessages,
      subscription,
      fileTokens,
      systemPromptTokens,
      providerInputTokens,
    )
  ) {
    return NO_SUMMARIZATION(uiMessages);
  }

  // Split only real messages so cutoff always references a DB message
  const { messagesToSummarize, lastMessages } = splitMessages(realMessages);

  const cutoffMessageId =
    messagesToSummarize[messagesToSummarize.length - 1].id;

  writeSummarizationStarted(writer);

  try {
    // Run summary generation and transcript saving in parallel — they are
    // independent (transcript is formatted from raw messages, not the summary).
    const summaryPromise = generateSummaryText(
      uiMessages,
      languageModel,
      mode,
      chatSystemPrompt,
      !!existingSummaryText,
      tools,
      providerOptions,
      abortSignal,
      modelMessages,
    );

    // In agent modes, save the full transcript of summarized messages to the sandbox
    // so the agent can consult the raw conversation later if context is lost
    const transcriptPromise: Promise<string | null> =
      ensureSandbox && mode === "agent"
        ? ensureSandbox()
            .then((sandbox) =>
              saveTranscriptToSandbox(
                messagesToSummarize,
                sandbox,
                modelMessages,
              ),
            )
            .catch((error) => {
              console.error(
                "[Summarization] Failed to ensure sandbox for transcript:",
                error,
              );
              return null;
            })
        : Promise.resolve(null);

    const [summaryResult, savedPath] = await Promise.all([
      summaryPromise,
      transcriptPromise,
    ]);

    const { text: summaryText, usage: summarizationUsage } = summaryResult;
    let finalSummaryText = summaryText;
    if (savedPath) {
      finalSummaryText += buildTranscriptNotice(savedPath);
    }

    const summaryMessage = buildSummaryMessage(finalSummaryText, todos);

    await persistSummary(chatId, finalSummaryText, cutoffMessageId);

    return {
      needsSummarization: true,
      summarizedMessages: [summaryMessage, ...lastMessages],
      cutoffMessageId,
      summaryText: finalSummaryText,
      summarizationUsage,
    };
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    console.error("[Summarization] Failed:", error);
    return NO_SUMMARIZATION(uiMessages);
  } finally {
    if (!abortSignal?.aborted) {
      writeSummarizationCompleted(writer);
    }
  }
};
