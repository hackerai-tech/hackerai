import {
  idempotencyKeys,
  logger as triggerLogger,
  tasks,
  wait,
} from "@trigger.dev/sdk";
import { tool, type UIMessageStreamWriter } from "ai";

import type { ToolContext } from "@/types";
import type {
  AgentPermissionMode,
  SandboxPreference,
  SubscriptionTier,
} from "@/types/chat";
import {
  cancelAgentInputSchema,
  continueAgentInputSchema,
  delegateTaskInputSchema,
  GENERAL_SUBAGENT_PROFILE,
  listAgentsInputSchema,
  sendMessageToAgentInputSchema,
  waitForAgentsInputSchema,
  SUBAGENT_ACTIVE_STATUSES,
  type SubagentLifecycleData,
  type SubagentProfile,
} from "@/lib/ai/subagents/contracts";
import {
  createAgentFingerprint,
  createSubagentId,
  createSubagentUpdateMessageId,
} from "@/lib/ai/subagents/fingerprint";
import { getSubagentSandboxIdentity } from "@/lib/ai/subagents/sandbox-identity";
import {
  resolveInitialSubagentModel,
  resolveSubagentTriggerPriority,
} from "@/lib/ai/subagents/model-routing";
import { getSubagentRecoveryErrorDiagnostics } from "@/lib/ai/subagents/runtime-recovery";
import { getSandboxWithFallbackGuard } from "@/lib/ai/tools/utils/sandbox-fallback";
import {
  claimNextTerminalSubagentForParent,
  failUnattachedSubagent,
  getSubagent,
  getSubagentForParent,
  listSubagentsForParent,
  reserveSubagent,
  cancelSubagentForUser,
  sendMessageToSubagent,
  consumeSubagentEventsForParent,
  listSubagentWorkLedgerForParent,
  resumeSubagentForParent,
  type PersistedSubagent,
} from "@/lib/db/subagents";
import { getConvexUrl } from "@/lib/db/convex-client";
import {
  captureSubagentLifecycleEvent,
  captureSubagentTerminalOutcome,
  subagentCancelRequestedEventUuid,
  subagentCreateAttemptEventUuid,
  subagentCreateFailureEventUuid,
  subagentOperationEventUuid,
  subagentResultClaimedEventUuid,
} from "@/lib/analytics/subagents";
import type { subagentTask } from "@/trigger/subagent";
import { resultFromPersistedSubagent } from "@/lib/ai/subagents/persisted-result";
import { toSubagentHandle } from "@/lib/ai/subagents/agent-handle";
import { resolveSubagentSkills } from "@/lib/ai/subagents/skills";
import { cancelAgentTriggerRun } from "@/lib/api/agent-approval-session";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { phLogger } from "@/lib/posthog/server";

export type SubagentToolsRuntimeConfig = {
  organizationId?: string;
  sandboxPreference?: SandboxPreference;
  permissionMode: AgentPermissionMode;
  subscription: SubscriptionTier;
  freeQuotaSubject?: string;
  triggerRegion?: TriggerRunRegion;
};

const writeLifecycle = (
  writer: UIMessageStreamWriter,
  data: SubagentLifecycleData,
): void => {
  writer.write({
    type: "data-subagent-lifecycle",
    id: `subagent-${data.subagent_id}-${data.parent_tool_call_id}-${data.event}`,
    data,
  } as Parameters<UIMessageStreamWriter["write"]>[0]);
};

const agentName = (row: PersistedSubagent & { title?: string }): string =>
  row.name ?? row.title ?? row.candidate?.title ?? "Subagent";

const reservationError = (outcome: string): string =>
  ({
    active_limit:
      "Two subagents are already active. Wait for one to finish before delegating another task.",
    total_limit: "This parent run has reached its subagent limit.",
    spend_limit: "This parent run has reached its subagent spend limit.",
    chat_missing: "The chat is unavailable or no longer owned by this user.",
  })[outcome] ?? "The subagent could not be created.";

