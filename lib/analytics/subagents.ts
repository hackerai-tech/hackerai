import "server-only";

import { v5 as uuidv5 } from "uuid";
import { phLogger } from "@/lib/posthog/server";
import type {
  SubagentStatus,
  SubagentVerdict,
  SubagentProfile,
} from "@/lib/ai/subagents/contracts";

type BaseSubagentEvent = {
  userId: string;
  eventUuid?: string;
  subagentId?: string;
  parentTriggerRunId: string;
  profile?: SubagentProfile;
};

type SubagentLifecycleEvent = BaseSubagentEvent & {
  status?: SubagentStatus;
  verdict?: SubagentVerdict;
  durationMs?: number;
  stepCount?: number;
  costDollars?: number;
  errorCategory?: string;
  runtimeErrorCategory?: string;
  modelFrom?: string;
  modelTo?: string;
  modelPromotionReason?: string;
  taskStatus?: "completed" | "partial" | "blocked";
  outcome?: string;
  failureStage?: string;
  activeCount?: number;
  totalCount?: number;
  terminalCount?: number;
  undeliveredCount?: number;
  targetCount?: number;
  resultAvailable?: boolean;
  resultRecoveryCount?: number;
  resultSubmissionCount?: number;
  skillCount?: number;
};

const boundedCategory = (value: string | undefined): string | undefined =>
  value?.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 80);

const runtimeEnvironment = (): string =>
  process.env.VERCEL_ENV ??
  process.env.NODE_ENV ??
  process.env.ENVIRONMENT ??
  "unknown";

const serviceVersion = (): string =>
  (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "dev").slice(
    0,
    64,
  );

export const captureSubagentLifecycleEvent = (
  event:
    | "subagent_available"
    | "subagent_create_attempted"
    | "subagent_create_blocked"
    | "subagent_create_failed"
    | "subagent_spawned"
    | "subagent_duplicate_reused"
    | "subagent_resumed"
    | "subagent_updated"
    | "subagent_list_outcome"
    | "subagent_update_outcome"
    | "subagent_wait_outcome"
    | "subagent_cancel_outcome"
    | "subagent_parent_settlement"
    | "subagent_parent_finish_blocked"
    | "subagent_deadline_reminder_sent"
    | "subagent_result_claimed"
    | "subagent_result_injected"
    | "subagent_result_delivered"
    | "subagent_cancel_requested"
    | "subagent_completed"
    | "subagent_validation_confirmed"
    | "subagent_validation_rejected"
    | "subagent_validation_inconclusive"
    | "subagent_model_promoted"
    | "subagent_canceled",
  fields: SubagentLifecycleEvent,
) => {
  phLogger.event(event, {
    userId: fields.userId,
    eventUuid: fields.eventUuid,
    subagent_id: fields.subagentId,
    parent_trigger_run_id: fields.parentTriggerRunId,
    profile: fields.profile,
    status: fields.status,
    verdict: fields.verdict,
    duration_ms: fields.durationMs,
    step_count: fields.stepCount,
    cost_dollars: fields.costDollars,
    error_category: boundedCategory(fields.errorCategory),
    runtime_error_category: boundedCategory(fields.runtimeErrorCategory),
    model_from: boundedCategory(fields.modelFrom),
    model_to: boundedCategory(fields.modelTo),
    model_promotion_reason: boundedCategory(fields.modelPromotionReason),
    task_status: fields.taskStatus,
    outcome: boundedCategory(fields.outcome),
    failure_stage: boundedCategory(fields.failureStage),
    active_count: fields.activeCount,
    total_count: fields.totalCount,
    terminal_count: fields.terminalCount,
    undelivered_count: fields.undeliveredCount,
    target_count: fields.targetCount,
    result_available: fields.resultAvailable,
    result_recovery_count: fields.resultRecoveryCount,
    result_submission_count: fields.resultSubmissionCount,
    skill_count: fields.skillCount,
    environment: runtimeEnvironment(),
    service_version: serviceVersion(),
  });
};

export const subagentAvailabilityEventUuid = (
  parentTriggerRunId: string,
  profile: SubagentProfile = "security_validation",
): string =>
  uuidv5(`subagent-available:${parentTriggerRunId}:${profile}`, uuidv5.URL);

export const subagentCreateAttemptEventUuid = (
  parentTriggerRunId: string,
  parentToolCallId: string,
  profile: SubagentProfile = "security_validation",
): string =>
  uuidv5(
    `subagent-create-attempted:${parentTriggerRunId}:${parentToolCallId}:${profile}`,
    uuidv5.URL,
  );

export const subagentCreateFailureEventUuid = (
  parentTriggerRunId: string,
  parentToolCallId: string,
  profile: SubagentProfile,
): string =>
  uuidv5(
    `subagent-create-failed:${parentTriggerRunId}:${parentToolCallId}:${profile}`,
    uuidv5.URL,
  );

export const subagentOperationEventUuid = (
  parentTriggerRunId: string,
  parentToolCallId: string,
  operation: "list" | "update" | "wait" | "cancel",
): string =>
  uuidv5(
    `subagent-operation:${operation}:${parentTriggerRunId}:${parentToolCallId}`,
    uuidv5.URL,
  );

export const subagentOutcomeEventUuid = (subagentId: string): string =>
  uuidv5(`subagent-terminal-outcome:${subagentId}`, uuidv5.URL);

export const subagentResultDeliveredEventUuid = (subagentId: string): string =>
  uuidv5(`subagent-result-delivered:${subagentId}`, uuidv5.URL);

export const subagentResultClaimedEventUuid = (
  subagentId: string,
  deliveryClaimId: string,
): string =>
  uuidv5(
    `subagent-result-claimed:${subagentId}:${deliveryClaimId}`,
    uuidv5.URL,
  );

export const subagentResultInjectedEventUuid = (subagentId: string): string =>
  uuidv5(`subagent-result-injected:${subagentId}`, uuidv5.URL);

export const subagentParentFinishBlockedEventUuid = (
  parentTriggerRunId: string,
): string =>
  uuidv5(`subagent-parent-finish-blocked:${parentTriggerRunId}`, uuidv5.URL);

export const subagentCancelRequestedEventUuid = (subagentId: string): string =>
  uuidv5(`subagent-cancel-requested:${subagentId}`, uuidv5.URL);

export const subagentModelPromotionEventUuid = (subagentId: string): string =>
  uuidv5(`subagent-model-promoted:${subagentId}`, uuidv5.URL);

export const subagentParentSettlementEventUuid = (
  parentTriggerRunId: string,
): string =>
  uuidv5(`subagent-parent-settlement:${parentTriggerRunId}`, uuidv5.URL);

export const captureSubagentTerminalOutcome = (
  fields: SubagentLifecycleEvent & {
    subagentId: string;
    status: "failed" | "canceled" | "timed_out";
  },
) =>
  captureSubagentLifecycleEvent(
    fields.status === "canceled" ? "subagent_canceled" : "subagent_completed",
    {
      ...fields,
      eventUuid: subagentOutcomeEventUuid(fields.subagentId),
    },
  );
