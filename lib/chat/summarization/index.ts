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
import { countMessagesTokens } from "@/lib/token-utils";
import {
  writeSummarizationCleared,
  writeSummarizationStarted,
  writeSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";
import { isE2BSandbox } from "@/lib/ai/tools/utils/sandbox-types";
import type { Id } from "@/convex/_generated/dataModel";
import {
  GROK_4_5_SLUG,
  KIMI_K2_7_CODE_SLUG,
  myProvider,
} from "@/lib/ai/providers";
import type { ProviderPromptPressure } from "./provider-pressure";

import {
  MESSAGES_TO_KEEP_UNSUMMARIZED,
  getSummaryInputMaxTokens,
  getSummarizationThresholdTokens,
} from "./constants";
import {
  NO_SUMMARIZATION,
  isAboveTokenThreshold,
  generateSummaryText,
  buildSummaryMessage,
  persistSummary,
  isSummaryMessage,
  extractSummaryText,
  buildSummaryPersistenceMetadata,
  resolveSummarizationMaxTokens,
} from "./helpers";
import type { SummarizationResult } from "./helpers";
import {
  getRetainedTailBudgetTokens,
  selectRetainedTailForSummarization,
} from "./retained-tail";

export type { SummarizationResult, SummarizationUsage } from "./helpers";

export type EnsureSandbox = () => Promise<AnySandbox>;

type CompactionLogReason =
  | "provider_pressure"
  | "provider_input_tokens"
  | "estimated_token_threshold";

type SummarizationAttempt = "primary" | "fallback";

const SUMMARIZATION_RETRY_MODEL_BY_MODE: Record<ChatMode, string> = {
  ask: "fallback-ask-model",
  agent: "fallback-agent-model",
};
const SUMMARIZATION_RETRY_FALLBACK_MODEL_SLUGS = [
  KIMI_K2_7_CODE_SLUG,
  GROK_4_5_SLUG,
] as const;
const SUMMARIZATION_ATTEMPT_ERROR_KEY = "__hackeraiSummarizationAttempt";

const getLanguageModelId = (
  languageModel: LanguageModel,
): string | undefined => {
  const modelId = (languageModel as { modelId?: unknown }).modelId;
  return typeof modelId === "string" && modelId.length > 0
    ? modelId
    : undefined;
};

const getErrorRecord = (error: unknown): Record<string, unknown> | null =>
  typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : null;

const getHeaderValue = (
  headers: unknown,
  headerName: string,
): string | undefined => {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return (
      headers.get(headerName) ??
      headers.get(headerName.toLowerCase()) ??
      undefined
    );
  }
  if (typeof headers !== "object" || headers === null) return undefined;

  const lowerHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    if (key.toLowerCase() !== lowerHeaderName) continue;
    return typeof value === "string" ? value : undefined;
  }

  return undefined;
};

const getBoundedErrorMessage = (error: unknown): string | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
};

const getBoundedErrorStack = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || !error.stack) return undefined;
  return error.stack.length > 1200
    ? `${error.stack.slice(0, 1200)}...`
    : error.stack;
};

const markSummarizationAttemptError = (
  error: unknown,
  attempt: SummarizationAttempt,
) => {
  const record = getErrorRecord(error);
  if (record) {
    record[SUMMARIZATION_ATTEMPT_ERROR_KEY] = attempt;
  }
};

const getSummarizationAttemptFromError = (
  error: unknown,
): SummarizationAttempt => {
  const record = getErrorRecord(error);
  return record?.[SUMMARIZATION_ATTEMPT_ERROR_KEY] === "fallback"
    ? "fallback"
    : "primary";
};

const summarizeSummarizationErrorForLog = (error: unknown) => {
  const record = getErrorRecord(error);
  const responseBody =
    typeof record?.responseBody === "string" ? record.responseBody : undefined;

  return {
    error_name:
      error instanceof Error && error.name ? error.name : typeof error,
    error_message: getBoundedErrorMessage(error),
    error_stack: getBoundedErrorStack(error),
    provider_status_code:
      typeof record?.statusCode === "number" ? record.statusCode : undefined,
    openrouter_generation_id: getHeaderValue(
      record?.responseHeaders,
      "x-generation-id",
    ),
    response_body_empty:
      responseBody !== undefined ? responseBody.trim().length === 0 : undefined,
    response_body_length: responseBody?.length,
  };
};