export const createDelegateTaskTool = (
  context: ToolContext,
  config: SubagentToolsRuntimeConfig,
) =>
  tool({
    description: `Delegate one named, bounded task to an asynchronous child. Up to two siblings may run at once and four may be created per parent run. Choose the smallest server-validated capability bundle, give explicit success criteria, and continue useful parent work while it runs. Skills are optional methodology and never grant authority. The child cannot delegate.`,
    inputSchema: delegateTaskInputSchema,
    execute: async (input, execution) => {
      const parsed = delegateTaskInputSchema.parse(input);
      const profile = GENERAL_SUBAGENT_PROFILE;
      phLogger.event("generic_delegation_feature_exposed", {
        userId: context.userID,
        parent_trigger_run_id: context.triggerRunId,
        capability_count: parsed.capabilities.length,
        complexity: parsed.complexity,
        expected_duration_minutes: parsed.expected_duration_minutes,
        output_kind: parsed.output_kind,
      });
      if (parsed.capabilities.includes("external_connectors")) {
        return {
          success: false,
          error:
            "external_connectors is not available to delegated children yet. Use the connector in the parent and pass only the required result reference.",
        };
      }
      const resolvedSkills = resolveSubagentSkills(parsed.skills ?? []);
      if (!resolvedSkills.success) {
        return { success: false, error: resolvedSkills.error };
      }
      const skills = resolvedSkills.skills.map((skill) => skill.id);
      const parentTriggerRunId = context.triggerRunId;
      const parentMessageId = context.assistantMessageId;
      if (!parentTriggerRunId || !parentMessageId) {
        return {
          success: false,
          error: "delegate_task is only available inside a durable Agent run.",
        };
      }
      if (config.permissionMode !== "full_access") {
        return {
          success: false,
          error: "delegate_task requires Full access for the shared sandbox.",
        };
      }

      captureSubagentLifecycleEvent("subagent_create_attempted", {
        userId: context.userID,
        eventUuid: subagentCreateAttemptEventUuid(
          parentTriggerRunId,
          execution.toolCallId,
          profile,
        ),
        parentTriggerRunId,
        profile,
      });

      const createStartedAt = Date.now();
      const captureCreateFailure = (
        failureStage: string,
        errorCategory: string,
        subagentId?: string,
      ) =>
        captureSubagentLifecycleEvent("subagent_create_failed", {
          userId: context.userID,
          eventUuid: subagentCreateFailureEventUuid(
            parentTriggerRunId,
            execution.toolCallId,
            profile,
          ),
          subagentId,
          parentTriggerRunId,
          profile,
          durationMs: Date.now() - createStartedAt,
          failureStage,
          errorCategory,
        });
      const { sandbox } = await getSandboxWithFallbackGuard({
        sandboxManager: context.sandboxManager,
      }).catch((error) => {
        const diagnostics = getSubagentRecoveryErrorDiagnostics(error);
        captureCreateFailure(
          "sandbox_acquisition",
          "sandbox_acquisition_error",
        );
        triggerLogger.error("[subagent] sandbox acquisition failed", {
          event: "subagent_sandbox_acquisition_failed",
          service: "hackerai-subagent",
          environment:
            process.env.TRIGGER_ENV ?? process.env.NODE_ENV ?? "unknown",
          user_id: context.userID,
          parent_trigger_run_id: parentTriggerRunId,
          parent_tool_call_id: execution.toolCallId,
          profile,
          failure_stage: "sandbox_acquisition",
          error_category: diagnostics.category,
          error_name: diagnostics.errorName,
          error_code: diagnostics.errorCode,
          status_code: diagnostics.statusCode,
          duration_ms: Date.now() - createStartedAt,
        });
        throw error;
      });
      const sandboxIdentity = getSubagentSandboxIdentity(sandbox);
      const candidateFingerprint = createAgentFingerprint({
        profile,
        name: parsed.name,
        task: parsed.task,
        successCriteria: parsed.success_criteria,
        skills,
      });
      const proposedSubagentId = createSubagentId();
      const reservation = await reserveSubagent({
        subagentId: proposedSubagentId,
        userId: context.userID,
        organizationId: config.organizationId,
        chatId: context.chatId,
        parentMessageId,
        parentToolCallId: execution.toolCallId,
        parentTriggerRunId,
        profile,
        name: parsed.name,
        objective: parsed.task,
        successCriteria: parsed.success_criteria,
        inheritContext: parsed.inherit_context,
        skills,
        contextRefs: parsed.context_refs ?? undefined,
        candidateFingerprint,
        sandboxPreference: config.sandboxPreference,
        sandboxIdentity,
        permissionMode: config.permissionMode,
        capabilityBundles: parsed.capabilities,
        taskComplexity: parsed.complexity,
        expectedDurationMinutes: parsed.expected_duration_minutes,
        outputKind: parsed.output_kind,
        selectedModel: resolveInitialSubagentModel({
          capabilities: parsed.capabilities,
          complexity: parsed.complexity,
          expectedDurationMinutes: parsed.expected_duration_minutes,
          outputKind: parsed.output_kind,
          subscription: config.subscription,
        }),
        subscription: config.subscription,
        freeQuotaSubject: config.freeQuotaSubject,
        userLocation: context.userLocation,
      }).catch((error) => {
        captureCreateFailure("reservation", "reservation_error");
        throw error;
      });

      if (!reservation.subagentId) {
        captureSubagentLifecycleEvent("subagent_create_blocked", {
          userId: context.userID,
          parentTriggerRunId,
          profile,
          durationMs: Date.now() - createStartedAt,
          errorCategory: reservation.outcome,
        });
        return {
          success: false,
          error: reservationError(reservation.outcome),
        };
      }

      const subagentId = reservation.subagentId;
      const agentHandle = toSubagentHandle(subagentId);
      let record = await getSubagent(subagentId).catch((error) => {
        captureCreateFailure(
          "reservation_lookup",
          "reservation_lookup_error",
          subagentId,
        );
        throw error;
      });
      if (!record) {
        captureCreateFailure(
          "reservation_lookup",
          "reservation_lost",
          subagentId,
        );
        return {
          success: false,
          error: "The subagent reservation was lost.",
        };
      }

      writeLifecycle(context.writer, {
        subagent_id: subagentId,
        parent_message_id: record.parent_message_id,
        parent_tool_call_id: execution.toolCallId,
        agent_name: agentName(record),
        event: "started",
        status: record.status,
      });

      if (reservation.outcome === "created") {
        captureSubagentLifecycleEvent("subagent_spawned", {
          userId: context.userID,
          subagentId,
          parentTriggerRunId,
          profile,
          status: "queued",
          skillCount: skills.length,
        });
      } else {
        captureSubagentLifecycleEvent("subagent_duplicate_reused", {
          userId: context.userID,
          subagentId,
          parentTriggerRunId,
          profile,
          status: record.status,
          outcome: "fingerprint_match",
        });
      }

      if (record.status === "queued" && !record.trigger_run_id) {
        try {
          const key = await idempotencyKeys.create([profile, subagentId], {
            scope: "global",
          });
          await tasks.trigger<typeof subagentTask>(
            "hackerai-subagent",
            {
              subagentId,
              convexUrl: getConvexUrl(),
              triggerRegion: config.triggerRegion,
            },
            {
              idempotencyKey: key,
              idempotencyKeyTTL: "6h",
              priority: resolveSubagentTriggerPriority({
                capabilities: parsed.capabilities,
                complexity: parsed.complexity,
                expectedDurationMinutes: parsed.expected_duration_minutes,
                outputKind: parsed.output_kind,
              }),
              tags: [
                `subagent_${subagentId}`,
                `parent_${parentTriggerRunId}`,
                `user_${context.userID}`,
                `profile_${profile}`,
              ],
              metadata: {
                subagentId,
                parentTriggerRunId,
                parentToolCallId: execution.toolCallId,
                profile,
              },
              region: config.triggerRegion,
            },
          );
        } catch {
          captureCreateFailure(
            "child_trigger",
            "child_trigger_failed",
            subagentId,
          );
          const failed = await failUnattachedSubagent({
            subagentId,
            parentTriggerRunId,
            failureCode: "child_trigger_failed",
            summary: "Subagent could not be started.",
          }).catch(() => false);
          if (failed) {
            captureSubagentTerminalOutcome({
              userId: context.userID,
              subagentId,
              parentTriggerRunId,
              profile,
              status: "failed",
              errorCategory: "child_trigger_failed",
            });
          }
          record = (await getSubagent(subagentId)) ?? record;
          writeLifecycle(context.writer, {
            subagent_id: subagentId,
            parent_message_id: record.parent_message_id,
            parent_tool_call_id: execution.toolCallId,
            agent_name: agentName(record),
            event: "finished",
            status: record.status,
            summary: record.summary,
          });
          return {
            success: false,
            agent_id: agentHandle,
            name: agentName(record),
            status: record.status,
            error: "The subagent run could not be started.",
          };
        }
      }

      return {
        success: true,
        agent_id: agentHandle,
        name: agentName(record),
        status: record.status,
        message: `Delegated to '${agentName(record)}' (${agentHandle}) in parallel. Continue useful work, inspect progress with list_agents or wait_for_agents, and consume its terminal result before the final answer.`,
      };
    },
  });

