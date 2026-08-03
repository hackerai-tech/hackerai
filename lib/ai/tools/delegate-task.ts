import { idempotencyKeys } from "@trigger.dev/sdk";
import { tool, type UIMessageStreamWriter } from "ai";

import type { ToolContext } from "@/types";
import type {
  AgentPermissionMode,
  SandboxPreference,
  SubscriptionTier,
} from "@/types/chat";
import {
  delegateTaskInputSchema,
  SUBAGENT_ACTIVE_STATUSES,
  SUBAGENT_TERMINAL_STATUSES,
  type DelegateTaskResult,
  type SecurityValidationResult,
  type SubagentLifecycleData,
} from "@/lib/ai/subagents/contracts";
import {
  createCandidateFingerprint,
  createSubagentId,
} from "@/lib/ai/subagents/fingerprint";
import { getSubagentSandboxIdentity } from "@/lib/ai/subagents/sandbox-identity";
import { serializeSubagentWaitForParent } from "@/lib/ai/subagents/parent-wait-lock";
import { SUBAGENT_TEXT_MODEL } from "@/lib/ai/subagents/model-routing";
import { getSandboxWithFallbackGuard } from "@/lib/ai/tools/utils/sandbox-fallback";
import {
  acknowledgeSubagentResult,
  failUnattachedSubagent,
  finishSubagent,
  getSubagent,
  reserveSubagent,
  type PersistedSubagent,
} from "@/lib/db/subagents";
import {
  captureSubagentLifecycleEvent,
  captureSubagentTerminalOutcome,
  subagentExposureEventUuid,
} from "@/lib/analytics/subagents";
import { subagentTask } from "@/trigger/subagent";
import { cancelAgentTriggerRun } from "@/lib/api/agent-approval-session";

export type DelegateTaskRuntimeConfig = {
  organizationId?: string;
  sandboxPreference?: SandboxPreference;
  permissionMode: AgentPermissionMode;
  subscription: SubscriptionTier;
  freeQuotaSubject?: string;
};

const writeLifecycle = (
  writer: UIMessageStreamWriter,
  data: SubagentLifecycleData,
): void => {
  writer.write({
    type: "data-subagent-lifecycle",
    id: `subagent-${data.subagent_id}-${data.status}`,
    data,
  } as Parameters<UIMessageStreamWriter["write"]>[0]);
};

const resultFromRecord = (row: PersistedSubagent): DelegateTaskResult => {
  const result = row.structured_result;
  const terminalStatus =
    row.status === "completed" ||
    row.status === "failed" ||
    row.status === "canceled" ||
    row.status === "timed_out"
      ? row.status
      : "failed";

  return {
    schema_version: 1,
    subagent_id: row.subagent_id,
    trigger_run_id: row.trigger_run_id ?? null,
    status: terminalStatus,
    verdict: result?.verdict ?? row.verdict ?? null,
    confidence: result?.confidence ?? row.confidence ?? null,
    summary:
      result?.summary ??
      row.summary ??
      "Independent validation did not finish.",
    ...(result?.observed_impact
      ? { observed_impact: result.observed_impact }
      : {}),
    ...(result?.reproduction_steps
      ? { reproduction_steps: result.reproduction_steps }
      : {}),
    evidence_refs: result?.evidence_refs ?? [],
    limitations: result?.limitations ?? [],
    recommended_severity: result?.recommended_severity ?? null,
    report_eligible:
      terminalStatus === "completed" && result?.verdict === "confirmed",
    ...(row.failure_code ? { failure_code: row.failure_code } : {}),
  };
};

const fallbackFailure = (
  subagentId: string,
  triggerRunId: string | null,
  failureCode: string,
): DelegateTaskResult => ({
  schema_version: 1,
  subagent_id: subagentId,
  trigger_run_id: triggerRunId,
  status: "failed",
  verdict: null,
  confidence: null,
  summary: "Independent validation could not be completed.",
  evidence_refs: [],
  limitations: [],
  recommended_severity: null,
  report_eligible: false,
  failure_code: failureCode,
});

