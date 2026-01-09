/**
 * Benchmark Handler
 *
 * Handler for running AI agent against security benchmarks.
 * Always uses streaming mode (SSE) with resumable stream support.
 * Always uses agent mode and generates a new chatId for each run.
 * Requires userId for proper sandbox access and chat persistence.
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  UIMessage,
  JsonToSseTransformStream,
  smoothStream,
} from "ai";
import { systemPrompt } from "@/lib/system-prompt";
import { createTools } from "@/lib/ai/tools";
import { ChatSDKError } from "@/lib/errors";
import { NextRequest, after } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { processChatMessages } from "@/lib/chat/chat-processor";
import { createTrackedProvider } from "@/lib/ai/providers";
import { geolocation } from "@vercel/functions";
import type { Todo, SandboxPreference } from "@/types";
import { getMaxStepsForUser } from "@/lib/chat/chat-processor";
import {
  handleInitialChatAndUserMessage,
  saveMessage,
  updateChat,
  startStream,
} from "@/lib/db/actions";
import { stripProviderMetadata } from "@/lib/utils/message-processor";
import { createResumableStreamContext } from "resumable-stream";

/** Default timeout (13 minutes) */
const DEFAULT_TIMEOUT_MS = 13 * 60 * 1000;

let globalStreamContext: ReturnType<
  typeof createResumableStreamContext
> | null = null;

export const getStreamContext = () => {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({ waitUntil: after });
    } catch (error: unknown) {
      if (
        typeof (error as Error)?.message === "string" &&
        (error as Error).message.includes("REDIS_URL")
      ) {
        console.log(
          " > Resumable streams are disabled due to missing REDIS_URL",
        );
      } else {
        console.warn("Resumable stream context init failed:", error);
      }
    }
  }
  return globalStreamContext;
};

/**
 * Validate the benchmark API key from request headers
 */
const validateBenchmarkApiKey = (req: NextRequest): boolean => {
  const authHeader = req.headers.get("authorization");
  const expectedKey = process.env.BENCHMARK_API_KEY;

  if (!expectedKey) {
    console.error("BENCHMARK_API_KEY is not configured");
    return false;
  }

  if (!authHeader) {
    return false;
  }

  // Support both "Bearer <key>" and raw key formats
  const providedKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  return providedKey === expectedKey;
};