export const createContinueAgentTool = (
  context: ToolContext,
  config: SubagentToolsRuntimeConfig,
) =>
  tool({
    description:
      "Resume a completed general subagent from its persisted transcript for one bounded follow-up. Reuses the same agent_id, ledger, and evidence instead of spawning a replacement.",
    inputSchema: continueAgentInputSchema,
    execute: async (input, execution) => {
      const parsed = continueAgentInputSchema.parse(input);
      const parentTriggerRunId = context.triggerRunId;
      if (!parentTriggerRunId || !context.assistantMessageId) {
        return {
          success: false,
          error: "continue_agent requires a durable Agent run.",
        };
      }
      const outcome = (await resumeSubagentForParent({
        userId: context.userID,
        chatId: context.chatId,
        parentTriggerRunId,
        targetAgentId: parsed.target_agent_id,
        followUp: parsed.follow_up,
      })) as { outcome: string; subagentId?: string };
      if (outcome.outcome !== "resumed" || !outcome.subagentId) {
        return {
          success: false,
          error:
            outcome.outcome === "active_limit"
              ? reservationError("active_limit")
              : outcome.outcome === "not_resumable"
                ? "Only completed general subagents can be resumed."
                : "The target subagent was not found.",
        };
      }
      const row = await getSubagent(outcome.subagentId);
      if (!row) {
        await failUnattachedSubagent({
          subagentId: outcome.subagentId,
          parentTriggerRunId,
          failureCode: "continuation_lookup_failed",
          summary: "Subagent continuation could not be started.",
        }).catch(() => false);
        return { success: false, error: "The resumed subagent was not found." };
      }
      try {
        const key = await idempotencyKeys.create(
          [
            "general",
            row.subagent_id,
            `continuation_${row.continuation_count ?? 1}`,
          ],
          { scope: "global" },
        );
        await tasks.trigger<typeof subagentTask>(
          "hackerai-subagent",
          {
            subagentId: row.subagent_id,
            convexUrl: getConvexUrl(),
            triggerRegion: config.triggerRegion,
          },
          {
            idempotencyKey: key,
            idempotencyKeyTTL: "6h",
            priority: resolveSubagentTriggerPriority({
              capabilities: row.capability_bundles ?? ["code_read"],
              complexity: row.task_complexity ?? "medium",
              expectedDurationMinutes: row.expected_duration_minutes ?? 8,
              outputKind: row.output_kind ?? "answer",
            }),
            tags: [
              `subagent_${row.subagent_id}`,
              `parent_${parentTriggerRunId}`,
              `user_${context.userID}`,
              "profile_general",
            ],
            metadata: {
              subagentId: row.subagent_id,
              parentTriggerRunId,
              parentToolCallId: execution.toolCallId,
              profile: "general",
              continuationCount: row.continuation_count ?? 1,
            },
            region: config.triggerRegion,
          },
        );
      } catch {
        await failUnattachedSubagent({
          subagentId: row.subagent_id,
          parentTriggerRunId,
          failureCode: "continuation_trigger_failed",
          summary: "Subagent continuation could not be started.",
        }).catch(() => false);
        return {
          success: false,
          agent_id: toSubagentHandle(row.subagent_id),
          error: "The continuation could not be started.",
        };
      }
      writeLifecycle(context.writer, {
        subagent_id: row.subagent_id,
        parent_message_id: row.parent_message_id,
        parent_tool_call_id: execution.toolCallId,
        agent_name: agentName(row),
        event: "started",
        status: "queued",
      });
      captureSubagentLifecycleEvent("subagent_resumed", {
        userId: context.userID,
        subagentId: row.subagent_id,
        parentTriggerRunId,
        profile: "general",
        status: "queued",
      });
      return {
        success: true,
        agent_id: toSubagentHandle(row.subagent_id),
        name: agentName(row),
        status: "queued" as const,
        message: "Resumed from the persisted child transcript.",
      };
    },
  });

