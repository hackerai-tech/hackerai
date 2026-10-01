import {
  checkFreeCostBudget,
  FreeDailyCostSettlement,
} from "../free-cost-budget";
import {
  checkFreeMonthlyCostLimit,
  recordFreeMonthlyCost,
} from "../free-monthly-cost";
import { createRedisClient } from "../redis";
import type { FreeLimitPolicy } from "../free-config";

jest.mock("../redis");
jest.mock("../free-monthly-cost");
const get = jest.fn();
const evalCost = jest.fn();
const policy: FreeLimitPolicy = {
  dailyRequests: 3,
  monthlyCostDollars: 0.1,
  agentDailyBudget: {
    bucket: "2026-10-01",
    resetTimestamp: Date.parse("2026-10-02T00:00:00Z"),
  },
};

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-10-01T23:59:00Z"));
  jest.clearAllMocks();
  jest
    .mocked(createRedisClient)
    .mockReturnValue({ get, eval: evalCost } as unknown as NonNullable<
      ReturnType<typeof createRedisClient>
    >);
  get.mockResolvedValue(700);
  evalCost.mockResolvedValue(900);
});
afterEach(() => jest.useRealTimers());

it("control preserves the regional monthly budget and existing ledger", async () => {
  const regional = { dailyRequests: 3, monthlyCostDollars: 0.1 };
  await checkFreeCostBudget("quota", regional);
  expect(checkFreeMonthlyCostLimit).toHaveBeenCalledWith("quota", regional);
  expect(get).not.toHaveBeenCalled();
});
it("treatment reads shared daily cost with no monthly admission gate", async () => {
  const snapshot = await checkFreeCostBudget("quota", policy);
  expect(get).toHaveBeenCalledWith("free_agent_daily_cost:quota:2026-10-01");
  expect(checkFreeMonthlyCostLimit).not.toHaveBeenCalled();
  expect(snapshot).toMatchObject({
    monthlyLimitPoints: 1000,
    monthlyRemainingAtStart: 300,
    budgetPeriod: "daily",
    capReasonOnExhaustion: "free_daily_cost_exhausted",
  });
  expect(snapshot.monthlyResetTime.toISOString()).toBe(
    "2026-10-02T00:00:00.000Z",
  );
});
it("denies an exhausted daily allowance with a distinct cap and next-day reset", async () => {
  get.mockResolvedValue(1010);
  await expect(checkFreeCostBudget("quota", policy)).rejects.toMatchObject({
    metadata: expect.objectContaining({
      capReason: "free_daily_cost_exhausted",
    }),
  });
});
it("settles cumulative actual cost into the original day and monthly shadow ledger", async () => {
  jest.setSystemTime(new Date("2026-10-02T00:01:00Z"));
  evalCost.mockResolvedValueOnce(201).mockResolvedValueOnce(500);
  const settlement = new FreeDailyCostSettlement("quota", policy, "attempt");
  await settlement.settle(0.02001);
  await settlement.settle(0.01);
  await settlement.settle(0.05);
  expect(evalCost).toHaveBeenCalledTimes(2);
  expect(evalCost).toHaveBeenNthCalledWith(
    1,
    expect.any(String),
    [
      "free_agent_daily_cost:quota:2026-10-01",
      "free_monthly_cost:quota:2026-10",
      "free_agent_daily_settlement:quota:attempt",
    ],
    [
      201,
      policy.agentDailyBudget!.resetTimestamp + 7 * 86400000,
      Date.parse("2026-11-01T00:00:00Z"),
    ],
  );
  expect(settlement.settledPoints).toBe(500);
});
it("does not allow a durable approval to reopen yesterday's quota", async () => {
  jest.setSystemTime(new Date("2026-10-02T00:01:00Z"));
  await expect(checkFreeCostBudget("quota", policy)).rejects.toMatchObject({
    cause: expect.stringContaining("daily allowance window has ended"),
  });
  expect(get).not.toHaveBeenCalled();
});
it("fails closed on invalid ledger data", async () => {
  get.mockResolvedValue("bad");
  await expect(checkFreeCostBudget("quota", policy)).rejects.toMatchObject({
    cause: "Rate limiting service returned invalid usage",
  });
});
it("retries cumulative settlement after a lost response without advancing local state", async () => {
  evalCost
    .mockRejectedValueOnce(new Error("redis unavailable"))
    .mockResolvedValueOnce(200);
  const settlement = new FreeDailyCostSettlement("quota", policy, "attempt");
  await expect(settlement.settle(0.02)).rejects.toThrow("redis unavailable");
  expect(settlement.settledPoints).toBe(0);
  await settlement.settle(0.02);
  expect(evalCost.mock.calls[0]).toEqual(evalCost.mock.calls[1]);
  expect(settlement.settledPoints).toBe(200);
});
