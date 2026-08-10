import { idempotencyKeys, wait } from "@trigger.dev/sdk";
import { tool, type UIMessageStreamWriter } from "ai";

import type { ToolContext } from "@/types";
import type {
  AgentPermissionMode,
  SandboxPreference,
  SubscriptionTier,
} from "@/types/chat";
import {
  agentValidationResultSchema,
  createAgentInputSchema,
  sendMessageToAgentInputSchema,
  SUBAGENT_TERMINAL_STATUSES,
  waitForAgentsInputSchema,
  type AgentValidationResult,
  type SubagentLifecycleData,
} from "@/lib/ai/subagents/contracts";
import {
  createAgentFingerprint,
  createSubagentId,
  createSubagentUpdateMessageId,
} from "@/lib/ai/subagents/fingerprint";
import { getSubagentSandboxIdentity } from "@/lib/ai/subagents/sandbox-identity";
import { SUBAGENT_TEXT_MODEL } from "@/lib/ai/subagents/model-routing";
import { getSandboxWithFallbackGuard } from "@/lib/ai/tools/utils/sandbox-fallback";
import {
  claimNextTerminalSubagentForParent,
  failUnattachedSubagent,
  getSubagent,
  reserveSubagent,
  sendMessageToSubagent,
  type PersistedSubagent,
} from "@/lib/db/subagents";
import { getConvexUrl } from "@/lib/db/convex-client";
import {
  captureSubagentLifecycleEvent,
  captureSubagentTerminalOutcome,
  subagentCreateAttemptEventUuid,
} from "@/lib/analytics/subagents";
import { subagentTask } from "@/trigger/subagent";

export type SubagentToolsRuntimeConfig = {
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
    id: `subagent-${data.subagent_id}-${data.parent_tool_call_id}-${data.event}`,
    data,
  } as Parameters<UIMessageStreamWriter["write"]>[0]);
};

const agentName = (row: PersistedSubagent & { title?: string }): string =>
  row.name ?? row.title ?? row.candidate?.title ?? "Subagent";

const resultFromRecord = (row: PersistedSubagent): AgentValidationResult => {
  const result = row.structured_result;
  const terminalStatus = SUBAGENT_TERMINAL_STATUSES.has(row.status)
    ? row.status
    : "failed";
  return agentValidationResultSchema.parse({
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
  });
};

const reservationError = (outcome: string): string =>
  ({
    active_limit:
      "Another validation subagent is already active. Wait for it to finish before creating another.",
    total_limit: "This parent run has reached its subagent limit.",
    spend_limit: "This parent run has reached its subagent spend limit.",
    chat_missing: "The chat is unavailable or no longer owned by this user.",
  })[outcome] ?? "The subagent could not be created.";

export const createCreateAgentTool = (
  context: ToolContext,
  config: SubagentToolsRuntimeConfig,
) =>
  tool({
    description: `Spawn a named specialist child agent that runs asynchronously with name, task, inherit_context, and skills. In this release, use it only to independently validate one concrete vulnerability candidate that is ready to reproduce or reject. The task must state the affected asset, weakness class, claimed impact, minimum evidence, success criteria, and authorization boundaries. Do not use it for discovery, reconnaissance, broad research, code review, or generic testing. Use a distinct human-readable name. After creating the child, continue useful work or call wait_for_agents; use send_message_to_agent only for essential new evidence or a correction.`,
    inputSchema: createAgentInputSchema,
    execute: async (input, execution) => {
      const parsed = createAgentInputSchema.parse(input);
      const parentTriggerRunId = context.triggerRunId;
      const parentMessageId = context.assistantMessageId;
      if (!parentTriggerRunId || !parentMessageId) {
        return {
          success: false,
          error: "create_agent is only available inside a durable Agent run.",
        };
      }
      if (config.permissionMode !== "full_access") {
        return {
          success: false,
          error: "create_agent requires Full access for the shared sandbox.",
        };
      }

      captureSubagentLifecycleEvent("subagent_create_attempted", {
        userId: context.userID,
        eventUuid: subagentCreateAttemptEventUuid(
          parentTriggerRunId,
          execution.toolCallId,
        ),
        parentTriggerRunId,
        profile: "security_validation",
      });

      const { sandbox } = await getSandboxWithFallbackGuard({
        sandboxManager: context.sandboxManager,
      });
      const sandboxIdentity = getSubagentSandboxIdentity(sandbox);
      const skills = parsed.skills ?? [];
      const candidateFingerprint = createAgentFingerprint(
        parsed.name,
        parsed.task,
        skills,
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
        name: parsed.name,
        objective: parsed.task,
        inheritContext: parsed.inherit_context,
        skills,
        candidateFingerprint,
        sandboxPreference: config.sandboxPreference,
        sandboxIdentity,
        permissionMode: config.permissionMode,
        selectedModel: SUBAGENT_TEXT_MODEL,
        subscription: config.subscription,
        freeQuotaSubject: config.freeQuotaSubject,
        userLocation: context.userLocation,
      });

      if (!reservation.subagentId) {
        return {
          success: false,
          error: reservationError(reservation.outcome),
        };
      }

      const subagentId = reservation.subagentId;
      let record = await getSubagent(subagentId);
      if (!record) {
        return { success: false, error: "The subagent reservation was lost." };
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
          profile: "security_validation",
          status: "queued",
        });
      }

      if (record.status === "queued" && !record.trigger_run_id) {
        try {
          const key = await idempotencyKeys.create(
            ["security-validation", subagentId],
            { scope: "global" },
          );
          await subagentTask.trigger(
            { subagentId, convexUrl: getConvexUrl() },
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
        } catch {
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
              profile: "security_validation",
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
            agent_id: subagentId,
            name: agentName(record),
            status: record.status,
            error: "The subagent run could not be started.",
          };
        }
      }

      return {
        success: true,
        agent_id: subagentId,
        name: agentName(record),
        status: record.status,
        message: `Spawned '${agentName(record)}' (${subagentId}) running in parallel.`,
      };
    },
  });

