import { createChatLogger, type ChatLogger } from "@/lib/api/chat-logger";
import type {
  AgentTaskPayload,
  SerializableRateLimitInfo,
} from "@/lib/api/prepare-agent-payload";

export function setupAgentChatLogger(
  payload: AgentTaskPayload,
  serializedRateLimitInfo: SerializableRateLimitInfo,
): ChatLogger {
  const {
    chatId,
    messages: processedMessages,
    assistantMessageId,
    mode,
    temporary,
    regenerate,
    userId,
    subscription,
    userLocation,
    extraUsageConfig,
    estimatedInputTokens,
    memoryEnabled,
    isNewChat,
    selectedModel,
    hasSandboxFiles,
    hasFileAttachments: hasFiles,
    fileCount,
    fileImageCount,
    sandboxPreference,
  } = payload;

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

  return chatLogger;
}
