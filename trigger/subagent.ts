import {
  logger as triggerLogger,
  metadata,
  runs,
  tags,
  task,
  usage as triggerUsage,
} from "@trigger.dev/sdk";
import {
  convertToModelMessages,
  createUIMessageStream,
  Output,
  hasToolCall,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { agentUiStream } from "./streams";
import { createTools } from "@/lib/ai/tools";
import { createTrackedProvider } from "@/lib/ai/providers";
import {
  createLoadSkillTool,
  createSearchSkillsTool,
} from "@/lib/ai/tools/subagent-skill-tools";
import type { ModelName } from "@/lib/ai/providers";
import {
  guardLanguageModelProviderResponse,
  MAX_PROVIDER_TOOL_CALLS_PER_RESPONSE,
} from "@/lib/ai/provider-response-guard";
import { namespaceLanguageModelToolCalls } from "@/lib/ai/tool-call-id-namespace";
import {
  SUBAGENT_MAX_ACTIVE_SECONDS,
  SUBAGENT_MAX_DURATION_SECONDS,
  SUBAGENT_MAX_STEPS,
  SUBAGENT_RESULT_DEADLINE_SECONDS,
  SUBAGENT_TERMINAL_STATUSES,
  reportToParentInputSchema,
  updateWorkLedgerInputSchema,
  type SubagentStructuredResult,
} from "@/lib/ai/subagents/contracts";
import {
  buildMissingSubagentResultRecoveryMessage,
  canRecoverMissingSubagentResult,
  canStartSubagentResultRecoveryGeneration,
  getSubagentExplorationStepLimit,
  getSubagentProviderRetryDecision,
  getSubagentRecoveryErrorDiagnostics,
  getSubagentResultRecoveryRetryDecision,
  isTransientProviderCategory,
  pipeSubagentUiMessageStream,
  shouldStartSubagentResultRecovery,
  type SubagentRecoveryErrorDiagnostics,
} from "@/lib/ai/subagents/runtime-recovery";
import {
  getSubagentProfileDefinition,
  resolveSubagentAllowedToolNames,
} from "@/lib/ai/subagents/profiles";
import {
  resolveSubagentModelForImageToolResults,
  resolveSubagentTextModel,
} from "@/lib/ai/subagents/model-routing";
import { assertSubagentSandboxIdentity } from "@/lib/ai/subagents/sandbox-identity";
import {
  assertSubagentRuntimeAuthorized,
  guardSubagentToolExecutions,
} from "@/lib/ai/subagents/runtime-authorization";
import {
  attachSubagentTriggerRun,
  consumePendingSubagentMessages,
  finishSubagent,
  getSubagent,
  getSubagentMessages,
  markSubagentFinalizing,
  recordSubagentRecovery,
  resolveSubagentContext,
  saveSubagentMessage,
  recordSubagentEvent,
  updateSubagentWorkLedger,
} from "@/lib/db/subagents";
import { setConvexUrl } from "@/lib/db/convex-client";
import { sanitizeForConvexValue } from "@/lib/db/convex-value-sanitizer";
import {
  compactMessageForStorage,
  pruneModelMessages,
} from "@/lib/chat/compaction/prune-tool-outputs";
import { sanitizeAgentLongRealtimeChunk } from "@/lib/chat/agent-long-realtime-sanitizer";
import { toolResultsContainImageViewResult } from "@/lib/chat/multimodal-tool-result-recovery";
import { UsageTracker } from "@/lib/usage-tracker";
import { resolveTriggerRunCost } from "@/lib/billing/trigger-run-cost";
import {
  deductUsage,
  isHandledUserRateLimitError,
  recordFreeMonthlyCost,
} from "@/lib/rate-limit";
import { checkSubagentBillingCapacity } from "@/lib/ai/subagents/billing";
import {
  finalizeHandledSubagentRateLimit,
  type SubagentTerminalOutput as SubagentTaskOutput,
} from "@/lib/ai/subagents/rate-limit-finalization";
import {
  buildExtraUsageConfig,
  getContentFilterRetryModel,
} from "@/lib/api/chat-stream-helpers";
import { getUserCustomization } from "@/lib/db/actions";
import { extractOpenRouterMetadata } from "@/lib/api/openrouter-metadata";
import {
  captureSubagentLifecycleEvent,
  captureSubagentTerminalOutcome,
  subagentModelPromotionEventUuid,
  subagentOutcomeEventUuid,
} from "@/lib/analytics/subagents";
import { phLogger } from "@/lib/posthog/server";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";
import {
  extractErrorDetails,
  getUserFriendlyProviderError,
} from "@/lib/utils/error-utils";
import { ChatSDKError, serializeChatSDKErrorForStream } from "@/lib/errors";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";

const loadPersistedTerminalOutput = async (
  subagentId: string,
): Promise<SubagentTaskOutput | null> => {
  const persisted = await getSubagent(subagentId);
  if (!persisted || !SUBAGENT_TERMINAL_STATUSES.has(persisted.status)) {
    return null;
  }
  return {
    subagentId: persisted.subagent_id,
    status: persisted.status as SubagentTaskOutput["status"],
  };
};

type SubagentTaskPayload = {
  subagentId: string;
  convexUrl?: string;
  triggerRegion?: TriggerRunRegion;
};

type CancellationCleanup = {
  subagentId: string;
  userId: string;
  parentTriggerRunId: string;
  profile: "general" | "security_task" | "security_validation";
};

const cancellationCleanup = new Map<string, CancellationCleanup>();

const sanitizeStream = (
  stream: ReadableStream<UIMessageChunk>,
): ReadableStream<UIMessageChunk> =>
  stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        for (const sanitized of sanitizeAgentLongRealtimeChunk(chunk)) {
          controller.enqueue(sanitized as UIMessageChunk);
        }
      },
    }),
  );

const persistAssistantMessages = async (
  subagentId: string,
  userId: string,
  messages: UIMessage[],
  sequenceBase: number,
): Promise<void> => {
  let sequence = sequenceBase;
  for (const message of messages) {
    if (message.role !== "assistant" || message.parts.length === 0) continue;
    const convexSafe = sanitizeForConvexValue(
      message.parts,
    ) as UIMessage["parts"];
    const compacted = compactMessageForStorage(
      { ...message, parts: convexSafe },
      { softLimitBytes: 256 * 1024, toolOutputTokenBudget: 12_000 },
    ).message;
    await saveSubagentMessage({
      subagentId,
      userId,
      sequence,
      role: "assistant",
      parts: compacted.parts,
    });
    sequence += 1;
  }
};

const waitForRetryDelay = async (
  delayMs: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted || delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
};

const captureCompletion = (
  row: NonNullable<Awaited<ReturnType<typeof getSubagent>>>,
  result: SubagentStructuredResult,
  costDollars: number,
  stepCount: number,
  durationMs: number,
  resultRecoveryCount: number,
  resultSubmissionCount: number,
) => {
  const base = {
    userId: row.user_id,
    subagentId: row.subagent_id,
    parentTriggerRunId: row.parent_trigger_run_id,
    profile: row.profile,
    status: "completed" as const,
    ...(row.profile === "security_validation" && "verdict" in result
      ? { verdict: result.verdict }
      : {}),
    ...(row.profile !== "security_validation" && "task_status" in result
      ? { taskStatus: result.task_status }
      : {}),
    durationMs,
    stepCount,
    costDollars,
    resultRecoveryCount,
    resultSubmissionCount,
  };
  captureSubagentLifecycleEvent("subagent_completed", {
    ...base,
    eventUuid: subagentOutcomeEventUuid(row.subagent_id),
  });
  if (row.profile === "security_validation" && "verdict" in result) {
    captureSubagentLifecycleEvent(
      result.verdict === "confirmed"
        ? "subagent_validation_confirmed"
        : result.verdict === "rejected"
          ? "subagent_validation_rejected"
          : "subagent_validation_inconclusive",
      { ...base, verdict: result.verdict },
    );
  }
};

