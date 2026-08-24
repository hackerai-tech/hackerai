import { describe, expect, it } from "@jest/globals";

import { resolveTriggerRunCost } from "@/lib/billing/trigger-run-cost";

describe("resolveTriggerRunCost", () => {
  it("uses Trigger's authoritative total for the machine assigned to the run", () => {
    const small1x = resolveTriggerRunCost({
      compute: { total: { costInCents: 10, durationMs: 36_000 } },
      baseCostInCents: 0.5,
      totalCostInCents: 10.5,
    });
    const small2x = resolveTriggerRunCost({
      compute: { total: { costInCents: 20, durationMs: 36_000 } },
      baseCostInCents: 0.5,
      totalCostInCents: 20.5,
    });

    expect(small1x.totalCostDollars).toBe(0.105);
    expect(small2x.totalCostDollars).toBe(0.205);
    expect(small2x.totalCostDollars).toBeGreaterThan(small1x.totalCostDollars);
  });

  it("keeps compute, invocation, duration, and total available for telemetry", () => {
    expect(
      resolveTriggerRunCost({
        compute: { total: { costInCents: 25, durationMs: 123_456 } },
        baseCostInCents: 0.5,
        totalCostInCents: 25.5,
      }),
    ).toEqual({
      totalCostDollars: 0.255,
      computeCostDollars: 0.25,
      baseCostDollars: 0.005,
      durationMs: 123_456,
    });
  });

  it("does not pass invalid negative or non-finite usage into billing", () => {
    expect(
      resolveTriggerRunCost({
        compute: {
          total: { costInCents: Number.POSITIVE_INFINITY, durationMs: -1 },
        },
        baseCostInCents: Number.NaN,
        totalCostInCents: -5,
      }),
    ).toEqual({
      totalCostDollars: 0,
      computeCostDollars: 0,
      baseCostDollars: 0,
      durationMs: 0,
    });
  });
});
