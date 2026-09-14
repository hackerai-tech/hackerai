import type { NextRequest } from "next/server";
import { createCanonicalFreeQuotaSubjectWithSecret } from "@/lib/auth/free-quota-subject-core";
import {
  FREE_QUOTA_MIGRATION_STATE,
  freeQuotaRedirectKey,
} from "@/lib/rate-limit/free-quota-migration";
import {
  getFreeMonthlyCostLimitDollars,
  getFreeRequestLimit,
} from "@/lib/rate-limit/free-config";
import {
  evaluateFreeMonthlyBudget,
  monthlyBudgetAllocation,
  captureFreeMonthlyBudgetExposure,
} from "../free-monthly-budget";
import { monthlyBudgetCountryFromRequest } from "../free-monthly-budget-request";

const mockGet = jest.fn();
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({ get: mockGet }),
}));

describe("verified free monthly budget experiment", () => {
  const env = { ...process.env };
  const subject = createCanonicalFreeQuotaSubjectWithSecret(
    "first.last+one@gmail.com",
    "synthetic-secret",
  );
  const getFeatureFlag = jest.fn();
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
    process.env.FREE_QUOTA_GMAIL_CANONICALIZATION = "true";
    process.env.VERCEL = "1";
    delete process.env.FREE_MONTHLY_COST_LIMIT_USD;
    delete process.env.FREE_RATE_LIMIT_REQUESTS;
    mockGet.mockImplementation(async (key) =>
      key === FREE_QUOTA_MIGRATION_STATE ? "complete" : null,
    );
    getFeatureFlag.mockImplementation(
      async (_key, _id, options) =>
        options.personProperties.free_monthly_budget_arm,
    );
  });
  afterEach(() => {
    process.env = { ...env };
    jest.useRealTimers();
  });

  it("keeps Gmail aliases together without sending quota identities or changing daily limits", async () => {
    process.env.FREE_RATE_LIMIT_REQUESTS = "7";
    const alias = createCanonicalFreeQuotaSubjectWithSecret(
      "f.i.r.s.t.last+two@googlemail.com",
      "synthetic-secret",
    );
    expect(alias).toBe(subject);
    const first = await evaluateFreeMonthlyBudget(args);
    const second = await evaluateFreeMonthlyBudget({
      ...args,
      userId: "different-account",
      freeQuotaSubject: alias,
    });
    expect(second).toEqual(first);
    expect(first?.dailyRequests).toBe(7);
    expect(getFreeRequestLimit(first)).toBe(7);
    expect(getFreeMonthlyCostLimitDollars(first)).toBe(
      first?.variant === "test" ? 0.5 : 0.25,
    );
    const sent = JSON.stringify(getFeatureFlag.mock.calls);
    expect(sent).not.toContain(subject);
    expect(sent).not.toContain("gmail.com");
    expect(getFeatureFlag.mock.calls[0][2].sendFeatureFlagEvents).toBe(false);
  });

  it("resolves an old durable payload to the migrated subject before bucketing", async () => {
    const old = `free_quota:v1:${"b".repeat(64)}`;
    mockGet.mockImplementation(async (key) =>
      key === FREE_QUOTA_MIGRATION_STATE
        ? "complete"
        : key === freeQuotaRedirectKey(old)
          ? subject
          : null,
    );
    await evaluateFreeMonthlyBudget({ ...args, freeQuotaSubject: old });
    expect(
      getFeatureFlag.mock.calls[0][2].personProperties
        .free_monthly_budget_bucket,
    ).toBe(monthlyBudgetAllocation(subject).bucket);
  });

  it.each([
    { subscription: "pro" },
    { subscription: "team" },
    { emailVerified: false },
    { emailVerified: undefined },
    { country: "IN" },
    { country: "PK" },
    { country: "BD" },
    { country: "NG" },
    { country: undefined },
    { country: "XX" },
    { freeQuotaSubject: undefined },
    { freeQuotaSubject: "user-id" },
  ])("does not evaluate the flag for ineligible input %j", async (patch) => {
    expect(
      await evaluateFreeMonthlyBudget({ ...args, ...patch }),
    ).toBeUndefined();
    expect(getFeatureFlag).not.toHaveBeenCalled();
  });

  it.each([null, "paused", "migrated"])(
    "requires completed migration, not %s",
    async (state) => {
      mockGet.mockResolvedValue(state);
      expect(await evaluateFreeMonthlyBudget(args)).toBeUndefined();
      expect(getFeatureFlag).not.toHaveBeenCalled();
    },
  );
  it("requires canonicalization enabled in this runtime", async () => {
    delete process.env.FREE_QUOTA_GMAIL_CANONICALIZATION;
    expect(await evaluateFreeMonthlyBudget(args)).toBeUndefined();
    expect(getFeatureFlag).not.toHaveBeenCalled();
  });
  it.each([false, true, undefined, "invalid"])(
    "does not enroll flag result %s",
    async (result) => {
      getFeatureFlag.mockResolvedValue(result);
      expect(await evaluateFreeMonthlyBudget(args)).toBeUndefined();
    },
  );
  it("rejects a remote variant inconsistent with the identity's stable arm", async () => {
    getFeatureFlag.mockResolvedValue(
      monthlyBudgetAllocation(subject).variant === "control"
        ? "test"
        : "control",
    );
    expect(await evaluateFreeMonthlyBudget(args)).toBeUndefined();
  });
  it.each(["0.10", "0.75"])(
    "does not reinterpret an operational budget override %s",
    async (limit) => {
      process.env.FREE_MONTHLY_COST_LIMIT_USD = limit;
      expect(await evaluateFreeMonthlyBudget(args)).toBeUndefined();
      expect(getFeatureFlag).not.toHaveBeenCalled();
    },
  );
  it("keeps normal allowance when evaluation fails", async () => {
    getFeatureFlag.mockRejectedValue(new Error("unavailable"));
    expect(await evaluateFreeMonthlyBudget(args)).toBeUndefined();
    mockGet.mockRejectedValue(new Error("unavailable"));
    expect(await evaluateFreeMonthlyBudget(args)).toBeUndefined();
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
    const assignment = await evaluateFreeMonthlyBudget(args);
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
