import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockWithAuth = jest.fn<() => Promise<{ user: { id: string } | null }>>();
const mockMutation = jest.fn<(...args: unknown[]) => Promise<string | null>>();
jest.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: mockWithAuth }));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation }),
}));
const mockCookieSet = jest.fn();
const mockCookieDelete = jest.fn();
const mockCookies = jest.fn(async () => ({
  get: jest.fn(),
  set: mockCookieSet,
  delete: mockCookieDelete,
}));

jest.mock("next/headers", () => ({ cookies: mockCookies }));

const { saveAnalyticsConsent } =
  require("../analytics-consent") as typeof import("../analytics-consent");

describe("saveAnalyticsConsent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithAuth.mockResolvedValue({ user: null });
    mockMutation.mockResolvedValue(null);
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

  it("withdraws persisted attribution for the authenticated user without browser cookies", async () => {
    mockWithAuth.mockResolvedValue({ user: { id: "user_authenticated" } });
    mockMutation.mockResolvedValueOnce("next-page").mockResolvedValueOnce(null);
    await saveAnalyticsConsent("declined");
    expect(mockMutation).toHaveBeenCalledTimes(2);
    expect(mockMutation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ cursor: "next-page" }),
    );
    expect(mockMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user_authenticated" }),
    );
  });

  it("preserves visitor cookies and reports failed durable withdrawal", async () => {
    mockWithAuth.mockResolvedValue({ user: { id: "user_authenticated" } });
    mockMutation.mockRejectedValue(new Error("Unavailable"));
    await expect(saveAnalyticsConsent("declined")).rejects.toThrow(
      "Unavailable",
    );
    expect(mockCookieDelete).not.toHaveBeenCalled();
  });

  it("removes existing optional analytics and attribution cookies on rejection", async () => {
    await saveAnalyticsConsent("declined");

    expect(mockCookieDelete.mock.calls.map(([name]) => name)).toEqual([
      "hackerai_partner",
      "hackerai_partner_visitor",
      "hackerai_first_touch_attribution",
      "hackerai_ref",
      "hackerai_ref_at",
      "ph_phc_test_posthog",
    ]);
  });
});