const isMalformedProviderJsonError = (
  error: unknown,
  depth: number = 0,
): boolean => {
  if (depth > 4) return false;

  const message = error instanceof Error ? error.message : String(error);
  const record = getErrorRecord(error);
  const responseBody =
    typeof record?.responseBody === "string" ? record.responseBody : undefined;
  const statusCode =
    typeof record?.statusCode === "number" ? record.statusCode : undefined;

  if (
    message.includes("Invalid JSON response") ||
    message.includes("JSON parsing failed") ||
    (error instanceof Error && error.name === "AI_JSONParseError") ||
    (statusCode === 200 &&
      responseBody !== undefined &&
      responseBody.trim().length === 0)
  ) {
    return true;
  }

  if (Array.isArray(record?.errors)) {
    return record.errors.some((nestedError) =>
      isMalformedProviderJsonError(nestedError, depth + 1),
    );
  }

  return record?.cause !== undefined
    ? isMalformedProviderJsonError(record.cause, depth + 1)
    : false;
};

const buildSummarizationRetryProviderOptions = (
  providerOptions?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> => {
  const retryProviderOptions: Record<string, Record<string, unknown>> = {};
  for (const [providerName, options] of Object.entries(providerOptions ?? {})) {
    retryProviderOptions[providerName] = { ...options };
  }

  retryProviderOptions.openrouter = {
    ...(retryProviderOptions.openrouter ?? {}),
    models: [...SUMMARIZATION_RETRY_FALLBACK_MODEL_SLUGS],
  };

  return retryProviderOptions;
};

const logContextCompactionRetrying = ({
  chatId,
  mode,
  subscription,
  reason,
  attempt,
  languageModel,
  retryModelName,
  error,
}: {
  chatId: string | null;
  mode: ChatMode;
  subscription: SubscriptionTier;
  reason: CompactionLogReason;
  attempt: SummarizationAttempt;
  languageModel: LanguageModel;
  retryModelName: string;
  error: unknown;
}) => {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "chat_context_compaction_retrying",
      service: "chat-handler",
      timestamp: new Date().toISOString(),
      chat_id: chatId ?? undefined,
      mode,
      subscription,
      reason,
      summarization_attempt: attempt,
      model_id: getLanguageModelId(languageModel),
      retry_model_name: retryModelName,
      retry_without_tools: true,
      ...summarizeSummarizationErrorForLog(error),
    }),
  );
};

const logContextCompactionFailed = ({
  chatId,
  mode,
  subscription,
  reason,
  attempt,
  languageModel,
  fallbackResult,
  error,
}: {
  chatId: string | null;
  mode: ChatMode;
  subscription: SubscriptionTier;
  reason: CompactionLogReason;
  attempt: SummarizationAttempt;
  languageModel: LanguageModel;
  fallbackResult: "no_summarization";
  error: unknown;
}) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "chat_context_compaction_failed",
      service: "chat-handler",
      timestamp: new Date().toISOString(),
      chat_id: chatId ?? undefined,
      mode,
      subscription,
      reason,
      summarization_attempt: attempt,
      model_id: getLanguageModelId(languageModel),
      fallback_result: fallbackResult,
      ...summarizeSummarizationErrorForLog(error),
    }),
  );
};

export interface CheckAndSummarizeOptions {
  uiMessages: UIMessage[];
  subscription: SubscriptionTier;
  languageModel: LanguageModel;
  mode: ChatMode;
  writer: UIMessageStreamWriter;
  chatId: string | null;
  fileTokens?: Record<Id<"files">, number>;
  todos?: Todo[];
  abortSignal?: AbortSignal;
  ensureSandbox?: EnsureSandbox;
  systemPromptTokens?: number;
  providerInputTokens?: number;
  chatSystemPrompt?: string;
  tools?: ToolSet;
  providerOptions?: Record<string, Record<string, unknown>>;
  modelMessages?: ModelMessage[];
  transcriptMessages?: UIMessage[];
  maxTokensOverride?: number;
  providerPromptPressure?: ProviderPromptPressure | null;
}

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

