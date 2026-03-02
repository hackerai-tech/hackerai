"use node";

import { isProviderApiError } from "@/lib/api/chat-stream-helpers";
import { extractErrorDetails } from "@/lib/utils/error-utils";
import { triggerAxiomLogger } from "@/lib/axiom/trigger";
import { createAgentStream } from "./create-stream";
import type { AgentStreamContext } from "./context";

export async function createAgentStreamWithFallback(
  fullContext: AgentStreamContext,
  selectedModel: string,
  logContext: {
    chatId: string;
    userId: string;
    mode: string;
    subscription: unknown;
    temporary: boolean;
  },
) {
  try {
    return await createAgentStream(fullContext, selectedModel);
  } catch (error) {
    if (!isProviderApiError(error)) throw error;

    const { logger } = await import("@trigger.dev/sdk/v3");
    const { chatId, userId, mode, subscription, temporary } = logContext;

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

    return createAgentStream(fullContext, "fallback-agent-model");
  }
}
