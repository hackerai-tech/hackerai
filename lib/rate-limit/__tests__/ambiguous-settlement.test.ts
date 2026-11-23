import type { PostHog } from "posthog-node";
import { UsageTracker } from "@/lib/usage-tracker";
import {
  captureUsageSettlement,
  captureUsageCost,
} from "@/lib/api/chat-logger";
jest.mock("next/server", () => ({ after: jest.fn() }));
import { deductUsageDelta, deductUsage } from "@/lib/rate-limit/token-bucket";
import {
  createUsageSettlementState,
  addUsageDeductionDelta,
  getUsageSettlementInitialDeduction,
  shouldSettleUsageMidRun,
  replaceUsageSettlementState,
} from "@/lib/rate-limit/usage-settlement";
jest.mock("@/lib/db/actions", () => ({ logUsageRecord: jest.fn() }));
const originalServiceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
beforeAll(() => {
  process.env.CONVEX_SERVICE_ROLE_KEY = "fixture-service-key";
});
afterAll(() => {
  if (originalServiceKey === undefined)
    delete process.env.CONVEX_SERVICE_ROLE_KEY;
  else process.env.CONVEX_SERVICE_ROLE_KEY = originalServiceKey;
});
const mockAction = jest.fn();
const mockReceiptQuery = jest.fn();
const mockRefund = jest.fn();
const mockRedisEval = jest.fn();
beforeEach(() => {
  mockAction.mockReset();
  mockReceiptQuery.mockReset().mockResolvedValue(null);
  mockRefund.mockReset();
  mockRedisEval.mockReset();
});
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    action: mockAction,
    query: mockReceiptQuery,
    mutation: mockRefund,
  }),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { error: jest.fn(), warn: jest.fn() },
}));
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    hget: async () => null,
    eval: mockRedisEval,
  }),
  formatTimeRemaining: () => "",
}));
jest.mock("@/lib/rate-limit/paid-bucket", () => ({
  limitPaidBucket: async () => ({
    success: true,
    remaining: 0,
    reset: 0,
    deducted: 0,
  }),
}));
it.each(["pro", "team"] as const)(
  "does not debit %s again after a committed mid-run debit loses its response",
  async (subscription) => {
    const organizationId = subscription === "team" ? "fixture-org" : undefined;
    let wallet = 1000;
    mockReceiptQuery.mockImplementation(async (_ref, args) => ({
      operation_id: args.operation_id,
      user_id: args.user_id,
      organization_id: args.organization_id,
      usage_settlement_id: "fixture-settlement",
      amount_points: 43,
      status: "pending",
      created_at: 1,
      debits: [
        {
          outcome: "applied",
          previous_balance_points: 1000,
          new_balance_points: 957,
        },
      ],
    }));
    mockAction
      .mockImplementationOnce(async (_ref, args) => {
        wallet -= args.amountPoints;
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
          }),
        });
      })
      .mockImplementation(async (_ref, args) => {
        wallet -= args.amountPoints;
        return {
          success: true,
          newBalanceDollars: wallet / 10000,
          insufficientFunds: false,
          monthlyCapExceeded: false,
        };
      });
    const config = {
      enabled: true,
      hasBalance: true,
      autoReloadEnabled: false,
    };
    const state = createUsageSettlementState({
      remaining: 0,
      resetTime: new Date(),
      limit: 250000,
      pointsDeducted: 0,
    });
    const delta = await deductUsageDelta(
      "fixture-user",
      subscription,
      43,
      config,
      organizationId,
      "fixture-settlement",
      1,
    );
    addUsageDeductionDelta(state, delta);
    expect(
      shouldSettleUsageMidRun({
        state,
        currentCostDollars: 60 / 12000,
        force: true,
      }),
    ).toBe(false);
    const final = await deductUsage(
      "fixture-user",
      subscription,
      0,
      0,
      0,
      config,
      60 / 12000,
      undefined,
      0,
      organizationId,
      getUsageSettlementInitialDeduction(state),
      undefined,
      "fixture-settlement",
    );
    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(mockReceiptQuery).toHaveBeenCalledTimes(1);
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockRedisEval).not.toHaveBeenCalled();
    expect(wallet).toBe(957);
    expect(final.usageDeductionFailed).toBe(true);
    expect(final.usageDeductionOutcomeUnknown).toBe(true);
    replaceUsageSettlementState(state, final);
    expect(state.usageDeductionOutcomeUnknown).toBe(true);
  },
);

