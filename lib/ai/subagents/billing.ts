import type { FreeLimitPolicy } from "@/lib/rate-limit/free-config";
import { checkFreeCostBudget, checkRateLimitCapacity } from "@/lib/rate-limit";
import type {
  ExtraUsageConfig,
  RateLimitInfo,
  SubscriptionTier,
} from "@/types";

type SubagentBillingCapacityInput = {
  userId: string;
  organizationId?: string;
  subscription: SubscriptionTier;
  freeQuotaSubject?: string;
  freeLimits?: FreeLimitPolicy;
  extraUsageConfig?: ExtraUsageConfig;
  modelName: string;
};

export type SubagentBillingCapacityDependencies = {
  checkFreeCostBudget: typeof checkFreeCostBudget;
  checkRateLimitCapacity: typeof checkRateLimitCapacity;
};

const defaultDependencies: SubagentBillingCapacityDependencies = {
  checkFreeCostBudget,
  checkRateLimitCapacity,
};

/**
 * Revalidate the cost capacity for a child without charging another user
 * request. A free child is part of the already-authorized parent Agent request,
 * so only its frozen shared cost budget needs another preflight check.
 */
export const checkSubagentBillingCapacity = async (
  input: SubagentBillingCapacityInput,
  dependencies: SubagentBillingCapacityDependencies = defaultDependencies,
): Promise<RateLimitInfo | undefined> => {
  if (input.subscription === "free") {
    await dependencies.checkFreeCostBudget(
      input.freeQuotaSubject ?? input.userId,
      ...(input.freeLimits ? [input.freeLimits] : []),
    );
    return undefined;
  }

  return await dependencies.checkRateLimitCapacity(
    input.userId,
    "agent",
    input.subscription,
    input.extraUsageConfig,
    input.modelName,
    input.organizationId,
    input.freeQuotaSubject,
  );
};
