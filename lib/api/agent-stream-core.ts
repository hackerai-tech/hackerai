import {
  convertToModelMessages,
  generateId,
  stepCountIs,
  streamText,
  smoothStream,
  UIMessage,
  UIMessagePart,
  type UIMessageStreamWriter,
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
  computeContextUsage,
  writeContextUsage,
  contextUsageEnabled,
  runSummarizationStep,
} from "@/lib/api/chat-stream-helpers";
import {
  writeUploadStartStatus,
  writeUploadCompleteStatus,
  createSummarizationCompletedPart,
  writeAutoContinue,
} from "@/lib/utils/stream-writer-utils";
import { uploadSandboxFiles } from "@/lib/utils/sandbox-file-utils";
import { createTrackedProvider } from "@/lib/ai/providers";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import {
  tokenExhaustedAfterSummarization,
  TOKEN_EXHAUSTION_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import { SUMMARIZATION_THRESHOLD_PERCENTAGE } from "@/lib/chat/summarization/constants";
import {
  saveMessage,
  updateChat,
  prepareForNewStream,
  deleteTempStreamForBackend,
} from "@/lib/db/actions";
import { deductUsage } from "@/lib/rate-limit";
import { UsageTracker } from "@/lib/usage-tracker";
import type { Id } from "@/convex/_generated/dataModel";
import {
  extractErrorDetails,
  getUserFriendlyProviderError,
} from "@/lib/utils/error-utils";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { createCancellationSubscriber } from "@/lib/utils/stream-cancellation";
import type { ChatLogger } from "@/lib/api/chat-logger";
import PostHogClient from "@/app/posthog";
import { countTokens } from "gpt-tokenizer";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import type {
  ChatMode,
  Todo,
  RateLimitInfo,
  SandboxPreference,
  ExtraUsageConfig,
  SubscriptionTier,
  SelectedModel,
} from "@/types";
import type { UserCustomization } from "@/types/user";
import type { SandboxFile } from "@/lib/utils/sandbox-file-utils";
import type { UsageRefundTracker } from "@/lib/rate-limit/refund";

/** Logger interface that abstracts over nextJsAxiomLogger / workflowAxiomLogger */
interface StreamLogger {
  error(message: string, meta: Record<string, unknown>): void;
  info(message: string, meta: Record<string, unknown>): void;
  warn?(message: string, meta: Record<string, unknown>): void;
  flush(): Promise<void>;
}

/** Optional preemptive timeout (only used by non-workflow handler) */
interface PreemptiveTimeout {
  isPreemptive(): boolean;
  clear(): void;
  getTriggerTime(): number | null;
}

/** Config for the shared agent stream execute function */
export interface AgentStreamConfig {
  // Identity
  chatId: string;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  assistantMessageId: string;
  endpoint: string;

  // Messages & model
  processedMessages: UIMessage[];
  selectedModel: string;
  selectedModelOverride?: SelectedModel;

  // Features
  temporary: boolean;
  regenerate: boolean;
  isNewChat: boolean;
  memoryEnabled: boolean;
  isAutoContinue?: boolean;

  // Pre-computed data
  rateLimitInfo: RateLimitInfo;
  baseTodos: Todo[];
  sandboxPreference: SandboxPreference;
  userLocation: { region?: string; city?: string; country?: string };
  userCustomization: UserCustomization | null;
  extraUsageConfig?: ExtraUsageConfig;
  estimatedInputTokens: number;
  fileTokens: Record<string, number>;
  sandboxFiles?: SandboxFile[];
  chatFinishReason?: string;

  // Tauri desktop integration
  tauriCmdServer?: { port: number; token: string } | null;

  // Platform-specific
  logger: StreamLogger;
  chatLogger: ChatLogger;
  usageRefundTracker: UsageRefundTracker;
  abortController: AbortController;

  // Optional (only non-workflow)
  preemptiveTimeout?: PreemptiveTimeout;
}

/**
 * Creates the `execute` callback for `createUIMessageStream`.
 *
 * This is the shared core between chat-handler.ts (serverless) and
 * agent-step.ts (Vercel Workflow). It encapsulates tool creation,
 * streamText, fallback retry, message persistence, and usage deduction.
 *
 * Callers wrap the returned callback differently:
 * - chat-handler: `createUIMessageStreamResponse({ stream: createUIMessageStream({ execute }) })`
 * - agent-step:   `createUIMessageStream({ execute }).pipeTo(getWritable())`
 */
export function createAgentStreamExecute(config: AgentStreamConfig) {
  const {
    chatId,
    userId,
    subscription,
    mode,
    assistantMessageId,
    endpoint,
    processedMessages,
    selectedModel,
    selectedModelOverride,
    temporary,
    regenerate,
    isNewChat,
    memoryEnabled,
    isAutoContinue,
    rateLimitInfo,
    baseTodos,
    sandboxPreference,
    userLocation,
    userCustomization,
    extraUsageConfig,
    estimatedInputTokens,
    fileTokens,
    sandboxFiles,
    chatFinishReason,
    tauriCmdServer,
    logger,
    chatLogger,
    usageRefundTracker,
    abortController: userStopSignal,
    preemptiveTimeout,
  } = config;

  // Set up cancellation: Redis pub/sub subscriber + AbortController
  let subscriberStopped = false;
  let cancellationSubscriber: Awaited<
    ReturnType<typeof createCancellationSubscriber>
  >;

  // Track summarization events to add to message parts
  const summarizationParts: UIMessagePart<
    Record<string, unknown>,
    Record<string, { input: unknown; output: unknown }>
  >[] = [];

  const execute = async ({ writer }: { writer: UIMessageStreamWriter }) => {
    try {
      // Initialize cancellation subscriber inside execute to ensure it's
      // created within the stream's execution context
      cancellationSubscriber = await createCancellationSubscriber({
        chatId,
        isTemporary: !!temporary,
        abortController: userStopSignal,
        onStop: () => {
          subscriberStopped = true;
        },
      });

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
        getSandboxSessionCost,
      } = createTools(
        userId,
        chatId,
        writer,
        mode,
        userLocation,
        baseTodos,
        memoryEnabled,
        temporary,
        assistantMessageId,
        sandboxPreference,
        process.env.CONVEX_SERVICE_ROLE_KEY,
        (userCustomization as { guardrails_config?: string } | null)
          ?.guardrails_config,
        undefined, // appendMetadataStream
        (costDollars: number) => {
          usageTracker.providerCost += costDollars;
          chatLogger?.getBuilder().addToolCost(costDollars);
        },
        tauriCmdServer ?? null,
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
        if (!fileMetadata || fileMetadata.length === 0) return;
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
      if (isAgentMode(mode) && "getSandboxContextForPrompt" in sandboxManager) {
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
      const posthog = PostHogClient();

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
      const isReasoningModel = isAgentMode(mode);
      const streamStartTime = Date.now();
      const configuredModelId =
        trackedProvider.languageModel(selectedModel).modelId;

      let streamUsage: Record<string, unknown> | undefined;
      let responseModel: string | undefined;
      let isRetryWithFallback = false;
      const fallbackModel =
        mode === "agent" ? "fallback-agent-model" : "fallback-ask-model";

      const usageTracker = new UsageTracker();
      let hasDeductedUsage = false;

      const deductAccumulatedUsage = async () => {
        if (hasDeductedUsage || subscription === "free") return;
        // Add E2B sandbox session cost (duration-based)
        const sandboxCost = getSandboxSessionCost();
        if (sandboxCost > 0) {
          usageTracker.providerCost += sandboxCost;
          chatLogger?.getBuilder().addToolCost(sandboxCost);
          console.log(
            `[sandbox-cost] E2B session cost: $${sandboxCost.toFixed(6)}`,
          );
        }
        if (!usageTracker.hasUsage) return;
        hasDeductedUsage = true;
        await deductUsage(
          userId,
          subscription,
          estimatedInputTokens,
          usageTracker.inputTokens,
          usageTracker.outputTokens,
          extraUsageConfig,
          usageTracker.providerCost > 0 ? usageTracker.providerCost : undefined,
          selectedModel,
        );
        usageTracker.log({
          userId,
          selectedModel,
          selectedModelOverride,
          responseModel,
          configuredModelId,
          rateLimitInfo,
        });
      };

      // Helper to create streamText with a given model (reused for retry)
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
                  providerInputTokens: usageTracker.lastStepInputTokens,
                  chatSystemPrompt: currentSystemPrompt,
                  tools,
                  providerOptions: buildProviderOptions(
                    isReasoningModel,
                    subscription,
                    userId,
                  ),
                });

                if (result.needsSummarization && result.summarizedMessages) {
                  hasSummarized = true;
                  summarizationParts.push(
                    createSummarizationCompletedPart() as UIMessagePart<
                      Record<string, unknown>,
                      Record<string, { input: unknown; output: unknown }>
                    >,
                  );
                  if (result.summarizationUsage) {
                    usageTracker.inputTokens +=
                      result.summarizationUsage.inputTokens;
                    usageTracker.outputTokens +=
                      result.summarizationUsage.outputTokens;
                    usageTracker.summarizationOutputTokens +=
                      result.summarizationUsage.outputTokens;
                    usageTracker.cacheReadTokens +=
                      result.summarizationUsage.cacheReadTokens || 0;
                    usageTracker.cacheWriteTokens +=
                      result.summarizationUsage.cacheWriteTokens || 0;
                    if (result.summarizationUsage.cost) {
                      usageTracker.providerCost +=
                        result.summarizationUsage.cost;
                    }
                  }
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

              const lastStep = Array.isArray(steps) ? steps.at(-1) : undefined;
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
              return currentSystemPrompt ? { system: currentSystemPrompt } : {};
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
                  threshold: Math.floor(
                    getMaxTokensForSubscription(subscription) *
                      SUMMARIZATION_THRESHOLD_PERCENTAGE,
                  ),
                  getLastStepInputTokens: () =>
                    usageTracker.lastStepInputTokens,
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
          experimental_onToolCallFinish: async ({
            toolCall,
            durationMs,
            success,
          }) => {
            logger.info("Tool call finished", {
              chatId,
              endpoint,
              toolName: toolCall?.toolName,
              durationMs,
              success,
            });
          },
          onStepFinish: async ({ usage }) => {
            if (usage) {
              usageTracker.accumulateStep(
                usage as Parameters<typeof usageTracker.accumulateStep>[0],
              );
            }
          },
          onFinish: async ({ finishReason, usage, response }) => {
            if (preemptiveTimeout?.isPreemptive()) {
              streamFinishReason = "timeout";
            } else if (stoppedDueToTokenExhaustion) {
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
              logger.error("Provider streaming error", {
                chatId,
                endpoint,
                mode,
                model: selectedModel,
                userId,
                subscription,
                isTemporary: temporary,
                ...extractErrorDetails(error),
              });
            }
            // Refund credits on streaming errors (idempotent - only refunds once)
            await usageRefundTracker.refund();
          },
        });

      let result;
      try {
        result = await createStream(selectedModel);
      } catch (error) {
        if (isProviderApiError(error) && !isRetryWithFallback) {
          logger.error("Provider API error, retrying with fallback", {
            chatId,
            endpoint,
            mode,
            originalModel: selectedModel,
            fallbackModel,
            userId,
            subscription,
            isTemporary: temporary,
            ...extractErrorDetails(error),
          });
          isRetryWithFallback = true;
          usageTracker.lastStepInputTokens = 0;
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
            // Check if stream finished with only step-start (incomplete response)
            const lastAssistantMessage = messages
              .slice()
              .reverse()
              .find((m) => m.role === "assistant");
            const hasOnlyStepStart =
              lastAssistantMessage?.parts?.length === 1 &&
              lastAssistantMessage.parts[0]?.type === "step-start";

            if (hasOnlyStepStart) {
              logger.error("Stream finished incomplete - triggering fallback", {
                chatId,
                endpoint,
                mode,
                model: selectedModel,
                userId,
                subscription,
                isTemporary: temporary,
                messageCount: messages.length,
                parts: lastAssistantMessage?.parts,
                isRetryWithFallback,
                assistantMessageId,
              });

              // Retry with fallback model if not already retrying
              if (!isRetryWithFallback && !isAborted) {
                isRetryWithFallback = true;
                usageTracker.lastStepInputTokens = 0;
                stoppedDueToTokenExhaustion = false;
                const fallbackStartTime = Date.now();

                const retryResult = await createStream(fallbackModel);
                const retryMessageId = generateId();

                writer.merge(
                  retryResult.toUIMessageStream({
                    generateMessageId: () => retryMessageId,
                    onFinish: async ({
                      messages: retryMessages,
                      isAborted: retryAborted,
                    }) => {
                      // Cleanup
                      preemptiveTimeout?.clear();
                      if (!subscriberStopped) {
                        await cancellationSubscriber.stop();
                        subscriberStopped = true;
                      }

                      chatLogger.setSandbox(sandboxManager.getSandboxInfo());
                      chatLogger.emitSuccess({
                        finishReason: streamFinishReason,
                        wasAborted: !!retryAborted,
                        wasPreemptiveTimeout: false,
                        hadSummarization: hasSummarized,
                      });

                      const generatedTitle = await titlePromise;

                      if (!temporary) {
                        const mergedTodos = getTodoManager().mergeWith(
                          baseTodos,
                          retryMessageId,
                        );

                        if (
                          generatedTitle ||
                          streamFinishReason ||
                          mergedTodos.length > 0
                        ) {
                          await updateChat({
                            chatId,
                            title: generatedTitle,
                            finishReason: streamFinishReason,
                            todos: mergedTodos,
                            defaultModelSlug: mode,
                            sandboxType:
                              sandboxManager.getEffectivePreference(),
                            selectedModel: selectedModelOverride,
                          });
                        } else {
                          await prepareForNewStream({ chatId });
                        }

                        const accumulatedFiles = getFileAccumulator().getAll();
                        const newFileIds = accumulatedFiles.map(
                          (f) => f.fileId,
                        );

                        for (const msg of retryMessages) {
                          if (msg.role !== "assistant") continue;

                          const processed =
                            summarizationParts.length > 0
                              ? {
                                  ...msg,
                                  parts: [
                                    ...summarizationParts,
                                    ...(msg.parts || []),
                                  ],
                                }
                              : msg;

                          // Skip empty messages
                          if (
                            (!processed.parts ||
                              processed.parts.length === 0) &&
                            newFileIds.length === 0
                          ) {
                            continue;
                          }

                          await saveMessage({
                            chatId,
                            userId,
                            message: processed,
                            extraFileIds: newFileIds,
                            usage: streamUsage,
                            model: responseModel,
                            generationTimeMs: Date.now() - fallbackStartTime,
                            finishReason: streamFinishReason,
                          });
                        }

                        sendFileMetadataToStream(accumulatedFiles);
                      } else {
                        const tempFiles = getFileAccumulator().getAll();
                        sendFileMetadataToStream(tempFiles);
                        await deleteTempStreamForBackend({ chatId });
                      }

                      // Log fallback result
                      const fallbackAssistantMessage = retryMessages
                        .slice()
                        .reverse()
                        .find((m) => m.role === "assistant");
                      const fallbackHasContent =
                        fallbackAssistantMessage?.parts?.some(
                          (p) =>
                            p.type === "text" ||
                            p.type === "tool-invocation" ||
                            p.type === "reasoning",
                        ) ?? false;

                      logger.info("Fallback completed", {
                        chatId,
                        originalModel: selectedModel,
                        originalAssistantMessageId: assistantMessageId,
                        fallbackModel,
                        fallbackAssistantMessageId: retryMessageId,
                        fallbackDurationMs: Date.now() - fallbackStartTime,
                        fallbackSuccess: fallbackHasContent,
                        fallbackWasAborted: retryAborted,
                        fallbackMessageCount: retryMessages.length,
                        userId,
                        subscription,
                      });

                      // Send updated context usage
                      if (contextUsageEnabled) {
                        writeContextUsage(writer, {
                          ...ctxUsage,
                          messagesTokens:
                            ctxUsage.messagesTokens +
                            usageTracker.streamOutputTokens,
                        });
                      }

                      await deductAccumulatedUsage();
                    },
                    sendReasoning: true,
                  }),
                );

                return; // Skip normal cleanup - retry handles it
              }
            }

            const isPreemptiveAbort =
              preemptiveTimeout?.isPreemptive() ?? false;
            const onFinishStartTime = Date.now();
            const triggerTime = preemptiveTimeout?.getTriggerTime();

            // Helper to log step timing during preemptive timeout
            const logStep = (step: string, stepStartTime: number) => {
              if (isPreemptiveAbort) {
                const stepDuration = Date.now() - stepStartTime;
                const totalElapsed =
                  Date.now() - (triggerTime || onFinishStartTime);
                logger.info("Preemptive timeout cleanup step", {
                  chatId,
                  step,
                  stepDurationMs: stepDuration,
                  totalElapsedSinceTriggerMs: totalElapsed,
                  endpoint,
                });
              }
            };

            if (isPreemptiveAbort) {
              logger.info("Preemptive timeout onFinish started", {
                chatId,
                endpoint,
                timeSinceTriggerMs: triggerTime
                  ? onFinishStartTime - triggerTime
                  : null,
                messageCount: messages.length,
                isTemporary: temporary,
              });
            }

            // Clear pre-emptive timeout
            let stepStart = Date.now();
            preemptiveTimeout?.clear();
            logStep("clear_timeout", stepStart);

            // Stop cancellation subscriber
            stepStart = Date.now();
            if (!subscriberStopped) {
              await cancellationSubscriber.stop();
              subscriberStopped = true;
            }
            logStep("stop_cancellation_subscriber", stepStart);

            // Clear finish reason for user-initiated aborts (not pre-emptive timeouts)
            if (isAborted && !isPreemptiveAbort) {
              streamFinishReason = undefined;
            }

            // Emit wide event
            stepStart = Date.now();
            chatLogger.setSandbox(sandboxManager.getSandboxInfo());
            chatLogger.emitSuccess({
              finishReason: streamFinishReason,
              wasAborted: !!isAborted,
              wasPreemptiveTimeout: isPreemptiveAbort,
              hadSummarization: hasSummarized,
            });
            logStep("emit_success_event", stepStart);

            stepStart = Date.now();
            const generatedTitle = await titlePromise;
            logStep("wait_title_generation", stepStart);

            if (!temporary) {
              stepStart = Date.now();
              const mergedTodos = getTodoManager().mergeWith(
                baseTodos,
                assistantMessageId,
              );
              logStep("merge_todos", stepStart);

              const shouldPersist = regenerate
                ? true
                : Boolean(
                    generatedTitle ||
                    streamFinishReason ||
                    mergedTodos.length > 0,
                  );

              if (shouldPersist) {
                stepStart = Date.now();
                await updateChat({
                  chatId,
                  title: generatedTitle,
                  finishReason: streamFinishReason,
                  todos: mergedTodos,
                  defaultModelSlug: mode,
                  sandboxType: sandboxManager.getEffectivePreference(),
                  selectedModel: selectedModelOverride,
                });
                logStep("update_chat", stepStart);
              } else {
                stepStart = Date.now();
                await prepareForNewStream({ chatId });
                logStep("prepare_for_new_stream", stepStart);
              }

              stepStart = Date.now();
              const accumulatedFiles = getFileAccumulator().getAll();
              const newFileIds = accumulatedFiles.map((f) => f.fileId);
              logStep("get_accumulated_files", stepStart);

              // Check for incomplete tool calls
              const hasIncompleteToolCalls = messages.some(
                (msg) =>
                  msg.role === "assistant" &&
                  msg.parts?.some(
                    (p: {
                      type?: string;
                      state?: string;
                      toolCallId?: string;
                    }) =>
                      p.type?.startsWith("tool-") &&
                      p.state !== "output-available" &&
                      p.toolCallId,
                  ),
              );

              // On abort, streamText.onFinish may not have fired yet, so streamUsage
              // could be undefined. Await usage from result to ensure we capture it.
              let resolvedUsage: Record<string, unknown> | undefined =
                streamUsage;
              if (!resolvedUsage && isAborted) {
                try {
                  resolvedUsage = (await result.usage) as Record<
                    string,
                    unknown
                  >;
                } catch {
                  // Usage unavailable on abort - continue without it
                }
              }

              const hasUsageToRecord = Boolean(resolvedUsage);

              // Skip save when:
              // 1. skipSave signal received (edit/regenerate/retry)
              // 2. No files, tools, or usage to record (frontend already saved)
              if (
                isAborted &&
                !isPreemptiveAbort &&
                (cancellationSubscriber.shouldSkipSave() ||
                  (newFileIds.length === 0 &&
                    !hasIncompleteToolCalls &&
                    !hasUsageToRecord))
              ) {
                await deductAccumulatedUsage();
                return;
              }

              // Save messages
              stepStart = Date.now();
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

                // Skip saving messages with no parts and no files
                if (
                  (!processedMessage.parts ||
                    processedMessage.parts.length === 0) &&
                  newFileIds.length === 0
                ) {
                  continue;
                }

                await saveMessage({
                  chatId,
                  userId,
                  message: processedMessage,
                  extraFileIds: newFileIds,
                  model: responseModel || configuredModelId,
                  generationTimeMs: Date.now() - streamStartTime,
                  finishReason: streamFinishReason,
                  usage: resolvedUsage ?? streamUsage,
                  updateOnly:
                    isAborted && !isPreemptiveAbort ? true : undefined,
                  isHidden:
                    isAutoContinue && processedMessage.role === "user"
                      ? true
                      : undefined,
                });
              }
              logStep("save_messages", stepStart);

              stepStart = Date.now();
              sendFileMetadataToStream(accumulatedFiles);
              logStep("send_file_metadata", stepStart);
            } else {
              stepStart = Date.now();
              const tempFiles = getFileAccumulator().getAll();
              sendFileMetadataToStream(tempFiles);
              logStep("send_temp_file_metadata", stepStart);

              stepStart = Date.now();
              await deleteTempStreamForBackend({ chatId });
              logStep("delete_temp_stream", stepStart);
            }

            if (isPreemptiveAbort) {
              const totalDuration = Date.now() - onFinishStartTime;
              logger.info("Preemptive timeout onFinish completed", {
                chatId,
                endpoint,
                totalOnFinishDurationMs: totalDuration,
                totalSinceTriggerMs: triggerTime
                  ? Date.now() - triggerTime
                  : null,
              });
              await logger.flush();
            }

            // Send updated context usage with output tokens
            if (contextUsageEnabled) {
              writeContextUsage(writer, {
                ...ctxUsage,
                messagesTokens:
                  ctxUsage.messagesTokens + usageTracker.streamOutputTokens,
              });
            }

            if (
              stoppedDueToTokenExhaustion &&
              isAgentMode(mode) &&
              !temporary
            ) {
              writeAutoContinue(writer);
            }

            await deductAccumulatedUsage();
          },
          sendReasoning: true,
        }),
      );
    } catch (error) {
      // Clean up cancellation subscriber on error
      if (cancellationSubscriber && !subscriberStopped) {
        await cancellationSubscriber.stop();
        subscriberStopped = true;
      }

      // Refund credits (idempotent - safe if already refunded in onError)
      await usageRefundTracker.refund();

      // Log to Axiom with full context
      if (!isXaiSafetyError(error)) {
        logger.error("Fatal streaming error", {
          chatId,
          endpoint,
          mode,
          userId,
          subscription,
          isTemporary: temporary,
          ...extractErrorDetails(error),
        });
        await logger.flush();
      }

      chatLogger.emitUnexpectedError(error);

      // Write user-friendly error to the stream so the client can display it
      try {
        writer.write({
          type: "error",
          errorText: getUserFriendlyProviderError(error),
        });
      } catch {
        // Stream may already be closed
      }

      // Clear active_stream_id so the chat isn't left "locked"
      try {
        await prepareForNewStream({ chatId });
      } catch {
        // Best-effort cleanup — don't mask the original error
      }

      throw error;
    }
  };

  return execute;
}
