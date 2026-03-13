import { getWritable, getStepMetadata } from "workflow";
import { createUIMessageStream, type UIMessageChunk } from "ai";
import {
  createAgentStreamExecute,
  type AgentStepResult,
} from "@/lib/api/agent-stream-core";
import { deserializeRateLimitInfo } from "@/lib/api/rate-limit-serialization";
import { UsageRefundTracker } from "@/lib/rate-limit/refund";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";
import { createChatLogger } from "@/lib/api/chat-logger";
import { workflowAxiomLogger } from "@/lib/axiom/workflow";

/**
 * Workflow step that runs the full agent loop.
 * Uses the shared createAgentStreamExecute() core, piping output
 * through the Workflow's writable stream.
 *
 * No preemptive timeout is needed since Workflow supports up to 1 hour execution.
 */
export async function runAgentStep(
  payload: AgentTaskPayload,
): Promise<AgentStepResult> {
  "use step";

  const { attempt, stepId } = getStepMetadata();
  workflowAxiomLogger.info("Workflow step started", {
    chatId: payload.chatId,
    stepId,
    attempt,
    isRetry: attempt > 1,
  });

  const {
    chatId,
    assistantMessageId,
    mode,
    todos: baseTodos,
    regenerate,
    temporary,
    sandboxPreference,
    tauriCmdServer,
    userId,
    subscription,
    userLocation,
    extraUsageConfig,
    estimatedInputTokens,
    memoryEnabled,
    userCustomization,
    isNewChat,
    selectedModel,
    selectedModelOverride,
    rateLimitInfo: serializedRateLimitInfo,
    sandboxFiles,
    fileTokens,
    chatFinishReason,
    messages: processedMessages,
  } = payload;

  const rateLimitInfo = deserializeRateLimitInfo(serializedRateLimitInfo);

  // Track usage deductions for refund on pre-stream errors
  const usageRefundTracker = new UsageRefundTracker();
  usageRefundTracker.setUser(userId, subscription);
  usageRefundTracker.recordDeductions({
    pointsDeducted: serializedRateLimitInfo.pointsDeducted,
    extraUsagePointsDeducted: serializedRateLimitInfo.extraUsagePointsDeducted,
  } as Parameters<UsageRefundTracker["recordDeductions"]>[0]);

  // Initialize chat logger
  const chatLogger = createChatLogger({
    chatId,
    endpoint: "/api/agent-workflow",
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
      hasSandboxFiles: payload.hasSandboxFiles,
      hasFileAttachments: payload.hasFileAttachments,
      fileCount: payload.fileCount,
      fileImageCount: payload.fileImageCount,
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
      monthly: serializedRateLimitInfo.monthly
        ? {
            remaining: serializedRateLimitInfo.monthly.remaining,
            limit: serializedRateLimitInfo.monthly.limit,
          }
        : undefined,
      remaining: serializedRateLimitInfo.remaining,
      subscription,
    },
    extraUsageConfig ?? undefined,
  );
  chatLogger.getBuilder().setAssistantId(assistantMessageId);
  chatLogger.startStream();

  const userStopSignal = new AbortController();

  // Get the Workflow's writable stream for piping output to the client
  const writable = getWritable<UIMessageChunk>();

  const { execute, getStepResult } = createAgentStreamExecute({
    chatId,
    userId,
    subscription,
    mode,
    assistantMessageId,
    endpoint: "/api/agent-workflow",
    processedMessages,
    selectedModel,
    selectedModelOverride,
    temporary: !!temporary,
    regenerate: !!regenerate,
    isNewChat,
    memoryEnabled,
    rateLimitInfo,
    baseTodos,
    sandboxPreference,
    userLocation: userLocation ?? {
      region: undefined,
      city: undefined,
      country: undefined,
    },
    userCustomization,
    extraUsageConfig: extraUsageConfig ?? undefined,
    estimatedInputTokens,
    fileTokens,
    sandboxFiles,
    chatFinishReason,
    tauriCmdServer,
    logger: workflowAxiomLogger,
    chatLogger,
    usageRefundTracker,
    abortController: userStopSignal,
    // No preemptiveTimeout — workflow supports up to 1 hour
    timeBudgetMs: 60_000, // 750s budget, 50s buffer for onFinish cleanup
  });

  const uiStream = createUIMessageStream({ execute });

  // Pipe the UIMessageStream output to the Workflow's writable stream.
  // pipeTo() closes the writable when the readable ends (signals "no more data"),
  // which closes the Workflow's readable side and lets WorkflowChatTransport
  // exit its read loop and transition useChat to "ready".
  await uiStream.pipeTo(writable);

  return await getStepResult();
}
