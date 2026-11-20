import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import {
  checkSubagentBillingCapacity,
  createSubagentQaUsageSettlement,
  type SubagentBillingCapacityDependencies,
  type SubagentQaUsageSettlementDependencies,
} from "../billing";
import type { RateLimitInfo } from "@/types";

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

describe("createSubagentQaUsageSettlement", () => {
  const resetTime = new Date("2026-12-01T00:00:00Z");
  // A child capacity check reserves nothing; it only identifies the pool.
  const qaAdmission: RateLimitInfo = {
    remaining: 5_000,
    resetTime,
    limit: 13_000,
    monthly: { remaining: 5_000, limit: 13_000, resetTime },
    pointsDeducted: 0,
    qaSpendPool: "preview",
  };
  // $0.01 raw cost = 130 billable points at the 1.3x usage multiplier.
  const CENT_POINTS = 130;

  let poolRemaining: number;
  let currentPool: RateLimitInfo["qaSpendPool"];
  const deductUsageDelta = jest.fn<
    SubagentQaUsageSettlementDependencies["deductUsageDelta"]
  >(async (_userId, _subscription, points) => {
    const deducted = Math.min(points, poolRemaining);
    poolRemaining -= deducted;
    const uncoveredPoints = points - deducted;
    return {
      includedPointsDeducted: deducted,
      extraUsagePointsDeducted: 0,
      uncoveredPoints,
      usageDeductionFailed: uncoveredPoints > 0,
      ...(uncoveredPoints > 0 && {
        usageDeductionFailureReason: "extra_usage_unavailable" as const,
      }),
    };
  });
  const checkRateLimitCapacity = jest.fn<
    SubagentQaUsageSettlementDependencies["checkRateLimitCapacity"]
  >(async () => ({
    ...qaAdmission,
    remaining: poolRemaining,
    qaSpendPool: currentPool,
  }));
  const dependencies = { deductUsageDelta, checkRateLimitCapacity };
  const create = (
    rateLimitInfo: RateLimitInfo | undefined = qaAdmission,
    subscription: "pro" | "free" = "pro",
  ) =>
    createSubagentQaUsageSettlement(
      {
        userId: "user-qa",
        subscription,
        // A funded wallet must not matter; the QA ledger never uses it.
        extraUsageConfig: { enabled: true, hasBalance: true },
        modelName: "glm-5.3-flash",
        rateLimitInfo,
        usageSettlementId: "settlement-child",
      },
      dependencies,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    poolRemaining = 5_000;
    currentPool = "preview";
  });

  it("leaves customer and Free children on their existing billing", () => {
    // Customer admission, Free child (no paid admission), Free tier.
    expect(create({ ...qaAdmission, qaSpendPool: undefined })).toBeNull();
    expect(
      createSubagentQaUsageSettlement(
        {
          userId: "user-qa",
          subscription: "free",
          modelName: "glm-5.3-flash",
          rateLimitInfo: undefined,
          usageSettlementId: "settlement-child",
        },
        dependencies,
      ),
    ).toBeNull();
    expect(create(qaAdmission, "free")).toBeNull();
  });

  it("charges each observed delta once on the admission pool and reports the cumulative debit for final settlement", async () => {
    const settlement = create()!;

    await settlement.settle(0.01); // step finished
    await settlement.fence(0.01); // next request: nothing new to charge
    await settlement.settle(0.02); // next step finished
    await settlement.fence(0.02);

    expect(deductUsageDelta.mock.calls.map((call) => call[2])).toEqual([
      CENT_POINTS,
      CENT_POINTS,
    ]);
    for (const [index, call] of deductUsageDelta.mock.calls.entries()) {
      // Same settlement identity, increasing step sequence, admission pool.
      expect(call.slice(5)).toEqual([
        "settlement-child",
        index + 1,
        "preview",
        resetTime.getTime(),
      ]);
    }
    expect(checkRateLimitCapacity).toHaveBeenCalledTimes(2);
    expect(poolRemaining).toBe(5_000 - 2 * CENT_POINTS);
    // Final deductUsage subtracts these points instead of charging them again.
    expect(settlement.initialDeduction()).toEqual({
      pointsDeducted: 2 * CENT_POINTS,
      extraUsagePointsDeducted: 0,
    });
    expect(settlement.stopped).toBe(false);
  });

  it("does not double-charge when step completion and the request fence overlap", async () => {
    const settlement = create()!;

    await Promise.all([settlement.settle(0.01), settlement.fence(0.01)]);

    expect(deductUsageDelta).toHaveBeenCalledTimes(1);
    expect(poolRemaining).toBe(5_000 - CENT_POINTS);
  });

  it("stops a child whose admission window has rolled over", async () => {
    const settlement = create()!;
    checkRateLimitCapacity.mockResolvedValueOnce({
      ...qaAdmission,
      resetTime: new Date(resetTime.getTime() + 30 * 24 * 60 * 60 * 1_000),
    });
    await expect(settlement.fence(0)).rejects.toMatchObject({
      cause: expect.stringContaining("pool has reset"),
    });
    expect(deductUsageDelta).not.toHaveBeenCalled();
    expect(settlement.stopped).toBe(true);
  });

  it("stops before the next request when the pool cannot cover observed cost", async () => {
    poolRemaining = 200;
    const settlement = create()!;

    await settlement.settle(0.03); // 390 points against 200 remaining
    expect(settlement.stopped).toBe(true);
    await expect(settlement.fence(0.03)).rejects.toMatchObject({
      type: "rate_limit",
      metadata: expect.objectContaining({ capReason: "qa_spend_cap" }),
    });

    // No further debit and no new capacity probe after the stop.
    expect(deductUsageDelta).toHaveBeenCalledTimes(1);
    expect(checkRateLimitCapacity).not.toHaveBeenCalled();
    expect(settlement.initialDeduction()).toMatchObject({
      pointsDeducted: 200,
    });
  });

  it.each([
    ["the customer bucket", undefined],
    ["a different QA pool", "development" as const],
  ])(
    "stops when the current policy routes this child to %s",
    async (_name, pool) => {
      currentPool = pool;
      const settlement = create()!;

      await expect(settlement.fence(0)).rejects.toMatchObject({
        metadata: expect.objectContaining({ capReason: "qa_spend_cap" }),
      });
      expect(settlement.stopped).toBe(true);
      await settlement.settle(0.01);
      expect(deductUsageDelta).not.toHaveBeenCalled();
    },
  );

  it("stops when the shared pool reports exhaustion at the fence", async () => {
    const exhausted = Object.assign(new Error("QA pool exhausted"), {
      metadata: { capReason: "qa_spend_cap" },
    });
    checkRateLimitCapacity.mockRejectedValueOnce(exhausted);
    const settlement = create()!;

    await expect(settlement.fence(0)).rejects.toBe(exhausted);
    expect(settlement.stopped).toBe(true);
  });

  it("never stacks another debit on an unacknowledged one", async () => {
    deductUsageDelta.mockRejectedValueOnce(new Error("lost response"));
    const settlement = create()!;

    await settlement.settle(0.01);
    await settlement.settle(0.02);

    expect(settlement.stopped).toBe(true);
    expect(deductUsageDelta).toHaveBeenCalledTimes(1);
    // Final deductUsage then preserves acknowledged totals without charging.
    expect(settlement.initialDeduction()).toMatchObject({
      usageDeductionOutcomeUnknown: true,
    });
  });
});