export const createSendMessageToAgentTool = (context: ToolContext) =>
  tool({
    description: `Send an essential update to a live subagent using the short target_agent_id returned by delegate_task. Use this only for new evidence, a focused answer, or a concrete correction; do not send routine status pings.`,
    inputSchema: sendMessageToAgentInputSchema,
    execute: async (input, execution) => {
      const parsed = sendMessageToAgentInputSchema.parse(input);
      const parentTriggerRunId = context.triggerRunId;
      if (!parentTriggerRunId || !context.assistantMessageId) {
        return {
          success: false,
          target_agent_id: parsed.target_agent_id,
          error:
            "send_message_to_agent is only available inside a durable Agent run.",
        };
      }
      const operationStartedAt = Date.now();
      const messageId = createSubagentUpdateMessageId(
        parentTriggerRunId,
        parsed.target_agent_id,
        execution.toolCallId,
      );
      const delivery = (await sendMessageToSubagent({
        targetAgentId: parsed.target_agent_id,
        userId: context.userID,
        chatId: context.chatId,
        parentTriggerRunId,
        parentToolCallId: execution.toolCallId,
        messageId,
        message: parsed.message,
        messageType: parsed.message_type,
        priority: parsed.priority,
      }).catch((error) => {
        captureSubagentLifecycleEvent("subagent_update_outcome", {
          userId: context.userID,
          eventUuid: subagentOperationEventUuid(
            parentTriggerRunId,
            execution.toolCallId,
            "update",
          ),
          parentTriggerRunId,
          durationMs: Date.now() - operationStartedAt,
          outcome: "error",
          errorCategory: "delivery_error",
        });
        throw error;
      })) as {
        outcome: "delivered" | "not_found" | "not_active";
        subagentId?: string;
        messageId?: string;
        agentName?: string;
        profile?: SubagentProfile;
        status?: PersistedSubagent["status"];
        parentMessageId?: string;
      };

      if (
        delivery.outcome !== "delivered" ||
        !delivery.agentName ||
        !delivery.subagentId ||
        !delivery.parentMessageId ||
        !delivery.profile ||
        !delivery.status
      ) {
        captureSubagentLifecycleEvent("subagent_update_outcome", {
          userId: context.userID,
          eventUuid: subagentOperationEventUuid(
            parentTriggerRunId,
            execution.toolCallId,
            "update",
          ),
          subagentId: delivery.subagentId,
          parentTriggerRunId,
          profile: delivery.profile,
          status: delivery.status,
          durationMs: Date.now() - operationStartedAt,
          outcome: delivery.outcome,
          errorCategory: delivery.outcome,
        });
        return {
          success: false,
          target_agent_id: parsed.target_agent_id,
          ...(delivery.agentName
            ? { target_agent_name: delivery.agentName }
            : {}),
          error:
            delivery.outcome === "not_active"
              ? `${delivery.agentName ?? "That subagent"} is no longer active.`
              : "The target subagent was not found in this chat.",
        };
      }

      writeLifecycle(context.writer, {
        subagent_id: delivery.subagentId,
        parent_message_id: delivery.parentMessageId,
        parent_tool_call_id: execution.toolCallId,
        agent_name: delivery.agentName,
        event: "updated",
        status: delivery.status,
      });
      captureSubagentLifecycleEvent("subagent_updated", {
        userId: context.userID,
        subagentId: delivery.subagentId,
        parentTriggerRunId,
        profile: delivery.profile,
        status: delivery.status,
      });
      captureSubagentLifecycleEvent("subagent_update_outcome", {
        userId: context.userID,
        eventUuid: subagentOperationEventUuid(
          parentTriggerRunId,
          execution.toolCallId,
          "update",
        ),
        subagentId: delivery.subagentId,
        parentTriggerRunId,
        profile: delivery.profile,
        status: delivery.status,
        durationMs: Date.now() - operationStartedAt,
        outcome: "delivered",
      });
      return {
        success: true,
        target_agent_id: parsed.target_agent_id,
        target_agent_name: delivery.agentName,
        delivery_status: "delivered" as const,
      };
    },
  });

