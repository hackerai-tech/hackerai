import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
  UIMessage,
} from "ai";
import { systemPrompt } from "@/lib/system-prompt";
import { getResumeSection } from "@/lib/system-prompt/resume";
import {
  tokenExhaustedAfterSummarization,
  TOKEN_EXHAUSTION_FINISH_REASON,
  elapsedTimeExceeds,
  PREEMPTIVE_TIMEOUT_FINISH_REASON,
  AGENT_MAX_STREAM_DURATION_MS,
  doomLoopDetected,
  DOOM_LOOP_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import {
  detectDoomLoop,
  generateDoomLoopNudge,
} from "@/lib/chat/doom-loop-detection";
import { createTools } from "@/lib/ai/tools";
import { generateTitleFromUserMessageWithWriter } from "@/lib/actions";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import type {
  ChatMode,
  Todo,
  SandboxPreference,
  ExtraUsageConfig,
  SelectedModel,
  RateLimitInfo,
} from "@/types";
import { isSelectedModel } from "@/types";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import {
  checkRateLimit,
  deductUsage,
  UsageRefundTracker,
} from "@/lib/rate-limit";
import { UsageTracker } from "@/lib/usage-tracker";
import { getExtraUsageBalance } from "@/lib/extra-usage";
import {
  countMessagesTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import { countTokens } from "gpt-tokenizer";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
import {
  captureFreeAgentRequest,
  captureToolCalls,
  createChatLogger,
  shutdownPostHog,
  type ChatLogger,
} from "@/lib/api/chat-logger";
import {
  countFileAttachments,
  sendRateLimitWarnings,
  buildProviderOptions,
  isXaiSafetyError,
  isProviderApiError,
  computeContextUsage,
  writeContextUsage,
  isContextUsageEnabled,
  runSummarizationStep,
  SummarizationTracker,
  appendSystemReminderToLastUserMessage,
  injectNotesIntoMessages,
  applyPrepareStepReminders,
  buildSystemPrompt,
  addCacheBreakpointToLastUserMessage,
} from "@/lib/api/chat-stream-helpers";
import { geolocation } from "@vercel/functions";
import { NextRequest } from "next/server";
import {
  handleInitialChatAndUserMessage,
  saveMessage,
  updateChat,
  getMessagesByChatId,
  getUserCustomization,
  prepareForNewStream,
  startStream,
  startTempStream,
  deleteTempStreamForBackend,
} from "@/lib/db/actions";
import {
  createCancellationSubscriber,
  createPreemptiveTimeout,
} from "@/lib/utils/stream-cancellation";
import { v4 as uuidv4 } from "uuid";
import { processChatMessages, selectModel } from "@/lib/chat/chat-processor";
import {
  createByokTrackedProvider,
  createTrackedProvider,
} from "@/lib/ai/providers";
import { getByokApiKey } from "@/lib/auth/byok";
import {
  uploadSandboxFiles,
  getUploadBasePath,
} from "@/lib/utils/sandbox-file-utils";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import {
  writeUploadStartStatus,
  writeUploadCompleteStatus,
  writeAutoContinue,
} from "@/lib/utils/stream-writer-utils";
import { Id } from "@/convex/_generated/dataModel";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import { nextJsAxiomLogger } from "@/lib/axiom/server";
import {
  extractErrorDetails,
  getUserFriendlyProviderError,
} from "@/lib/utils/error-utils";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { SUMMARIZATION_THRESHOLD_PERCENTAGE } from "@/lib/chat/summarization/constants";
import {
  pruneToolOutputs,
  pruneModelMessages,
  filterEmptyAssistantMessages,
} from "@/lib/chat/compaction/prune-tool-outputs";

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

export const createChatHandler = (
  endpoint: "/api/chat" | "/api/agent" = "/api/chat",
) => {
  return async (req: NextRequest) => {
    let preemptiveTimeout:
      | ReturnType<typeof createPreemptiveTimeout>
      | undefined;

    // Track usage deductions for refund on error
    const usageRefundTracker = new UsageRefundTracker();

    // Wide event logger for structured logging
    let chatLogger: ChatLogger | undefined;

    try {
      const {
        messages,
        mode,
        todos,
        chatId,
        regenerate,
        temporary,
        sandboxPreference,
        selectedModel: rawSelectedModel,
        isAutoContinue,
      }: {
        messages: UIMessage[];
        mode: ChatMode;
        chatId: string;
        todos?: Todo[];
        regenerate?: boolean;
        temporary?: boolean;
        sandboxPreference?: SandboxPreference;
        selectedModel?: string;
        isAutoContinue?: boolean;
      } = await req.json();

      const selectedModelOverride: SelectedModel | undefined =
        rawSelectedModel && isSelectedModel(rawSelectedModel)
          ? rawSelectedModel
          : undefined;

      // Local provider models are handled client-side and must never reach the server
      if (
        rawSelectedModel === "codex-local" ||
        (rawSelectedModel && rawSelectedModel.startsWith("codex-local:"))
      ) {
        throw new ChatSDKError(
          "bad_request:api",
          "Local provider models are handled client-side",
        );
      }

      // Initialize chat logger
      chatLogger = createChatLogger({ chatId, endpoint });
      chatLogger.setRequestDetails({
        mode,
        isTemporary: !!temporary,
        isRegenerate: !!regenerate,
      });

      const { userId, subscription, organizationId } =
        await getUserIDAndPro(req);
      usageRefundTracker.setUser(userId, subscription);
      const userLocation = geolocation(req);

      // Add user context to logger (only region, not full location for privacy)
      chatLogger.setUser({
        id: userId,
        subscription,
        region: userLocation?.region,
      });

      if (isAgentMode(mode) && subscription === "free") {
        // Gate 1: Free agent requires a local sandbox preference (not E2B)
        const isLocalSandbox = sandboxPreference && sandboxPreference !== "e2b";
        if (!isLocalSandbox) {
          throw new ChatSDKError(
            "forbidden:chat",
            "Agent mode on the free plan requires a local sandbox. Install the desktop app or upgrade to Pro for cloud access.",
          );
        }

        // Gate 2: Free agent must use auto model selection (no model override)
        if (rawSelectedModel && rawSelectedModel !== "auto") {
          throw new ChatSDKError(
            "forbidden:chat",
            "Custom model selection in agent mode requires a Pro plan. Free agent mode uses the default model.",
          );
        }
      }

      // Set up pre-emptive abort before Vercel timeout (moved early to cover entire request)
      const userStopSignal = new AbortController();
      // Agent mode uses elapsedTimeExceeds stop condition instead
      if (!isAgentMode(mode)) {
        preemptiveTimeout = createPreemptiveTimeout({
          chatId,
          endpoint,
          abortController: userStopSignal,
        });
      }

      // Fetch user customization early so max_mode_enabled can influence
      // context truncation (before messages are fetched from DB).
      const userCustomization = await getUserCustomization({ userId });

      // BYOK: if the user enabled their own OpenRouter API key, route LLM calls
      // through their key and bypass our rate limiter. Sandbox/tool costs are
      // still billed to their subscription. The Convex flag gates the Vault
      // lookup so non-BYOK users pay zero WorkOS round-trips. Removing the key
      // (whether via UI DELETE or the GET self-heal path) also clears the
      // flag, so an orphan flag-without-key state isn't reachable from the UI.
      const byokApiKey =
        subscription !== "free" && userCustomization?.byok_enabled
          ? await getByokApiKey(userId)
          : undefined;
      const isByok = !!byokApiKey;
      // Max Mode only applies when a specific model is selected — not in Auto.
      const isAutoModelSelection =
        !selectedModelOverride || selectedModelOverride === "auto";
      const maxModeEnabled =
        !isAutoModelSelection && (userCustomization?.max_mode_enabled ?? false);
      const resolvedModelName = selectModel(
        mode,
        subscription,
        selectedModelOverride,
      );

      const { truncatedMessages, chat, isNewChat, fileTokens } =
        await getMessagesByChatId({
          chatId,
          userId,
          subscription,
          newMessages: messages,
          regenerate,
          isTemporary: temporary,
          mode,
          maxMode: maxModeEnabled,
          modelName: resolvedModelName,
        });

      const baseTodos: Todo[] = getBaseTodosForRequest(
        (chat?.todos as unknown as Todo[]) || [],
        Array.isArray(todos) ? todos : [],
        { isTemporary: !!temporary, regenerate },
      );

      if (!temporary) {
        await handleInitialChatAndUserMessage({
          chatId,
          userId,
          messages: truncatedMessages,
          regenerate,
          chat,
          isHidden: isAutoContinue ? true : undefined,
        });
      }

      // Free users in ask mode: check rate limit early (sliding window, no token counting needed)
      // This avoids unnecessary processing if they're over the limit
      const freeAskRateLimitInfo =
        mode === "ask" && subscription === "free"
          ? await checkRateLimit(userId, mode, subscription)
          : null;

      const uploadBasePath = isAgentMode(mode)
        ? getUploadBasePath(sandboxPreference)
        : undefined;

      const { processedMessages, selectedModel, sandboxFiles } =
        await processChatMessages({
          messages: truncatedMessages,
          mode,
          subscription,
          uploadBasePath,
          modelOverride: selectedModelOverride,
        });

      // Validate that we have at least one message with content after processing
      // This prevents "must include at least one parts field" errors from providers like Gemini
      if (!processedMessages || processedMessages.length === 0) {
        throw new ChatSDKError(
          "bad_request:api",
          "Your message could not be processed. Please include some text with your file attachments and try again.",
        );
      }

      const memoryEnabled =
        subscription !== "free" &&
        (userCustomization?.include_memory_entries ?? true);

      // Agent mode and paid ask mode: check rate limit with model-specific pricing after knowing the model
      // Token bucket requires estimated token count for cost calculation
      // Note: File tokens are not included because counts are inaccurate (especially PDFs)
      // and deductUsage reconciles with actual provider cost anyway
      let estimatedInputTokens = 0;
      if (isAgentMode(mode) || subscription !== "free") {
        const messageTokens = countMessagesTokens(truncatedMessages);
        // Compute system prompt tokens early (without sandboxContext) for a more
        // accurate pre-flight estimate. The real prompt is built later with sandbox
        // context, but the difference is small (~200-500 tokens).
        const estimatedSystemPrompt = await systemPrompt(
          userId,
          mode,
          subscription,
          selectedModel,
          userCustomization,
          temporary,
          null, // sandboxContext not available yet
        );
        const systemTokens = countTokens(estimatedSystemPrompt);
        // Tool schemas are sent alongside the request but can't be computed here
        // (they depend on sandboxManager). Agent mode has ~8 tools (~1500 tokens),
        // ask mode has ~4 tools (~500 tokens).
        const toolSchemaOverhead = isAgentMode(mode) ? 1500 : 500;
        estimatedInputTokens =
          messageTokens + systemTokens + toolSchemaOverhead;
      }

      // Add chat context to logger
      const fileCounts = countFileAttachments(truncatedMessages);
      chatLogger.setChat(
        {
          messageCount: truncatedMessages.length,
          estimatedInputTokens,
          isNewChat,
          fileCount: fileCounts.totalFiles,
          imageCount: fileCounts.imageCount,
          memoryEnabled,
        },
        selectedModel,
      );
      chatLogger.setByok(isByok);

      // Build extra usage config (paid users only, works for both agent and ask modes)
      // extra_usage_enabled is in userCustomization, balance is in extra_usage
      let extraUsageConfig: ExtraUsageConfig | undefined;
      if (subscription !== "free") {
        const extraUsageEnabled =
          userCustomization?.extra_usage_enabled ?? false;

        if (extraUsageEnabled) {
          const balanceInfo = await getExtraUsageBalance(userId);

          if (!balanceInfo) {
            // Balance check failed (Convex error) — use optimistic config so
            // the rate limiter still attempts the deduction, which is the real
            // source of truth. Without this, a transient Convex failure silently
            // disables extra usage and the user hits the hard subscription limit.
            console.warn(
              `[chat-handler] getExtraUsageBalance returned null for user ${userId}, using optimistic extra usage config`,
            );
            extraUsageConfig = {
              enabled: true,
              hasBalance: true,
              autoReloadEnabled: false,
            };
          } else if (
            balanceInfo.balanceDollars > 0 ||
            balanceInfo.autoReloadEnabled
          ) {
            extraUsageConfig = {
              enabled: true,
              hasBalance: balanceInfo.balanceDollars > 0,
              balanceDollars: balanceInfo.balanceDollars,
              autoReloadEnabled: balanceInfo.autoReloadEnabled,
            };
          }
        }
      }

      const rateLimitInfo: RateLimitInfo = isByok
        ? {
            remaining: Number.POSITIVE_INFINITY,
            resetTime: new Date(0),
            limit: Number.POSITIVE_INFINITY,
            pointsDeducted: 0,
            extraUsagePointsDeducted: 0,
            rateLimitSkipped: true,
          }
        : (freeAskRateLimitInfo ??
          (await checkRateLimit(
            userId,
            mode,
            subscription,
            estimatedInputTokens,
            extraUsageConfig,
            selectedModel,
            organizationId,
          )));

      // Track deductions for potential refund on error (no-op for BYOK)
      if (!isByok) {
        usageRefundTracker.recordDeductions(rateLimitInfo);
      }

      // Add rate limit and extra usage context to logger
      chatLogger.setRateLimit(
        {
          pointsDeducted: rateLimitInfo.pointsDeducted,
          extraUsagePointsDeducted: rateLimitInfo.extraUsagePointsDeducted,
          monthly: rateLimitInfo.monthly,
          remaining: rateLimitInfo.remaining,
          subscription,
        },
        extraUsageConfig,
      );

      // PostHog client for analytics (initialized once, used at end of request)
      const posthog = PostHogClient();

      const assistantMessageId = uuidv4();
      chatLogger.getBuilder().setAssistantId(assistantMessageId);

      // Start temp stream coordination for temporary chats
      if (temporary) {
        try {
          await startTempStream({ chatId, userId });
        } catch {
          // Silently continue; temp coordination is best-effort
        }
      }

      // Start cancellation subscriber (Redis pub/sub with fallback to polling)
      let subscriberStopped = false;
      const cancellationSubscriber = await createCancellationSubscriber({
        chatId,
        isTemporary: !!temporary,
        abortController: userStopSignal,
        onStop: () => {
          subscriberStopped = true;
        },
      });

      const summarizationTracker = new SummarizationTracker();

      // Start stream timing
      chatLogger.startStream();

      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          // Send rate limit warnings based on subscription type
          sendRateLimitWarnings(writer, { subscription, mode, rateLimitInfo });

          const {
            tools,
            getSandbox,
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
            userCustomization?.guardrails_config,
            userCustomization?.caido_enabled ?? false,
            userCustomization?.caido_port,
            undefined, // appendMetadataStream
            (costDollars: number) => {
              usageTracker.providerCost += costDollars;
              usageTracker.nonModelCost += costDollars;
              chatLogger?.getBuilder().addToolCost(costDollars);
            },
            subscription,
          );

          // Helper to send file metadata via stream for resumable stream clients
          // Uses accumulated metadata directly - no DB query needed!
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
              ? generateTitleFromUserMessageWithWriter(
                  processedMessages,
                  writer,
                )
              : Promise.resolve(undefined);

          const trackedProvider = isByok
            ? createByokTrackedProvider(byokApiKey!)
            : createTrackedProvider();

          let currentSystemPrompt = await systemPrompt(
            userId,
            mode,
            subscription,
            selectedModel,
            userCustomization,
            temporary,
            sandboxContext,
          );

          const systemPromptTokens = countTokens(currentSystemPrompt);

          // Compute and stream context usage breakdown
          const contextUsageOn = isContextUsageEnabled(subscription, mode);
          const ctxSystemTokens = contextUsageOn ? systemPromptTokens : 0;
          const ctxMaxTokens = contextUsageOn
            ? getMaxTokensForSubscription(subscription, {
                maxMode: maxModeEnabled,
                modelName: selectedModel,
                mode,
              })
            : 0;
          let ctxUsage = contextUsageOn
            ? computeContextUsage(
                truncatedMessages,
                fileTokens,
                ctxSystemTokens,
                ctxMaxTokens,
              )
            : {
                usedTokens: 0,
                maxTokens: 0,
              };
          // Context usage is sent after pruning, summarization, each step, and onFinish

          let streamFinishReason: string | undefined;
          // finalMessages will be set in prepareStep if summarization is needed
          let finalMessages = processedMessages;

          // Inject resume context into messages instead of system prompt
          // to keep the system prompt stable for caching
          const resumeContext = getResumeSection(chat?.finish_reason);
          if (resumeContext) {
            finalMessages = appendSystemReminderToLastUserMessage(
              finalMessages,
              resumeContext,
            );
          }

          // Inject notes into messages instead of system prompt
          // to keep the system prompt stable for prompt caching
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

          const hasSummarized = () => summarizationTracker.hasSummarized;
          let stoppedDueToTokenExhaustion = false;
          let stoppedDueToPreemptiveTimeout = false;
          let stoppedDueToDoomLoop = false;
          let lastStepInputTokens = 0;
          const isReasoningModel = isAgentMode(mode);

          // Track metrics for data collection
          const streamStartTime = Date.now();
          const configuredModelId =
            trackedProvider.languageModel(selectedModel).modelId;

          let streamUsage: Record<string, unknown> | undefined;
          let responseModel: string | undefined;
          let isRetryWithFallback = false;
          const isAutoModel = [
            "ask-model",
            "ask-model-free",
            "agent-model",
            "agent-model-free",
          ].includes(selectedModel);
          const fallbackModel =
            mode === "agent" ? "fallback-agent-model" : "fallback-ask-model";

          const usageTracker = new UsageTracker();
          let hasDeductedUsage = false;
          // Snapshot cache tokens before fallback retry so we can isolate fallback-only metrics
          let preFallbackCacheRead = 0;
          let preFallbackCacheWrite = 0;

          const deductAccumulatedUsage = async () => {
            if (hasDeductedUsage || subscription === "free") return;
            // Add E2B sandbox session cost (duration-based)
            const sandboxCost = getSandboxSessionCost();
            if (sandboxCost > 0) {
              usageTracker.providerCost += sandboxCost;
              usageTracker.nonModelCost += sandboxCost;
              chatLogger?.getBuilder().addToolCost(sandboxCost);
            }

            // BYOK: LLM cost is on the user's OpenRouter account. Still charge
            // the full non-model spend (sandbox session fee + any tool charges
            // accumulated during the stream) to the subscription bucket, and
            // still log usage.
            if (isByok) {
              const byokNonModelCost = usageTracker.nonModelCost;
              if (byokNonModelCost > 0) {
                hasDeductedUsage = true;
                await deductUsage(
                  userId,
                  subscription,
                  0,
                  0,
                  0,
                  extraUsageConfig,
                  byokNonModelCost,
                  selectedModel,
                  byokNonModelCost,
                );
              }
              usageTracker.log({
                userId,
                selectedModel,
                selectedModelOverride,
                responseModel,
                configuredModelId,
                rateLimitInfo,
                byok: isByok,
                maxMode: maxModeEnabled,
              });
              return;
            }

            if (!usageTracker.hasUsage) {
              // No usage data reported — skip deduction
              return;
            }
            hasDeductedUsage = true;

            // Trust accumulated provider cost (sum of per-step usage.raw.cost) even on
            // non-clean streams. Each completed step reports authoritative cost with
            // cache discounts baked in, so summing them is more accurate than the
            // token-based fallback (which ignores cache reads and overcharges). Fall
            // back to token calc only when no step reported any cost.
            const providerCost =
              usageTracker.providerCost > 0
                ? usageTracker.providerCost
                : undefined;

            await deductUsage(
              userId,
              subscription,
              estimatedInputTokens,
              usageTracker.inputTokens,
              usageTracker.outputTokens,
              extraUsageConfig,
              providerCost,
              selectedModel,
              usageTracker.nonModelCost,
            );
            usageTracker.log({
              userId,
              selectedModel,
              selectedModelOverride,
              responseModel,
              configuredModelId,
              rateLimitInfo,
              maxMode: maxModeEnabled,
            });
          };

          // Helper to create streamText with a given model (reused for retry)
          const createStream = async (modelName: string) =>
            streamText({
              model: trackedProvider.languageModel(modelName),
              maxOutputTokens: 30000,
              system: buildSystemPrompt(currentSystemPrompt, modelName),
              messages: filterEmptyAssistantMessages(
                await convertToModelMessages(finalMessages),
              ),
              tools,
              // Refresh system prompt when memory updates occur, cache and reuse until next update
              prepareStep: async ({ steps, messages }) => {
                try {
                  const stepNumber = steps.length;
                  const threshold = Math.floor(
                    getMaxTokensForSubscription(subscription, {
                      maxMode: maxModeEnabled,
                      modelName: selectedModel,
                      mode,
                    }) * SUMMARIZATION_THRESHOLD_PERCENTAGE,
                  );

                  // Prune old tool outputs to stay within rolling token budget
                  const pruneResult = pruneToolOutputs(finalMessages);
                  if (pruneResult.prunedCount > 0) {
                    finalMessages = pruneResult.messages;
                  }

                  // Run summarization check on every step (non-temporary chats only)
                  // but only summarize once
                  if (!temporary && !hasSummarized()) {
                    const result = await runSummarizationStep({
                      messages: finalMessages,
                      modelMessages: messages,
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
                      chatSystemPrompt: currentSystemPrompt,
                      tools,
                      providerOptions: buildProviderOptions(
                        isReasoningModel,
                        subscription,
                        userId,
                      ),
                    });

                    if (
                      result.needsSummarization &&
                      result.summarizedMessages
                    ) {
                      summarizationTracker.recordSummarization(
                        steps.length,
                        result.summarizationUsage,
                        usageTracker,
                      );
                      if (result.contextUsage) {
                        ctxUsage = result.contextUsage;
                      }
                      return {
                        messages: filterEmptyAssistantMessages(
                          await convertToModelMessages(
                            result.summarizedMessages,
                          ),
                        ),
                      };
                    }
                  }

                  // Prune old tool-result outputs in model-level messages
                  // (these accumulate during the agentic loop, up to 100 tool calls)
                  let currentMessages = messages as Array<
                    Record<string, unknown>
                  >;
                  const modelPrune = pruneModelMessages(currentMessages);
                  if (modelPrune.prunedCount > 0) {
                    currentMessages = modelPrune.messages;
                  }

                  const lastStep = Array.isArray(steps)
                    ? steps.at(-1)
                    : undefined;
                  const toolResults =
                    (lastStep &&
                      (lastStep as { toolResults?: unknown[] }).toolResults) ||
                    [];

                  let updatedMessages = await applyPrepareStepReminders(
                    currentMessages,
                    { toolResults, noteInjectionOpts },
                  );

                  // Doom loop detection: inject nudge as trailing user message
                  const loopCheck = detectDoomLoop(
                    steps as unknown as Parameters<typeof detectDoomLoop>[0],
                  );
                  if (loopCheck.severity !== "none") {
                    console.log(
                      `[doom-loop] severity=${loopCheck.severity} tools=${loopCheck.toolNames.join(",")} count=${loopCheck.consecutiveCount} step=${steps.length}`,
                    );

                    if (loopCheck.severity === "warning") {
                      const nudge = generateDoomLoopNudge(loopCheck);
                      console.log(
                        `[doom-loop] Injecting nudge as last user message`,
                      );
                      updatedMessages = [
                        ...updatedMessages,
                        { role: "user", content: nudge },
                      ] as typeof updatedMessages;
                    }
                  }

                  return {
                    messages: filterEmptyAssistantMessages(
                      addCacheBreakpointToLastUserMessage(
                        updatedMessages,
                        modelName,
                      ),
                    ) as typeof messages,
                  };
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
              abortSignal: userStopSignal.signal,
              providerOptions: buildProviderOptions(
                isReasoningModel,
                subscription,
                userId,
              ),
              stopWhen: isAgentMode(mode)
                ? [
                    stepCountIs(getMaxStepsForUser(mode, subscription)),
                    tokenExhaustedAfterSummarization({
                      threshold: Math.floor(
                        getMaxTokensForSubscription(subscription, {
                          maxMode: maxModeEnabled,
                          modelName: selectedModel,
                          mode,
                        }) * SUMMARIZATION_THRESHOLD_PERCENTAGE,
                      ),
                      getLastStepInputTokens: () => lastStepInputTokens,
                      getHasSummarized: hasSummarized,
                      onFired: () => {
                        stoppedDueToTokenExhaustion = true;
                      },
                    }),
                    elapsedTimeExceeds({
                      maxDurationMs: AGENT_MAX_STREAM_DURATION_MS,
                      getStartTime: () => streamStartTime,
                      onFired: () => {
                        stoppedDueToPreemptiveTimeout = true;
                      },
                    }),
                    doomLoopDetected({
                      onFired: () => {
                        stoppedDueToDoomLoop = true;
                      },
                    }),
                  ]
                : stepCountIs(getMaxStepsForUser(mode, subscription)),
              onChunk: async (chunk) => {
                if (chunk.chunk.type === "tool-call") {
                  const sandboxType = sandboxManager.getSandboxType(
                    chunk.chunk.toolName,
                  );

                  chatLogger!.recordToolCall(chunk.chunk.toolName, sandboxType);
                }
              },
              onStepFinish: async ({ usage }) => {
                if (usage) {
                  usageTracker.accumulateStep(
                    usage as Parameters<typeof usageTracker.accumulateStep>[0],
                  );
                  lastStepInputTokens = usage.inputTokens || 0;

                  // Update context indicator after each step
                  if (contextUsageOn) {
                    writeContextUsage(writer, {
                      usedTokens:
                        ctxUsage.usedTokens + usageTracker.streamOutputTokens,
                      maxTokens: ctxUsage.maxTokens,
                    });
                  }
                }
              },
              onFinish: async ({ finishReason, usage, response }) => {
                // If preemptive timeout triggered, use "timeout" as finish reason
                if (preemptiveTimeout?.isPreemptive()) {
                  streamFinishReason = "timeout";
                } else if (stoppedDueToPreemptiveTimeout) {
                  streamFinishReason = PREEMPTIVE_TIMEOUT_FINISH_REASON;
                } else if (stoppedDueToTokenExhaustion) {
                  streamFinishReason = TOKEN_EXHAUSTION_FINISH_REASON;
                } else if (stoppedDueToDoomLoop) {
                  streamFinishReason = DOOM_LOOP_FINISH_REASON;
                } else {
                  streamFinishReason = finishReason;
                }
                // Capture full usage and model
                streamUsage = usage as Record<string, unknown>;
                responseModel = response?.modelId;

                // Update logger with model and usage
                chatLogger!.setStreamResponse(responseModel, streamUsage);
              },
              onError: async (error) => {
                // Suppress xAI safety check errors from logging (they're expected for certain content)
                if (!isXaiSafetyError(error)) {
                  console.error("Error:", error);

                  // Log provider errors to Axiom with request context
                  nextJsAxiomLogger.error("Provider streaming error", {
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
                // No refund on streaming errors - usage is still charged
              },
            });

          let result;
          try {
            result = await createStream(selectedModel);
          } catch (error) {
            // If provider returns error (e.g., INVALID_ARGUMENT from Gemini), retry with fallback.
            // For BYOK users this still uses the user's key because trackedProvider is the BYOK
            // provider — only the model name changes.
            if (
              isProviderApiError(error) &&
              !isRetryWithFallback &&
              isAutoModel
            ) {
              nextJsAxiomLogger.error(
                "Provider API error, retrying with fallback",
                {
                  chatId,
                  endpoint,
                  mode,
                  originalModel: selectedModel,
                  fallbackModel,
                  userId,
                  subscription,
                  isTemporary: temporary,
                  preFallbackCacheReadTokens: usageTracker.cacheReadTokens,
                  preFallbackCacheWriteTokens: usageTracker.cacheWriteTokens,
                  ...extractErrorDetails(error),
                },
              );

              isRetryWithFallback = true;
              lastStepInputTokens = 0;
              stoppedDueToTokenExhaustion = false;
              stoppedDueToPreemptiveTimeout = false;
              stoppedDueToDoomLoop = false;
              preFallbackCacheRead = usageTracker.cacheReadTokens;
              preFallbackCacheWrite = usageTracker.cacheWriteTokens;
              result = await createStream(fallbackModel);
            } else {
              throw error;
            }
          }

          writer.merge(
            result.toUIMessageStream({
              generateMessageId: () => assistantMessageId,
              onFinish: async ({ messages, isAborted }) => {
                // Check if stream finished with only step-start (indicates incomplete response)
                const lastAssistantMessage = messages
                  .slice()
                  .reverse()
                  .find((m) => m.role === "assistant");
                const hasOnlyStepStart =
                  lastAssistantMessage?.parts?.length === 1 &&
                  lastAssistantMessage.parts[0]?.type === "step-start";

                if (hasOnlyStepStart) {
                  nextJsAxiomLogger.warn(
                    "Stream finished incomplete - triggering fallback",
                    {
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
                    },
                  );

                  // Retry with fallback model if not already retrying (only for auto models)
                  if (!isRetryWithFallback && !isAborted && isAutoModel) {
                    isRetryWithFallback = true;
                    lastStepInputTokens = 0;
                    stoppedDueToTokenExhaustion = false;
                    stoppedDueToPreemptiveTimeout = false;
                    stoppedDueToDoomLoop = false;
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
                          // Cleanup for retry
                          preemptiveTimeout?.clear();
                          if (!subscriberStopped) {
                            await cancellationSubscriber.stop();
                            subscriberStopped = true;
                          }

                          chatLogger!.setSandbox(
                            sandboxManager.getSandboxInfo(),
                          );
                          // Use fallback-only cache tokens (subtract pre-fallback snapshot)
                          // so the wide event isn't mixing cumulative cache with retry-only usage
                          const fallbackCacheRead =
                            usageTracker.cacheReadTokens - preFallbackCacheRead;
                          const fallbackCacheWrite =
                            usageTracker.cacheWriteTokens -
                            preFallbackCacheWrite;
                          const fallbackCacheTotal =
                            fallbackCacheRead + fallbackCacheWrite;
                          chatLogger!.setCacheMetrics({
                            cacheHitRate:
                              fallbackCacheTotal > 0
                                ? fallbackCacheRead / fallbackCacheTotal
                                : null,
                            cacheReadTokens: fallbackCacheRead,
                            cacheWriteTokens: fallbackCacheWrite,
                          });
                          captureToolCalls({
                            posthog,
                            chatLogger,
                            userId,
                            mode,
                          });
                          if (mode === "agent" && subscription === "free") {
                            captureFreeAgentRequest({
                              posthog,
                              chatLogger,
                              userId,
                              estimatedInputTokens,
                              selectedModel,
                              selectedModelOverride,
                              configuredModelId,
                              responseModel,
                              usageTracker,
                              finishReason: streamFinishReason,
                              wasAborted: retryAborted,
                              wasPreemptiveTimeout: false,
                              hadSummarization: hasSummarized(),
                              isTemporary: !!temporary,
                              isRegenerate: !!regenerate,
                            });
                          }
                          shutdownPostHog(posthog);
                          chatLogger!.emitSuccess({
                            finishReason: streamFinishReason,
                            wasAborted: retryAborted,
                            wasPreemptiveTimeout: false,
                            hadSummarization: hasSummarized(),
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

                            const accumulatedFiles =
                              getFileAccumulator().getAll();
                            const newFileIds = accumulatedFiles.map(
                              (f) => f.fileId,
                            );

                            // Only save NEW assistant messages from retry (skip already-saved user messages)
                            for (const msg of retryMessages) {
                              if (msg.role !== "assistant") continue;

                              const processed =
                                summarizationTracker.processMessageForSave(msg);

                              await saveMessage({
                                chatId,
                                userId,
                                message: processed,
                                extraFileIds: newFileIds,
                                usage: streamUsage,
                                model: responseModel,
                                generationTimeMs:
                                  Date.now() - fallbackStartTime,
                                finishReason: streamFinishReason,
                              });
                            }

                            // Send file metadata via stream for resumable stream clients
                            sendFileMetadataToStream(accumulatedFiles);
                          } else {
                            // For temporary chats, send file metadata via stream before cleanup
                            const tempFiles = getFileAccumulator().getAll();
                            sendFileMetadataToStream(tempFiles);

                            // Ensure temp stream row is removed backend-side
                            await deleteTempStreamForBackend({ chatId });
                          }

                          // Verify fallback produced valid content
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
                          const fallbackPartTypes =
                            fallbackAssistantMessage?.parts?.map(
                              (p) => p.type,
                            ) ?? [];

                          nextJsAxiomLogger.info("Fallback completed", {
                            chatId,
                            originalModel: selectedModel,
                            originalAssistantMessageId: assistantMessageId,
                            fallbackModel,
                            fallbackAssistantMessageId: retryMessageId,
                            fallbackDurationMs: Date.now() - fallbackStartTime,
                            fallbackSuccess: fallbackHasContent,
                            fallbackWasAborted: retryAborted,
                            fallbackMessageCount: retryMessages.length,
                            fallbackPartTypes,
                            preFallbackCacheReadTokens: preFallbackCacheRead,
                            preFallbackCacheWriteTokens: preFallbackCacheWrite,
                            fallbackCacheReadTokens: fallbackCacheRead,
                            fallbackCacheWriteTokens: fallbackCacheWrite,
                            fallbackCacheHitRate:
                              fallbackCacheTotal > 0
                                ? fallbackCacheRead / fallbackCacheTotal
                                : null,
                            userId,
                            subscription,
                          });

                          // Deduct accumulated usage (includes both original + retry streams)
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
                    nextJsAxiomLogger.info("Preemptive timeout cleanup step", {
                      chatId,
                      step,
                      stepDurationMs: stepDuration,
                      totalElapsedSinceTriggerMs: totalElapsed,
                      endpoint,
                    });
                  }
                };

                if (isPreemptiveAbort) {
                  nextJsAxiomLogger.info(
                    "Preemptive timeout onFinish started",
                    {
                      chatId,
                      endpoint,
                      timeSinceTriggerMs: triggerTime
                        ? onFinishStartTime - triggerTime
                        : null,
                      messageCount: messages.length,
                      isTemporary: temporary,
                    },
                  );
                }

                // Clear pre-emptive timeout
                let stepStart = Date.now();
                preemptiveTimeout?.clear();
                logStep("clear_timeout", stepStart);

                // Stop cancellation subscriber
                stepStart = Date.now();
                await cancellationSubscriber.stop();
                subscriberStopped = true;
                logStep("stop_cancellation_subscriber", stepStart);

                // Clear finish reason for user-initiated aborts (not pre-emptive timeouts)
                // This prevents showing "going off course" message when user clicks stop
                if (isAborted && !isPreemptiveAbort) {
                  streamFinishReason = undefined;
                }

                // Emit wide event
                stepStart = Date.now();
                chatLogger!.setSandbox(sandboxManager.getSandboxInfo());
                chatLogger!.setCacheMetrics({
                  cacheHitRate: usageTracker.cacheHitRate,
                  cacheReadTokens: usageTracker.cacheReadTokens,
                  cacheWriteTokens: usageTracker.cacheWriteTokens,
                });
                captureToolCalls({ posthog, chatLogger, userId, mode });
                if (mode === "agent" && subscription === "free") {
                  captureFreeAgentRequest({
                    posthog,
                    chatLogger,
                    userId,
                    estimatedInputTokens,
                    selectedModel,
                    selectedModelOverride,
                    configuredModelId,
                    responseModel,
                    usageTracker,
                    finishReason: streamFinishReason,
                    wasAborted: isAborted,
                    wasPreemptiveTimeout: isPreemptiveAbort,
                    hadSummarization: hasSummarized(),
                    isTemporary: !!temporary,
                    isRegenerate: !!regenerate,
                  });
                }
                shutdownPostHog(posthog);
                chatLogger!.emitSuccess({
                  finishReason: streamFinishReason,
                  wasAborted: isAborted,
                  wasPreemptiveTimeout: isPreemptiveAbort,
                  hadSummarization: hasSummarized(),
                });
                logStep("emit_success_event", stepStart);

                // Sandbox cleanup is automatic with auto-pause
                // The sandbox will auto-pause after inactivity timeout (7 minutes)
                // No manual pause needed

                // Always wait for title generation to complete
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
                    // updateChat automatically clears stream state (active_stream_id and canceled_at)
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
                    // If not persisting, still need to clear stream state
                    stepStart = Date.now();
                    await prepareForNewStream({ chatId });
                    logStep("prepare_for_new_stream", stepStart);
                  }

                  stepStart = Date.now();
                  const accumulatedFiles = getFileAccumulator().getAll();
                  const newFileIds = accumulatedFiles.map((f) => f.fileId);
                  logStep("get_accumulated_files", stepStart);

                  // Check if any messages have incomplete tool calls that need completion
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
                  // This must happen BEFORE we decide whether to skip saving.
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

                  // If user aborted (not pre-emptive), skip message save when:
                  // 1. skipSave signal received via Redis (edit/regenerate/retry — message will be discarded)
                  // 2. No files, tools, or usage to record (frontend already saved the message)
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

                  // Save messages (either full save or just append extraFileIds)
                  stepStart = Date.now();
                  for (const message of messages) {
                    let processedMessage =
                      summarizationTracker.processMessageForSave(message);

                    // Skip saving messages with no parts or files
                    // This prevents saving empty messages on error that would accumulate on retry
                    if (
                      (!processedMessage.parts ||
                        processedMessage.parts.length === 0) &&
                      newFileIds.length === 0
                    ) {
                      continue;
                    }

                    // Use resolvedUsage which was already awaited above on abort
                    // Falls back to streamUsage for non-abort cases
                    // On user-initiated abort, use updateOnly as safety net:
                    // only patch existing messages (add files/usage), don't create new ones.
                    // This prevents orphan messages when Redis skipSave signal was missed.
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

                  // Send file metadata via stream for resumable stream clients
                  // Uses accumulated metadata directly - no DB query needed!
                  stepStart = Date.now();
                  sendFileMetadataToStream(accumulatedFiles);
                  logStep("send_file_metadata", stepStart);
                } else {
                  // For temporary chats, send file metadata via stream before cleanup
                  stepStart = Date.now();
                  const tempFiles = getFileAccumulator().getAll();
                  sendFileMetadataToStream(tempFiles);
                  logStep("send_temp_file_metadata", stepStart);

                  // Ensure temp stream row is removed backend-side
                  stepStart = Date.now();
                  await deleteTempStreamForBackend({ chatId });
                  logStep("delete_temp_stream", stepStart);
                }

                if (isPreemptiveAbort) {
                  const totalDuration = Date.now() - onFinishStartTime;
                  nextJsAxiomLogger.info(
                    "Preemptive timeout onFinish completed",
                    {
                      chatId,
                      endpoint,
                      totalOnFinishDurationMs: totalDuration,
                      totalSinceTriggerMs: triggerTime
                        ? Date.now() - triggerTime
                        : null,
                    },
                  );
                  await nextJsAxiomLogger.flush();
                }

                // Send updated context usage with output tokens included
                if (contextUsageOn) {
                  writeContextUsage(writer, {
                    usedTokens:
                      ctxUsage.usedTokens + usageTracker.streamOutputTokens,
                    maxTokens: ctxUsage.maxTokens,
                  });
                }

                if (
                  (stoppedDueToTokenExhaustion ||
                    stoppedDueToPreemptiveTimeout) &&
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
        },
      });

      return createUIMessageStreamResponse({
        stream,
        headers: {
          "Transfer-Encoding": "chunked",
        },
        async consumeSseStream({ stream: sseStream }) {
          // Temporary chats do not support resumption
          if (temporary) {
            return;
          }

          try {
            const streamContext = getStreamContext();
            if (streamContext) {
              const streamId = generateId();
              await startStream({ chatId, streamId });
              await streamContext.createNewResumableStream(
                streamId,
                () => sseStream,
              );
            }
          } catch (error) {
            // Non-fatal: stream still works without resumability
            nextJsAxiomLogger.warn("Stream resumption setup failed", {
              chatId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
    } catch (error) {
      // Clear timeout if error occurs before onFinish
      preemptiveTimeout?.clear();

      // No refund on errors - usage is still charged

      // Handle ChatSDKErrors (including authentication errors)
      if (error instanceof ChatSDKError) {
        chatLogger?.emitChatError(error);
        return error.toResponse();
      }

      // Handle unexpected errors (provider failures, etc.)
      chatLogger?.emitUnexpectedError(error);

      const unexpectedError = new ChatSDKError(
        "bad_request:stream",
        getUserFriendlyProviderError(error),
      );
      return unexpectedError.toResponse();
    }
  };
};
