"use node";

import { convertToModelMessages, streamText, smoothStream } from "ai";
import { logger } from "@trigger.dev/sdk/v3";
import { systemPrompt } from "@/lib/system-prompt";
import {
  buildProviderOptions,
  isXaiSafetyError,
} from "@/lib/api/chat-stream-helpers";
import { createSummarizationCompletedPart } from "@/lib/utils/stream-writer-utils";
import { checkAndSummarizeIfNeeded } from "@/lib/chat/summarization";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import {
  tokenExhaustedAfterSummarization,
  TOKEN_EXHAUSTION_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import { stepCountIs } from "ai";
import { extractErrorDetails } from "@/lib/utils/error-utils";
import { triggerAxiomLogger } from "@/lib/axiom/trigger";
import PostHogClient from "@/app/posthog";
import type { AgentStreamContext } from "./context";

export { TOKEN_EXHAUSTION_FINISH_REASON };

/** If summarization runs, mutates context and returns new messages; otherwise returns null. */
async function trySummarizeStep(
  context: AgentStreamContext,
  modelName: string,
): Promise<{
  messages: Awaited<ReturnType<typeof convertToModelMessages>>;
} | null> {
  const {
    payload,
    metadataWriter,
    trackedProvider,
    finalMessages,
    getTodoManager,
    ensureSandbox,
    summarizationParts,
  } = context;
  const { subscription, mode, chatId, fileTokens, temporary } = payload;
  if (temporary || context.hasSummarized) return null;

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
      undefined,
      context.lastStepInputTokens,
    );
  if (!needsSummarization) return null;

  context.hasSummarized = true;
  summarizationParts.push(createSummarizationCompletedPart());
  return {
    messages: await convertToModelMessages(summarizedMessages),
  };
}

export async function createAgentStream(
  context: AgentStreamContext,
  modelName: string,
) {
  const {
    payload,
    metadataWriter,
    chatLogger,
    trackedProvider,
    currentSystemPrompt,
    finalMessages,
    tools,
    getTodoManager,
    ensureSandbox,
    sandboxContext,
    summarizationParts,
    shouldEnableReasoning,
  } = context;
  const { fileTokens } = payload;

  const {
    chatId,
    mode,
    subscription,
    selectedModel,
    userCustomization,
    temporary,
    chatFinishReason,
    userId,
  } = payload;

  const posthog = PostHogClient();

  return streamText({
    model: trackedProvider.languageModel(modelName),
    system: currentSystemPrompt,
    messages: await convertToModelMessages(finalMessages),
    tools,
    prepareStep: async ({ steps, messages }) => {
      try {
        const summarizationResult = await trySummarizeStep(context, modelName);
        if (summarizationResult) return summarizationResult;

        const lastStep = steps.at(-1);
        const toolResults = lastStep?.toolResults ?? [];
        const wasMemoryUpdate = toolResults.some(
          (r) => r?.toolName === "update_memory",
        );
        const wasNoteModified = toolResults.some(
          (r) =>
            r != null &&
            ["create_note", "update_note", "delete_note"].includes(r.toolName),
        );
        if (!wasMemoryUpdate && !wasNoteModified) {
          return {
            messages,
            ...(context.currentSystemPrompt && {
              system: context.currentSystemPrompt,
            }),
          };
        }
        context.currentSystemPrompt = await systemPrompt(
          userId,
          mode,
          subscription,
          selectedModel,
          userCustomization,
          temporary,
          chatFinishReason,
          sandboxContext,
        );
        return {
          messages,
          system: context.currentSystemPrompt,
        };
      } catch (error) {
        logger.error("Error in prepareStep", { error });
        return context.currentSystemPrompt
          ? { system: context.currentSystemPrompt }
          : {};
      }
    },
    providerOptions: buildProviderOptions(shouldEnableReasoning, subscription),
    experimental_transform: smoothStream({ chunking: "word" }),
    stopWhen: [
      stepCountIs(getMaxStepsForUser(mode, subscription)),
      tokenExhaustedAfterSummarization({
        getLastStepInputTokens: () => context.lastStepInputTokens,
        getHasSummarized: () => context.hasSummarized,
        onFired: () => {
          context.stoppedDueToTokenExhaustion = true;
        },
      }),
    ],
    onChunk: async (chunk) => {
      if (chunk.chunk.type === "tool-call") {
        const sandboxType = context.sandboxManager.getSandboxType(
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
        context.accumulatedInputTokens += usage.inputTokens || 0;
        context.accumulatedOutputTokens += usage.outputTokens || 0;
        context.lastStepInputTokens = usage.inputTokens || 0;
        const rawCost = usage.raw?.cost;
        if (typeof rawCost === "number")
          context.accumulatedProviderCost += rawCost;
      }
    },
    onFinish: async ({ finishReason, usage, response }) => {
      context.streamFinishReason = context.stoppedDueToTokenExhaustion
        ? TOKEN_EXHAUSTION_FINISH_REASON
        : finishReason;
      // Safe widening: LanguageModelUsage → Record<string, unknown> for DB persistence
      context.streamUsage = usage as Record<string, unknown>;
      context.responseModel = response?.modelId;
      chatLogger.setStreamResponse(context.responseModel, context.streamUsage);
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
      }
    },
  });
}
