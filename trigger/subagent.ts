import {
  logger as triggerLogger,
  metadata,
  tags,
  task,
} from "@trigger.dev/sdk";
import {
  createUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { agentUiStream } from "./streams";
import { createTools } from "@/lib/ai/tools";
import { createTrackedProvider } from "@/lib/ai/providers";
import {
  SUBAGENT_MAX_ACTIVE_SECONDS,
  SUBAGENT_MAX_DURATION_SECONDS,
  SUBAGENT_MAX_STEPS,
  type SecurityValidationResult,
} from "@/lib/ai/subagents/contracts";
import { getSubagentProfileDefinition } from "@/lib/ai/subagents/profiles";
import { assertSubagentSandboxIdentity } from "@/lib/ai/subagents/sandbox-identity";
import {
  attachSubagentTriggerRun,
  finishSubagent,
  getSubagent,
  markSubagentFinalizing,
  resolveSubagentContext,
  saveSubagentMessage,
} from "@/lib/db/subagents";
import { sanitizeForConvexValue } from "@/lib/db/convex-value-sanitizer";
import {
  compactMessageForStorage,
  pruneModelMessages,
} from "@/lib/chat/compaction/prune-tool-outputs";
import { sanitizeAgentLongRealtimeChunk } from "@/lib/chat/agent-long-realtime-sanitizer";
import { UsageTracker } from "@/lib/usage-tracker";
import {
  checkFreeMonthlyCostLimit,
  checkRateLimitCapacity,
  deductUsage,
  recordFreeMonthlyCost,
} from "@/lib/rate-limit";
import { buildExtraUsageConfig } from "@/lib/api/chat-stream-helpers";
import { getUserCustomization } from "@/lib/db/actions";
import { extractOpenRouterMetadata } from "@/lib/api/openrouter-metadata";
import { captureSubagentLifecycleEvent } from "@/lib/analytics/subagents";
import { phLogger } from "@/lib/posthog/server";
import { ptySessionManager } from "@/lib/ai/tools/utils/pty-session-manager";

type SubagentTaskOutput = {
  subagentId: string;
  status: "completed" | "failed" | "canceled" | "timed_out";
};

type CancellationCleanup = {
  subagentId: string;
  userId: string;
  parentTriggerRunId: string;
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
): Promise<void> => {
  let sequence = 1;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
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

const captureCompletion = (
  row: NonNullable<Awaited<ReturnType<typeof getSubagent>>>,
  result: SecurityValidationResult,
  costDollars: number,
  stepCount: number,
  durationMs: number,
) => {
  const base = {
    userId: row.user_id,
    subagentId: row.subagent_id,
    parentTriggerRunId: row.parent_trigger_run_id,
    profile: "security_validation" as const,
    status: "completed" as const,
    verdict: result.verdict,
    durationMs,
    stepCount,
    costDollars,
  };
  captureSubagentLifecycleEvent("subagent_completed", base);
  captureSubagentLifecycleEvent(
    result.verdict === "confirmed"
      ? "subagent_validation_confirmed"
      : result.verdict === "rejected"
        ? "subagent_validation_rejected"
        : "subagent_validation_inconclusive",
    base,
  );
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
    await finishSubagent({
      subagentId: cleanup.subagentId,
      triggerRunId: ctx.run.id,
      status: "canceled",
      summary: "Independent validation was canceled with its parent run.",
      failureCode: "parent_or_user_canceled",
      cancelReason: "parent_or_user_canceled",
    }).catch(() => undefined);
    await ptySessionManager.closeAll(cleanup.subagentId).catch(() => undefined);
    captureSubagentLifecycleEvent("subagent_canceled", {
      userId: cleanup.userId,
      subagentId: cleanup.subagentId,
      parentTriggerRunId: cleanup.parentTriggerRunId,
      profile: "security_validation",
      status: "canceled",
      errorCategory: "parent_or_user_canceled",
    });
    await phLogger.flush().catch(() => undefined);
    cancellationCleanup.delete(ctx.run.id);
  },

  run: async (
    payload: { subagentId: string },
    { ctx, signal: triggerSignal },
  ): Promise<SubagentTaskOutput> => {
    const startedAt = Date.now();
    const row = await getSubagent(payload.subagentId);
    if (!row) throw new Error("Subagent reservation not found");
    if (row.status === "canceled") {
      return { subagentId: row.subagent_id, status: "canceled" };
    }
    if (
      row.depth !== 1 ||
      (row.status !== "queued" && row.status !== "running") ||
      row.permission_mode !== "full_access"
    ) {
      throw new Error("Unsupported subagent profile or depth");
    }
    const profile = getSubagentProfileDefinition(row.profile);
    const costLimitDollars = row.cost_limit_dollars;

    cancellationCleanup.set(ctx.run.id, {
      subagentId: row.subagent_id,
      userId: row.user_id,
      parentTriggerRunId: row.parent_trigger_run_id,
    });
    await attachSubagentTriggerRun(row.subagent_id, ctx.run.id);
    await tags.add([
      `subagent_${row.subagent_id}`,
      `parent_${row.parent_trigger_run_id}`,
      `user_${row.user_id}`,
      "profile_security_validation",
    ]);
    metadata
      .set("status", "running")
      .set("subagentId", row.subagent_id)
      .set("parentTriggerRunId", row.parent_trigger_run_id)
      .set("parentToolCallId", row.parent_tool_call_id)
      .set("profile", row.profile);

    const activeAbort = new AbortController();
    let activeTimedOut = false;
    let spendCapExceeded = false;
    const abortFromParent = () => activeAbort.abort();
    triggerSignal.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(() => {
      activeTimedOut = true;
      activeAbort.abort();
    }, SUBAGENT_MAX_ACTIVE_SECONDS * 1_000);

    const usageTracker = new UsageTracker();
    let resultValue: SecurityValidationResult | undefined;
    let stepCount = 0;
    let responseModel: string | undefined;
    let extraUsageConfig:
      Awaited<ReturnType<typeof buildExtraUsageConfig>> | undefined;
    let rateLimitInfo:
      Awaited<ReturnType<typeof checkRateLimitCapacity>> | undefined;
    let usageSettled = false;
    const selectedModel =
      row.selected_model ??
      (row.subscription === "free" ? "agent-model-free" : "agent-model");

    const settleUsage = async (): Promise<{
      costDollars: number;
      billingFailure: boolean;
    }> => {
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
      if (!extraUsageConfig || !rateLimitInfo) {
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
      const customization = await getUserCustomization({ userId: row.user_id });
      extraUsageConfig = await buildExtraUsageConfig({
        userId: row.user_id,
        subscription: row.subscription,
        userCustomization: customization,
        organizationId: row.organization_id,
        failClosedOnLookupError: true,
      });
      rateLimitInfo = await checkRateLimitCapacity(
        row.user_id,
        "agent",
        row.subscription,
        extraUsageConfig,
        selectedModel,
        row.organization_id,
        row.free_quota_subject,
      );
      if (row.subscription === "free") {
        await checkFreeMonthlyCostLimit(row.free_quota_subject ?? row.user_id);
      }

      const resolvedContext = await resolveSubagentContext(row.subagent_id);
      const prompt = profile.buildPrompt(row, resolvedContext);
      await saveSubagentMessage({
        subagentId: row.subagent_id,
        userId: row.user_id,
        sequence: 0,
        role: "user",
        parts: [{ type: "text", text: prompt }],
      });

      const uiStream = createUIMessageStream({
        execute: async ({ writer }) => {
          const submitResult = tool({
            description: profile.finalResultTool.description,
            inputSchema: profile.finalResultTool.schema,
            execute: async (input) => {
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
                  error: "A validation result was already accepted.",
                };
              }
              resultValue = parsed;
              return { accepted: true, verdict: parsed.verdict };
            },
          });

          const { tools, ensureSandbox } = createTools(
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
            ctx.run.id,
            {
              allowedToolNames: [
                ...profile.allowedToolNames,
                profile.finalResultTool.name,
              ],
              additionalTools: () => ({
                [profile.finalResultTool.name]: submitResult,
              }),
              ptyScopeId: row.subagent_id,
              chargeSandboxRuntime: false,
            },
          );
          const sandbox = await ensureSandbox();
          assertSubagentSandboxIdentity(sandbox, row.sandbox_identity);

          const provider = createTrackedProvider();
          const generation = streamText({
            model: provider.languageModel(selectedModel),
            system: profile.systemPrompt,
            prompt,
            tools,
            stopWhen: stepCountIs(SUBAGENT_MAX_STEPS),
            maxOutputTokens: profile.maxOutputTokens,
            abortSignal: activeAbort.signal,
            prepareStep: async ({ messages }) => {
              const compacted = pruneModelMessages(
                messages as Array<Record<string, unknown>>,
                12_000,
                2_000,
              );
              return { messages: compacted.messages as ModelMessage[] };
            },
            onStepFinish: async ({ usage, response, providerMetadata }) => {
              stepCount += 1;
              responseModel = response?.modelId ?? responseModel;
              const index = usage
                ? usageTracker.accumulateStep(usage, response?.modelId)
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
                usageTracker.computeCostDollars(selectedModel, responseModel) >=
                costLimitDollars
              ) {
                spendCapExceeded = true;
                activeAbort.abort();
              }
            },
          });

          writer.merge(
            generation.toUIMessageStream({
              generateMessageId: () => row.subagent_id,
              sendReasoning: true,
              onFinish: async ({ messages }) => {
                await persistAssistantMessages(
                  row.subagent_id,
                  row.user_id,
                  messages,
                );
              },
            }),
          );
        },
      });

      const { waitUntilComplete } = agentUiStream.pipe(
        sanitizeStream(uiStream),
      );
      await waitUntilComplete();
      await markSubagentFinalizing(row.subagent_id, ctx.run.id);

      const { costDollars, billingFailure } = await settleUsage();

      const terminalFailure = activeTimedOut
        ? {
            status: "timed_out" as const,
            code: "active_time_limit",
            summary:
              "Independent validation reached its 15-minute active limit.",
          }
        : triggerSignal.aborted
          ? {
              status: "canceled" as const,
              code: "parent_or_user_canceled",
              summary: "Independent validation was canceled.",
            }
          : spendCapExceeded
            ? {
                status: "failed" as const,
                code: "spend_cap",
                summary: `Independent validation reached its $${costLimitDollars.toFixed(2)} spend limit.`,
              }
            : billingFailure
              ? {
                  status: "failed" as const,
                  code: "billing_limit",
                  summary:
                    "Independent validation could not settle within the available usage budget.",
                }
              : !resultValue
                ? {
                    status: "failed" as const,
                    code: "structured_result_missing",
                    summary:
                      "Independent validation ended without a structured verdict.",
                  }
                : null;

      if (terminalFailure) {
        await finishSubagent({
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
        captureSubagentLifecycleEvent("subagent_completed", {
          userId: row.user_id,
          subagentId: row.subagent_id,
          parentTriggerRunId: row.parent_trigger_run_id,
          profile: "security_validation",
          status: terminalFailure.status,
          durationMs: Date.now() - startedAt,
          stepCount,
          costDollars,
          errorCategory: terminalFailure.code,
        });
        if (terminalFailure.status === "canceled") {
          captureSubagentLifecycleEvent("subagent_canceled", {
            userId: row.user_id,
            subagentId: row.subagent_id,
            parentTriggerRunId: row.parent_trigger_run_id,
            profile: "security_validation",
            status: "canceled",
            durationMs: Date.now() - startedAt,
            stepCount,
            costDollars,
            errorCategory: terminalFailure.code,
          });
        }
        metadata.set("status", terminalFailure.status);
        return { subagentId: row.subagent_id, status: terminalFailure.status };
      }

      const validationResult = resultValue as SecurityValidationResult;
      await finishSubagent({
        subagentId: row.subagent_id,
        triggerRunId: ctx.run.id,
        status: "completed",
        summary: validationResult.summary,
        verdict: validationResult.verdict,
        confidence: validationResult.confidence,
        structuredResult: validationResult,
        costDollars,
        stepCount,
      });
      metadata
        .set("status", "completed")
        .set("verdict", validationResult.verdict)
        .set("stepCount", stepCount)
        .set("costDollars", costDollars);
      captureCompletion(
        row,
        validationResult,
        costDollars,
        stepCount,
        Date.now() - startedAt,
      );
      return { subagentId: row.subagent_id, status: "completed" };
    } catch (error) {
      const status = triggerSignal.aborted ? "canceled" : "failed";
      const failureCode = triggerSignal.aborted
        ? "parent_or_user_canceled"
        : "runtime_error";
      const fallbackCostDollars = usageTracker.computeCostDollars(
        selectedModel,
        responseModel,
      );
      const settlement = await settleUsage().catch(() => ({
        costDollars: fallbackCostDollars,
        billingFailure: true,
      }));
      await finishSubagent({
        subagentId: row.subagent_id,
        triggerRunId: ctx.run.id,
        status,
        summary:
          status === "canceled"
            ? "Independent validation was canceled."
            : "Independent validation failed before producing a verdict.",
        failureCode,
        ...(status === "canceled" ? { cancelReason: failureCode } : {}),
        costDollars: settlement.costDollars,
        stepCount,
      }).catch(() => undefined);
      triggerLogger.error("[security-validation-subagent] run failed", {
        subagentId: row.subagent_id,
        parentTriggerRunId: row.parent_trigger_run_id,
        errorName: error instanceof Error ? error.name : "UnknownError",
        failureCode,
      });
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
