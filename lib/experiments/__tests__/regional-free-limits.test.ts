import {
  evaluateRegionalFreeLimits,
  captureRegionalFreeLimitsExposure,
  regionalFreeLimitsProperties,
  REGIONAL_FREE_LIMITS_KEY,
} from "../regional-free-limits";
import { regionalFreeCountryFromRequest } from "../regional-free-limits-request";
import type { NextRequest } from "next/server";

describe("regional free allowance", () => {
  const getFeatureFlag = jest.fn();
  const posthog = { getFeatureFlag };
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VERCEL = "1";
    delete process.env.FREE_RATE_LIMIT_REQUESTS;
    delete process.env.FREE_MONTHLY_COST_LIMIT_USD;
    getFeatureFlag.mockResolvedValue("test");
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it.each(["IN", "PK", "BD"])(
    "uses a stable account flag and reduced limits for %s",
    async (country) => {
      const result = await evaluateRegionalFreeLimits({
        posthog,
        userId: "test-user",
        subscription: "free",
        country,
      });
      expect(result).toMatchObject({
        country,
        variant: "test",
        dailyRequests: 3,
        monthlyCostDollars: 0.1,
      });
      expect(getFeatureFlag).toHaveBeenCalledWith(
        REGIONAL_FREE_LIMITS_KEY,
        "test-user",
        {
          sendFeatureFlagEvents: false,
          personProperties: {
            regional_free_country: country,
            subscription: "free",
          },
        },
      );
    },
  );

  it.each(["pro", "pro-plus", "ultra", "team"])(
    "never changes %s limits",
    async (subscription) => {
      expect(
        await evaluateRegionalFreeLimits({
          posthog,
          userId: "test-user",
          subscription,
          country: "IN",
        }),
      ).toBeUndefined();
      expect(getFeatureFlag).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "US", "XX", "", "India"])(
    "excludes non-target/unknown country %s",
    async (country) => {
      expect(
        await evaluateRegionalFreeLimits({
          posthog,
          userId: "test-user",
          subscription: "free",
          country,
        }),
      ).toBeUndefined();
      expect(getFeatureFlag).not.toHaveBeenCalled();
    },
  );

  it("keeps configured control limits and never raises a stricter existing cap", async () => {
    process.env.FREE_RATE_LIMIT_REQUESTS = "8";
    process.env.FREE_MONTHLY_COST_LIMIT_USD = "0.20";
    getFeatureFlag.mockResolvedValue("control");
    expect(
      await evaluateRegionalFreeLimits({
        posthog,
        userId: "test-user",
        subscription: "free",
        country: "IN",
      }),
    ).toMatchObject({ dailyRequests: 8, monthlyCostDollars: 0.2 });
    process.env.FREE_RATE_LIMIT_REQUESTS = "2";
    process.env.FREE_MONTHLY_COST_LIMIT_USD = "0.05";
    getFeatureFlag.mockResolvedValue("test");
    expect(
      await evaluateRegionalFreeLimits({
        posthog,
        userId: "test-user",
        subscription: "free",
        country: "IN",
      }),
    ).toMatchObject({ dailyRequests: 2, monthlyCostDollars: 0.05 });
  });

  it.each([false, true, undefined, "unexpected"])(
    "does not enroll disabled or invalid flag value %s",
    async (value) => {
      getFeatureFlag.mockResolvedValue(value);
      expect(
        await evaluateRegionalFreeLimits({
          posthog,
          userId: "test-user",
          subscription: "free",
          country: "IN",
        }),
      ).toBeUndefined();
    },
  );
  it("fails open to normal limits on flag lookup errors", async () => {
    getFeatureFlag.mockRejectedValue(new Error("offline"));
    expect(
      await evaluateRegionalFreeLimits({
        posthog,
        userId: "test-user",
        subscription: "free",
        country: "IN",
      }),
    ).toBeUndefined();
  });
  it("requires trusted ingress and respects declined consent", () => {
    const req = (headers: Record<string, string>) =>
      ({
        headers: new Headers(headers),
        cookies: {
          get: () =>
            headers.cookie
              ? { value: headers.cookie.split("=")[1] }
              : undefined,
        },
      }) as unknown as NextRequest;
    expect(
      regionalFreeCountryFromRequest(req({ "x-vercel-ip-country": "IN" })),
    ).toBe("IN");
    expect(
      regionalFreeCountryFromRequest(
        req({
          "x-vercel-ip-country": "IN",
          cookie: "hackerai_analytics_consent=declined",
        }),
      ),
    ).toBeUndefined();
    expect(
      regionalFreeCountryFromRequest(req({ "cf-ipcountry": "IN" })),
    ).toBeUndefined();
    delete process.env.VERCEL;
    expect(
      regionalFreeCountryFromRequest(req({ "x-vercel-ip-country": "IN" })),
    ).toBeUndefined();
  });
  it("emits exposure only explicitly at enforcement and preserves other experiment dimensions", async () => {
    const capture = jest.fn();
    const flush = jest.fn().mockResolvedValue(undefined);
    const assignment = await evaluateRegionalFreeLimits({
      posthog,
      userId: "test-user",
      subscription: "free",
      country: "IN",
    });
    expect(capture).not.toHaveBeenCalled();
    await captureRegionalFreeLimitsExposure(
      { capture, flush },
      assignment,
      "test-user",
      "ask",
    );
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "regional_free_limits_exposed",
        properties: expect.objectContaining({
          regional_free_variant: "test",
          regional_free_country: "IN",
          $geoip_disable: true,
        }),
      }),
    );
    expect(regionalFreeLimitsProperties(assignment)).not.toHaveProperty(
      "experiment_key",
    );
    expect(flush).toHaveBeenCalledTimes(1);
    capture.mockClear();
    await captureRegionalFreeLimitsExposure(
      { capture, flush },
      undefined,
      "test-user",
      "ask",
    );
    expect(capture).not.toHaveBeenCalled();
  });
});
