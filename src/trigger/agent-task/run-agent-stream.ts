"use node";

import { createTools } from "@/lib/ai/tools";
import { sendRateLimitWarnings } from "@/lib/api/chat-stream-helpers";
import {
  writeUploadStartStatus,
  writeUploadCompleteStatus,
} from "@/lib/utils/stream-writer-utils";
import { uploadSandboxFiles } from "@/lib/utils/sandbox-file-utils";
import { createTrackedProvider } from "@/lib/ai/providers";
import { systemPrompt } from "@/lib/system-prompt";
import { clearActiveTriggerRunIdFromBackend } from "@/lib/db/actions";
import {
  appendChunk,
  clearChunks,
  clearTodoState,
  saveTodoState,
} from "./chunk-store";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { aiStream } from "../streams";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";
import type { AgentStreamContext, EarlyAgentStreamContext } from "./context";
import { handleAgentStreamFinish } from "./handle-stream-finish";
import { createAgentStreamWithFallback } from "./create-agent-stream-with-fallback";
import { startTitlePromise } from "./start-title-promise";
import { prepareRetryContext } from "./prepare-retry-context";

/** Setup, run the LLM stream, pipe to UI stream, and wait until complete. */
export async function runAgentStream(
  context: EarlyAgentStreamContext,
  payload: AgentTaskPayload,
  attemptNumber: number,
): Promise<void> {
  const {
    chatId,
    mode,
    temporary,
    userId,
    subscription,
    userLocation,
    todos: baseTodos,
    memoryEnabled,
    sandboxPreference,
    isNewChat,
    userCustomization,
    chatFinishReason,
    selectedModel,
    sandboxFiles,
  } = payload;
  const { metadataWriter, rateLimitInfo } = context;

  let effectiveIsNewChat = isNewChat;
  let effectiveBaseTodos = baseTodos;

  if (attemptNumber > 1) {
    ({ effectiveIsNewChat, effectiveBaseTodos } = await prepareRetryContext(
      context,
      payload,
    ));
  }

  sendRateLimitWarnings(metadataWriter, {
    subscription,
    mode,
    rateLimitInfo,
  });

  const appendMetadataStream = async (event: {
    type: "data-terminal";
    data: { terminal: string; toolCallId: string };
  }) => {
    await context.appendMetadata(event);
  };

  const toolsResult = createTools(
    userId,
    chatId,
    metadataWriter,
    mode,
    userLocation ?? { region: undefined, city: undefined, country: undefined },
    effectiveBaseTodos,
    memoryEnabled,
    temporary,
    context.activeAssistantMessageId,
    sandboxPreference,
    process.env.CONVEX_SERVICE_ROLE_KEY,
    userCustomization != null &&
      "guardrails_config" in userCustomization &&
      typeof userCustomization.guardrails_config === "string"
      ? userCustomization.guardrails_config
      : undefined,
    appendMetadataStream,
    (todos) => saveTodoState(chatId, todos),
  );

  const {
    tools,
    getTodoManager,
    getFileAccumulator,
    sandboxManager,
    ensureSandbox,
  } = toolsResult;

  let sandboxContext: string | null = null;
  if (
    isAgentMode(mode) &&
    sandboxManager &&
    "getSandboxContextForPrompt" in sandboxManager
  ) {
    try {
      sandboxContext = await sandboxManager.getSandboxContextForPrompt();
    } catch (error) {
      const { logger } = await import("@trigger.dev/sdk/v3");
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

  const titlePromise = startTitlePromise(payload.messages, {
    isNewChat: effectiveIsNewChat,
    temporary,
    appendMetadata: context.appendMetadata,
  });

  const trackedProvider = createTrackedProvider();
  const currentSystemPrompt = await systemPrompt(
    userId,
    mode,
    subscription,
    selectedModel,
    userCustomization,
    temporary,
    chatFinishReason,
    sandboxContext,
  );
  const configuredModelId =
    trackedProvider.languageModel(selectedModel).modelId;
  const streamStartTime = Date.now();

  const fullContext: AgentStreamContext = {
    ...context,
    tools,
    getTodoManager,
    getFileAccumulator,
    sandboxManager,
    ensureSandbox,
    sandboxContext,
    titlePromise,
    trackedProvider,
    currentSystemPrompt,
    configuredModelId,
    streamStartTime,
  };

  const result = await createAgentStreamWithFallback(
    fullContext,
    selectedModel,
    {
      chatId,
      userId,
      mode,
      subscription,
      temporary,
    },
  );

  clearChunks(chatId);
  const chunkInterceptor = new TransformStream({
    transform(chunk, controller) {
      appendChunk(chatId, chunk);
      controller.enqueue(chunk);
    },
  });

  const { waitUntilComplete } = aiStream.pipe(
    result
      .toUIMessageStream({
        generateMessageId: () => fullContext.activeAssistantMessageId,
        onFinish: async (e) => {
          await handleAgentStreamFinish(fullContext, e);
        },
        sendReasoning: true,
      })
      .pipeThrough(chunkInterceptor),
  );

  try {
    await waitUntilComplete();
    clearChunks(chatId);
    clearTodoState(chatId);
  } finally {
    await clearActiveTriggerRunIdFromBackend({ chatId });
  }
}
