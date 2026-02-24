"use node";

import { createTools } from "@/lib/ai/tools";
import {
  sendRateLimitWarnings,
  isProviderApiError,
} from "@/lib/api/chat-stream-helpers";
import {
  writeUploadStartStatus,
  writeUploadCompleteStatus,
} from "@/lib/utils/stream-writer-utils";
import { uploadSandboxFiles } from "@/lib/utils/sandbox-file-utils";
import { createTrackedProvider } from "@/lib/ai/providers";
import { systemPrompt } from "@/lib/system-prompt";
import { clearActiveTriggerRunIdFromBackend } from "@/lib/db/actions";
import { extractErrorDetails } from "@/lib/utils/error-utils";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { triggerAxiomLogger } from "@/lib/axiom/trigger";
import { aiStream } from "../streams";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";
import { createAgentStreamContext } from "./context";
import type { AgentStreamContext } from "./context";
import { createAgentStream } from "./create-stream";
import { handleAgentStreamFinish } from "./handle-stream-finish";
import { startTitlePromise } from "./start-title-promise";

/** Setup, run the LLM stream, pipe to UI stream, and wait until complete. */
export async function runAgentStream(
  context: ReturnType<typeof createAgentStreamContext>,
  payload: AgentTaskPayload,
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
    assistantMessageId,
    sandboxPreference,
    isNewChat,
    userCustomization,
    chatFinishReason,
    selectedModel,
    sandboxFiles,
  } = payload;
  const { metadataWriter, rateLimitInfo } = context;

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

  context.tools = toolsResult.tools;
  context.getTodoManager = toolsResult.getTodoManager;
  context.getFileAccumulator = toolsResult.getFileAccumulator;
  context.sandboxManager = toolsResult.sandboxManager;
  context.ensureSandbox = toolsResult.ensureSandbox;

  if (
    isAgentMode(mode) &&
    "getSandboxContextForPrompt" in context.sandboxManager
  ) {
    try {
      context.sandboxContext = await (
        context.sandboxManager as {
          getSandboxContextForPrompt: () => Promise<string | null>;
        }
      ).getSandboxContextForPrompt();
    } catch (error) {
      const { logger } = await import("@trigger.dev/sdk/v3");
      logger.warn("Failed to get sandbox context for prompt", { error });
    }
  }

  if (isAgentMode(mode) && sandboxFiles && sandboxFiles.length > 0) {
    writeUploadStartStatus(metadataWriter);
    try {
      await uploadSandboxFiles(sandboxFiles, context.ensureSandbox);
    } finally {
      writeUploadCompleteStatus(metadataWriter);
    }
  }

  context.titlePromise = startTitlePromise(payload.messages, {
    isNewChat,
    temporary,
    appendMetadata: context.appendMetadata,
  });

  context.trackedProvider = createTrackedProvider();
  context.currentSystemPrompt = await systemPrompt(
    userId,
    mode,
    subscription,
    selectedModel,
    userCustomization,
    temporary,
    chatFinishReason,
    context.sandboxContext,
  );
  context.configuredModelId =
    context.trackedProvider.languageModel(selectedModel).modelId;
  context.streamStartTime = Date.now();

  let result;
  try {
    result = await createAgentStream(
      context as AgentStreamContext,
      selectedModel,
    );
  } catch (error) {
    if (isProviderApiError(error)) {
      const { logger } = await import("@trigger.dev/sdk/v3");
      logger.warn("Provider API error, retrying with fallback", {
        chatId,
        selectedModel,
        userId,
      });
      triggerAxiomLogger.error("Provider API error, retrying with fallback", {
        chatId,
        endpoint: "/api/agent-long",
        mode,
        originalModel: selectedModel,
        fallbackModel: "fallback-agent-model",
        userId,
        subscription,
        isTemporary: temporary,
        ...extractErrorDetails(error),
      });
      await triggerAxiomLogger.flush();
      result = await createAgentStream(
        context as AgentStreamContext,
        "fallback-agent-model",
      );
    } else {
      throw error;
    }
  }

  const { waitUntilComplete } = aiStream.pipe(
    result.toUIMessageStream({
      generateMessageId: () => assistantMessageId,
      onFinish: async (e) => {
        await handleAgentStreamFinish(context as AgentStreamContext, e);
      },
      sendReasoning: true,
    }),
  );

  try {
    await waitUntilComplete();
  } finally {
    await clearActiveTriggerRunIdFromBackend({ chatId });
  }
}