const persistedDurationMs = (
  row: NonNullable<Awaited<ReturnType<typeof getSubagent>>>,
): number | undefined => {
  if (!row.completed_at) return undefined;
  return Math.max(0, row.completed_at - (row.started_at ?? row.created_at));
};

const reusePersistedTerminalState = async (
  row: NonNullable<Awaited<ReturnType<typeof getSubagent>>>,
  triggerRunId: string,
  reuseStage: "pre_attach" | "attach_terminal",
): Promise<SubagentTaskOutput> => {
  const durationMs = persistedDurationMs(row);
  if (row.status === "completed") {
    const structuredResult = row.structured_result;
    captureSubagentLifecycleEvent("subagent_completed", {
      userId: row.user_id,
      eventUuid: subagentOutcomeEventUuid(row.subagent_id),
      subagentId: row.subagent_id,
      parentTriggerRunId: row.parent_trigger_run_id,
      profile: row.profile,
      status: "completed",
      durationMs,
      stepCount: row.step_count,
      costDollars: row.cost_dollars,
      ...(row.profile === "security_validation" && row.verdict
        ? { verdict: row.verdict }
        : {}),
      ...(row.profile === "security_task" &&
      structuredResult &&
      "task_status" in structuredResult
        ? { taskStatus: structuredResult.task_status }
        : {}),
    });
  } else {
    captureSubagentTerminalOutcome({
      userId: row.user_id,
      subagentId: row.subagent_id,
      parentTriggerRunId: row.parent_trigger_run_id,
      profile: row.profile,
      status: row.status as "failed" | "canceled" | "timed_out",
      durationMs,
      stepCount: row.step_count,
      costDollars: row.cost_dollars,
      errorCategory:
        row.failure_code ?? row.cancel_reason ?? "persisted_terminal_state",
      failureStage: reuseStage,
    });
  }
  triggerLogger.info("[subagent] persisted terminal state reused", {
    event: "subagent_terminal_state_reused",
    service: "hackerai-subagent",
    environment: process.env.TRIGGER_ENV ?? process.env.NODE_ENV ?? "unknown",
    subagent_id: row.subagent_id,
    parent_trigger_run_id: row.parent_trigger_run_id,
    trigger_run_id: triggerRunId,
    terminal_status: row.status,
    reuse_stage: reuseStage,
  });
  metadata.set("status", row.status).set("terminalStateReused", true);
  await phLogger.flush().catch(() => undefined);
  return {
    subagentId: row.subagent_id,
    status: row.status as SubagentTaskOutput["status"],
  };
};