const activeAgentOutput = (
  active: Array<PersistedSubagent & { title?: string }>,
) =>
  active.map((row) => ({
    agent_id: toSubagentHandle(row.subagent_id),
    name: agentName(row),
    status: row.status,
  }));

export const createListAgentsTool = (context: ToolContext) =>
  tool({
    description:
      "List this parent run's subagents and their current durable status. Use the returned short agent_id handles for updates, targeted waits, or cancellation.",
    inputSchema: listAgentsInputSchema,
    execute: async (input, execution) => {
      listAgentsInputSchema.parse(input);
      if (!context.triggerRunId || !context.assistantMessageId) {
        return {
          success: false,
          agents: [],
          error: "list_agents is only available inside a durable Agent run.",
        };
      }
      const operationStartedAt = Date.now();
      const [agents, work_ledger, events] = await Promise.all([
        listSubagentsForParent({
          userId: context.userID,
          chatId: context.chatId,
          parentTriggerRunId: context.triggerRunId,
        }),
        listSubagentWorkLedgerForParent({
          userId: context.userID,
          chatId: context.chatId,
          parentTriggerRunId: context.triggerRunId,
        }),
        consumeSubagentEventsForParent({
          userId: context.userID,
          chatId: context.chatId,
          parentTriggerRunId: context.triggerRunId,
        }),
      ]).catch((error) => {
        captureSubagentLifecycleEvent("subagent_list_outcome", {
          userId: context.userID,
          eventUuid: subagentOperationEventUuid(
            context.triggerRunId!,
            execution.toolCallId,
            "list",
          ),
          parentTriggerRunId: context.triggerRunId!,
          durationMs: Date.now() - operationStartedAt,
          outcome: "error",
          errorCategory: "list_error",
        });
        throw error;
      });
      captureSubagentLifecycleEvent("subagent_list_outcome", {
        userId: context.userID,
        eventUuid: subagentOperationEventUuid(
          context.triggerRunId,
          execution.toolCallId,
          "list",
        ),
        parentTriggerRunId: context.triggerRunId,
        durationMs: Date.now() - operationStartedAt,
        outcome: "listed",
        totalCount: agents.length,
        activeCount: agents.filter((row) =>
          SUBAGENT_ACTIVE_STATUSES.has(row.status),
        ).length,
      });
      return {
        success: true,
        agents: agents.map((row) => ({
          agent_id: toSubagentHandle(row.subagent_id),
          name: agentName(row),
          profile: row.profile,
          status: row.status,
          result_available: row.structured_result !== undefined,
        })),
        events,
        work_ledger: work_ledger.map((item) => ({
          agent_id: toSubagentHandle(item.subagent_id),
          owner: item.owner,
          status: item.status,
          dependencies: item.dependencies,
          refs: item.refs,
          claims: item.claims,
          assessed_scope: item.assessed_scope,
          unassessed_scope: item.unassessed_scope,
          artifacts: item.artifacts,
          updated_at: item.updated_at,
        })),
      };
    },
  });

