import { task, metadata } from "@trigger.dev/sdk";
import {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  UIMessage,
} from "ai";
import type { Geo } from "@vercel/functions";
import { v4 as uuidv4 } from "uuid";

import { systemPrompt } from "@/lib/system-prompt";
import { createTools } from "@/lib/ai/tools";
import {
  processChatMessages,
  getMaxStepsForUser,
} from "@/lib/chat/chat-processor";
import { createTrackedProvider } from "@/lib/ai/providers";
import {
  buildProviderOptions,
  buildSystemPrompt,
  injectNotesIntoMessages,
  addCacheBreakpointToLastUserMessage,
  applyPrepareStepReminders,
} from "@/lib/api/chat-stream-helpers";
import {
  doomLoopDetected,
  tokenExhaustedAfterSummarization,
} from "@/lib/chat/stop-conditions";
import {
  detectDoomLoop,
  generateDoomLoopNudge,
} from "@/lib/chat/doom-loop-detection";
import {
  filterEmptyAssistantMessages,
  pruneToolOutputs,
  pruneModelMessages,
} from "@/lib/chat/compaction/prune-tool-outputs";
import {
  saveMessage,
  updateChat,
  getUserCustomization,
} from "@/lib/db/actions";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import { SUMMARIZATION_THRESHOLD_PERCENTAGE } from "@/lib/chat/summarization/constants";
import type {
  SubscriptionTier,
  Todo,
  SandboxPreference,
  SelectedModel,
} from "@/types";

export type AgentLongPayload = {
  chatId: string;
  userId: string;
  subscription: SubscriptionTier;
  organizationId?: string;
  messages: UIMessage[];
  baseTodos: Todo[];
  sandboxPreference?: SandboxPreference;
  selectedModel?: SelectedModel;
  userLocation: Geo;
  temporary?: boolean;
  isAutoContinue?: boolean;
};

