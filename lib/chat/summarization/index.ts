import "server-only";

import { UIMessage, UIMessageStreamWriter, LanguageModel, ToolSet } from "ai";
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
import { formatTranscript } from "./transcript-formatter";
import type { SummarizationResult } from "./helpers";

export type { SummarizationResult, SummarizationUsage } from "./helpers";

export type EnsureSandbox = () => Promise<AnySandbox>;

/**
 * Builds the instructional notice appended to summaryText pointing the agent
 * to the saved transcript file on the sandbox filesystem.
 */
const buildTranscriptNotice = (path: string): string => `

Transcript location:
   This is the full plain-text transcript of your past conversation with the user (pre- and post-summary): ${path}

   If anything about the task or current state is unclear (missing context, ambiguous requirements, uncertain decisions, exact wording, IDs/paths, errors/logs, tool inputs/outputs), you should consult this transcript rather than guessing.

   How to use it:
   - Search first for relevant keywords (task name, filenames, IDs, errors, tool names).
   - Then read a small window around the matching lines to reconstruct intent and state.
   - Avoid reading linearly end-to-end; the file can be very large and some single lines (tool payloads/results) can be huge.

   Format:
   - Plain text with role labels ("user:", "A:")
   - Tool calls: [Tool call] toolName with arguments
   - Tool results: [Tool result] toolName
   - Reasoning/thinking: [Thinking] ...
   - Images/files: [Image] and [File: filename]`;

/**
 * Maximum size (in bytes) for each chunk when writing transcripts.
 * Kept well under typical OS ARG_MAX (~2MB) to avoid E2BIG errors
 * after base64 inflation (~33%).
 */
const TRANSCRIPT_CHUNK_SIZE = 256_000; // ~256KB raw → ~341KB base64, safe for all OS ARG_MAX limits

/**
 * Writes a plain-text transcript of the summarized messages to the sandbox.
 * E2B (cloud) persists to ~/agent-transcripts/, local Docker to /tmp/agent-transcripts/.
 *
 * Large transcripts are written in chunks using base64-encoded shell commands
 * piped through stdin to avoid E2BIG errors from exceeding OS argument limits.
 *
 * Returns the file path if saved, or null on failure.
 */
const saveTranscriptToSandbox = async (
  messages: UIMessage[],
  sandbox: AnySandbox,
): Promise<string | null> => {
  try {
    const transcriptId = uuidv4();
    const dir = isE2BSandbox(sandbox)
      ? "/home/user/agent-transcripts"
      : "/tmp/agent-transcripts";
    const path = `${dir}/${transcriptId}`;

    await sandbox.commands.run(`mkdir -p ${dir}`, { timeoutMs: 5000 });

    const content = formatTranscript(messages);

    if (content.length <= TRANSCRIPT_CHUNK_SIZE) {
      await sandbox.files.write(path, content);
    } else {
      // Write in chunks using base64 piped through stdin to avoid E2BIG.
      // Each chunk is base64-encoded and decoded on the sandbox side,
      // keeping the command argument size well under OS limits.
      for (let i = 0; i < content.length; i += TRANSCRIPT_CHUNK_SIZE) {
        const chunk = content.slice(i, i + TRANSCRIPT_CHUNK_SIZE);
        const b64 = Buffer.from(chunk).toString("base64");
        const operator = i === 0 ? ">" : ">>";
        const result = await sandbox.commands.run(
          `printf '%s' "${b64}" | base64 -d ${operator} ${path}`,
          { timeoutMs: 30_000 },
        );
        if (result.exitCode !== 0) {
          throw new Error(`Failed to write transcript chunk: ${result.stderr}`);
        }
      }
    }

    return path;
  } catch (error) {
    console.error("[Summarization] Failed to save transcript:", error);
    return null;
  }
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
    );

    // In agent modes, save the full transcript of summarized messages to the sandbox
    // so the agent can consult the raw conversation later if context is lost
    const transcriptPromise: Promise<string | null> =
      ensureSandbox && (mode === "agent" || mode === "agent-long")
        ? ensureSandbox()
            .then((sandbox) =>
              saveTranscriptToSandbox(messagesToSummarize, sandbox),
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