export const createCancelAgentTool = (context: ToolContext) =>
  tool({
    description:
      "Cancel one active subagent owned by this parent run using its short target_agent_id. Use only when its work is no longer useful or its scope is wrong.",
    inputSchema: cancelAgentInputSchema,
    execute: async (input, execution) => {
      const parsed = cancelAgentInputSchema.parse(input);
      const parentTriggerRunId = context.triggerRunId;
      if (!parentTriggerRunId || !context.assistantMessageId) {
        return {
          success: false,
          target_agent_id: parsed.target_agent_id,
          error: "cancel_agent is only available inside a durable Agent run.",
        };
      }
      const operationStartedAt = Date.now();
      const row = await getSubagentForParent({
        userId: context.userID,
        chatId: context.chatId,
        parentTriggerRunId,
        targetAgentId: parsed.target_agent_id,
      }).catch((error) => {
        captureSubagentLifecycleEvent("subagent_cancel_outcome", {
          userId: context.userID,
          eventUuid: subagentOperationEventUuid(
            parentTriggerRunId,
            execution.toolCallId,
            "cancel",
          ),
          parentTriggerRunId,
          durationMs: Date.now() - operationStartedAt,
          outcome: "error",
          errorCategory: "lookup_error",
        });
        throw error;
      });
      if (!row) {
        captureSubagentLifecycleEvent("subagent_cancel_outcome", {
          userId: context.userID,
          eventUuid: subagentOperationEventUuid(
            parentTriggerRunId,
            execution.toolCallId,
            "cancel",
          ),
          parentTriggerRunId,
          durationMs: Date.now() - operationStartedAt,
          outcome: "not_found",
          errorCategory: "not_found",
        });
        return {
          success: false,
          target_agent_id: parsed.target_agent_id,
          error: "The target subagent was not found in this parent run.",
        };
      }
      if (!SUBAGENT_ACTIVE_STATUSES.has(row.status)) {
        captureSubagentLifecycleEvent("subagent_cancel_outcome", {
          userId: context.userID,
          eventUuid: subagentOperationEventUuid(
            parentTriggerRunId,
            execution.toolCallId,
            "cancel",
          ),
          subagentId: row.subagent_id,
          parentTriggerRunId,
          profile: row.profile,
          status: row.status,
          durationMs: Date.now() - operationStartedAt,
          outcome: "already_terminal",
          errorCategory: "already_terminal",
        });
        return {
          success: false,
          target_agent_id: parsed.target_agent_id,
          target_agent_name: agentName(row),
          status: row.status,
          error: "That subagent is already terminal.",
        };
      }
      const stateCanceled = await cancelSubagentForUser({
        subagentId: row.subagent_id,
        userId: context.userID,
        triggerRunId: row.trigger_run_id,
        reason: "parent_requested",
      }).catch(() => false);
      if (!stateCanceled) {
        const persistedRow = await getSubagentForParent({
          userId: context.userID,
          chatId: context.chatId,
          parentTriggerRunId,
          targetAgentId: parsed.target_agent_id,
        }).catch(() => null);
        const persistedStatus = persistedRow?.status ?? row.status;
        captureSubagentLifecycleEvent("subagent_cancel_outcome", {
          userId: context.userID,
          eventUuid: subagentOperationEventUuid(
            parentTriggerRunId,
            execution.toolCallId,
            "cancel",
          ),
          subagentId: row.subagent_id,
          parentTriggerRunId,
          profile: row.profile,
          status: persistedStatus,
          durationMs: Date.now() - operationStartedAt,
          outcome: SUBAGENT_ACTIVE_STATUSES.has(persistedStatus)
            ? "persistence_failed"
            : "terminal_race",
          errorCategory: SUBAGENT_ACTIVE_STATUSES.has(persistedStatus)
            ? "persistence_failed"
            : "terminal_race",
        });
        return {
          success: false,
          target_agent_id: parsed.target_agent_id,
          target_agent_name: agentName(persistedRow ?? row),
          status: persistedStatus,
          error: SUBAGENT_ACTIVE_STATUSES.has(persistedStatus)
            ? "The cancellation could not be persisted."
            : `The subagent reached ${persistedStatus} before cancellation was persisted.`,
        };
      }
      const triggerCancellationRequested = row.trigger_run_id
        ? await cancelAgentTriggerRun(row.trigger_run_id).catch(() => false)
        : true;
      captureSubagentLifecycleEvent("subagent_cancel_requested", {
        userId: context.userID,
        eventUuid: subagentCancelRequestedEventUuid(row.subagent_id),
        subagentId: row.subagent_id,
        parentTriggerRunId,
        profile: row.profile,
        status: "canceled",
        errorCategory: triggerCancellationRequested
          ? "parent_requested"
          : "parent_requested_trigger_error",
      });
      captureSubagentTerminalOutcome({
        userId: context.userID,
        subagentId: row.subagent_id,
        parentTriggerRunId,
        profile: row.profile,
        status: "canceled",
        errorCategory: "parent_requested",
      });
      captureSubagentLifecycleEvent("subagent_cancel_outcome", {
        userId: context.userID,
        eventUuid: subagentOperationEventUuid(
          parentTriggerRunId,
          execution.toolCallId,
          "cancel",
        ),
        subagentId: row.subagent_id,
        parentTriggerRunId,
        profile: row.profile,
        status: "canceled",
        durationMs: Date.now() - operationStartedAt,
        outcome: triggerCancellationRequested
          ? "canceled"
          : "canceled_trigger_error",
        errorCategory: triggerCancellationRequested
          ? undefined
          : "trigger_cancel_failed",
      });
      return {
        success: true,
        target_agent_id: parsed.target_agent_id,
        target_agent_name: agentName(row),
        status: "canceled" as const,
      };
    },
  });