export const agentLongTask = task({
  id: "agent-long",
  // Long agent runs may legitimately need an hour of tool calls.
  maxDuration: 60 * 60,
  run: async (payload: AgentLongPayload) => {
    const {
      chatId,
      userId,
      subscription,
      messages,
      baseTodos,
      sandboxPreference,
      selectedModel: selectedModelOverride,
      userLocation,
      temporary,
    } = payload;

    const assistantMessageId = uuidv4();
    const mode = "agent" as const; // Long mode reuses the agent loop verbatim.

    const userCustomization = await getUserCustomization({ userId });
    const memoryEnabled = userCustomization?.include_memory_entries ?? true;

    const { processedMessages, selectedModel } = await processChatMessages({
      messages,
      mode,
      subscription,
      modelOverride: selectedModelOverride,
    });

    if (!processedMessages.length) {
      throw new Error("Empty processed messages — nothing to send to model");
    }

    const trackedProvider = createTrackedProvider();
    const currentSystemPrompt = await systemPrompt(
      userId,
      mode,
      subscription,
      selectedModel,
      userCustomization,
      temporary,
      null,
    );

    // Build the UI message stream once, then pipe it into trigger.dev's
    // realtime metadata stream. The client subscribes via useRealtimeStream
    // and replays the same chunks the Vercel agent path would emit.
    let finishReason: string | undefined;
    let savedAssistantMessage = false;
    let finalMessages = processedMessages;
    let lastStepInputTokens = 0;
    let stoppedDueToTokenExhaustion = false;
    let stoppedDueToDoomLoop = false;

    const uiStream = createUIMessageStream({
      execute: async ({ writer }) => {
        const { tools, getTodoManager, getFileAccumulator, sandboxManager } =
          createTools(
            userId,
            chatId,
            writer,
            mode,
            userLocation,
            baseTodos,
            memoryEnabled,
            !!temporary,
            assistantMessageId,
            sandboxPreference,
            process.env.CONVEX_SERVICE_ROLE_KEY,
            userCustomization?.guardrails_config,
            false,
            undefined,
            undefined,
            undefined,
            subscription,
            undefined,
            undefined,
          );

        const noteInjectionOpts = {
          userId,
          subscription,
          shouldIncludeNotes: userCustomization?.include_memory_entries ?? true,
          isTemporary: !!temporary,
        };
        finalMessages = await injectNotesIntoMessages(
          finalMessages,
          noteInjectionOpts,
        );

        const requestedLanguageModel =
          trackedProvider.languageModel(selectedModel);
        const isReasoningModel = true;

        const result = streamText({
          model: requestedLanguageModel,
          maxOutputTokens: 30000,
          system: buildSystemPrompt(currentSystemPrompt, selectedModel),
          messages: filterEmptyAssistantMessages(
            await convertToModelMessages(finalMessages),
          ),
          tools,
          providerOptions: buildProviderOptions(
            isReasoningModel,
            userId,
            selectedModel,
          ),
          prepareStep: async ({ steps, messages: stepMessages }) => {
            const pruneResult = pruneToolOutputs(finalMessages);
            if (pruneResult.prunedCount > 0) {
              finalMessages = pruneResult.messages;
            }

            let currentMessages = stepMessages as Array<
              Record<string, unknown>
            >;
            const modelPrune = pruneModelMessages(currentMessages);
            if (modelPrune.prunedCount > 0) {
              currentMessages = modelPrune.messages;
            }

            const lastStep = Array.isArray(steps) ? steps.at(-1) : undefined;
            const toolResults =
              (lastStep &&
                (lastStep as { toolResults?: unknown[] }).toolResults) ||
              [];

            let updatedMessages = await applyPrepareStepReminders(
              currentMessages,
              { toolResults, noteInjectionOpts },
            );

            const loopCheck = detectDoomLoop(
              steps as unknown as Parameters<typeof detectDoomLoop>[0],
            );
            if (loopCheck.severity === "warning") {
              const nudge = generateDoomLoopNudge(loopCheck);
              updatedMessages = [
                ...updatedMessages,
                { role: "user", content: nudge },
              ] as typeof updatedMessages;
            }

            return {
              messages: filterEmptyAssistantMessages(
                addCacheBreakpointToLastUserMessage(
                  updatedMessages,
                  selectedModel,
                ),
              ) as typeof stepMessages,
            };
          },
          stopWhen: [
            stepCountIs(getMaxStepsForUser(mode, subscription)),
            tokenExhaustedAfterSummarization({
              threshold: Math.floor(
                getMaxTokensForSubscription(subscription, { mode }) *
                  SUMMARIZATION_THRESHOLD_PERCENTAGE,
              ),
              getLastStepInputTokens: () => lastStepInputTokens,
              getHasSummarized: () => false,
              onFired: () => {
                stoppedDueToTokenExhaustion = true;
              },
            }),
            doomLoopDetected({
              onFired: () => {
                stoppedDueToDoomLoop = true;
              },
            }),
          ],
          onStepFinish: async ({ usage }) => {
            if (usage) {
              lastStepInputTokens = usage.inputTokens || 0;
            }
          },
          onFinish: async ({ finishReason: fr }) => {
            if (stoppedDueToTokenExhaustion) finishReason = "token-exhausted";
            else if (stoppedDueToDoomLoop) finishReason = "doom-loop";
            else finishReason = fr;
          },
        });

        writer.merge(
          result.toUIMessageStream({
            generateMessageId: () => assistantMessageId,
            sendReasoning: true,
            onFinish: async ({ messages: finishedMessages }) => {
              if (temporary) return;

              const accumulatedFiles = getFileAccumulator().getAll();
              const newFileIds = accumulatedFiles.map((f) => f.fileId);
              const mergedTodos = getTodoManager().mergeWith(
                baseTodos,
                assistantMessageId,
              );

              await updateChat({
                chatId,
                finishReason,
                todos: mergedTodos,
                defaultModelSlug: "agent-long",
                sandboxType: sandboxManager.getEffectivePreference(),
              });

              for (const msg of finishedMessages) {
                if (!msg.parts || msg.parts.length === 0) continue;
                await saveMessage({
                  chatId,
                  userId,
                  message: msg,
                  extraFileIds: newFileIds,
                  model: selectedModel,
                  finishReason,
                });
                if (msg.role === "assistant") savedAssistantMessage = true;
              }
            },
          }),
        );
      },
    });

    await metadata.stream("ui", uiStream);

    return {
      chatId,
      assistantMessageId,
      finishReason,
      savedAssistantMessage,
    };
  },
});
