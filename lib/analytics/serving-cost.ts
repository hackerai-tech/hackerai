import { v5 as uuidv5 } from "uuid";
import { isAbliterationModel } from "@/lib/ai/abliteration";
import { isInferenceCyberModel } from "@/lib/ai/inference";
import type { UsageLogPersistence } from "@/lib/db/actions";

/**
 * Model-serving providers with separate invoices. Every other model route is
 * served through OpenRouter. Keep this list bounded: it becomes analytics keys.
 */
export type ServingProvider = "inference" | "abliteration" | "openrouter";

export const servingProviderForModel = (
  modelName: string | undefined,
): ServingProvider =>
  isInferenceCyberModel(modelName)
    ? "inference"
    : isAbliterationModel(modelName)
      ? "abliteration"
      : "openrouter";

/** Measured/estimated model spend by provider, rather than final response model. */
export const servingProviderCostProperties = (
  steps: ReadonlyArray<{ modelName?: string; costDollars: number }>,
) => {
  const totals: Record<ServingProvider, number> = {
    inference: 0,
    abliteration: 0,
    openrouter: 0,
  };
  for (const step of steps) {
    totals[servingProviderForModel(step.modelName)] += step.costDollars;
  }
  return {
    usage_inference_model_cost_dollars: totals.inference,
    usage_abliteration_model_cost_dollars: totals.abliteration,
    usage_openrouter_model_cost_dollars: totals.openrouter,
  };
};

/** Ledger persistence is "not_applicable" when the tier has no usage_logs row. */
export const usageLogProperties = (
  usageLog: UsageLogPersistence | "not_applicable" | undefined,
) => {
  if (!usageLog) return {};
  if (usageLog === "not_applicable") {
    return { usage_log_status: "not_applicable" as const };
  }
  return usageLog.status === "persisted"
    ? { usage_log_status: "persisted" as const }
    : {
        usage_log_status: "failed" as const,
        usage_log_failure_category: usageLog.failureCategory,
      };
};

/**
 * One cost event identity per non-Trigger settlement. Normal and fallback
 * captures share it, so a retransmission or late fallback cannot add a second
 * cost record for the same request.
 */
export const usageCostEventUuid = (usageSettlementId: string) =>
  uuidv5(`hackerai:usage-cost:v1:${usageSettlementId}`, uuidv5.URL);

const knownAmount = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/**
 * Known work (including token estimates), with missing work excluded. Trigger compute recorded
 * in the tracker is replaced by the latest Trigger snapshot, never added twice.
 */
export const knownIncurredCostLowerBound = ({
  knownIncurredCostDollars,
  trackedTriggerCostDollars = 0,
  latestTriggerCostDollars,
}: {
  knownIncurredCostDollars?: number;
  trackedTriggerCostDollars?: number;
  latestTriggerCostDollars?: number;
}): number | null => {
  const known = knownAmount(knownIncurredCostDollars);
  const latestTrigger = knownAmount(latestTriggerCostDollars);
  if (known === null) return latestTrigger;
  const tracked = knownAmount(trackedTriggerCostDollars) ?? 0;
  const withoutTrackedTrigger = Math.max(0, known - tracked);
  return withoutTrackedTrigger + Math.max(latestTrigger ?? 0, tracked);
};