export const createWaitForAgentsTool = (context: ToolContext) =>
  tool({
    description: `Pause until a child reports material progress, asks a question, hits a blocker, produces an artifact, finishes, or the timeout elapses. Optionally target selected agent ids. Terminal results are delivered durably once; progress events are bounded and parent-mediated.`,
    inputSchema: waitForAgentsInputSchema,
    execute: async (input, execution) => {
      const parsed = waitForAgentsInputSchema.parse(input);
      if (!context.triggerRunId || !context.assistantMessageId) {
        return {
          success: false,
          wait_outcome: "no_active_agents" as const,
          reason: parsed.reason,
          active_agents: [],
        };
      }

      const startedAt = Date.now();
      const deadline = startedAt + parsed.timeout_seconds * 1_000;
      const deliveryClaimId = subagentOperationEventUuid(
        context.triggerRunId,
        execution.toolCallId,
        "wait",
      );
      const captureWaitOutcome = ({
        outcome,
        activeCount,
        subagent,
        resultAvailable,
        errorCategory,
      }: {
        outcome:
          | "agent_finished"
          | "progress"
          | "no_active_agents"
          | "timeout"
          | "targets_not_found"
          | "error";
        activeCount: number;
        subagent?: PersistedSubagent;
        resultAvailable?: boolean;
        errorCategory?: string;
      }) =>
        captureSubagentLifecycleEvent("subagent_wait_outcome", {
          userId: context.userID,
          eventUuid: subagentOperationEventUuid(
            context.triggerRunId!,
            execution.toolCallId,
            "wait",
          ),
          subagentId: subagent?.subagent_id,
          parentTriggerRunId: context.triggerRunId!,
          profile: subagent?.profile,
          status: subagent?.status,
          durationMs: Date.now() - startedAt,
          outcome,
          activeCount,
          targetCount: parsed.target_agent_ids?.length ?? 0,
          resultAvailable,
          errorCategory,
        });
      while (true) {
        const progressEvents = (await consumeSubagentEventsForParent({
          userId: context.userID,
          chatId: context.chatId,
          parentTriggerRunId: context.triggerRunId,
          targetAgentIds: parsed.target_agent_ids ?? undefined,
        })) as Array<{
          agentId: string;
          agentName: string;
          eventType:
            "progress" | "question" | "blocker" | "artifact" | "result";
          message: string;
          refs: string[];
          createdAt: number;
        }>;
        const targetedProgress = progressEvents;
        if (targetedProgress.length > 0) {
          captureWaitOutcome({ outcome: "progress", activeCount: 0 });
          return {
            success: true,
            wait_outcome: "progress" as const,
            reason: parsed.reason,
            events: targetedProgress.map((event) => ({
              agent_id: toSubagentHandle(event.agentId),
              agent_name: event.agentName,
              event_type: event.eventType,
              message: event.message,
              refs: event.refs,
              created_at: event.createdAt,
            })),
          };
        }
        const state = await claimNextTerminalSubagentForParent({
          userId: context.userID,
          chatId: context.chatId,
          parentTriggerRunId: context.triggerRunId,
          targetAgentIds: parsed.target_agent_ids ?? undefined,
          deliveryClaimId,
        }).catch((error) => {
          captureWaitOutcome({
            outcome: "error",
            activeCount: 0,
            errorCategory: "state_lookup_error",
          });
          throw error;
        });
        const unmatchedTargetAgentIds = state.unmatchedTargetAgentIds ?? [];
        if (unmatchedTargetAgentIds.length > 0) {
          captureWaitOutcome({
            outcome: "targets_not_found",
            activeCount: state.active.length,
            errorCategory: "targets_not_found",
          });
          return {
            success: false,
            wait_outcome: "targets_not_found" as const,
            reason: parsed.reason,
            target_agent_ids: unmatchedTargetAgentIds,
            active_agents: activeAgentOutput(state.active),
            error:
              "One or more target subagents were not found in this parent run.",
          };
        }
        if (state.terminal) {
          const name = agentName(state.terminal);
          const result = resultFromPersistedSubagent(state.terminal);
          if (state.deliveryClaimId) {
            captureSubagentLifecycleEvent("subagent_result_claimed", {
              userId: context.userID,
              eventUuid: subagentResultClaimedEventUuid(
                state.terminal.subagent_id,
                state.deliveryClaimId,
              ),
              subagentId: state.terminal.subagent_id,
              parentTriggerRunId: context.triggerRunId,
              profile: state.terminal.profile,
              status: state.terminal.status,
            });
          }
          captureWaitOutcome({
            outcome: "agent_finished",
            activeCount: state.active.length,
            subagent: state.terminal,
            resultAvailable: state.terminal.structured_result !== undefined,
          });
          writeLifecycle(context.writer, {
            subagent_id: state.terminal.subagent_id,
            parent_message_id: state.terminal.parent_message_id,
            parent_tool_call_id: execution.toolCallId,
            agent_name: name,
            event: "finished",
            status: state.terminal.status,
            summary: result.summary,
            ...(result.profile === "security_validation" && result.verdict
              ? { verdict: result.verdict }
              : {}),
            elapsed_ms:
              state.terminal.started_at && state.terminal.completed_at
                ? Math.max(
                    0,
                    state.terminal.completed_at - state.terminal.started_at,
                  )
                : undefined,
          });
          return {
            success: true,
            wait_outcome: "agent_finished" as const,
            reason: parsed.reason,
            agent_id: toSubagentHandle(state.terminal.subagent_id),
            agent_name: name,
            result,
            active_agents: activeAgentOutput(state.active),
            ...(state.deliveryClaimId
              ? {
                  _delivery_claim: {
                    subagent_id: state.terminal.subagent_id,
                    claim_id: state.deliveryClaimId,
                  },
                }
              : {}),
          };
        }
        if (state.active.length === 0 && state.pendingDeliveryCount === 0) {
          captureWaitOutcome({
            outcome: "no_active_agents",
            activeCount: 0,
          });
          return {
            success: true,
            wait_outcome: "no_active_agents" as const,
            reason: parsed.reason,
            active_agents: [],
          };
        }

        const remainingSeconds = Math.ceil((deadline - Date.now()) / 1_000);
        if (remainingSeconds <= 0) {
          captureWaitOutcome({
            outcome: "timeout",
            activeCount: state.active.length,
            errorCategory: "timeout",
          });
          return {
            success: true,
            wait_outcome: "timeout" as const,
            reason: parsed.reason,
            active_agents: activeAgentOutput(state.active),
          };
        }
        await wait.for({ seconds: Math.min(5, remainingSeconds) });
      }
    },
  });
