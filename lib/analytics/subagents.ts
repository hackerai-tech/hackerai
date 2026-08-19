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
  profile: SubagentProfile;
};

type SubagentLifecycleEvent = BaseSubagentEvent & {
  status?: SubagentStatus;
  verdict?: SubagentVerdict;
  durationMs?: number;
  stepCount?: number;
  costDollars?: number;
  errorCategory?: string;
  modelFrom?: string;
  modelTo?: string;
  modelPromotionReason?: string;
  taskStatus?: "completed" | "partial" | "blocked";
};

const boundedCategory = (value: string | undefined): string | undefined =>
  value?.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 80);

export const captureSubagentLifecycleEvent = (
  event:
    | "subagent_available"
    | "subagent_create_attempted"
    | "subagent_create_blocked"
    | "subagent_spawned"
    | "subagent_updated"
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
    model_from: boundedCategory(fields.modelFrom),
    model_to: boundedCategory(fields.modelTo),
    model_promotion_reason: boundedCategory(fields.modelPromotionReason),
    task_status: fields.taskStatus,
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

export const subagentOutcomeEventUuid = (subagentId: string): string =>
  uuidv5(`subagent-terminal-outcome:${subagentId}`, uuidv5.URL);

export const subagentResultDeliveredEventUuid = (subagentId: string): string =>
  uuidv5(`subagent-result-delivered:${subagentId}`, uuidv5.URL);

export const subagentCancelRequestedEventUuid = (subagentId: string): string =>
  uuidv5(`subagent-cancel-requested:${subagentId}`, uuidv5.URL);

export const subagentModelPromotionEventUuid = (subagentId: string): string =>
  uuidv5(`subagent-model-promoted:${subagentId}`, uuidv5.URL);

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