export const createSendMessageToAgentTool = (context: ToolContext) =>
  tool({
    description: `Send an essential update to a live subagent's inbox with target_agent_id, message, message_type, and priority. Use this only for new evidence, a focused question, or a concrete correction that changes an active independent validation. Do not send routine status pings or repeat context the child already has.`,
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
      })) as {
        outcome: "delivered" | "not_found" | "not_active";
        messageId?: string;
        agentName?: string;
        status?: PersistedSubagent["status"];
        parentMessageId?: string;
      };

      if (
        delivery.outcome !== "delivered" ||
        !delivery.agentName ||
        !delivery.parentMessageId ||
        !delivery.status
      ) {
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
        subagent_id: parsed.target_agent_id,
        parent_message_id: delivery.parentMessageId,
        parent_tool_call_id: execution.toolCallId,
        agent_name: delivery.agentName,
        event: "updated",
        status: delivery.status,
      });
      captureSubagentLifecycleEvent("subagent_updated", {
        userId: context.userID,
        subagentId: parsed.target_agent_id,
        parentTriggerRunId,
        profile: "security_validation",
        status: delivery.status,
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
    agent_id: row.subagent_id,
    name: agentName(row),
    status: row.status,
  }));

export const createWaitForAgentsTool = (context: ToolContext) =>
  tool({
    description: `Pause until a validation subagent finishes or the timeout elapses using reason and timeout_seconds. This waits for durable child state, not terminal commands. A completed structured result is returned once to the parent; failed, canceled, timed-out, rejected, and inconclusive outcomes are not independent confirmation. Do not call this when no subagent is active.`,
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
      while (true) {
        const state = await claimNextTerminalSubagentForParent({
          userId: context.userID,
          chatId: context.chatId,
          parentTriggerRunId: context.triggerRunId,
        });
        if (state.terminal) {
          const name = agentName(state.terminal);
          const result = resultFromRecord(state.terminal);
          writeLifecycle(context.writer, {
            subagent_id: state.terminal.subagent_id,
            parent_message_id: state.terminal.parent_message_id,
            parent_tool_call_id: execution.toolCallId,
            agent_name: name,
            event: "finished",
            status: state.terminal.status,
            summary: result.summary,
            ...(result.verdict ? { verdict: result.verdict } : {}),
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
            agent_id: state.terminal.subagent_id,
            agent_name: name,
            result,
            active_agents: activeAgentOutput(state.active),
          };
        }
        if (state.active.length === 0) {
          return {
            success: true,
            wait_outcome: "no_active_agents" as const,
            reason: parsed.reason,
            active_agents: [],
          };
        }

        const remainingSeconds = Math.ceil((deadline - Date.now()) / 1_000);
        if (remainingSeconds <= 0) {
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