const reconcileFailedChildWait = async (args: {
  subagentId: string;
  parentTriggerRunId: string;
  userId: string;
  failureCode: "child_run_failed" | "child_wait_failed";
}): Promise<PersistedSubagent | null> => {
  const current = await getSubagent(args.subagentId);
  if (!current || !SUBAGENT_ACTIVE_STATUSES.has(current.status)) {
    return current;
  }

  let updated = false;
  if (current.trigger_run_id) {
    await cancelAgentTriggerRun(current.trigger_run_id).catch(() => false);
    updated =
      (await finishSubagent({
        subagentId: current.subagent_id,
        triggerRunId: current.trigger_run_id,
        status: "failed",
        summary: "Subagent stopped before returning a result.",
        failureCode: args.failureCode,
      }).catch(() => null)) === "updated";
  } else {
    updated = await failUnattachedSubagent({
      subagentId: current.subagent_id,
      parentTriggerRunId: args.parentTriggerRunId,
      failureCode: args.failureCode,
      summary: "Subagent stopped before returning a result.",
    }).catch(() => false);
  }

  if (updated) {
    captureSubagentTerminalOutcome({
      userId: args.userId,
      subagentId: current.subagent_id,
      parentTriggerRunId: args.parentTriggerRunId,
      profile: "security_validation",
      status: "failed",
      errorCategory: args.failureCode,
    });
  }
  return await getSubagent(args.subagentId);
};

