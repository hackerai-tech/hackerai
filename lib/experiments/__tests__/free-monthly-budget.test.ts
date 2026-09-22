import type { NextRequest } from "next/server";
import { getFreeMonthlyCostLimitDollars } from "@/lib/rate-limit/free-config";
import {
  evaluateFreeMonthlyBudget,
  captureFreeMonthlyBudgetExposure,
  type FreeMonthlyBudgetAssignment,
} from "../free-monthly-budget";
import { monthlyBudgetCountryFromRequest } from "../free-monthly-budget-request";

describe("verified free monthly budget experiment", () => {
  const env = { ...process.env };
  const subject = `free_quota:v1:${"a".repeat(64)}`;
  const getFeatureFlag = jest.fn().mockResolvedValue("test");
  const args = {
    posthog: { getFeatureFlag },
    userId: "synthetic-user",
    subscription: "free",
    emailVerified: true,
    country: "US",
    freeQuotaSubject: subject,
  };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VERCEL = "1";
    delete process.env.FREE_MONTHLY_COST_LIMIT_USD;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("keeps enrollment disabled even when the remote flag would offer the larger budget", async () => {
    const assignment = await evaluateFreeMonthlyBudget(args);
    expect(assignment).toBeUndefined();
    expect(getFeatureFlag).not.toHaveBeenCalled();
    expect(getFreeMonthlyCostLimitDollars(assignment)).toBe(0.25);
  });

  it("never raises an ordinary regional policy or a stricter emergency cap", () => {
    expect(
      getFreeMonthlyCostLimitDollars({
        dailyRequests: 10,
        monthlyCostDollars: 0.5,
      }),
    ).toBe(0.25);
    process.env.FREE_MONTHLY_COST_LIMIT_USD = "0.1";
    expect(
      getFreeMonthlyCostLimitDollars({
        dailyRequests: 10,
        monthlyCostDollars: 0.5,
        monthlyBudgetExperiment: "free_monthly_budget_v1",
      }),
    ).toBe(0.1);
  });

  const request = (
    country?: string,
    consent?: string,
    fallbackCountry?: string,
  ) =>
    ({
      headers: new Headers({
        ...(country ? { "x-vercel-ip-country": country } : {}),
        ...(fallbackCountry ? { "cf-ipcountry": fallbackCountry } : {}),
      }),
      cookies: { get: () => (consent ? { value: consent } : undefined) },
    }) as unknown as NextRequest;
  it("requires trusted ingress and respects explicit declines and EU consent", () => {
    expect(monthlyBudgetCountryFromRequest(request("US"))).toBe("US");
    expect(
      monthlyBudgetCountryFromRequest(request("US", "declined")),
    ).toBeUndefined();
    expect(monthlyBudgetCountryFromRequest(request("DE"))).toBeUndefined();
    expect(monthlyBudgetCountryFromRequest(request("DE", "accepted"))).toBe(
      "DE",
    );
    expect(
      monthlyBudgetCountryFromRequest(request(undefined, "accepted", "US")),
    ).toBeUndefined();
    expect(
      monthlyBudgetCountryFromRequest(request("NG", "accepted")),
    ).toBeUndefined();
    delete process.env.VERCEL;
    expect(
      monthlyBudgetCountryFromRequest(request("US", "accepted")),
    ).toBeUndefined();
  });

  it("captures enforcement exposure before any usage and bounds failed delivery", async () => {
    const assignment: FreeMonthlyBudgetAssignment = {
      monthlyBudgetExperiment: "free_monthly_budget_v1",
      variant: "test",
      dailyRequests: 10,
      monthlyCostDollars: 0.5,
    };
    const capture = jest.fn();
    const flush = jest.fn().mockRejectedValue(new Error("offline"));
    await expect(
      captureFreeMonthlyBudgetExposure(
        { capture, flush },
        assignment,
        args.userId,
        "ask",
      ),
    ).resolves.toBeUndefined();
    const event = capture.mock.calls[0][0];
    expect(event.event).toBe("free_monthly_budget_exposed");
    expect(event.properties).toMatchObject({
      exposure_surface: "quota_enforcement",
      free_monthly_budget_variant: assignment?.variant,
    });
    expect(JSON.stringify(event)).not.toContain(subject);
    capture.mockClear();
    await captureFreeMonthlyBudgetExposure(
      { capture, flush },
      undefined,
      args.userId,
      "ask",
    );
    expect(capture).not.toHaveBeenCalled();
  });
});