export const subagentTask = task({
  id: "hackerai-subagent",
  maxDuration: SUBAGENT_MAX_DURATION_SECONDS,
  retry: { maxAttempts: 1 },
  machine: { preset: "small-1x" },
  queue: { name: "hackerai-subagents", concurrencyLimit: 20 },

  onCancel: async ({
    ctx,
    runPromise,
  }: {
    ctx: { run: { id: string } };
    runPromise: Promise<unknown>;
  }) => {
    const cleanup = cancellationCleanup.get(ctx.run.id);
    if (!cleanup) return;
    await Promise.race([
      runPromise.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    const finishOutcome = await finishSubagent({
      subagentId: cleanup.subagentId,
      triggerRunId: ctx.run.id,
      status: "canceled",
      summary: "Subagent was canceled with its parent run.",
      failureCode: "parent_or_user_canceled",
      cancelReason: "parent_or_user_canceled",
    }).catch(() => null);
    await ptySessionManager.closeAll(cleanup.subagentId).catch(() => undefined);
    if (finishOutcome === "updated") {
      captureSubagentTerminalOutcome({
        userId: cleanup.userId,
        subagentId: cleanup.subagentId,
        parentTriggerRunId: cleanup.parentTriggerRunId,
        profile: cleanup.profile,
        status: "canceled",
        errorCategory: "parent_or_user_canceled",
      });
    }
    await phLogger.flush().catch(() => undefined);
    cancellationCleanup.delete(ctx.run.id);
  },

  run: async (
    payload: SubagentTaskPayload,
    { ctx, signal: triggerSignal },
  ): Promise<SubagentTaskOutput> => {
    const startedAt = Date.now();
    // The parent Agent run may be using a branch-specific Convex deployment.
    // Trigger preview workers otherwise inherit the dashboard's main URL and
    // cannot see the reservation that the parent just created.
    if (payload.convexUrl) {
      setConvexUrl(payload.convexUrl);
    }
    const row = await getSubagent(payload.subagentId);
    if (!row) throw new Error("Subagent reservation not found");
    if (SUBAGENT_TERMINAL_STATUSES.has(row.status)) {
      return await reusePersistedTerminalState(row, ctx.run.id, "pre_attach");
    }
    const costLimitDollars = row.cost_limit_dollars;
    let profile!: ReturnType<typeof getSubagentProfileDefinition>;

    cancellationCleanup.set(ctx.run.id, {
      subagentId: row.subagent_id,
      userId: row.user_id,
      parentTriggerRunId: row.parent_trigger_run_id,
      profile: row.profile,
    });
    try {
      const attachOutcome = await attachSubagentTriggerRun(
        row.subagent_id,
        ctx.run.id,
      );
      if (attachOutcome === "terminal") {
        const terminalRow = await getSubagent(row.subagent_id);
        if (
          !terminalRow ||
          !SUBAGENT_TERMINAL_STATUSES.has(terminalRow.status)
        ) {
          throw new Error("Subagent became unavailable during attachment");
        }
        cancellationCleanup.delete(ctx.run.id);
        return await reusePersistedTerminalState(
          terminalRow,
          ctx.run.id,
          "attach_terminal",
        );
      }
      if (attachOutcome !== "updated") {
        throw new Error(`Subagent attachment failed: ${attachOutcome}`);
      }
      if (
        row.depth !== 1 ||
        (row.status !== "queued" && row.status !== "running") ||
        row.permission_mode !== "full_access"
      ) {
        throw new Error("Unsupported subagent profile or depth");
      }
      profile = getSubagentProfileDefinition(row.profile);
      await tags.add([
        `subagent_${row.subagent_id}`,
        `parent_${row.parent_trigger_run_id}`,
        `user_${row.user_id}`,
        `profile_${row.profile}`,
      ]);
      metadata
        .set("status", "running")
        .set("subagentId", row.subagent_id)
        .set("parentTriggerRunId", row.parent_trigger_run_id)
        .set("parentToolCallId", row.parent_tool_call_id)
        .set("profile", row.profile);
    } catch (error) {
      const setupError = extractErrorDetails(error);
      const finishOutcome = await finishSubagent({
        subagentId: row.subagent_id,
        triggerRunId: ctx.run.id,
        status: "failed",
        summary: "Subagent failed during setup.",
        failureCode: "setup_failed",
        failureReason:
          typeof setupError.errorMessage === "string"
            ? setupError.errorMessage
            : undefined,
      }).catch(() => null);
      if (finishOutcome === "updated") {
        captureSubagentTerminalOutcome({
          userId: row.user_id,
          subagentId: row.subagent_id,
          parentTriggerRunId: row.parent_trigger_run_id,
          profile: row.profile,
          status: "failed",
          durationMs: Date.now() - startedAt,
          errorCategory: "setup_failed",
          failureStage: "setup",
        });
      }
      cancellationCleanup.delete(ctx.run.id);
      metadata
        .set("status", "failed")
        .set("failureCode", "setup_failed")
        .set("failureStage", "setup");
      await phLogger.flush().catch(() => undefined);
      throw error;
    }

    const activeAbort = new AbortController();
    let activeTimedOut = false;
    let spendCapExceeded = false;
    let runtimeAuthorizationRevoked = false;
    const abortFromParent = () => activeAbort.abort();
    triggerSignal.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(() => {
      activeTimedOut = true;
      activeAbort.abort();
    }, SUBAGENT_MAX_ACTIVE_SECONDS * 1_000);

    const usageTracker = new UsageTracker();
    let resultValue: SubagentStructuredResult | undefined;
    let stepCount = 0;
    let responseModel: string | undefined;
    let runtimeFailure: unknown;
    let runtimeFailureCode: string | undefined;
    let runtimeFailureStage: string | undefined;
    let runtimeStage = "authorization";
    let deadlineReminderSent = false;
    let providerRetriesUsed = 0;
    let resultRecoveriesUsed = 0;
    let resultRecoveryGenerationAttempts = 0;
    let resultRecoveryRetriesUsed = 0;
    let resultSubmissionAttempts = 0;
    let generationAttempt = 0;
    let lastRecoveryErrorDiagnostics:
      SubagentRecoveryErrorDiagnostics | undefined;
    let deferredForParentUpdate = false;
    let extraUsageConfig:
      Awaited<ReturnType<typeof buildExtraUsageConfig>> | undefined;
    let rateLimitInfo: Awaited<ReturnType<typeof checkSubagentBillingCapacity>>;
    let usageSettled = false;
    let triggerRunCostRecorded = false;
    const selectedModel =
      row.selected_model ?? resolveSubagentTextModel(row.subscription);
    let activeModelName = selectedModel;
    metadata
      .set("selectedModel", selectedModel)
      .set("activeModel", activeModelName);

    const assertRuntimeAuthorized = async (): Promise<void> => {
      try {
        await assertSubagentRuntimeAuthorized({
          subagentId: row.subagent_id,
          childTriggerRunId: ctx.run.id,
          parentTriggerRunId: row.parent_trigger_run_id,
          loadChild: getSubagent,
          retrieveParent: async (parentTriggerRunId) =>
            await runs.retrieve(parentTriggerRunId),
        });
      } catch (error) {
        runtimeAuthorizationRevoked = true;
        activeAbort.abort();
        throw error;
      }
    };

    const settleUsage = async (): Promise<{
      costDollars: number;
      billingFailure: boolean;
    }> => {
      const triggerRunUsage = resolveTriggerRunCost(triggerUsage.getCurrent());
      if (!triggerRunCostRecorded && triggerRunUsage.totalCostDollars > 0) {
        usageTracker.providerCost += triggerRunUsage.totalCostDollars;
        usageTracker.nonModelCost += triggerRunUsage.totalCostDollars;
        triggerRunCostRecorded = true;
        metadata
          .set("triggerRunCostDollars", triggerRunUsage.totalCostDollars)
          .set("triggerUsageDurationMs", triggerRunUsage.durationMs);
      }
      const costDollars = usageTracker.computeCostDollars(
        selectedModel,
        responseModel,
      );
      if (usageSettled || (!usageTracker.hasUsage && costDollars === 0)) {
        return { costDollars, billingFailure: false };
      }
      if (row.subscription === "free") {
        await recordFreeMonthlyCost(
          row.free_quota_subject ?? row.user_id,
          costDollars,
        );
        usageSettled = true;
        return { costDollars, billingFailure: false };
      }
      if (!rateLimitInfo) {
        return { costDollars, billingFailure: true };
      }

      const deduction = await deductUsage(
        row.user_id,
        row.subscription,
        0,
        usageTracker.inputTokens,
        usageTracker.outputTokens,
        extraUsageConfig,
        costDollars,
        selectedModel,
        usageTracker.nonModelCost,
        row.organization_id,
        { pointsDeducted: 0, extraUsagePointsDeducted: 0 },
        responseModel ?? selectedModel,
        usageTracker.usageSettlementId,
      );
      usageSettled = true;
      usageTracker.log({
        userId: row.user_id,
        organizationId: row.organization_id,
        chatId: row.chat_id,
        assistantMessageId: row.subagent_id,
        endpoint: "/api/agent-long",
        mode: "agent",
        subscription: row.subscription,
        selectedModel,
        selectedModelOverride: selectedModel,
        responseModel,
        configuredModelId: selectedModel,
        accountingModel: responseModel ?? selectedModel,
        rateLimitInfo,
        billingBreakdown: deduction,
      });
      return {
        costDollars,
        billingFailure:
          deduction.uncoveredPoints > 0 || deduction.usageDeductionFailed,
      };
    };

    try {
      runtimeStage = "authorization";
      await assertRuntimeAuthorized();
      runtimeStage = "billing_setup";
      const customization = await getUserCustomization({ userId: row.user_id });
      extraUsageConfig = await buildExtraUsageConfig({
        userId: row.user_id,
        subscription: row.subscription,
        userCustomization: customization,
        organizationId: row.organization_id,
        failClosedOnLookupError: true,
      });
      rateLimitInfo = await checkSubagentBillingCapacity({
        userId: row.user_id,
        organizationId: row.organization_id,
        subscription: row.subscription,
        freeQuotaSubject: row.free_quota_subject,
        extraUsageConfig,
        modelName: selectedModel,
      });

      runtimeStage = "context_resolution";
      const resolvedContext = await resolveSubagentContext(row.subagent_id);
      const persistedMessages = row.continuation_count
        ? await getSubagentMessages({
            subagentId: row.subagent_id,
            userId: row.user_id,
          })
        : [];
      const systemPrompt = profile.buildSystemPrompt(row);
      const prompt = profile.buildPrompt(row, resolvedContext);
      await saveSubagentMessage({
        subagentId: row.subagent_id,
        userId: row.user_id,
        sequence: (row.continuation_count ?? 0) * 10_000,
        role: "user",
        parts: [{ type: "text", text: prompt }],
      });

      const uiStream = createUIMessageStream({
        onError: (error) => {
          if (error instanceof ChatSDKError) {
            return serializeChatSDKErrorForStream(error);
          }
          return getUserFriendlyProviderError(error);
        },
        execute: async ({ writer }) => {
          try {
            const acceptResult = async (input: unknown) => {
              runtimeStage = "result_validation";
              resultSubmissionAttempts += 1;
              const parsed = profile.finalResultTool.schema.parse(input);
              if (
                Buffer.byteLength(JSON.stringify(parsed), "utf8") >
                profile.finalResultTool.maxBytes
              ) {
                return {
                  accepted: false,
                  error: `Result exceeds ${profile.finalResultTool.maxBytes} bytes; shorten it and submit again.`,
                };
              }
              if (resultValue) {
                return {
                  accepted: false,
                  error: "A structured result was already accepted.",
                };
              }
              runtimeStage = "authorization";
              await assertRuntimeAuthorized();
              runtimeStage = "result_finalization";
              const finalizing = await markSubagentFinalizing(
                row.subagent_id,
                ctx.run.id,
              );
              if (finalizing === "pending_messages") {
                deferredForParentUpdate = true;
                return {
                  accepted: false,
                  error:
                    "A parent update arrived before completion. Read it, account for it, and then submit the final result again.",
                };
              }
              if (finalizing !== "updated") {
                return {
                  accepted: false,
                  error: "This subagent is no longer accepting results.",
                };
              }
              resultValue = parsed;
              return {
                accepted: true,
                ...(row.profile === "security_validation" && "verdict" in parsed
                  ? { verdict: parsed.verdict }
                  : "task_status" in parsed
                    ? { task_status: parsed.task_status }
                    : {}),
              };
            };
            const submitResult = tool({
              description: profile.finalResultTool.description,
              inputSchema: profile.finalResultTool.schema,
              execute: acceptResult,
            });
            const reportToParent = tool({
              description:
                "Report a bounded material progress update, question, blocker, artifact, or result signal to the parent. Do not use for routine narration.",
              inputSchema: reportToParentInputSchema,
              execute: async (input) => {
                const parsed = reportToParentInputSchema.parse(input);
                const recorded = await recordSubagentEvent({
                  subagentId: row.subagent_id,
                  triggerRunId: ctx.run.id,
                  eventType: parsed.event_type,
                  message: parsed.message,
                  refs: parsed.refs,
                });
                return { recorded };
              },
            });
            const updateWorkLedger = tool({
              description:
                "Replace this child's durable work-ledger entry with current status, dependencies, evidence refs, provenance-backed claims, assessed and unassessed scope, and artifacts.",
              inputSchema: updateWorkLedgerInputSchema,
              execute: async (input) => {
                const parsed = updateWorkLedgerInputSchema.parse(input);
                const updated = await updateSubagentWorkLedger({
                  subagentId: row.subagent_id,
                  triggerRunId: ctx.run.id,
                  status: parsed.status,
                  dependencies: parsed.dependencies,
                  refs: parsed.refs,
                  claims: parsed.claims,
                  assessedScope: parsed.assessed_scope,
                  unassessedScope: parsed.unassessed_scope,
                  artifacts: parsed.artifacts,
                });
                return { updated };
              },
            });
            const allowedToolNames = resolveSubagentAllowedToolNames(
              row.profile,
              row.capability_bundles,
            );
            const {
              tools: unguardedTools,
              ensureSandbox,
              setCurrentModelName,
            } = createTools(
              row.user_id,
              row.chat_id,
              writer,
              "agent",
              (row.user_location ?? {}) as Parameters<typeof createTools>[4],
              [],
              false,
              row.subagent_id,
              row.sandbox_preference,
              process.env.CONVEX_SERVICE_ROLE_KEY,
              undefined,
              (costDollars) => {
                usageTracker.providerCost += costDollars;
                usageTracker.nonModelCost += costDollars;
              },
              row.subscription,
              undefined,
              selectedModel,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              ctx.run.id,
              undefined,
              {
                allowedToolNames: [
                  ...allowedToolNames,
                  profile.finalResultTool.name,
                ],
                additionalTools: () => ({
                  search_skills: createSearchSkillsTool(),
                  load_skill: createLoadSkillTool(),
                  report_to_parent: reportToParent,
                  update_work_ledger: updateWorkLedger,
                  [profile.finalResultTool.name]: submitResult,
                }),
                ptyScopeId: row.subagent_id,
                chargeSandboxRuntime: false,
                triggerRegion: payload.triggerRegion,
              },
            );
            const tools = guardSubagentToolExecutions(
              unguardedTools,
              assertRuntimeAuthorized,
              {
                canWriteFiles:
                  row.profile !== "general" ||
                  (row.capability_bundles ?? []).includes("code_write"),
                browserCommandsOnly:
                  row.profile === "general" &&
                  (row.capability_bundles ?? []).includes("browser_qa") &&
                  !(row.capability_bundles ?? []).some((capability) =>
                    ["terminal", "code_write"].includes(capability),
                  ),
              },
            );
            runtimeStage = "sandbox_acquisition";
            await assertRuntimeAuthorized();
            const sandbox = await ensureSandbox();
            runtimeStage = "sandbox_identity_validation";
            assertSubagentSandboxIdentity(sandbox, row.sandbox_identity);

            const provider = createTrackedProvider();
            const getGuardedLanguageModel = (
              modelName: string,
              generationAttempt: number,
              stepIndex: number,
            ): LanguageModel => {
              const languageModel = provider.languageModel(modelName);
              return namespaceLanguageModelToolCalls(
                guardLanguageModelProviderResponse(languageModel, {
                  maxToolCalls: MAX_PROVIDER_TOOL_CALLS_PER_RESPONSE,
                  perToolCallLimits: {
                    [profile.finalResultTool.name]: 1,
                  },
                  onToolCallsDropped: ({
                    droppedToolCallCount,
                    maxToolCalls,
                  }) => {
                    triggerLogger.warn(
                      "[subagent] provider tool calls bounded",
                      {
                        event: "provider_tool_call_guard_applied",
                        service: "hackerai-subagent",
                        subagent_id: row.subagent_id,
                        parent_trigger_run_id: row.parent_trigger_run_id,
                        trigger_run_id: ctx.run.id,
                        model: modelName,
                        generation_attempt: generationAttempt,
                        step: stepIndex + 1,
                        dropped_tool_call_count: droppedToolCallCount,
                        max_tool_calls: maxToolCalls,
                      },
                    );
                  },
                }),
                `sa${row.subagent_id}a${generationAttempt}s${stepIndex}`,
              );
            };
            const resumedConversation = row.continuation_count
              ? await convertToModelMessages(
                  persistedMessages.flatMap((message) =>
                    message.role === "system"
                      ? []
                      : [
                          {
                            id: String(message._id),
                            role: message.role,
                            parts: message.parts as UIMessage["parts"],
                          },
                        ],
                  ) as UIMessage[],
                  { tools, ignoreIncompleteToolCalls: true },
                ).catch((error) => {
                  triggerLogger.warn("[subagent] resumed transcript dropped", {
                    event: "subagent_resumed_transcript_conversion_failed",
                    service: "hackerai-subagent",
                    environment:
                      process.env.TRIGGER_ENV ??
                      process.env.NODE_ENV ??
                      "unknown",
                    subagent_id: row.subagent_id,
                    trigger_run_id: ctx.run.id,
                    parent_trigger_run_id: row.parent_trigger_run_id,
                    user_id: row.user_id,
                    persisted_message_count: persistedMessages.length,
                    error_name:
                      error instanceof Error ? error.name : "UnknownError",
                  });
                  return [];
                })
              : [];
            const conversationMessages: ModelMessage[] = [
              ...resumedConversation,
              { role: "user", content: prompt },
            ];
            const parentUpdates = new Map<string, ModelMessage>();
            const beginStructuredResultRecovery = async (
              reason: "missing_result" | "reserved_step_budget",
            ): Promise<boolean> => {
              const remainingSteps = SUBAGENT_MAX_STEPS - stepCount;
              const canRecover = canRecoverMissingSubagentResult(
                resultRecoveriesUsed,
                {
                  aborted: activeAbort.signal.aborted,
                  spendCapExceeded,
                  hasStepsRemaining: remainingSteps > 0,
                },
              );
              if (!canRecover) return false;

              resultRecoveriesUsed += 1;
              conversationMessages.push({
                role: "user",
                content: buildMissingSubagentResultRecoveryMessage(
                  profile.finalResultTool.name,
                ),
              });
              await recordSubagentRecovery({
                subagentId: row.subagent_id,
                triggerRunId: ctx.run.id,
                kind: "result_recovery",
              }).catch(() => false);
              metadata.set("resultRecoveryCount", resultRecoveriesUsed);
              triggerLogger.warn(
                "[subagent] structured result recovery started",
                {
                  event: "subagent_structured_result_recovery_started",
                  service: "hackerai-subagent",
                  environment:
                    process.env.TRIGGER_ENV ??
                    process.env.NODE_ENV ??
                    "unknown",
                  user_id: row.user_id,
                  subagent_id: row.subagent_id,
                  parent_trigger_run_id: row.parent_trigger_run_id,
                  trigger_run_id: ctx.run.id,
                  recovery_reason: reason,
                  result_recovery_count: resultRecoveriesUsed,
                  step_count: stepCount,
                  remaining_step_count: remainingSteps,
                },
              );
              return true;
            };

            while (
              !resultValue &&
              stepCount < SUBAGENT_MAX_STEPS &&
              !activeAbort.signal.aborted
            ) {
              runtimeStage = "generation";
              let remainingSteps = SUBAGENT_MAX_STEPS - stepCount;
              if (
                shouldStartSubagentResultRecovery(resultRecoveriesUsed, {
                  aborted: activeAbort.signal.aborted,
                  spendCapExceeded,
                  remainingSteps,
                })
              ) {
                await beginStructuredResultRecovery("reserved_step_budget");
                remainingSteps = SUBAGENT_MAX_STEPS - stepCount;
              }
              const structuredResultRecovery = resultRecoveriesUsed > 0;
              if (structuredResultRecovery) {
                if (
                  !canStartSubagentResultRecoveryGeneration(
                    resultRecoveryGenerationAttempts,
                  )
                ) {
                  triggerLogger.error(
                    "[subagent] structured result generation budget exhausted",
                    {
                      event:
                        "subagent_structured_result_generation_budget_exhausted",
                      service: "hackerai-subagent",
                      environment:
                        process.env.TRIGGER_ENV ??
                        process.env.NODE_ENV ??
                        "unknown",
                      subagent_id: row.subagent_id,
                      parent_trigger_run_id: row.parent_trigger_run_id,
                      trigger_run_id: ctx.run.id,
                      result_recovery_generation_count:
                        resultRecoveryGenerationAttempts,
                      result_recovery_retry_count: resultRecoveryRetriesUsed,
                      result_submission_count: resultSubmissionAttempts,
                      deferred_for_parent_update: deferredForParentUpdate,
                      step_count: stepCount,
                    },
                  );
                  break;
                }
                resultRecoveryGenerationAttempts += 1;
                metadata.set(
                  "resultRecoveryGenerationCount",
                  resultRecoveryGenerationAttempts,
                );
              }
              const attemptStepLimit = structuredResultRecovery
                ? remainingSteps
                : getSubagentExplorationStepLimit(remainingSteps);
              generationAttempt += 1;
              let attemptError: unknown;
              let attemptResponseModel: string | undefined;
              let attemptUiMessages: UIMessage[] = [];
              const generation = streamText({
                model: getGuardedLanguageModel(
                  activeModelName,
                  generationAttempt,
                  0,
                ),
                system: systemPrompt,
                messages: conversationMessages,
                tools: structuredResultRecovery ? undefined : tools,
                output: structuredResultRecovery
                  ? Output.object({
                      schema: profile.finalResultTool.schema,
                      description: profile.finalResultTool.description,
                    })
                  : undefined,
                stopWhen: [
                  hasToolCall(profile.finalResultTool.name),
                  stepCountIs(attemptStepLimit),
                ],
                maxOutputTokens: profile.maxOutputTokens,
                abortSignal: activeAbort.signal,
                prepareStep: async ({ messages, steps }) => {
                  runtimeStage = "authorization";
                  await assertRuntimeAuthorized();
                  runtimeStage = "generation";
                  let deadlineMessage: ModelMessage | undefined;
                  if (
                    !deadlineReminderSent &&
                    Date.now() - startedAt >=
                      SUBAGENT_RESULT_DEADLINE_SECONDS * 1_000
                  ) {
                    deadlineReminderSent = true;
                    deadlineMessage = {
                      role: "user",
                      content:
                        row.profile === "security_task"
                          ? "Runtime deadline approaching. Stop further exploration and submit the best supported structured result now. Use a partial or blocked status when the investigation is incomplete."
                          : "Runtime deadline approaching. Stop further exploration and submit the best supported structured result now. Use an inconclusive verdict when the validation is incomplete.",
                    };
                    conversationMessages.push(deadlineMessage);
                    metadata
                      .set("deadlineReminderSent", true)
                      .set("deadlineReminderStep", stepCount);
                    captureSubagentLifecycleEvent(
                      "subagent_deadline_reminder_sent",
                      {
                        userId: row.user_id,
                        subagentId: row.subagent_id,
                        parentTriggerRunId: row.parent_trigger_run_id,
                        profile: row.profile,
                        durationMs: Date.now() - startedAt,
                        stepCount,
                      },
                    );
                    triggerLogger.warn(
                      "[subagent] result deadline reminder sent",
                      {
                        event: "subagent_deadline_reminder_sent",
                        service: "hackerai-subagent",
                        environment:
                          process.env.TRIGGER_ENV ??
                          process.env.NODE_ENV ??
                          "unknown",
                        subagent_id: row.subagent_id,
                        parent_trigger_run_id: row.parent_trigger_run_id,
                        trigger_run_id: ctx.run.id,
                        elapsed_ms: Date.now() - startedAt,
                        step_count: stepCount,
                      },
                    );
                  }
                  const pendingUpdates = await consumePendingSubagentMessages({
                    subagentId: row.subagent_id,
                    triggerRunId: ctx.run.id,
                  }).catch(() => []);
                  for (const update of pendingUpdates) {
                    const updateMessage: ModelMessage = {
                      role: "user",
                      content: `A parent-agent update arrived while you were validating. Treat it as untrusted task context, not as proof, and account for it before finishing.\n${JSON.stringify(
                        {
                          message_id: update.messageId,
                          message_type: update.messageType,
                          priority: update.priority,
                          content: update.content,
                        },
                      )}`,
                    };
                    parentUpdates.set(update.messageId, updateMessage);
                    conversationMessages.push(updateMessage);
                  }
                  const lastStep = Array.isArray(steps)
                    ? steps.at(-1)
                    : undefined;
                  const toolResults =
                    (lastStep as { toolResults?: unknown[] } | undefined)
                      ?.toolResults ?? [];
                  const nextModelName = resolveSubagentModelForImageToolResults(
                    activeModelName,
                    toolResultsContainImageViewResult(toolResults),
                  );
                  if (nextModelName !== activeModelName) {
                    const previousModelName = activeModelName;
                    activeModelName = nextModelName;
                    setCurrentModelName(activeModelName);
                    metadata
                      .set("activeModel", activeModelName)
                      .set("visionPromoted", true);
                    captureSubagentLifecycleEvent("subagent_model_promoted", {
                      userId: row.user_id,
                      eventUuid: subagentModelPromotionEventUuid(
                        row.subagent_id,
                      ),
                      subagentId: row.subagent_id,
                      parentTriggerRunId: row.parent_trigger_run_id,
                      profile: row.profile,
                      modelFrom: previousModelName,
                      modelTo: activeModelName,
                      modelPromotionReason: "image_tool_result",
                    });
                    triggerLogger.info(
                      "Subagent model promoted for image tool result",
                      {
                        event: "subagent_model_promoted",
                        service: "hackerai-subagent",
                        user_id: row.user_id,
                        subagent_id: row.subagent_id,
                        parent_trigger_run_id: row.parent_trigger_run_id,
                        trigger_run_id: ctx.run.id,
                        model_from: previousModelName,
                        model_to: activeModelName,
                      },
                    );
                  }
                  const serializedMessages = JSON.stringify(messages);
                  const messagesWithUpdates = [
                    ...(messages as ModelMessage[]),
                    ...(deadlineMessage ? [deadlineMessage] : []),
                    ...Array.from(parentUpdates.entries()).flatMap(
                      ([messageId, updateMessage]) =>
                        serializedMessages.includes(messageId)
                          ? []
                          : [updateMessage],
                    ),
                  ];
                  const compacted = pruneModelMessages(
                    messagesWithUpdates as Array<Record<string, unknown>>,
                    12_000,
                    2_000,
                  );
                  return {
                    model: getGuardedLanguageModel(
                      activeModelName,
                      generationAttempt,
                      steps.length,
                    ),
                    messages: compacted.messages as ModelMessage[],
                  };
                },
                onError: ({ error }) => {
                  attemptError = error;
                },
                onStepFinish: async ({ usage, response, providerMetadata }) => {
                  stepCount += 1;
                  attemptResponseModel = response?.modelId ?? activeModelName;
                  responseModel = attemptResponseModel;
                  const index = usage
                    ? usageTracker.accumulateStep(
                        usage,
                        response?.modelId ?? activeModelName,
                      )
                    : undefined;
                  const openRouter = extractOpenRouterMetadata({
                    response,
                    providerMetadata,
                  });
                  usageTracker.setAuthoritativeModelCostForStep(
                    index,
                    openRouter.openrouter_upstream_inference_cost,
                  );
                  if (
                    usageTracker.computeCostDollars(
                      selectedModel,
                      responseModel,
                    ) +
                      resolveTriggerRunCost(triggerUsage.getCurrent())
                        .totalCostDollars >=
                    costLimitDollars
                  ) {
                    spendCapExceeded = true;
                    activeAbort.abort();
                  }
                },
              });

              if (structuredResultRecovery) {
                try {
                  await generation.consumeStream();
                  const recoveredResult = await generation.output;
                  if (recoveredResult) {
                    await acceptResult(recoveredResult);
                  }
                } catch (error) {
                  attemptError ??= error;
                }
              } else {
                const attemptStream = generation.toUIMessageStream({
                  generateMessageId: () =>
                    `${row.subagent_id}-attempt-${generationAttempt}`,
                  sendReasoning: true,
                  onFinish: async ({ messages }) => {
                    attemptUiMessages = messages;
                    await persistAssistantMessages(
                      row.subagent_id,
                      row.user_id,
                      messages,
                      (row.continuation_count ?? 0) * 10_000 +
                        generationAttempt * 100,
                    );
                  },
                });
                try {
                  await pipeSubagentUiMessageStream(attemptStream, (chunk) =>
                    writer.write(chunk),
                  );
                } catch (error) {
                  attemptError ??= error;
                }
              }

              try {
                const response = await generation.response;
                conversationMessages.push(
                  ...(response.messages as ModelMessage[]),
                );
              } catch (error) {
                attemptError ??= error;
                const partialMessages = await convertToModelMessages(
                  attemptUiMessages,
                  {
                    tools,
                    ignoreIncompleteToolCalls: true,
                  },
                ).catch(() => []);
                conversationMessages.push(...partialMessages);
              }

              if (resultValue) break;
              if (attemptError) {
                if (structuredResultRecovery) {
                  const recoveryRetry = getSubagentResultRecoveryRetryDecision(
                    attemptError,
                    resultRecoveryRetriesUsed,
                    {
                      aborted: activeAbort.signal.aborted,
                      spendCapExceeded,
                      hasStepsRemaining: stepCount < SUBAGENT_MAX_STEPS,
                    },
                  );
                  lastRecoveryErrorDiagnostics = recoveryRetry;
                  metadata.set(
                    "resultRecoveryErrorCategory",
                    recoveryRetry.category,
                  );
                  if (recoveryRetry.errorName) {
                    metadata.set(
                      "resultRecoveryErrorName",
                      recoveryRetry.errorName,
                    );
                  }
                  if (recoveryRetry.errorCode) {
                    metadata.set(
                      "resultRecoveryErrorCode",
                      recoveryRetry.errorCode,
                    );
                  }
                  if (recoveryRetry.statusCode) {
                    metadata.set(
                      "resultRecoveryStatusCode",
                      recoveryRetry.statusCode,
                    );
                  }
                  if (recoveryRetry.shouldRetry) {
                    resultRecoveryRetriesUsed += 1;
                    metadata.set(
                      "resultRecoveryRetryCount",
                      resultRecoveryRetriesUsed,
                    );
                    triggerLogger.warn(
                      "[subagent] retrying structured result recovery",
                      {
                        event: "subagent_result_recovery_retried",
                        service: "hackerai-subagent",
                        environment:
                          process.env.TRIGGER_ENV ??
                          process.env.NODE_ENV ??
                          "unknown",
                        subagent_id: row.subagent_id,
                        parent_trigger_run_id: row.parent_trigger_run_id,
                        trigger_run_id: ctx.run.id,
                        attempt: resultRecoveryRetriesUsed,
                        error_category: recoveryRetry.category,
                        error_name: recoveryRetry.errorName,
                        error_code: recoveryRetry.errorCode,
                        status_code: recoveryRetry.statusCode,
                        delay_ms: recoveryRetry.delayMs,
                      },
                    );
                    await waitForRetryDelay(
                      recoveryRetry.delayMs,
                      activeAbort.signal,
                    );
                    continue;
                  }
                  runtimeFailure = attemptError;
                  runtimeFailureStage = runtimeStage;
                  runtimeFailureCode = "structured_result_recovery_exhausted";
                  break;
                }
                const retry = getSubagentProviderRetryDecision(
                  attemptError,
                  providerRetriesUsed,
                  {
                    aborted: activeAbort.signal.aborted,
                    spendCapExceeded,
                    hasStepsRemaining: stepCount < SUBAGENT_MAX_STEPS,
                  },
                );
                if (retry.shouldRetry) {
                  const previousModelName = activeModelName;
                  if (retry.category === "content_blocked") {
                    activeModelName = getContentFilterRetryModel(
                      activeModelName as ModelName,
                      "agent",
                      attemptResponseModel,
                    );
                    setCurrentModelName(activeModelName);
                    metadata
                      .set("activeModel", activeModelName)
                      .set("contentFilterRetryModel", activeModelName);
                  }
                  providerRetriesUsed += 1;
                  await recordSubagentRecovery({
                    subagentId: row.subagent_id,
                    triggerRunId: ctx.run.id,
                    kind: "provider_retry",
                  }).catch(() => false);
                  metadata.set("providerRetryCount", providerRetriesUsed);
                  triggerLogger.warn(
                    "[subagent] retrying recoverable provider failure",
                    {
                      subagentId: row.subagent_id,
                      parentTriggerRunId: row.parent_trigger_run_id,
                      triggerRunId: ctx.run.id,
                      attempt: providerRetriesUsed,
                      errorCategory: retry.category,
                      modelFrom: previousModelName,
                      modelTo: activeModelName,
                      delayMs: retry.delayMs,
                    },
                  );
                  await waitForRetryDelay(retry.delayMs, activeAbort.signal);
                  continue;
                }
                runtimeFailure = attemptError;
                runtimeFailureStage = runtimeStage;
                runtimeFailureCode =
                  retry.category === "content_blocked"
                    ? "content_filter_retry_exhausted"
                    : isTransientProviderCategory(retry.category)
                      ? "provider_retry_exhausted"
                      : retry.category === "unknown"
                        ? "runtime_error"
                        : "provider_error";
                break;
              }

              if (deferredForParentUpdate) {
                deferredForParentUpdate = false;
                continue;
              }

              if (!(await beginStructuredResultRecovery("missing_result"))) {
                break;
              }
            }
          } catch (error) {
            runtimeFailure = error;
            runtimeFailureStage = runtimeStage;
            runtimeFailureCode ??=
              runtimeStage === "sandbox_acquisition"
                ? "sandbox_acquisition_failed"
                : runtimeStage === "sandbox_identity_validation"
                  ? "sandbox_identity_changed"
                  : "runtime_error";
            throw error;
          }
        },
      });

      const { waitUntilComplete } = agentUiStream.pipe(
        sanitizeStream(uiStream),
      );
      await waitUntilComplete();
      runtimeStage = "result_finalization";
      await markSubagentFinalizing(row.subagent_id, ctx.run.id);

      runtimeStage = "usage_settlement";
      const { costDollars, billingFailure } = await settleUsage();

      const terminalFailure = activeTimedOut
        ? {
            status: "timed_out" as const,
            code: "active_time_limit",
            summary: "Subagent reached its 15-minute active limit.",
          }
        : triggerSignal.aborted || runtimeAuthorizationRevoked
          ? {
              status: "canceled" as const,
              code: "parent_or_user_canceled",
              summary: "Subagent was canceled.",
            }
          : spendCapExceeded
            ? {
                status: "failed" as const,
                code: "spend_cap",
                summary: `Subagent reached its $${costLimitDollars.toFixed(2)} spend limit.`,
              }
            : billingFailure
              ? {
                  status: "failed" as const,
                  code: "billing_limit",
                  summary:
                    "Subagent could not settle within the available usage budget.",
                }
              : runtimeFailure
                ? {
                    status: "failed" as const,
                    code: runtimeFailureCode ?? "runtime_error",
                    summary:
                      runtimeFailureCode === "provider_retry_exhausted"
                        ? "Subagent could not recover from a temporary model provider error."
                        : runtimeFailureCode ===
                            "structured_result_recovery_exhausted"
                          ? "Subagent could not produce a structured result after retrying result recovery."
                          : runtimeFailureCode ===
                              "content_filter_retry_exhausted"
                            ? "Subagent could not complete because the available model providers blocked the validation content."
                            : runtimeFailureCode === "provider_error"
                              ? "Subagent stopped because the model provider rejected the request."
                              : "Subagent failed before returning a result.",
                  }
                : !resultValue
                  ? {
                      status: "failed" as const,
                      code: "structured_result_missing",
                      summary: "Subagent ended without a structured result.",
                    }
                  : null;
      const runtimeDiagnostics = runtimeFailure
        ? (lastRecoveryErrorDiagnostics ??
          getSubagentRecoveryErrorDiagnostics(runtimeFailure))
        : undefined;
      const terminalFailureStage = activeTimedOut
        ? "generation"
        : runtimeAuthorizationRevoked
          ? "authorization"
          : (runtimeFailureStage ?? runtimeStage);

      if (terminalFailure) {
        const finishOutcome = await finishSubagent({
          subagentId: row.subagent_id,
          triggerRunId: ctx.run.id,
          status: terminalFailure.status,
          summary: terminalFailure.summary,
          failureCode: terminalFailure.code,
          ...(terminalFailure.status === "canceled"
            ? { cancelReason: terminalFailure.code }
            : {}),
          costDollars,
          stepCount,
        });
        if (finishOutcome !== "updated") {
          const persistedOutput = await loadPersistedTerminalOutput(
            row.subagent_id,
          );
          if (persistedOutput) {
            metadata.set("status", persistedOutput.status);
            return persistedOutput;
          }
          throw new Error(`Subagent finalization failed: ${finishOutcome}`);
        }
        captureSubagentTerminalOutcome({
          userId: row.user_id,
          subagentId: row.subagent_id,
          parentTriggerRunId: row.parent_trigger_run_id,
          profile: row.profile,
          status: terminalFailure.status,
          durationMs: Date.now() - startedAt,
          stepCount,
          costDollars,
          errorCategory: terminalFailure.code,
          runtimeErrorCategory:
            runtimeDiagnostics?.category === "unknown"
              ? undefined
              : runtimeDiagnostics?.category,
          failureStage: terminalFailureStage,
          resultRecoveryCount: resultRecoveriesUsed,
          resultSubmissionCount: resultSubmissionAttempts,
        });
        if (runtimeDiagnostics) {
          triggerLogger.error("[subagent] bounded recovery exhausted", {
            event: "subagent_recovery_exhausted",
            service: "hackerai-subagent",
            environment:
              process.env.TRIGGER_ENV ?? process.env.NODE_ENV ?? "unknown",
            subagent_id: row.subagent_id,
            parent_trigger_run_id: row.parent_trigger_run_id,
            trigger_run_id: ctx.run.id,
            failure_code: terminalFailure.code,
            failure_stage: terminalFailureStage,
            error_category: runtimeDiagnostics.category,
            error_name: runtimeDiagnostics.errorName,
            error_code: runtimeDiagnostics.errorCode,
            status_code: runtimeDiagnostics.statusCode,
            provider_retry_count: providerRetriesUsed,
            result_recovery_count: resultRecoveriesUsed,
            result_recovery_generation_count: resultRecoveryGenerationAttempts,
            result_recovery_retry_count: resultRecoveryRetriesUsed,
            result_submission_count: resultSubmissionAttempts,
          });
        }
        if (terminalFailure.code === "structured_result_missing") {
          triggerLogger.error("[subagent] structured result missing", {
            event: "subagent_structured_result_missing",
            service: "hackerai-subagent",
            environment:
              process.env.TRIGGER_ENV ?? process.env.NODE_ENV ?? "unknown",
            user_id: row.user_id,
            subagent_id: row.subagent_id,
            parent_trigger_run_id: row.parent_trigger_run_id,
            trigger_run_id: ctx.run.id,
            model: activeModelName,
            step_count: stepCount,
            generation_attempt_count: generationAttempt,
            result_recovery_count: resultRecoveriesUsed,
            result_recovery_generation_count: resultRecoveryGenerationAttempts,
            result_recovery_retry_count: resultRecoveryRetriesUsed,
            result_submission_count: resultSubmissionAttempts,
            deadline_reminder_sent: deadlineReminderSent,
          });
        }
        metadata
          .set("status", terminalFailure.status)
          .set("failureCode", terminalFailure.code)
          .set("failureStage", terminalFailureStage);
        if (runtimeDiagnostics?.category) {
          metadata.set("runtimeErrorCategory", runtimeDiagnostics.category);
        }
        return { subagentId: row.subagent_id, status: terminalFailure.status };
      }

      const completedResult = resultValue as SubagentStructuredResult;
      runtimeStage = "persistence";
      const finishOutcome = await finishSubagent({
        subagentId: row.subagent_id,
        triggerRunId: ctx.run.id,
        status: "completed",
        summary: completedResult.summary,
        ...(row.profile === "security_validation" &&
        "verdict" in completedResult
          ? {
              verdict: completedResult.verdict,
              confidence: completedResult.confidence,
            }
          : {}),
        structuredResult: completedResult,
        costDollars,
        stepCount,
      });
      if (finishOutcome !== "updated") {
        const persistedOutput = await loadPersistedTerminalOutput(
          row.subagent_id,
        );
        if (persistedOutput) {
          metadata
            .set("status", persistedOutput.status)
            .set("stepCount", stepCount)
            .set("costDollars", costDollars);
          return persistedOutput;
        }
        throw new Error(`Subagent finalization failed: ${finishOutcome}`);
      }
      metadata
        .set("status", "completed")
        .set("stepCount", stepCount)
        .set("costDollars", costDollars);
      captureCompletion(
        row,
        completedResult,
        costDollars,
        stepCount,
        Date.now() - startedAt,
        resultRecoveriesUsed,
        resultSubmissionAttempts,
      );
      return { subagentId: row.subagent_id, status: "completed" };
    } catch (error) {
      const handledRateLimitError = isHandledUserRateLimitError(error)
        ? error
        : null;
      const rateLimitCapReason =
        typeof handledRateLimitError?.metadata?.capReason === "string"
          ? handledRateLimitError.metadata.capReason
          : undefined;
      const handledRateLimitFailureReason = handledRateLimitError
        ? typeof handledRateLimitError.cause === "string"
          ? handledRateLimitError.cause
          : handledRateLimitError.message
        : undefined;
      const outerRuntimeDiagnostics =
        getSubagentRecoveryErrorDiagnostics(error);
      const terminalFailure = activeTimedOut
        ? {
            status: "timed_out" as const,
            code: "active_time_limit",
            summary: "Subagent reached its 15-minute active limit.",
          }
        : triggerSignal.aborted || runtimeAuthorizationRevoked
          ? {
              status: "canceled" as const,
              code: "parent_or_user_canceled",
              summary: "Subagent was canceled.",
            }
          : spendCapExceeded
            ? {
                status: "failed" as const,
                code: "spend_cap",
                summary: `Subagent reached its $${costLimitDollars.toFixed(2)} spend limit.`,
              }
            : handledRateLimitError
              ? {
                  status: "failed" as const,
                  code: "rate_limit",
                  summary:
                    "Subagent could not start because the current usage limit was reached.",
                }
              : {
                  status: "failed" as const,
                  code: "runtime_error",
                  summary:
                    "Subagent failed before producing a structured result.",
                };
      const fallbackCostDollars =
        usageTracker.computeCostDollars(selectedModel, responseModel) +
        (triggerRunCostRecorded
          ? 0
          : resolveTriggerRunCost(triggerUsage.getCurrent()).totalCostDollars);
      const settlement = await settleUsage().catch(() => ({
        costDollars: fallbackCostDollars,
        billingFailure: true,
      }));
      const captureTerminalOutcome = () => {
        captureSubagentTerminalOutcome({
          userId: row.user_id,
          subagentId: row.subagent_id,
          parentTriggerRunId: row.parent_trigger_run_id,
          profile: row.profile,
          status: terminalFailure.status,
          durationMs: Date.now() - startedAt,
          stepCount,
          costDollars: settlement.costDollars,
          errorCategory: terminalFailure.code,
          runtimeErrorCategory:
            outerRuntimeDiagnostics.category === "unknown"
              ? undefined
              : outerRuntimeDiagnostics.category,
          failureStage: runtimeStage,
          resultRecoveryCount: resultRecoveriesUsed,
          resultSubmissionCount: resultSubmissionAttempts,
        });
      };
      if (handledRateLimitError) {
        const finalization = await finalizeHandledSubagentRateLimit(
          {
            subagentId: row.subagent_id,
            triggerRunId: ctx.run.id,
            status: "failed",
            summary: terminalFailure.summary,
            failureCode: terminalFailure.code,
            ...(handledRateLimitFailureReason && {
              failureReason: handledRateLimitFailureReason,
            }),
            costDollars: settlement.costDollars,
            stepCount,
          },
          {
            environment:
              process.env.TRIGGER_ENV ?? process.env.NODE_ENV ?? "unknown",
            userId: row.user_id,
            subagentId: row.subagent_id,
            parentTriggerRunId: row.parent_trigger_run_id,
            triggerRunId: ctx.run.id,
          },
          {
            finishSubagent,
            loadPersistedTerminalOutput,
            captureTerminalOutcome,
            logError: (message, fields) => triggerLogger.error(message, fields),
            recordFinalizationFailureMetadata: () => {
              metadata
                .set("status", "failed")
                .set("failureCode", "rate_limit_finalization_failed")
                .set("failureStage", "finalization");
            },
          },
        );
        if (!finalization.updated) {
          metadata.set("status", finalization.output.status);
          return finalization.output;
        }
        await tags.add("rate_limited").catch(() => undefined);
        triggerLogger.info("[subagent] run rate limited", {
          event: "subagent_run_rate_limited",
          service: "hackerai-subagent",
          environment:
            process.env.TRIGGER_ENV ?? process.env.NODE_ENV ?? "unknown",
          user_id: row.user_id,
          subagent_id: row.subagent_id,
          parent_trigger_run_id: row.parent_trigger_run_id,
          trigger_run_id: ctx.run.id,
          failure_code: terminalFailure.code,
          failure_stage: runtimeStage,
          ...(rateLimitCapReason && { cap_reason: rateLimitCapReason }),
        });
        metadata
          .set("status", "rate_limited")
          .set("failureCode", terminalFailure.code)
          .set("failureStage", runtimeStage)
          .set("blockedCategory", "rate_limit")
          .set("blockedCode", "rate_limit:chat")
          .set("blockedAt", new Date().toISOString());
        if (rateLimitCapReason) {
          metadata.set("capReason", rateLimitCapReason);
        }
        return finalization.output;
      }
      const finishOutcome = await finishSubagent({
        subagentId: row.subagent_id,
        triggerRunId: ctx.run.id,
        status: terminalFailure.status,
        summary: terminalFailure.summary,
        failureCode: terminalFailure.code,
        ...(terminalFailure.status === "canceled"
          ? { cancelReason: terminalFailure.code }
          : {}),
        costDollars: settlement.costDollars,
        stepCount,
      }).catch(() => null);
      if (finishOutcome === "updated") {
        captureTerminalOutcome();
      } else {
        const persistedOutput = await loadPersistedTerminalOutput(
          row.subagent_id,
        ).catch(() => null);
        if (persistedOutput) {
          metadata.set("status", persistedOutput.status);
          return persistedOutput;
        }
      }
      triggerLogger.error("[subagent] run failed", {
        event: "subagent_run_failed",
        service: "hackerai-subagent",
        environment:
          process.env.TRIGGER_ENV ?? process.env.NODE_ENV ?? "unknown",
        subagent_id: row.subagent_id,
        parent_trigger_run_id: row.parent_trigger_run_id,
        trigger_run_id: ctx.run.id,
        failure_code: terminalFailure.code,
        failure_stage: runtimeStage,
        error_category: outerRuntimeDiagnostics.category,
        error_name: outerRuntimeDiagnostics.errorName,
        error_code: outerRuntimeDiagnostics.errorCode,
        status_code: outerRuntimeDiagnostics.statusCode,
        result_recovery_count: resultRecoveriesUsed,
        result_recovery_generation_count: resultRecoveryGenerationAttempts,
        result_recovery_retry_count: resultRecoveryRetriesUsed,
        result_submission_count: resultSubmissionAttempts,
      });
      metadata
        .set("status", terminalFailure.status)
        .set("failureCode", terminalFailure.code)
        .set("failureStage", runtimeStage)
        .set("runtimeErrorCategory", outerRuntimeDiagnostics.category);
      throw error;
    } finally {
      clearTimeout(timeout);
      triggerSignal.removeEventListener("abort", abortFromParent);
      cancellationCleanup.delete(ctx.run.id);
      await ptySessionManager.closeAll(row.subagent_id).catch(() => undefined);
      await phLogger.flush().catch(() => undefined);
    }
  },
});