export const createDelegateTask = (
  context: ToolContext,
  config: DelegateTaskRuntimeConfig,
) =>
  tool({
    description: `Delegate one concrete, report-ready vulnerability candidate to an independent validation child and wait for its structured verdict. In this release profile must be security_validation. Do not use this for discovery, reconnaissance, broad research, code review, or parallel work. Pass only stable references to the minimum relevant parent evidence; never paste the full conversation into objective. A vulnerability_report is eligible only when this returns report_eligible=true.`,
    inputSchema: delegateTaskInputSchema,
    execute: async (input, execution) => {
      const parsed = delegateTaskInputSchema.parse(input);
      const parentTriggerRunId = context.triggerRunId;
      const parentMessageId = context.assistantMessageId;
      if (!parentTriggerRunId || !parentMessageId) {
        return fallbackFailure("unavailable", null, "parent_linkage_missing");
      }
      if (config.permissionMode !== "full_access") {
        return fallbackFailure("unavailable", null, "full_access_required");
      }
      captureSubagentLifecycleEvent("subagent_feature_exposed", {
        userId: context.userID,
        eventUuid: subagentExposureEventUuid(parentTriggerRunId),
        parentTriggerRunId,
        profile: "security_validation",
      });

      const { sandbox } = await getSandboxWithFallbackGuard({
        sandboxManager: context.sandboxManager,
      });
      const sandboxIdentity = getSubagentSandboxIdentity(sandbox);
      const candidateFingerprint = createCandidateFingerprint(
        parsed.profile_input.candidate,
        parsed.context_refs,
      );
      const proposedSubagentId = createSubagentId();
      const reservation = await reserveSubagent({
        subagentId: proposedSubagentId,
        userId: context.userID,
        organizationId: config.organizationId,
        chatId: context.chatId,
        parentMessageId,
        parentToolCallId: execution.toolCallId,
        parentTriggerRunId,
        objective: parsed.objective,
        candidate: parsed.profile_input.candidate,
        candidateFingerprint,
        contextRefs: parsed.context_refs,
        sandboxPreference: config.sandboxPreference,
        sandboxIdentity,
        permissionMode: config.permissionMode,
        selectedModel: SUBAGENT_TEXT_MODEL,
        subscription: config.subscription,
        freeQuotaSubject: config.freeQuotaSubject,
        userLocation: context.userLocation,
      });

      if (
        reservation.outcome === "active_limit" ||
        reservation.outcome === "total_limit" ||
        reservation.outcome === "spend_limit" ||
        reservation.outcome === "chat_missing"
      ) {
        return fallbackFailure(proposedSubagentId, null, reservation.outcome);
      }

      const subagentId = reservation.subagentId ?? proposedSubagentId;
      const initialRecord = await getSubagent(subagentId);
      if (!initialRecord) {
        return fallbackFailure(subagentId, null, "persistence_missing");
      }

      writeLifecycle(context.writer, {
        subagent_id: subagentId,
        parent_trigger_run_id: parentTriggerRunId,
        parent_tool_call_id: execution.toolCallId,
        trigger_run_id: initialRecord.trigger_run_id ?? null,
        profile: "security_validation",
        status: initialRecord.status,
        title: initialRecord.candidate.title,
      });

      if (reservation.outcome === "created") {
        captureSubagentLifecycleEvent("subagent_spawned", {
          userId: context.userID,
          subagentId,
          parentTriggerRunId,
          profile: "security_validation",
          status: "queued",
        });
      }

      if (SUBAGENT_TERMINAL_STATUSES.has(initialRecord.status)) {
        if (initialRecord.status === "completed") {
          await acknowledgeSubagentResult(subagentId, parentTriggerRunId);
        }
        const output = resultFromRecord(initialRecord);
        writeLifecycle(context.writer, {
          subagent_id: subagentId,
          parent_trigger_run_id: parentTriggerRunId,
          parent_tool_call_id: execution.toolCallId,
          trigger_run_id: initialRecord.trigger_run_id ?? null,
          profile: "security_validation",
          status: initialRecord.status,
          title: initialRecord.candidate.title,
          summary: output.summary,
          ...(output.verdict ? { verdict: output.verdict } : {}),
          elapsed_ms:
            initialRecord.started_at && initialRecord.completed_at
              ? Math.max(
                  0,
                  initialRecord.completed_at - initialRecord.started_at,
                )
              : undefined,
        });
        return output;
      }

      const waitOutcome = await (async () => {
        try {
          return await serializeSubagentWaitForParent(
            parentTriggerRunId,
            async () => {
              const beforeWait = await getSubagent(subagentId);
              if (
                !beforeWait ||
                SUBAGENT_TERMINAL_STATUSES.has(beforeWait.status)
              ) {
                return { childResult: null, record: beforeWait };
              }

              const key = await idempotencyKeys.create(
                ["security-validation", subagentId],
                { scope: "global" },
              );
              const result = await subagentTask.triggerAndWait(
                { subagentId },
                {
                  idempotencyKey: key,
                  idempotencyKeyTTL: "6h",
                  tags: [
                    `subagent_${subagentId}`,
                    `parent_${parentTriggerRunId}`,
                    `user_${context.userID}`,
                    "profile_security_validation",
                  ],
                  metadata: {
                    subagentId,
                    parentTriggerRunId,
                    parentToolCallId: execution.toolCallId,
                    profile: "security_validation",
                  },
                },
              );

              return {
                childResult: result,
                record: await getSubagent(subagentId),
              };
            },
          );
        } catch {
          return {
            childResult: null,
            record: await reconcileFailedChildWait({
              subagentId,
              parentTriggerRunId,
              userId: context.userID,
              failureCode: "child_wait_failed",
            }),
          };
        }
      })();
      let { childResult, record } = waitOutcome;
      if (
        childResult?.ok === false &&
        record &&
        SUBAGENT_ACTIVE_STATUSES.has(record.status)
      ) {
        record = await reconcileFailedChildWait({
          subagentId,
          parentTriggerRunId,
          userId: context.userID,
          failureCode: "child_run_failed",
        });
      }
      if (!record) {
        return fallbackFailure(
          subagentId,
          childResult?.id ?? initialRecord.trigger_run_id ?? null,
          childResult?.ok === false
            ? "child_run_failed"
            : "result_persistence_missing",
        );
      }

      if (record.status === "completed") {
        await acknowledgeSubagentResult(subagentId, parentTriggerRunId);
      }
      const output = resultFromRecord(record);
      writeLifecycle(context.writer, {
        subagent_id: subagentId,
        parent_trigger_run_id: parentTriggerRunId,
        parent_tool_call_id: execution.toolCallId,
        trigger_run_id: record.trigger_run_id ?? childResult?.id ?? null,
        profile: "security_validation",
        status: record.status,
        title: record.candidate.title,
        summary: output.summary,
        ...(output.verdict ? { verdict: output.verdict } : {}),
        elapsed_ms:
          record.started_at && record.completed_at
            ? Math.max(0, record.completed_at - record.started_at)
            : undefined,
      });
      return output;
    },
  });

export const validationResultFromToolOutput = (
  value: unknown,
): SecurityValidationResult | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<SecurityValidationResult>;
  return row.verdict && row.confidence && row.summary
    ? (row as SecurityValidationResult)
    : null;
};