it.each(["pro", "team"] as const)(
  "accounts for a completed %s receipt through delta and finalization without another financial call",
  async (subscription) => {
    const organizationId = subscription === "team" ? "fixture-org" : undefined;
    let wallet = 1000;
    let saved: Record<string, unknown> | null = null;
    mockAction.mockImplementationOnce(async (_ref, args) => {
      wallet -= args.amountPoints;
      saved = {
        operation_id: args.settlementOperationId,
        user_id: args.userId,
        organization_id: args.organizationId,
        usage_settlement_id: args.usageSettlementId,
        amount_points: args.amountPoints,
        status: "completed",
        result: {
          success: true,
          newBalanceDollars: wallet * 0.00015,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          autoReloadTriggered: false,
        },
        debits: [
          {
            outcome: "applied",
            previous_balance_points: 1000,
            new_balance_points: wallet,
            result: { success: true },
          },
        ],
      };
      throw new TypeError("fetch failed");
    });
    mockReceiptQuery.mockImplementation(async () => saved);
    const config = {
      enabled: true,
      hasBalance: true,
      autoReloadEnabled: false,
    };
    const state = createUsageSettlementState({
      remaining: 0,
      resetTime: new Date(),
      limit: 250000,
      pointsDeducted: 0,
    });
    const delta = await deductUsageDelta(
      "fixture-user",
      subscription,
      43,
      config,
      organizationId,
      "fixture-settlement",
      1,
    );
    addUsageDeductionDelta(state, delta);
    expect(delta).toMatchObject({
      extraUsagePointsDeducted: 43,
      uncoveredPoints: 0,
      usageDeductionFailed: false,
    });
    const final = await deductUsage(
      "fixture-user",
      subscription,
      0,
      0,
      0,
      config,
      43 / 12000,
      undefined,
      0,
      organizationId,
      getUsageSettlementInitialDeduction(state),
      undefined,
      "fixture-settlement",
    );
    expect(final).toMatchObject({
      extraUsagePointsDeducted: 43,
      uncoveredPoints: 0,
      usageDeductionFailed: false,
    });
    expect(final.usageDeductionOutcomeUnknown).not.toBe(true);
    expect(wallet).toBe(957);
    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(mockReceiptQuery).toHaveBeenCalledTimes(1);
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockRedisEval).not.toHaveBeenCalled();
  },
);

it("does not refund acknowledged points while another debit outcome is unknown", async () => {
  mockAction.mockRejectedValueOnce(new TypeError("fetch failed"));
  const config = { enabled: true, hasBalance: true, autoReloadEnabled: false };
  const state = createUsageSettlementState({
    remaining: 0,
    resetTime: new Date(),
    limit: 250000,
    pointsDeducted: 7,
    extraUsagePointsDeducted: 11,
  });
  addUsageDeductionDelta(
    state,
    await deductUsageDelta("fixture-user", "pro", 43, config),
  );
  const final = await deductUsage(
    "fixture-user",
    "pro",
    0,
    0,
    0,
    config,
    0,
    undefined,
    0,
    undefined,
    getUsageSettlementInitialDeduction(state),
  );
  expect(mockAction).toHaveBeenCalledTimes(1);
  expect(mockRefund.mock.calls.length).toBe(0);
  expect(mockRedisEval).not.toHaveBeenCalled();
  expect(final).toMatchObject({
    includedPointsDeducted: 7,
    extraUsagePointsDeducted: 11,
    usageDeductionOutcomeUnknown: true,
    usageDeductionFailed: true,
  });
});
it("retains normal final settlement after a definite insufficient-funds rejection", async () => {
  mockAction
    .mockResolvedValueOnce({
      success: false,
      newBalanceDollars: 0,
      insufficientFunds: true,
      monthlyCapExceeded: false,
    })
    .mockResolvedValueOnce({
      success: true,
      newBalanceDollars: 1,
      insufficientFunds: false,
      monthlyCapExceeded: false,
    });
  const config = { enabled: true, hasBalance: true, autoReloadEnabled: false };
  const state = createUsageSettlementState({
    remaining: 0,
    resetTime: new Date(),
    limit: 250000,
    pointsDeducted: 0,
  });
  addUsageDeductionDelta(
    state,
    await deductUsageDelta("fixture-user", "pro", 43, config),
  );
  const final = await deductUsage(
    "fixture-user",
    "pro",
    0,
    0,
    0,
    config,
    60 / 12000,
    undefined,
    0,
    undefined,
    getUsageSettlementInitialDeduction(state),
  );
  expect(mockAction).toHaveBeenCalledTimes(2);
  expect(final).toMatchObject({
    extraUsagePointsDeducted: 60,
    uncoveredPoints: 0,
    usageDeductionFailed: false,
  });
});

it("keeps unknown debit state visible in existing final and step events", () => {
  const deduction = {
    includedPointsDeducted: 7,
    extraUsagePointsDeducted: 11,
    uncoveredPoints: 43,
    usageDeductionFailed: true,
    usageDeductionFailureReason: "deduction_failed" as const,
    usageDeductionOutcomeUnknown: true,
  };
  const tracker = new UsageTracker();
  const cost = tracker.createUsageCostRecord({
    selectedModel: "auto",
    configuredModelId: "auto",
    rateLimitInfo: { remaining: 0, resetTime: new Date(), limit: 250000 },
    billingBreakdown: deduction,
  });
  expect(cost).toMatchObject({
    usageDeductionFailed: true,
    usageDeductionOutcomeUnknown: true,
    extraUsagePointsDeducted: 11,
  });
  const capture = jest.fn();
  const context = {
    posthog: { capture } as unknown as PostHog,
    userId: "fixture-user",
    subscription: "pro",
    chatId: "fixture-chat",
    endpoint: "/api/agent-long" as const,
    mode: "agent" as const,
  };
  captureUsageCost({ ...context, usage: cost });
  captureUsageSettlement({
    ...context,
    model: "auto",
    usageSettlementId: "fixture-settlement",
    settlementSequence: 1,
    currentCostDollars: 0.05,
    requestedDeltaPoints: 43,
    deduction,
    forced: false,
  });
  expect(capture).toHaveBeenCalledTimes(2);
  for (const [event] of capture.mock.calls)
    expect(event.properties).toMatchObject({
      usage_deduction_failed: true,
      usage_deduction_outcome_unknown: true,
      extra_usage_points_deducted: 11,
    });
});
