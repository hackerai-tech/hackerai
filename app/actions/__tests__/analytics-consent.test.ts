import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCookieSet = jest.fn();
const mockCookieDelete = jest.fn();
const mockCookies = jest.fn(async () => ({
  set: mockCookieSet,
  delete: mockCookieDelete,
}));

jest.mock("next/headers", () => ({ cookies: mockCookies }));

const { saveAnalyticsConsent } =
  require("../analytics-consent") as typeof import("../analytics-consent");

describe("saveAnalyticsConsent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  });

  it("stores an HttpOnly consent choice", async () => {
    await saveAnalyticsConsent("accepted");

    expect(mockCookieSet).toHaveBeenCalledWith(
      "hackerai_analytics_consent",
      "accepted",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        maxAge: 180 * 24 * 60 * 60,
        path: "/",
      }),
    );
    expect(mockCookieDelete).not.toHaveBeenCalled();
  });

  it("removes existing optional analytics and attribution cookies on rejection", async () => {
    await saveAnalyticsConsent("declined");

    expect(mockCookieDelete.mock.calls.map(([name]) => name)).toEqual([
      "hackerai_first_touch_attribution",
      "hackerai_ref",
      "hackerai_ref_at",
      "ph_phc_test_posthog",
    ]);
  });
});
