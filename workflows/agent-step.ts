import { getWritable } from "workflow";
import {
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  stepCountIs,
  streamText,
  smoothStream,
  UIMessagePart,
  type UIMessageChunk,
} from "ai";
import { systemPrompt } from "@/lib/system-prompt";
import { getResumeSection } from "@/lib/system-prompt/resume";
import { createTools } from "@/lib/ai/tools";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import {
  sendRateLimitWarnings,
  buildProviderOptions,
  isXaiSafetyError,
  isProviderApiError,
  appendSystemReminderToLastUserMessage,
  injectNotesIntoMessages,
  refreshNotesInModelMessages,
} from "@/lib/api/chat-stream-helpers";
import {
  writeUploadStartStatus,
  writeUploadCompleteStatus,
  createSummarizationCompletedPart,
} from "@/lib/utils/stream-writer-utils";
import { checkAndSummarizeIfNeeded } from "@/lib/chat/summarization";
import { uploadSandboxFiles } from "@/lib/utils/sandbox-file-utils";
import { createTrackedProvider } from "@/lib/ai/providers";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import {
  tokenExhaustedAfterSummarization,
  TOKEN_EXHAUSTION_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import {
  saveMessage,
  updateChat,
  prepareForNewStream,
  deleteTempStreamForBackend,
} from "@/lib/db/actions";
import { deductUsage } from "@/lib/rate-limit";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";
import { deserializeRateLimitInfo } from "@/lib/api/rate-limit-serialization";
import type { Id } from "@/convex/_generated/dataModel";
import {
  extractErrorDetails,
  getUserFriendlyProviderError,
} from "@/lib/utils/error-utils";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { createCancellationSubscriber } from "@/lib/utils/stream-cancellation";
import { createChatLogger } from "@/lib/api/chat-logger";
import PostHogClient from "@/app/posthog";
import { countTokens } from "gpt-tokenizer";
import {
  countMessagesTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import {
  computeContextUsage,
  writeContextUsage,
  contextUsageEnabled,
  runSummarizationStep,
} from "@/lib/api/chat-stream-helpers";

/**
 * Workflow step that runs the full agent loop.
 * Contains the same logic as the `execute` callback in createChatHandler,
 * adapted to pipe output through the Workflow's writable stream.
 *
 * No preemptive timeout is needed since Workflow supports up to 1 hour execution.
 */
export async function runAgentStep(payload: AgentTaskPayload) {
  "use step";

  const {
    chatId,
    messages: processedMessages,
    assistantMessageId,
    mode,
    todos: baseTodos,
    regenerate,
    temporary,
    sandboxPreference,
    userId,
    subscription,
    userLocation,
    extraUsageConfig,
    estimatedInputTokens,
    memoryEnabled,
    userCustomization,
    isNewChat,
    selectedModel,
    selectedModelOverride,
    rateLimitInfo: serializedRateLimitInfo,
    sandboxFiles,
    fileTokens,
    chatFinishReason,
  } = payload;

  const rateLimitInfo = deserializeRateLimitInfo(serializedRateLimitInfo);
  const posthog = PostHogClient();

  // Initialize chat logger
  const chatLogger = createChatLogger({
    chatId,
    endpoint: "/api/agent-workflow",
  });
  chatLogger.setRequestDetails({
    mode,
    isTemporary: !!temporary,
    isRegenerate: !!regenerate,
  });
  chatLogger.setUser({
    id: userId,
    subscription,
    region: userLocation?.region,
  });
  chatLogger.setChat(
    {
      messageCount: processedMessages.length,
      estimatedInputTokens,
      hasSandboxFiles: payload.hasSandboxFiles,
      hasFileAttachments: payload.hasFileAttachments,
      fileCount: payload.fileCount,
      fileImageCount: payload.fileImageCount,
      sandboxPreference,
      memoryEnabled,
      isNewChat,
    },
    selectedModel,
  );
  chatLogger.setRateLimit(
    {
      pointsDeducted: serializedRateLimitInfo.pointsDeducted,
      extraUsagePointsDeducted:
        serializedRateLimitInfo.extraUsagePointsDeducted,
      session: serializedRateLimitInfo.session
        ? {
            remaining: serializedRateLimitInfo.session.remaining,
            limit: serializedRateLimitInfo.session.limit,
          }
        : undefined,
      weekly: serializedRateLimitInfo.weekly
        ? {
            remaining: serializedRateLimitInfo.weekly.remaining,
            limit: serializedRateLimitInfo.weekly.limit,
          }
        : undefined,
      remaining: serializedRateLimitInfo.remaining,
      subscription,
    },
    extraUsageConfig ?? undefined,
  );
  chatLogger.getBuilder().setAssistantId(assistantMessageId);
  chatLogger.startStream();

  // Set up cancellation: Redis pub/sub subscriber + AbortController
  // When the user clicks stop, cancelStreamFromClient publishes to Redis,
  // which triggers the abort controller and stops the streamText call.
  const userStopSignal = new AbortController();
  let subscriberStopped = false;
  const cancellationSubscriber = await createCancellationSubscriber({
    chatId,
    isTemporary: !!temporary,
    abortController: userStopSignal,
    onStop: () => {
      subscriberStopped = true;
    },
  });

  // Get the Workflow's writable stream for piping output to the client
  const writable = getWritable<UIMessageChunk>();

  // Track summarization events to add to message parts
  const summarizationParts: UIMessagePart<
    Record<string, unknown>,
    Record<string, { input: unknown; output: unknown }>
  >[] = [];

  // Create a UIMessageStream with a real UIMessageStreamWriter,
  // so all existing helper functions (sendRateLimitWarnings, writeUploadStartStatus, etc.)
  // work unchanged.
  const uiStream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        sendRateLimitWarnings(writer, {
          subscription,
          mode,
          rateLimitInfo,
        });

        const {
          tools,
          ensureSandbox,
          getTodoManager,
          getFileAccumulator,
          sandboxManager,
        } = createTools(
          userId,
          chatId,
          writer,
          mode,
          userLocation ?? {
            region: undefined,
            city: undefined,
            country: undefined,
          },
          baseTodos,
          memoryEnabled,
          temporary,
          assistantMessageId,
          sandboxPreference,
          process.env.CONVEX_SERVICE_ROLE_KEY,
          (userCustomization as { guardrails_config?: string } | null)
            ?.guardrails_config,
        );

        const sendFileMetadataToStream = (
          fileMetadata: Array<{
            fileId: Id<"files">;
            name: string;
            mediaType: string;
            s3Key?: string;
            storageId?: Id<"_storage">;
          }>,
        ) => {
          if (!fileMetadata?.length) return;
          writer.write({
            type: "data-file-metadata",
            data: {
              messageId: assistantMessageId,
              fileDetails: fileMetadata,
            },
          });
        };

        // Get sandbox context for system prompt (only for local sandboxes)
        let sandboxContext: string | null = null;
        if (
          isAgentMode(mode) &&
          "getSandboxContextForPrompt" in sandboxManager
        ) {
          try {
            sandboxContext = await (
              sandboxManager as {
                getSandboxContextForPrompt: () => Promise<string | null>;
              }
            ).getSandboxContextForPrompt();
          } catch (error) {
            console.warn("Failed to get sandbox context for prompt:", error);
          }
        }

        if (isAgentMode(mode) && sandboxFiles && sandboxFiles.length > 0) {
          writeUploadStartStatus(writer);
          try {
            await uploadSandboxFiles(sandboxFiles, ensureSandbox);
          } finally {
            writeUploadCompleteStatus(writer);
          }
        }

        // Generate title in parallel only for non-temporary new chats
        const titlePromise =
          isNewChat && !temporary
            ? generateTitleFromUserMessageWithWriter(processedMessages, writer)
            : Promise.resolve(undefined);

        const trackedProvider = createTrackedProvider();

        const currentSystemPrompt = await systemPrompt(
          userId,
          mode,
          subscription,
          selectedModel,
          userCustomization,
          temporary,
          sandboxContext,
        );

        const systemPromptTokens = countTokens(currentSystemPrompt);

        // Compute and stream actual context usage breakdown (when enabled)
        const ctxSystemTokens = contextUsageEnabled ? systemPromptTokens : 0;
        const ctxMaxTokens = contextUsageEnabled
          ? getMaxTokensForSubscription(subscription)
          : 0;
        let ctxUsage = contextUsageEnabled
          ? computeContextUsage(
              processedMessages,
              fileTokens,
              ctxSystemTokens,
              ctxMaxTokens,
            )
          : {
              systemTokens: 0,
              summaryTokens: 0,
              messagesTokens: 0,
              maxTokens: 0,
            };
        if (contextUsageEnabled) {
          writeContextUsage(writer, ctxUsage);
        }

        let streamFinishReason: string | undefined;
        let finalMessages = processedMessages;

        // Inject resume context
        const resumeContext = getResumeSection(chatFinishReason);
        if (resumeContext) {
          finalMessages = appendSystemReminderToLastUserMessage(
            finalMessages,
            resumeContext,
          );
        }

        // Inject notes into messages
        const shouldIncludeNotes =
          userCustomization?.include_memory_entries ?? true;
        const noteInjectionOpts = {
          userId,
          subscription,
          shouldIncludeNotes,
          isTemporary: temporary,
        };
        finalMessages = await injectNotesIntoMessages(
          finalMessages,
          noteInjectionOpts,
        );

        let hasSummarized = false;
        let stoppedDueToTokenExhaustion = false;
        let lastStepInputTokens = 0;
        const isReasoningModel = isAgentMode(mode);
        const streamStartTime = Date.now();
        const configuredModelId =
          trackedProvider.languageModel(selectedModel).modelId;

        let streamUsage: Record<string, unknown> | undefined;
        let responseModel: string | undefined;
        let isRetryWithFallback = false;
        const fallbackModel = "fallback-agent-model";

        let accumulatedInputTokens = 0;
        let accumulatedOutputTokens = 0;
        let accumulatedProviderCost = 0;
        let hasDeductedUsage = false;

        const deductAccumulatedUsage = async () => {
          if (hasDeductedUsage || subscription === "free") return;
          if (accumulatedInputTokens > 0 || accumulatedOutputTokens > 0) {
            hasDeductedUsage = true;
            await deductUsage(
              userId,
              subscription,
              estimatedInputTokens,
              accumulatedInputTokens,
              accumulatedOutputTokens,
              extraUsageConfig ?? undefined,
              accumulatedProviderCost > 0 ? accumulatedProviderCost : undefined,
              selectedModel,
            );
          }
        };

        const createStream = async (modelName: string) =>
          streamText({
            model: trackedProvider.languageModel(modelName),
            system: currentSystemPrompt,
            messages: await convertToModelMessages(finalMessages),
            tools,
            abortSignal: userStopSignal.signal,
            prepareStep: async ({ steps, messages }) => {
              try {
                if (!temporary && !hasSummarized) {
                  const result = await runSummarizationStep({
                    messages: finalMessages,
                    subscription,
                    languageModel: trackedProvider.languageModel(modelName),
                    mode,
                    writer,
                    chatId,
                    fileTokens,
                    todos: getTodoManager().getAllTodos(),
                    abortSignal: userStopSignal.signal,
                    ensureSandbox,
                    systemPromptTokens,
                    ctxSystemTokens,
                    ctxMaxTokens,
                    providerInputTokens: lastStepInputTokens,
                  });

                  if (result.needsSummarization && result.summarizedMessages) {
                    hasSummarized = true;
                    summarizationParts.push(
                      createSummarizationCompletedPart() as UIMessagePart<
                        Record<string, unknown>,
                        Record<string, { input: unknown; output: unknown }>
                      >,
                    );
                    if (result.contextUsage) {
                      ctxUsage = result.contextUsage;
                    }
                    return {
                      messages: await convertToModelMessages(
                        result.summarizedMessages,
                      ),
                    };
                  }
                }

                const lastStep = Array.isArray(steps)
                  ? steps.at(-1)
                  : undefined;
                const toolResults =
                  (lastStep &&
                    (lastStep as { toolResults?: unknown[] }).toolResults) ||
                  [];

                const wasNoteModified =
                  Array.isArray(toolResults) &&
                  toolResults.some((r) =>
                    ["create_note", "update_note", "delete_note"].includes(
                      (r as { toolName?: string })?.toolName ?? "",
                    ),
                  );

                if (!wasNoteModified) {
                  return { messages };
                }

                const updatedMessages = await refreshNotesInModelMessages(
                  messages as Array<Record<string, unknown>>,
                  noteInjectionOpts,
                );

                return { messages: updatedMessages as typeof messages };
              } catch (error) {
                if (
                  error instanceof DOMException &&
                  error.name === "AbortError"
                ) {
                  // Expected when user stops the stream
                } else {
                  console.error("Error in prepareStep:", error);
                }
                return currentSystemPrompt
                  ? { system: currentSystemPrompt }
                  : {};
              }
            },
            providerOptions: buildProviderOptions(
              isReasoningModel,
              subscription,
              userId,
            ),
            experimental_transform: smoothStream({ chunking: "word" }),
            stopWhen: isAgentMode(mode)
              ? [
                  stepCountIs(getMaxStepsForUser(mode, subscription)),
                  tokenExhaustedAfterSummarization({
                    getLastStepInputTokens: () => lastStepInputTokens,
                    getHasSummarized: () => hasSummarized,
                    onFired: () => {
                      stoppedDueToTokenExhaustion = true;
                    },
                  }),
                ]
              : stepCountIs(getMaxStepsForUser(mode, subscription)),
            onChunk: async (chunk) => {
              if (chunk.chunk.type === "tool-call") {
                const sandboxType = sandboxManager.getSandboxType(
                  chunk.chunk.toolName,
                );

                chatLogger.recordToolCall(chunk.chunk.toolName, sandboxType);

                if (posthog) {
                  posthog.capture({
                    distinctId: userId,
                    event: "hackerai-" + chunk.chunk.toolName,
                    properties: {
                      mode,
                      ...(sandboxType && { sandboxType }),
                    },
                  });
                }
              }
            },
            onStepFinish: async ({ usage }) => {
              if (usage) {
                accumulatedInputTokens += usage.inputTokens || 0;
                accumulatedOutputTokens += usage.outputTokens || 0;
                lastStepInputTokens = usage.inputTokens || 0;
                const stepCost = (usage as { raw?: { cost?: number } }).raw
                  ?.cost;
                if (stepCost) {
                  accumulatedProviderCost += stepCost;
                }
              }
            },
            onFinish: async ({ finishReason, usage, response }) => {
              if (stoppedDueToTokenExhaustion) {
                streamFinishReason = TOKEN_EXHAUSTION_FINISH_REASON;
              } else {
                streamFinishReason = finishReason;
              }
              streamUsage = usage as Record<string, unknown>;
              responseModel = response?.modelId;
              chatLogger.setStreamResponse(responseModel, streamUsage);
            },
            onError: async (error) => {
              if (!isXaiSafetyError(error)) {
                console.error("Provider streaming error:", error);
              }
            },
          });

        let result;
        try {
          result = await createStream(selectedModel);
        } catch (error) {
          if (isProviderApiError(error) && !isRetryWithFallback) {
            console.warn(
              "Provider API error, retrying with fallback",
              extractErrorDetails(error),
            );
            isRetryWithFallback = true;
            lastStepInputTokens = 0;
            stoppedDueToTokenExhaustion = false;
            result = await createStream(fallbackModel);
          } else {
            throw error;
          }
        }

        writer.merge(
          result.toUIMessageStream({
            generateMessageId: () => assistantMessageId,
            onFinish: async ({ messages, isAborted }) => {
              // Stop cancellation subscriber
              if (!subscriberStopped) {
                await cancellationSubscriber.stop();
                subscriberStopped = true;
              }

              // Clear finish reason for user-initiated aborts
              if (isAborted) {
                streamFinishReason = undefined;
              }

              // Emit wide event
              chatLogger.setSandbox(sandboxManager.getSandboxInfo());
              chatLogger.emitSuccess({
                finishReason: streamFinishReason,
                wasAborted: !!isAborted,
                wasPreemptiveTimeout: false,
                hadSummarization: hasSummarized,
              });

              const generatedTitle = await titlePromise;

              if (!temporary) {
                const mergedTodos = getTodoManager().mergeWith(
                  baseTodos,
                  assistantMessageId,
                );

                const shouldPersist = regenerate
                  ? true
                  : Boolean(
                      generatedTitle ||
                      streamFinishReason ||
                      mergedTodos.length > 0,
                    );

                if (shouldPersist) {
                  await updateChat({
                    chatId,
                    title: generatedTitle,
                    finishReason: streamFinishReason,
                    todos: mergedTodos,
                    defaultModelSlug: mode,
                    sandboxType: sandboxManager.getEffectivePreference(),
                    selectedModel: selectedModelOverride,
                  });
                } else {
                  await prepareForNewStream({ chatId });
                }

                const accumulatedFiles = getFileAccumulator().getAll();
                const newFileIds = accumulatedFiles.map((f) => f.fileId);

                // On user-initiated abort with skipSave, skip message persistence
                // (edit/regenerate/retry — message will be discarded)
                if (
                  isAborted &&
                  cancellationSubscriber.shouldSkipSave() &&
                  newFileIds.length === 0
                ) {
                  await deductAccumulatedUsage();
                  return;
                }

                for (const message of messages) {
                  if (message.role !== "assistant") continue;

                  const processedMessage =
                    summarizationParts.length > 0
                      ? {
                          ...message,
                          parts: [
                            ...summarizationParts,
                            ...(message.parts || []),
                          ],
                        }
                      : message;

                  await saveMessage({
                    chatId,
                    userId,
                    message: processedMessage,
                    extraFileIds: newFileIds,
                    model: responseModel || configuredModelId,
                    generationTimeMs: Date.now() - streamStartTime,
                    finishReason: streamFinishReason,
                    usage: streamUsage,
                    updateOnly: isAborted ? true : undefined,
                  });
                }

                sendFileMetadataToStream(accumulatedFiles);
              } else {
                const tempFiles = getFileAccumulator().getAll();
                sendFileMetadataToStream(tempFiles);
                await deleteTempStreamForBackend({ chatId });
              }

              // Send updated context usage with output tokens
              if (contextUsageEnabled) {
                writeContextUsage(writer, {
                  ...ctxUsage,
                  messagesTokens:
                    ctxUsage.messagesTokens + accumulatedOutputTokens,
                });
              }

              await deductAccumulatedUsage();
            },
            sendReasoning: true,
          }),
        );
      } catch (error) {
        // Clean up cancellation subscriber on error
        if (!subscriberStopped) {
          await cancellationSubscriber.stop();
          subscriberStopped = true;
        }
        chatLogger.emitUnexpectedError(error);
        throw error;
      }
    },
  });

  // Pipe the UIMessageStream output to the Workflow's writable stream
  const reader = uiStream.getReader();
  const wWriter = writable.getWriter();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await wWriter.write(value);
    }
  } finally {
    reader.releaseLock();
    wWriter.releaseLock();
  }
}
