import {
  evaluateFreeAgentBudget,
  freeAgentBudgetPolicy,
  freeAgentBudgetProperties,
  FREE_AGENT_DAILY_COST_KEY,
} from "../free-agent-budget";
import { getExperimentAnalyticsProperties } from "@/lib/analytics/experiment-context";
import type { PostHog } from "posthog-node";
const capture = jest.fn();
const getFeatureFlagResult = jest.fn();
const posthog = { capture, getFeatureFlagResult } as unknown as Pick<
  PostHog,
  "capture" | "getFeatureFlagResult"
>;
const input = {
  posthog,
  userId: "user",
  subscription: "free" as const,
  mode: "agent" as const,
  requestId: "attempt",
};
beforeEach(() => {
  jest.clearAllMocks();
  getFeatureFlagResult.mockResolvedValue({ enabled: true, variant: "test" });
});
it("does not evaluate Ask or paid requests", async () => {
  expect(
    await evaluateFreeAgentBudget({ ...input, mode: "ask" }),
  ).toBeUndefined();
  expect(
    await evaluateFreeAgentBudget({ ...input, subscription: "pro" }),
  ).toBeUndefined();
  expect(getFeatureFlagResult).not.toHaveBeenCalled();
});
it("records exposure before any quota or provider requirement", async () => {
  expect(await evaluateFreeAgentBudget(input)).toEqual({ variant: "test" });
  expect(getFeatureFlagResult).toHaveBeenCalledWith(
    FREE_AGENT_DAILY_COST_KEY,
    "user",
    { sendFeatureFlagEvents: false },
  );
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "free_agent_budget_experiment_exposed",
      distinctId: "user",
      properties: expect.objectContaining({
        exposure_surface: "agent_quota_check",
        request_id: "attempt",
        experiment_variant: "test",
      }),
    }),
  );
});
it("preserves baseline for disabled, unknown, and unavailable flags", async () => {
  for (const variant of [false, undefined, "bad"]) {
    getFeatureFlagResult.mockResolvedValue(
      variant === false || variant === undefined
        ? undefined
        : { enabled: true, variant },
    );
    expect(await evaluateFreeAgentBudget(input)).toBeUndefined();
  }
  getFeatureFlagResult.mockRejectedValue(new Error("timeout"));
  expect(await evaluateFreeAgentBudget(input)).toBeUndefined();
  expect(capture).not.toHaveBeenCalled();
});
it("capture failure leaves the assigned billing policy intact", async () => {
  capture.mockImplementationOnce(() => {
    throw new Error("capture unavailable");
  });
  expect(await evaluateFreeAgentBudget(input)).toEqual({ variant: "test" });
});
it("freezes a UTC day while preserving regional policy for control", () => {
  const regional = { dailyRequests: 3, monthlyCostDollars: 0.1 };
  expect(freeAgentBudgetPolicy({ variant: "control" }, regional)).toBe(
    regional,
  );
  expect(freeAgentBudgetPolicy(undefined, regional)).toBe(regional);
  expect(
    freeAgentBudgetPolicy(
      { variant: "test" },
      regional,
      new Date("2026-10-01T23:59:00Z"),
    )?.agentDailyBudget,
  ).toEqual({
    bucket: "2026-10-01",
    resetTimestamp: Date.parse("2026-10-02T00:00:00Z"),
  });
});
it("budget attribution cannot overwrite model experiment attribution", () => {
  const props = {
    ...getExperimentAnalyticsProperties({
      key: "model_experiment",
      variant: "control",
    }),
    ...freeAgentBudgetProperties({ variant: "test" }),
  };
  expect(props).toMatchObject({
    experiment_key: "model_experiment",
    experiment_variant: "control",
    free_agent_budget_experiment_variant: "test",
    "$feature/model_experiment": "control",
    ["$feature/" + FREE_AGENT_DAILY_COST_KEY]: "test",
  });
});