export const createBenchmarkHandler = () => {
  return async (req: NextRequest): Promise<Response> => {
    // Set up abort controller for timeout (declared early for cleanup in catch)
    let abortController: AbortController | undefined;
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      // Validate benchmark API key authentication
      if (!validateBenchmarkApiKey(req)) {
        throw new ChatSDKError(
          "unauthorized:chat",
          "Invalid or missing benchmark API key. Set Authorization header with BENCHMARK_API_KEY.",
        );
      }

      const {
        messages: inputMessages,
        todos = [],
        timeout = DEFAULT_TIMEOUT_MS,
        sandboxPreference = "e2b",
        userId,
      }: {
        messages: UIMessage[];
        todos?: Todo[];
        timeout?: number;
        sandboxPreference?: SandboxPreference;
        userId: string;
      } = await req.json();

      // Validate required fields
      if (!userId) {
        throw new ChatSDKError(
          "bad_request:api",
          "Missing required field: userId",
        );
      }

      if (
        !inputMessages ||
        !Array.isArray(inputMessages) ||
        inputMessages.length === 0
      ) {
        throw new ChatSDKError(
          "bad_request:api",
          "Missing or invalid messages",
        );
      }

      // Always use agent mode for benchmarks
      const mode = "agent" as const;
      const subscription = "ultra" as const;
      const userLocation = geolocation(req);

      // Generate new chatId for each benchmark run
      const chatId = uuidv4();

      // Set up abort controller for timeout
      abortController = new AbortController();
      timeoutId = setTimeout(() => {
        abortController?.abort();
      }, timeout);

      // Process messages
      const { processedMessages, selectedModel } = await processChatMessages({
        messages: inputMessages,
        mode,
        subscription,
      });

      const assistantMessageId = uuidv4();
      const baseTodos: Todo[] = Array.isArray(todos) ? todos : [];

      console.log(
        `[Benchmark] Starting - userId: ${userId}, chatId: ${chatId}, sandbox: ${sandboxPreference}`,
      );

      // Always create chat for benchmark runs
      try {
        await handleInitialChatAndUserMessage({
          chatId,
          userId,
          messages: inputMessages,
          regenerate: false,
          chat: null,
        });
      } catch (error) {
        console.warn("[Benchmark] Failed to create initial chat:", error);
      }

      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          const { tools, getTodoManager, sandboxManager } = createTools(
            userId,
            writer,
            mode,
            userLocation,
            baseTodos,
            false, // memoryEnabled
            false, // isTemporary - always save for benchmarks
            assistantMessageId,
            sandboxPreference,
            process.env.CONVEX_SERVICE_ROLE_KEY,
            undefined,
            undefined,
          );

          // Get sandbox context for system prompt (only for local sandboxes)
          let sandboxContext: string | null = null;
          if (
            mode === "agent" &&
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

          const trackedProvider = createTrackedProvider(
            userId,
            chatId,
            subscription,
            null,
          );

          const currentSystemPrompt = await systemPrompt(
            userId,
            mode,
            subscription,
            selectedModel,
            undefined,
            false, // isTemporary - always save for benchmarks
            undefined,
            sandboxContext,
          );

          const streamStartTime = Date.now();
          const configuredModelId =
            trackedProvider.languageModel(selectedModel).modelId;
          let streamUsage: Record<string, unknown> | undefined;
          let responseModel: string | undefined;
          let streamFinishReason: string | undefined;

          console.log(
            `[Benchmark] Streaming with model: ${configuredModelId}, sandbox: ${sandboxPreference}`,
          );

          const result = streamText({
            model: trackedProvider.languageModel(selectedModel),
            system: currentSystemPrompt,
            messages: await convertToModelMessages(processedMessages),
            tools,
            stopWhen: stepCountIs(getMaxStepsForUser(mode, subscription)),
            abortSignal: abortController?.signal,
            providerOptions: {
              openrouter: {
                reasoning: { enabled: true },
                provider: { sort: "latency" },
              },
            },
            experimental_transform: smoothStream({ chunking: "word" }),
            onStepFinish: async ({ text, toolCalls }) => {
              const toolNames =
                toolCalls
                  ?.map((tc) => tc?.toolName)
                  .filter(Boolean)
                  .join(", ") || "none";
              console.log(
                `[Benchmark] Step - Tools: ${toolNames}, Text: ${text?.substring(0, 100) || "(none)"}...`,
              );
            },
            onFinish: async ({ finishReason, usage, response }) => {
              if (timeoutId) clearTimeout(timeoutId);
              streamFinishReason = finishReason;
              streamUsage = usage as Record<string, unknown>;
              responseModel = response?.modelId;
            },
          });

          writer.merge(
            result.toUIMessageStream({
              generateMessageId: () => assistantMessageId,
              onFinish: async ({ messages }) => {
                if (timeoutId) clearTimeout(timeoutId);

                try {
                  const mergedTodos = getTodoManager().mergeWith(
                    baseTodos,
                    assistantMessageId,
                  );

                  await updateChat({
                    chatId,
                    title: `Benchmark ${chatId}`,
                    finishReason: streamFinishReason,
                    todos: mergedTodos,
                    defaultModelSlug: mode,
                  });

                  for (const message of messages) {
                    const messageToSave = stripProviderMetadata(message);
                    if (
                      !messageToSave.parts ||
                      messageToSave.parts.length === 0
                    ) {
                      continue;
                    }

                    await saveMessage({
                      chatId,
                      userId,
                      message: messageToSave,
                      extraFileIds: [],
                      model: responseModel || configuredModelId,
                      generationTimeMs: Date.now() - streamStartTime,
                      finishReason: streamFinishReason,
                      usage: streamUsage,
                    });
                  }
                } catch (error) {
                  console.error("[Benchmark] Failed to save messages:", error);
                }
              },
              sendReasoning: true,
            }),
          );
        },
      });

      // Wrap the UI message stream as SSE
      const sse = stream.pipeThrough(new JsonToSseTransformStream());

      // Create a resumable stream and persist the active stream id
      const streamContext = getStreamContext();
      if (streamContext) {
        const streamId = uuidv4();
        await startStream({ chatId, streamId });
        const body = await streamContext.resumableStream(streamId, () => sse);
        return new Response(body);
      }

      // Fallback if resumable streams unavailable
      return new Response(sse);
    } catch (error) {
      // Clear timeout if error occurs
      if (timeoutId) clearTimeout(timeoutId);

      // Handle ChatSDKErrors
      if (error instanceof ChatSDKError) {
        return error.toResponse();
      }

      // Handle abort/timeout
      if (error instanceof Error && error.name === "AbortError") {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Benchmark timeout",
            response: "",
            steps: 0,
            finishReason: "timeout",
          }),
          {
            status: 408,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Handle unexpected errors
      console.error("Unexpected error in benchmark route:", error);
      const unexpectedError = new ChatSDKError(
        "offline:chat",
        error instanceof Error ? error.message : "Unknown error occurred",
      );
      return unexpectedError.toResponse();
    }
  };
};
