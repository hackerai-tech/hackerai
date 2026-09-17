import {
  getRegionalFreeLimits,
  regionalFreeLimitsProperties,
} from "../regional-free-limits";
import { regionalFreeCountryFromRequest } from "../regional-free-limits-request";
import type { NextRequest } from "next/server";

describe("permanent regional free allowance", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.VERCEL = "1";
    delete process.env.FREE_RATE_LIMIT_REQUESTS;
    delete process.env.FREE_MONTHLY_COST_LIMIT_USD;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const policy = (country?: string, subscription = "free", userId = "user") =>
    getRegionalFreeLimits({ userId, subscription, country });
  const req = (headers: Record<string, string>, consent?: string) =>
    ({
      headers: new Headers(headers),
      cookies: { get: () => (consent ? { value: consent } : undefined) },
    }) as unknown as NextRequest;

  it.each(["IN", "PK", "BD", "NG"])(
    "applies the default policy in %s without analytics or flag availability",
    (country) => {
      expect(policy(country)).toEqual({
        country,
        dailyRequests: 3,
        monthlyCostDollars: 0.1,
      });
      expect(
        regionalFreeCountryFromRequest(req({ "x-vercel-ip-country": country })),
      ).toBe(country);
    },
  );

  it.each(["pro", "pro-plus", "ultra", "team"])(
    "preserves %s entitlements",
    (subscription) => expect(policy("IN", subscription)).toBeUndefined(),
  );
  it.each([undefined, "US", "XX", "", "India", "in"])(
    "preserves normal limits for unknown or excluded country %s",
    (country) => expect(policy(country)).toBeUndefined(),
  );
  it("requires an authenticated identity", () => {
    expect(policy("IN", "free", "")).toBeUndefined();
  });
  it("never raises stricter operational limits", () => {
    process.env.FREE_RATE_LIMIT_REQUESTS = "2";
    process.env.FREE_MONTHLY_COST_LIMIT_USD = "0.05";
    expect(policy("IN")).toMatchObject({
      dailyRequests: 2,
      monthlyCostDollars: 0.05,
    });
  });
  it.each(["IN", "PK", "BD", "NG"])(
    "preserves the consent opt-out in %s",
    (country) => {
      const trustedCountry = regionalFreeCountryFromRequest(
        req({ "x-vercel-ip-country": country }, "declined"),
      );
      expect(trustedCountry).toBeUndefined();
      expect(policy(trustedCountry)).toBeUndefined();
    },
  );
  it("requires Vercel ingress and does not trust Cloudflare country headers", () => {
    expect(
      regionalFreeCountryFromRequest(req({ "cf-ipcountry": "IN" })),
    ).toBeUndefined();
    delete process.env.VERCEL;
    expect(
      regionalFreeCountryFromRequest(req({ "x-vercel-ip-country": "IN" })),
    ).toBeUndefined();
  });
  it("normalizes trusted country values but rejects missing or excluded values", () => {
    expect(
      regionalFreeCountryFromRequest(req({ "x-vercel-ip-country": " ng " })),
    ).toBe("NG");
    expect(regionalFreeCountryFromRequest(req({}))).toBeUndefined();
    expect(
      regionalFreeCountryFromRequest(req({ "x-vercel-ip-country": "US" })),
    ).toBeUndefined();
  });
  it("records policy dimensions without attributing new requests to the ended experiment", () => {
    expect(regionalFreeLimitsProperties(policy("IN"))).toEqual({
      regional_free_policy_version: 1,
      regional_free_country: "IN",
      regional_free_daily_requests: 3,
      regional_free_monthly_cost_dollars: 0.1,
    });
    expect(regionalFreeLimitsProperties()).toEqual({});
  });
});
