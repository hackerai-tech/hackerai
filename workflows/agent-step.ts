import { getStepMetadata } from "workflow";
import { createUIMessageStream, type UIMessageChunk } from "ai";
import {
  createAgentStreamExecute,
  type AgentStepResult,
} from "@/lib/api/agent-stream-core";
import { WORKFLOW_CHECKPOINT_FINISH_REASON } from "@/lib/chat/stop-conditions";
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
  writable: WritableStream<UIMessageChunk>,
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
    timeBudgetMs: 750_000, // 750s budget, 50s buffer for onFinish cleanup
  });

  const uiStream = createUIMessageStream({ execute });

  // Strip the "finish" chunk from the UIMessageStream so the client doesn't
  // see it mid-workflow. The workflow sends a single finish event after all
  // steps complete. Without this, WorkflowChatTransport would interpret the
  // per-step finish as "chat is done" and stop listening.
  const stripFinish = new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if ("type" in chunk && chunk.type === "finish") return;
      controller.enqueue(chunk);
    },
  });

  // preventClose keeps the writable open so the workflow can continue
  // piping from subsequent steps after a time-budget checkpoint.
  await uiStream
    .pipeThrough(stripFinish)
    .pipeTo(writable, { preventClose: true });

  const result = await getStepResult();

  // Close the stream unless this is a checkpoint that can actually continue
  // (has a messages snapshot for the next step). This must happen here
  // (inside "use step") because the workflow orchestrator can't call
  // WritableStream methods like getWriter()/close().
  const canContinue =
    result.finishReason === WORKFLOW_CHECKPOINT_FINISH_REASON &&
    (result.messagesSnapshot?.length ?? 0) > 0;

  if (!canContinue) {
    const writer = writable.getWriter();
    await writer.write({ type: "finish", finishReason: "stop" });
    writer.releaseLock();
    await writable.close();
  }

  return result;
}

/**
 * Closes the workflow writable stream. Called by the workflow orchestrator
 * when the continuation loop exits without the final step having closed it
 * (e.g. MAX_CONTINUATIONS reached). Must be a step function because
 * WritableStream methods aren't available in "use workflow" context.
 */
export async function closeWorkflowStream(
  writable: WritableStream<UIMessageChunk>,
) {
  "use step";
  const writer = writable.getWriter();
  await writer.write({ type: "finish", finishReason: "stop" });
  writer.releaseLock();
  await writable.close();
}

closeWorkflowStream.maxRetries = 0;
