"use node";

import {
  convertToModelMessages,
  generateId,
  stepCountIs,
  streamText,
  smoothStream,
  UIMessagePart,
} from "ai";
import { task } from "@trigger.dev/sdk/v3";
import { logger } from "@trigger.dev/sdk/v3";
import { systemPrompt } from "@/lib/system-prompt";
import { createTools } from "@/lib/ai/tools";
import { generateTitleFromUserMessage } from "@/lib/actions";
import {
  sendRateLimitWarnings,
  buildProviderOptions,
  isXaiSafetyError,
  isProviderApiError,
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
  saveMessage,
  updateChat,
  prepareForNewStream,
  deleteTempStreamForBackend,
  clearActiveTriggerRunIdFromBackend,
} from "@/lib/db/actions";
import { deductUsage } from "@/lib/rate-limit";
import { aiStream, metadataStream, type MetadataEvent } from "./streams";
import type {
  AgentTaskPayload,
  SerializableRateLimitInfo,
} from "@/lib/api/prepare-agent-payload";
import type { UIMessageStreamWriter } from "ai";
import type { Id } from "@/convex/_generated/dataModel";
import { extractErrorDetails } from "@/lib/utils/error-utils";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { createChatLogger } from "@/lib/api/chat-logger";
import { triggerAxiomLogger } from "@/lib/axiom/trigger";
import PostHogClient from "@/app/posthog";

/**
 * Classifies errors that indicate client disconnect / stream closed (S2Error, ECONNRESET).
 * These should be logged for ops but not reported as user-facing unexpected errors.
 */
function isClientDisconnectError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "S2Error") return true;
    const msg = err.message ?? "";
    if (
      msg.includes("stream is not open") ||
      msg.includes("HTTP/2") ||
      msg.includes("ECONNRESET")
    )
      return true;
  }
  const nodeErr = err as NodeJS.ErrnoException | undefined;
  if (nodeErr?.code === "ECONNRESET") return true;
  return false;
}

function deserializeRateLimitInfo(info: SerializableRateLimitInfo): {
  remaining: number;
  resetTime: Date;
  limit: number;
  session?: { remaining: number; limit: number; resetTime: Date };
  weekly?: { remaining: number; limit: number; resetTime: Date };
  extraUsagePointsDeducted?: number;
} {
  return {
    ...info,
    resetTime: new Date(info.resetTime),
    session: info.session
      ? {
          ...info.session,
          resetTime: new Date(info.session.resetTime),
        }
      : undefined,
    weekly: info.weekly
      ? {
          ...info.weekly,
          resetTime: new Date(info.weekly.resetTime),
        }
      : undefined,
  };
}

/** Append a metadata event as a JSON string so the client receives parseable data. */
function appendMetadata(event: MetadataEvent): Promise<void> {
  return metadataStream.append(JSON.stringify(event));
}

/** Creates a writer-like object that appends data-* parts to metadataStream. Uses shared reporter for append failures. */
function createMetadataWriter(
  reportStreamWriteError: (err: unknown, context?: { type?: string }) => void,
): UIMessageStreamWriter {
  return {
    write(part: { type: string; data?: unknown }) {
      if (!part.type.startsWith("data-")) return;
      const event = { type: part.type, data: part.data } as MetadataEvent;
      appendMetadata(event).catch((err) =>
        reportStreamWriteError(err, { type: part.type }),
      );
    },
    merge: () => {
      // No-op: we pipe LLM stream separately to aiStream
    },
    onError: undefined,
  };
}

/**
 * Agent-long error boundaries (for ops/docs):
 * - Route (POST /api/agent-long): ChatSDKError → toResponse(); other errors → 503 JSON. posthog.flush() wrapped in try/catch so trigger success always returns runId/token.
 * - Task outer catch (below): logs + chatLogger.emitUnexpectedError + Axiom, then rethrows.
 * - reportStreamWriteError: all metadata append failures; client-disconnect (S2Error, ECONNRESET) → log only; others → log + emitUnexpectedError + Axiom.
 * - onFinish catch: log + emitUnexpectedError + Axiom; no rethrow (best-effort persistence).
 * - streamText onError: log + Axiom + emitUnexpectedError.
 * - unhandledRejection (pipe/stream): client-disconnect → log only + promise.catch(); others → reportStreamWriteError. Listener removed in outer finally so it is always cleaned up (including when error escapes before waitUntilComplete).
 */