const summarizeFileTokensForLog = (fileTokens: Record<Id<"files">, number>) => {
  const values = Object.values(fileTokens).filter(
    (tokens) => Number.isFinite(tokens) && tokens > 0,
  );

  return {
    file_count: values.length,
    total_file_tokens: values.reduce((total, tokens) => total + tokens, 0),
    largest_file_tokens: values.length > 0 ? Math.max(...values) : 0,
  };
};

const getCompactionLogReason = ({
  providerPromptPressure,
  providerInputTokens,
  summarizationThreshold,
}: {
  providerPromptPressure?: ProviderPromptPressure | null;
  providerInputTokens: number;
  summarizationThreshold: number;
}): CompactionLogReason => {
  if (providerPromptPressure) return "provider_pressure";
  if (providerInputTokens > summarizationThreshold) {
    return "provider_input_tokens";
  }
  return "estimated_token_threshold";
};

const logContextCompactionStarted = ({
  chatId,
  mode,
  subscription,
  reason,
  totalEstimatedTokens,
  systemPromptTokens,
  providerInputTokens,
  maxTokens,
  summarizationThreshold,
  providerPromptPressure,
  fileTokens,
  cutoffMessageId,
  retainedTail,
}: {
  chatId: string | null;
  mode: ChatMode;
  subscription: SubscriptionTier;
  reason: CompactionLogReason;
  totalEstimatedTokens: number;
  systemPromptTokens: number;
  providerInputTokens: number;
  maxTokens: number;
  summarizationThreshold: number;
  providerPromptPressure?: ProviderPromptPressure | null;
  fileTokens: Record<Id<"files">, number>;
  cutoffMessageId: string;
  retainedTail?: {
    budget_tokens: number;
    retained_tokens: number;
    retained_message_count: number;
    retained_part_count: number;
    projected_part_count: number;
  };
}) => {
  const fileTokenSummary = summarizeFileTokensForLog(fileTokens);

  console.info(
    JSON.stringify({
      level: "info",
      event: "chat_context_compaction_started",
      service: "chat-handler",
      timestamp: new Date().toISOString(),
      chat_id: chatId ?? undefined,
      mode,
      subscription,
      reason,
      total_estimated_tokens: totalEstimatedTokens,
      system_prompt_tokens: systemPromptTokens,
      provider_input_tokens: providerInputTokens,
      max_tokens: maxTokens,
      threshold_tokens: summarizationThreshold,
      ...fileTokenSummary,
      provider_pressure_reason: providerPromptPressure?.reason,
      provider_pressure_reasons: providerPromptPressure?.reasons,
      provider_pressure_serialized_message_bytes:
        providerPromptPressure?.serializedMessageBytes,
      provider_pressure_tool_result_count:
        providerPromptPressure?.toolResultCount,
      provider_pressure_message_count: providerPromptPressure?.messageCount,
      cutoff_message_id: cutoffMessageId,
      retained_tail_budget_tokens: retainedTail?.budget_tokens,
      retained_tail_tokens: retainedTail?.retained_tokens,
      retained_tail_message_count: retainedTail?.retained_message_count,
      retained_tail_part_count: retainedTail?.retained_part_count,
      retained_tail_projected_part_count: retainedTail?.projected_part_count,
    }),
  );
};

const generateSummaryTextWithRetry = async ({
  messagesToSummarize,
  modelMessages,
  languageModel,
  mode,
  chatSystemPrompt,
  hasExistingSummary,
  tools,
  providerOptions,
  abortSignal,
  summaryInputMaxTokens,
  chatId,
  subscription,
  reason,
}: {
  messagesToSummarize: UIMessage[];
  modelMessages?: ModelMessage[];
  languageModel: LanguageModel;
  mode: ChatMode;
  chatSystemPrompt: string;
  hasExistingSummary: boolean;
  tools?: ToolSet;
  providerOptions?: Record<string, Record<string, unknown>>;
  abortSignal?: AbortSignal;
  summaryInputMaxTokens: number;
  chatId: string | null;
  subscription: SubscriptionTier;
  reason: CompactionLogReason;
}): Promise<
  Awaited<ReturnType<typeof generateSummaryText>> & {
    languageModel: LanguageModel;
    attempt: SummarizationAttempt;
  }
