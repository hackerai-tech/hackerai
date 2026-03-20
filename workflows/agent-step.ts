import { getStepMetadata, getWritable } from "workflow";
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
import { appendChunk, markStreamDone } from "@/lib/utils/redis-stream";

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

  // Each step calls getWritable() to get a writable connected to the
  // current execution context's buffer. Passing the writable from the
  // workflow doesn't work across step boundaries because durable
  // execution re-runs the workflow function between steps.
  const writable = getWritable<UIMessageChunk>();

  const { attempt, stepId } = getStepMetadata();
  const isContinuation =
    payload.chatFinishReason === WORKFLOW_CHECKPOINT_FINISH_REASON;
  workflowAxiomLogger.info("Workflow step started", {
    chatId: payload.chatId,
    stepId,
    attempt,
    isRetry: attempt > 1,
    isContinuation,
    messageCount: isContinuation ? payload.messages.length : undefined,
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
    timeBudgetMs: 750_000, // 750s per step (50s buffer before Vercel's 800s limit)
  });

  const uiStream = createUIMessageStream({ execute });

  // Shadow every chunk to Redis Streams as a fire-and-forget side effect.
  // Skip per-step "finish" chunks — those are an internal workflow artifact.
  // The real finish + __done sentinel are written explicitly in the
  // !canContinue block (and closeWorkflowStream safety net).
  //
  // On continuation steps, suppress "warm-up" reasoning at the start.
  // After a checkpoint the model receives the full message history and
  // generates many reasoning blocks before producing useful output.
  // These add noise to the UI, so we gate them until the first real
  // content chunk (text, tool call, etc.) arrives.
  let seenRealContent = !isContinuation;
  const redisWriteTransform = new TransformStream<
    UIMessageChunk,
    UIMessageChunk
  >({
    transform(chunk, controller) {
      if ("type" in chunk && chunk.type === "finish")
        return controller.enqueue(chunk);

      const type = "type" in chunk ? (chunk.type as string) : "";
      if (
        !seenRealContent &&
        (type === "reasoning-start" ||
          type === "reasoning-delta" ||
          type === "reasoning-end" ||
          type === "step-start")
      ) {
        // Suppress warm-up reasoning — don't write to Redis or forward
        return;
      }
      seenRealContent = true;

      void appendChunk(chatId, chunk);
      controller.enqueue(chunk);
    },
  });

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
  // preventAbort stops the budget abort from killing the writable so
  // the next step can still pipe to it. The .catch() prevents the
  // pipeTo rejection (from the aborted source) from crashing the step.
  await uiStream
    .pipeThrough(redisWriteTransform)
    .pipeThrough(stripFinish)
    .pipeTo(writable, { preventClose: true, preventAbort: true })
    .catch(() => {});

  const result = await getStepResult();

  // Close the stream unless this is a checkpoint that can actually continue
  // (has a messages snapshot for the next step). This must happen here
  // (inside "use step") because the workflow orchestrator can't call
  // WritableStream methods like getWriter()/close().
  const canContinue =
    result.finishReason === WORKFLOW_CHECKPOINT_FINISH_REASON &&
    (result.messagesSnapshot?.length ?? 0) > 0;

  if (canContinue) {
    // Write a checkpoint marker to Redis so the stream reader knows more
    // data is coming from the next step. Without this, the reader's stale
    // timeout (30s of silence) fires during the step transition gap and
    // emits a synthetic finish, which tells the client the chat is done
    // even though a new step is about to start.
    await appendChunk(chatId, "__checkpoint");
  } else {
    // Write the final finish + __done sentinel to Redis BEFORE closing the
    // Vercel writable. These must be awaited — fire-and-forget risks the step
    // exiting before the writes complete, leaving the stream without __done
    // and causing an infinite reconnect loop on the client.
    await appendChunk(chatId, { type: "finish", finishReason: "stop" });
    await markStreamDone(chatId);

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
export async function closeWorkflowStream(chatId: string) {
  "use step";
  await appendChunk(chatId, { type: "finish", finishReason: "stop" });
  await markStreamDone(chatId);

  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  await writer.write({ type: "finish", finishReason: "stop" });
  writer.releaseLock();
  await writable.close();
}

closeWorkflowStream.maxRetries = 0;
