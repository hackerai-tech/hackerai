import type { NextRequest } from "next/server";
import {
  evaluateRegionalSubscriptionFirst,
  enforceRegionalSubscriptionFirst,
  subscriptionFirstCountryFromRequest,
} from "../regional-subscription-first.server";

const mockGetFeatureFlag = jest.fn();
const mockCapture = jest.fn();
const mockFlush = jest.fn();
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({
    getFeatureFlag: mockGetFeatureFlag,
    capture: mockCapture,
    flush: mockFlush,
  }),
}));

const base = {
  userId: "user-1",
  subscription: "free",
  country: "IN",
  surface: "ask" as const,
};
const request = (country?: string, consent?: string, vercelHeader = true) =>
  ({
    headers: new Headers(
      country
        ? { [vercelHeader ? "x-vercel-ip-country" : "cf-ipcountry"]: country }
        : {},
    ),
    cookies: { get: () => (consent ? { value: consent } : undefined) },
  }) as unknown as NextRequest;

describe("regional subscription access", () => {
  const originalVercel = process.env.VERCEL;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VERCEL = "1";
    mockGetFeatureFlag.mockResolvedValue("test");
    mockFlush.mockResolvedValue(undefined);
  });
  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
    jest.useRealTimers();
  });

  it.each(["IN", "PK", "BD", "NG"])(
    "requires payment for a treatment request from %s",
    async (country) => {
      await expect(
        enforceRegionalSubscriptionFirst({ ...base, country }),
      ).rejects.toMatchObject({
        statusCode: 403,
        metadata: { subscription_required: true },
      });
      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: base.userId,
          properties: expect.objectContaining({
            regional_subscription_country: country,
            exposure_surface: "ask",
          }),
        }),
      );
    },
  );

  it.each(["pro", "pro-plus", "ultra", "team"])(
    "preserves %s access even under treatment",
    async (subscription) => {
      await expect(
        enforceRegionalSubscriptionFirst({ ...base, subscription }),
      ).resolves.toBeUndefined();
      expect(mockGetFeatureFlag).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "US", "XX", "", "India"])(
    "excludes unknown or out-of-scope country %s",
    async (country) => {
      await expect(
        enforceRegionalSubscriptionFirst({ ...base, country }),
      ).resolves.toBeUndefined();
      expect(mockGetFeatureFlag).not.toHaveBeenCalled();
    },
  );

  it.each([false, true, undefined, "unexpected"])(
    "preserves access for inactive/invalid flag %s",
    async (value) => {
      mockGetFeatureFlag.mockResolvedValue(value);
      await expect(
        enforceRegionalSubscriptionFirst(base),
      ).resolves.toBeUndefined();
      expect(mockCapture).not.toHaveBeenCalled();
    },
  );

  it("allows controls and captures their zero-cost exposure", async () => {
    mockGetFeatureFlag.mockResolvedValue("control");
    await expect(enforceRegionalSubscriptionFirst(base)).resolves.toEqual({
      variant: "control",
      country: "IN",
    });
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it("does not count a presentation lookup as exposure", async () => {
    await evaluateRegionalSubscriptionFirst(base);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockGetFeatureFlag).toHaveBeenCalledWith(
      "regional_subscription_first_v1",
      "user-1",
      expect.objectContaining({ sendFeatureFlagEvents: false }),
    );
  });

  it("restores access on flag failure and after subscription activation", async () => {
    mockGetFeatureFlag.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      enforceRegionalSubscriptionFirst(base),
    ).resolves.toBeUndefined();
    await expect(
      enforceRegionalSubscriptionFirst({ ...base, subscription: "pro" }),
    ).resolves.toBeUndefined();
  });

  it("never lets telemetry failure bypass the paywall", async () => {
    mockFlush.mockRejectedValueOnce(new Error("offline"));
    await expect(enforceRegionalSubscriptionFirst(base)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("bounds telemetry flushing for rejected requests", async () => {
    jest.useFakeTimers();
    mockFlush.mockReturnValueOnce(new Promise(() => {}));
    const result = expect(
      enforceRegionalSubscriptionFirst(base),
    ).rejects.toMatchObject({ statusCode: 403 });
    await jest.advanceTimersByTimeAsync(750);
    await result;
  });

  it("requires trusted ingress and consent", () => {
    expect(subscriptionFirstCountryFromRequest(request(" ng "))).toBe("NG");
    expect(
      subscriptionFirstCountryFromRequest(request("IN", "declined")),
    ).toBeUndefined();
    expect(
      subscriptionFirstCountryFromRequest(request("IN", undefined, false)),
    ).toBeUndefined();
    expect(subscriptionFirstCountryFromRequest(request())).toBeUndefined();
    delete process.env.VERCEL;
    expect(subscriptionFirstCountryFromRequest(request("IN"))).toBeUndefined();
  });
});