> => {
  try {
    const result = await generateSummaryText(
      messagesToSummarize,
      languageModel,
      mode,
      chatSystemPrompt,
      hasExistingSummary,
      tools,
      providerOptions,
      abortSignal,
      modelMessages,
      summaryInputMaxTokens,
    );

    return {
      ...result,
      languageModel,
      attempt: "primary",
    };
  } catch (error) {
    if (abortSignal?.aborted || !isMalformedProviderJsonError(error)) {
      throw error;
    }

    const retryModelName = SUMMARIZATION_RETRY_MODEL_BY_MODE[mode];
    const retryLanguageModel = myProvider.languageModel(retryModelName);
    logContextCompactionRetrying({
      chatId,
      mode,
      subscription,
      reason,
      attempt: "primary",
      languageModel,
      retryModelName,
      error,
    });

    let result: Awaited<ReturnType<typeof generateSummaryText>>;
    try {
      result = await generateSummaryText(
        messagesToSummarize,
        retryLanguageModel,
        mode,
        chatSystemPrompt,
        hasExistingSummary,
        undefined,
        buildSummarizationRetryProviderOptions(providerOptions),
        abortSignal,
        modelMessages,
        summaryInputMaxTokens,
      );
    } catch (retryError) {
      markSummarizationAttemptError(retryError, "fallback");
      throw retryError;
    }

    return {
      ...result,
      languageModel: retryLanguageModel,
      attempt: "fallback",
    };
  }
};

export interface CompactModelMessagesInRunOptions {
  modelMessages: ModelMessage[];
  /** Raw cumulative SDK history used only for the transcript sidecar. */
  transcriptModelMessages: ModelMessage[];
  subscription: SubscriptionTier;
  languageModel: LanguageModel;
  mode: ChatMode;
  writer: UIMessageStreamWriter;
  chatId: string | null;
  todos?: Todo[];
  abortSignal?: AbortSignal;
  ensureSandbox?: EnsureSandbox;
  systemPromptTokens?: number;
  providerInputTokens?: number;
  chatSystemPrompt?: string;
  tools?: ToolSet;
  providerOptions?: Record<string, Record<string, unknown>>;
  maxTokens: number;
  providerPromptPressure?: ProviderPromptPressure | null;
  compactionIndex: number;
  hasExistingSummary: boolean;
}

export interface InRunModelCompactionResult {
  summaryMessage: UIMessage;
  summaryText: string;
  summarizationUsage: SummarizationResult["summarizationUsage"];
}

/**
 * Compacts the live ModelMessage history without updating latest_summary_id.
 *
 * In-flight assistant/tool messages do not have a durable chat message cutoff
 * yet, so persisting this summary would make reloads duplicate that work. The
 * caller keeps the result as a run-scoped rolling checkpoint instead.
 */
