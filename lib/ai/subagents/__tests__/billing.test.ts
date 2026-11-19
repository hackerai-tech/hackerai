import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import {
  checkSubagentBillingCapacity,
  type SubagentBillingCapacityDependencies,
} from "../billing";

describe("checkSubagentBillingCapacity", () => {
  const checkFreeMonthlyCostLimit =
    jest.fn<SubagentBillingCapacityDependencies["checkFreeMonthlyCostLimit"]>();
  const checkRateLimitCapacity =
    jest.fn<SubagentBillingCapacityDependencies["checkRateLimitCapacity"]>();
  const dependencies = {
    checkFreeMonthlyCostLimit,
    checkRateLimitCapacity,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("inherits the parent daily request authorization for free children", async () => {
    checkFreeMonthlyCostLimit.mockResolvedValue({
      monthlyLimitPoints: 2_500,
      monthlyRemainingAtStart: 1_000,
      monthlyResetTime: new Date("2026-10-01T00:00:00Z"),
      extraUsageEnabledAtStart: false,
      extraUsageHasBalanceAtStart: false,
      extraUsageBalanceAtStart: 0,
      extraUsageAutoReload: false,
    });

    await expect(
      checkSubagentBillingCapacity(
        {
          userId: "user-123",
          freeQuotaSubject: "quota-subject",
          subscription: "free",
          modelName: "glm-5.3-flash",
        },
        dependencies,
      ),
    ).resolves.toBeUndefined();

    expect(checkFreeMonthlyCostLimit).toHaveBeenCalledWith("quota-subject");
    expect(checkRateLimitCapacity).not.toHaveBeenCalled();
  });

  it("still blocks free children when the monthly cost cap is exhausted", async () => {
    const error = new Error("monthly cost exhausted");
    checkFreeMonthlyCostLimit.mockRejectedValue(error);

    await expect(
      checkSubagentBillingCapacity(
        {
          userId: "user-123",
          subscription: "free",
          modelName: "glm-5.3-flash",
        },
        dependencies,
      ),
    ).rejects.toBe(error);
  });

  it("revalidates paid capacity before starting a child", async () => {
    const rateLimitInfo = {
      remaining: 5_000,
      resetTime: new Date("2026-10-01T00:00:00Z"),
      limit: 10_000,
    };
    checkRateLimitCapacity.mockResolvedValue(rateLimitInfo);
    const extraUsageConfig = {
      enabled: true,
      hasBalance: true,
      autoReloadEnabled: false,
    };

    await expect(
      checkSubagentBillingCapacity(
        {
          userId: "user-123",
          organizationId: "org-123",
          subscription: "pro",
          extraUsageConfig,
          modelName: "glm-5.3-flash",
        },
        dependencies,
      ),
    ).resolves.toBe(rateLimitInfo);

    expect(checkRateLimitCapacity).toHaveBeenCalledWith(
      "user-123",
      "agent",
      "pro",
      extraUsageConfig,
      "glm-5.3-flash",
      "org-123",
      undefined,
    );
    expect(checkFreeMonthlyCostLimit).not.toHaveBeenCalled();
  });
});