export const agentStreamTask = task({
  id: "agent-stream",
  retry: { maxAttempts: 0 },
  run: async (payload: AgentTaskPayload) => {
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
      rateLimitInfo: serializedRateLimitInfo,
      sandboxFiles,
      fileTokens,
      chatFinishReason,
      hasSandboxFiles,
      hasFileAttachments: hasFiles,
      fileCount,
      fileImageCount,
    } = payload;

    const rateLimitInfo = deserializeRateLimitInfo(serializedRateLimitInfo);
    const posthog = PostHogClient();

    // Initialize wide event logger (mirrors chat-handler)
    const chatLogger = createChatLogger({
      chatId,
      endpoint: "/api/agent-long",
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
        hasSandboxFiles,
        hasFileAttachments: hasFiles,
        fileCount,
        fileImageCount,
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

    /** Shared stream-write error reporter: logs all; for non–client-disconnect errors also reports via chatLogger and Axiom. */
    const reportStreamWriteError = (
      err: unknown,
      context?: { type?: string },
    ) => {
      if (isClientDisconnectError(err)) {
        logger.warn("Stream write failed (client likely disconnected)", {
          ...context,
          err,
        });
        triggerAxiomLogger.warn("Stream lost (client likely disconnected)", {
          chatId,
          endpoint: "/api/agent-long",
          ...context,
          ...extractErrorDetails(err),
        });
        return;
      }
      logger.warn("Stream write failed", { ...context, err });
      chatLogger.emitUnexpectedError(err);
      triggerAxiomLogger.error("Stream write failed in agent-task", {
        chatId,
        endpoint: "/api/agent-long",
        ...context,
        ...extractErrorDetails(err),
      });
    };

    const metadataWriter = createMetadataWriter(reportStreamWriteError);

    const unhandledRejectionHandler = (
      reason: unknown,
      promise: Promise<unknown>,
    ) => {
      if (isClientDisconnectError(reason)) {
        logger.warn("Stream lost (client likely disconnected)", {
          chatId,
          err: reason,
        });
        triggerAxiomLogger.warn("Stream lost (client likely disconnected)", {
          chatId,
          endpoint: "/api/agent-long",
          ...extractErrorDetails(reason),
        });
      } else {
        reportStreamWriteError(reason);
      }
      promise.catch(() => {});
    };
    process.on("unhandledRejection", unhandledRejectionHandler);

    try {
      sendRateLimitWarnings(metadataWriter, {
        subscription,
        mode,
        rateLimitInfo,
      });

      const appendMetadataStream = async (event: {
        type: "data-terminal";
        data: { terminal: string; toolCallId: string };
      }) => {
        await appendMetadata(event);
      };

      const {
        tools,
        getTodoManager,
        getFileAccumulator,
        sandboxManager,
        ensureSandbox,
      } = createTools(
        userId,
        chatId,
        metadataWriter,
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
        appendMetadataStream,
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
        appendMetadata({
          type: "data-file-metadata",
          data: {
            messageId: assistantMessageId,
            fileDetails: fileMetadata,
          },
        }).catch((err) =>
          reportStreamWriteError(err, { type: "data-file-metadata" }),
        );
      };

      let sandboxContext: string | null = null;
      if (isAgentMode(mode) && "getSandboxContextForPrompt" in sandboxManager) {
        try {
          sandboxContext = await (
            sandboxManager as {
              getSandboxContextForPrompt: () => Promise<string | null>;
            }
          ).getSandboxContextForPrompt();
        } catch (error) {
          logger.warn("Failed to get sandbox context for prompt", { error });
        }
      }

      if (isAgentMode(mode) && sandboxFiles && sandboxFiles.length > 0) {
        writeUploadStartStatus(metadataWriter);
        try {
          await uploadSandboxFiles(sandboxFiles, ensureSandbox);
        } finally {
          writeUploadCompleteStatus(metadataWriter);
        }
      }

      const titlePromise =
        isNewChat && !temporary
          ? (async () => {
              try {
                const chatTitle =
                  await generateTitleFromUserMessage(processedMessages);
                if (chatTitle) {
                  await appendMetadata({
                    type: "data-title",
                    data: { chatTitle },
                  });
                }
                return chatTitle;
              } catch (error) {
                if (!isXaiSafetyError(error)) {
                  logger.warn("Failed to generate chat title", { error });
                }
                return undefined;
              }
            })()
          : Promise.resolve(undefined);

      const trackedProvider = createTrackedProvider();
      let currentSystemPrompt = await systemPrompt(
        userId,
        mode,
        subscription,
        selectedModel,
        userCustomization,
        temporary,
        chatFinishReason,
        sandboxContext,
      );

      let streamFinishReason: string | undefined;
      let finalMessages = processedMessages;
      let hasSummarized = false;
      const isReasoningModel = isAgentMode(mode);
      // Use permissive types so we can push data parts (e.g. summarization) that aren't tool parts
      const summarizationParts: UIMessagePart<
        Record<string, unknown>, // UIDataTypes
        Record<string, { input: unknown; output: unknown }> // UITools
      >[] = [];
      const streamStartTime = Date.now();
      const configuredModelId =
        trackedProvider.languageModel(selectedModel).modelId;
      let streamUsage: Record<string, unknown> | undefined;
      let responseModel: string | undefined;
      let accumulatedInputTokens = 0;
      let accumulatedOutputTokens = 0;
      let accumulatedProviderCost = 0;
      let hasDeductedUsage = false;

      const deductAccumulatedUsage = async () => {
        if (hasDeductedUsage || subscription === "free") return;
        if (accumulatedInputTokens > 0 || accumulatedOutputTokens > 0) {
          await deductUsage(
            userId,
            subscription,
            estimatedInputTokens,
            accumulatedInputTokens,
            accumulatedOutputTokens,
            extraUsageConfig ?? undefined,
            accumulatedProviderCost > 0 ? accumulatedProviderCost : undefined,
          );
          hasDeductedUsage = true;
        }
      };

      const createStream = async (modelName: string) =>
        streamText({
          model: trackedProvider.languageModel(modelName),
          system: currentSystemPrompt,
          messages: await convertToModelMessages(finalMessages),
          tools,
          prepareStep: async ({ steps, messages }) => {
            try {
              if (!temporary && !hasSummarized) {
                const { needsSummarization, summarizedMessages } =
                  await checkAndSummarizeIfNeeded(
                    finalMessages,
                    subscription,
                    trackedProvider.languageModel(modelName),
                    mode,
                    metadataWriter,
                    chatId,
                    fileTokens,
                    getTodoManager().getAllTodos(),
                    undefined,
                    ensureSandbox,
                  );
                if (needsSummarization) {
                  hasSummarized = true;
                  summarizationParts.push(
                    createSummarizationCompletedPart() as UIMessagePart<
                      Record<string, unknown>,
                      Record<string, { input: unknown; output: unknown }>
                    >,
                  );
                  return {
                    messages: await convertToModelMessages(summarizedMessages),
                  };
                }
              }
              const lastStep = Array.isArray(steps) ? steps.at(-1) : undefined;
              const toolResults =
                (lastStep &&
                  (lastStep as { toolResults?: unknown[] }).toolResults) ||
                [];
              const wasMemoryUpdate =
                Array.isArray(toolResults) &&
                toolResults.some(
                  (r) =>
                    (r as { toolName?: string })?.toolName === "update_memory",
                );
              const wasNoteModified =
                Array.isArray(toolResults) &&
                toolResults.some((r) =>
                  ["create_note", "update_note", "delete_note"].includes(
                    (r as { toolName?: string })?.toolName ?? "",
                  ),
                );
              if (!wasMemoryUpdate && !wasNoteModified) {
                return {
                  messages,
                  ...(currentSystemPrompt && {
                    system: currentSystemPrompt,
                  }),
                };
              }
              currentSystemPrompt = await systemPrompt(
                userId,
                mode,
                subscription,
                selectedModel,
                userCustomization,
                temporary,
                chatFinishReason,
                sandboxContext,
              );
              return { messages, system: currentSystemPrompt };
            } catch (error) {
              logger.error("Error in prepareStep", { error });
              return currentSystemPrompt ? { system: currentSystemPrompt } : {};
            }
          },
          providerOptions: buildProviderOptions(isReasoningModel, subscription),
          experimental_transform: smoothStream({ chunking: "word" }),
          stopWhen: stepCountIs(getMaxStepsForUser(mode, subscription)),
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
              const stepCost = (usage as { raw?: { cost?: number } }).raw?.cost;
              if (stepCost) accumulatedProviderCost += stepCost;
            }
          },
          onFinish: async ({ finishReason, usage, response }) => {
            streamFinishReason = finishReason;
            streamUsage = usage as Record<string, unknown>;
            responseModel = response?.modelId;
            chatLogger.setStreamResponse(responseModel, streamUsage);
          },
          onError: async (error) => {
            if (!isXaiSafetyError(error)) {
              logger.error("Provider streaming error", {
                error,
                chatId,
                mode,
                model: selectedModel,
                userId,
                subscription,
                isTemporary: temporary,
                ...extractErrorDetails(error),
              });
              triggerAxiomLogger.error("Provider streaming error", {
                chatId,
                endpoint: "/api/agent-long",
                mode,
                model: selectedModel,
                userId,
                subscription,
                isTemporary: temporary,
                ...extractErrorDetails(error),
              });
              await triggerAxiomLogger.flush();
              chatLogger.emitUnexpectedError(error);
            }
          },
        });

      let result;
      try {
        result = await createStream(selectedModel);
      } catch (error) {
        if (isProviderApiError(error)) {
          logger.warn("Provider API error, retrying with fallback", {
            chatId,
            selectedModel,
            userId,
          });
          triggerAxiomLogger.error(
            "Provider API error, retrying with fallback",
            {
              chatId,
              endpoint: "/api/agent-long",
              mode,
              originalModel: selectedModel,
              fallbackModel: "fallback-agent-model",
              userId,
              subscription,
              isTemporary: temporary,
              ...extractErrorDetails(error),
            },
          );
          await triggerAxiomLogger.flush();
          result = await createStream("fallback-agent-model");
        } else {
          throw error;
        }
      }

      const { waitUntilComplete } = aiStream.pipe(
        result.toUIMessageStream({
          generateMessageId: () => assistantMessageId,
          onFinish: async ({ messages, isAborted }) => {
            try {
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
                  });
                } else {
                  await prepareForNewStream({ chatId });
                }
                const accumulatedFiles = getFileAccumulator().getAll();
                const newFileIds = accumulatedFiles.map((f) => f.fileId);
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
                  });
                }
                sendFileMetadataToStream(accumulatedFiles);
              } else {
                const tempFiles = getFileAccumulator().getAll();
                sendFileMetadataToStream(tempFiles);
                await deleteTempStreamForBackend({ chatId });
              }
              await deductAccumulatedUsage();

              // Emit wide event
              chatLogger.setSandbox(sandboxManager.getSandboxInfo());
              chatLogger.emitSuccess({
                finishReason: streamFinishReason,
                wasAborted: !!isAborted,
                wasPreemptiveTimeout: false,
                hadSummarization: hasSummarized,
              });
            } catch (error) {
              logger.error("onFinish failed", {
                chatId,
                userId,
                mode,
                error,
              });
              chatLogger.emitUnexpectedError(error);
              triggerAxiomLogger.error("onFinish failed in agent-task", {
                chatId,
                userId,
                mode,
                endpoint: "/api/agent-long",
                ...extractErrorDetails(error),
              });
              // Do not rethrow: best-effort persistence; we still report so observability sees the failure.
            }
          },
          sendReasoning: true,
        }),
      );

      try {
        await waitUntilComplete();
      } finally {
        await clearActiveTriggerRunIdFromBackend({ chatId });
      }
    } catch (error) {
      chatLogger.emitUnexpectedError(error);
      triggerAxiomLogger.error("Unexpected error in agent-task", {
        chatId,
        mode,
        userId,
        subscription,
        isTemporary: temporary,
        ...extractErrorDetails(error),
      });
      await triggerAxiomLogger.flush();
      throw error;
    } finally {
      process.off("unhandledRejection", unhandledRejectionHandler);
    }
  },
});