export const compactModelMessagesInRun = async ({
  modelMessages,
  transcriptModelMessages,
  subscription,
  languageModel,
  mode,
  writer,
  chatId,
  todos = [],
  abortSignal,
  ensureSandbox,
  systemPromptTokens = 0,
  providerInputTokens = 0,
  chatSystemPrompt = "",
  tools,
  providerOptions,
  maxTokens,
  providerPromptPressure,
  compactionIndex,
  hasExistingSummary,
}: CompactModelMessagesInRunOptions): Promise<InRunModelCompactionResult | null> => {
  const summarizationThreshold = getSummarizationThresholdTokens(maxTokens);
  const compactionReason = getCompactionLogReason({
    providerPromptPressure,
    providerInputTokens,
    summarizationThreshold,
  });

  console.info(
    JSON.stringify({
      level: "info",
      event: "agent_in_run_context_compaction_started",
      service: "chat-handler",
      timestamp: new Date().toISOString(),
      chat_id: chatId ?? undefined,
      mode,
      subscription,
      reason: compactionReason,
      compaction_index: compactionIndex,
      persistence: "run_scoped",
      model_message_count: modelMessages.length,
      provider_input_tokens: providerInputTokens,
      max_tokens: maxTokens,
      threshold_tokens: summarizationThreshold,
      system_prompt_tokens: systemPromptTokens,
      provider_pressure_reason: providerPromptPressure?.reason,
      provider_pressure_serialized_message_bytes:
        providerPromptPressure?.serializedMessageBytes,
    }),
  );
  writeSummarizationStarted(writer, compactionIndex);

  try {
    const summaryPromise = generateSummaryTextWithRetry({
      messagesToSummarize: [],
      modelMessages,
      languageModel,
      mode,
      chatSystemPrompt,
      hasExistingSummary,
      tools,
      providerOptions,
      abortSignal,
      summaryInputMaxTokens: getSummaryInputMaxTokens(maxTokens),
      chatId,
      subscription,
      reason: compactionReason,
    });
    const transcriptPromise: Promise<string | null> =
      ensureSandbox && mode === "agent"
        ? ensureSandbox()
            .then((sandbox) =>
              saveTranscriptToSandbox([], sandbox, transcriptModelMessages),
            )
            .catch((error) => {
              console.error(
                "[Summarization] Failed to ensure sandbox for in-run transcript:",
                error,
              );
              return null;
            })
        : Promise.resolve(null);

    const [summaryResult, savedPath] = await Promise.all([
      summaryPromise,
      transcriptPromise,
    ]);
    let finalSummaryText = summaryResult.text;
    if (savedPath) finalSummaryText += buildTranscriptNotice(savedPath);

    console.info(
      JSON.stringify({
        level: "info",
        event: "agent_in_run_context_compaction_generated",
        service: "chat-handler",
        timestamp: new Date().toISOString(),
        chat_id: chatId ?? undefined,
        mode,
        subscription,
        compaction_index: compactionIndex,
        persistence: "run_scoped",
        summary_input_tokens: summaryResult.usage.inputTokens,
        summary_output_tokens: summaryResult.usage.outputTokens,
        estimated_compacted_input_tokens:
          summaryResult.usage.estimatedCompactedInputTokens,
      }),
    );

    return {
      summaryMessage: buildSummaryMessage(finalSummaryText, todos),
      summaryText: finalSummaryText,
      summarizationUsage: summaryResult.usage,
    };
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    const failedAttempt = getSummarizationAttemptFromError(error);
    logContextCompactionFailed({
      chatId,
      mode,
      subscription,
      reason: compactionReason,
      attempt: failedAttempt,
      languageModel:
        failedAttempt === "fallback"
          ? myProvider.languageModel(SUMMARIZATION_RETRY_MODEL_BY_MODE[mode])
          : languageModel,
      fallbackResult: "no_summarization",
      error,
    });
    writeSummarizationCleared(writer, compactionIndex);
    return null;
  }
};

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

