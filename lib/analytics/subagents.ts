import "server-only";

import { phLogger } from "@/lib/posthog/server";
import type {
  SubagentStatus,
  SubagentVerdict,
} from "@/lib/ai/subagents/contracts";

type BaseSubagentEvent = {
  userId: string;
  subagentId?: string;
  parentTriggerRunId: string;
  profile: "security_validation";
};

type SubagentLifecycleEvent = BaseSubagentEvent & {
  status?: SubagentStatus;
  verdict?: SubagentVerdict;
  durationMs?: number;
  stepCount?: number;
  costDollars?: number;
  errorCategory?: string;
};

const boundedCategory = (value: string | undefined): string | undefined =>
  value?.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 80);

export const captureSubagentLifecycleEvent = (
  event:
    | "subagent_feature_exposed"
    | "subagent_spawned"
    | "subagent_completed"
    | "subagent_validation_confirmed"
    | "subagent_validation_rejected"
    | "subagent_validation_inconclusive"
    | "subagent_canceled",
  fields: SubagentLifecycleEvent,
) => {
  phLogger.event(event, {
    userId: fields.userId,
    subagent_id: fields.subagentId,
    parent_trigger_run_id: fields.parentTriggerRunId,
    profile: fields.profile,
    status: fields.status,
    verdict: fields.verdict,
    duration_ms: fields.durationMs,
    step_count: fields.stepCount,
    cost_dollars: fields.costDollars,
    error_category: boundedCategory(fields.errorCategory),
  });
};