export const checkAndSummarizeIfNeeded = async ({
  uiMessages,
  subscription,
  languageModel,
  mode,
  writer,
  chatId,
  fileTokens = {},
  todos = [],
  abortSignal,
  ensureSandbox,
  systemPromptTokens = 0,
  providerInputTokens = 0,
  chatSystemPrompt = "",
  tools,
  providerOptions,
  modelMessages,
  transcriptMessages,
  maxTokensOverride,
  providerPromptPressure,
}: CheckAndSummarizeOptions): Promise<SummarizationResult> => {
  // Detect and separate synthetic summary message from real messages
  let realMessages: UIMessage[];
  let existingSummaryText: string | null = null;
  let existingSummaryMessage: UIMessage | null = null;

  if (uiMessages.length > 0 && isSummaryMessage(uiMessages[0])) {
    realMessages = uiMessages.slice(1);
    existingSummaryText = extractSummaryText(uiMessages[0]);
    existingSummaryMessage = uiMessages[0];
  } else {
    realMessages = uiMessages;
  }

  // Guard: need enough real messages to split
  if (realMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return NO_SUMMARIZATION(uiMessages);
  }

  // Check token threshold on full messages (including summary) to determine need
  const effectiveMaxTokensOverride =
    providerPromptPressure?.summarizationMaxTokensOverride ?? maxTokensOverride;
  const maxTokens = resolveSummarizationMaxTokens(
    subscription,
    effectiveMaxTokensOverride,
  );
  const summarizationThreshold = getSummarizationThresholdTokens(maxTokens);
  const totalEstimatedTokens =
    countMessagesTokens(uiMessages, fileTokens) + systemPromptTokens;
  if (
    !providerPromptPressure &&
    !isAboveTokenThreshold(
      uiMessages,
      subscription,
      fileTokens,
      systemPromptTokens,
      providerInputTokens,
      effectiveMaxTokensOverride,
    )
  ) {
    return NO_SUMMARIZATION(uiMessages);
  }

  const retainedTailBudget = getRetainedTailBudgetTokens(
    summarizationThreshold,
  );
  let tailSelection = selectRetainedTailForSummarization(realMessages, {
    budgetTokens: retainedTailBudget,
    fileTokens,
  });

  if (
    tailSelection.headMessages.length === 0 &&
    providerPromptPressure &&
    !tailSelection.retainedTail?.projected_part_count
  ) {
    tailSelection = {
      headMessages: realMessages,
      tailMessages: [],
      cutoffMessageId: realMessages.at(-1)?.id ?? null,
    };
  }

  const hasSummarizableHead =
    tailSelection.headMessages.length > 0 ||
    existingSummaryMessage !== null ||
    (tailSelection.retainedTail?.projected_part_count ?? 0) > 0;

  if (!hasSummarizableHead || !tailSelection.cutoffMessageId) {
    return NO_SUMMARIZATION(uiMessages);
  }

  const messagesToSummarize = existingSummaryMessage
    ? [existingSummaryMessage, ...tailSelection.headMessages]
    : tailSelection.headMessages;

  const cutoffMessageId = tailSelection.cutoffMessageId;
  const compactionReason = getCompactionLogReason({
    providerPromptPressure,
    providerInputTokens,
    summarizationThreshold,
  });
  logContextCompactionStarted({
    chatId,
    mode,
    subscription,
    reason: compactionReason,
    totalEstimatedTokens,
    systemPromptTokens,
    providerInputTokens,
    maxTokens,
    summarizationThreshold,
    providerPromptPressure,
    fileTokens,
    cutoffMessageId,
    retainedTail: tailSelection.retainedTail,
  });

  writeSummarizationStarted(writer, 1);

  try {
    // Run summary generation and transcript saving in parallel — they are
    // independent (transcript is formatted from raw messages, not the summary).
    const summaryPromise = generateSummaryTextWithRetry({
      messagesToSummarize,
      languageModel,
      mode,
      chatSystemPrompt,
      hasExistingSummary: !!existingSummaryText,
      tools,
      providerOptions,
      abortSignal,
      summaryInputMaxTokens: getSummaryInputMaxTokens(maxTokens),
      chatId,
      subscription,
      reason: compactionReason,
    });

    // In agent modes, save the full transcript of summarized messages to the sandbox
    // so the agent can consult the raw conversation later if context is lost
    const transcriptPromise: Promise<string | null> =
      ensureSandbox && mode === "agent"
        ? ensureSandbox()
            .then((sandbox) =>
              saveTranscriptToSandbox(
                transcriptMessages ?? tailSelection.headMessages,
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

    const {
      text: summaryText,
      usage: summarizationUsage,
      languageModel: summaryLanguageModel,
    } = summaryResult;
    let finalSummaryText = summaryText;
    if (savedPath) {
      finalSummaryText += buildTranscriptNotice(savedPath);
    }

    const summaryMessage = buildSummaryMessage(finalSummaryText, todos);
    const metadata = buildSummaryPersistenceMetadata({
      providerInputTokens,
      threshold: summarizationThreshold,
      languageModel: summaryLanguageModel,
      transcriptPath: savedPath,
      retainedTail: tailSelection.retainedTail,
      reason: providerPromptPressure ? "provider_pressure" : undefined,
    });

    await persistSummary(chatId, finalSummaryText, cutoffMessageId, metadata);

    return {
      summarizationAttempted: true,
      needsSummarization: true,
      summarizedMessages: [summaryMessage, ...tailSelection.tailMessages],
      cutoffMessageId,
      summaryText: finalSummaryText,
      summarizationUsage,
    };
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const failedAttempt = getSummarizationAttemptFromError(error);
    logContextCompactionFailed({
      chatId,
      mode,
      subscription,
      reason: compactionReason,
      attempt: failedAttempt,
      languageModel:
        failedAttempt === "fallback"
          ? myProvider.languageModel(SUMMARIZATION_RETRY_MODEL_BY_MODE[mode])
          : languageModel,
      fallbackResult: "no_summarization",
      error,
    });
    return {
      ...NO_SUMMARIZATION(uiMessages),
      summarizationAttempted: true,
    };
  } finally {
    if (!abortSignal?.aborted) {
      writeSummarizationCompleted(writer, 1);
    }
  }
};
