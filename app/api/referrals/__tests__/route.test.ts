import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { mockMutation as mockConvexMutation } from "convex/browser";

const mockGetUserIDAndPro = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

describe("GET /api/referrals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = "https://zhacker.ai";
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
    delete process.env.REFERRAL_REFERRED_SIGNUP_BONUS_UNITS;

    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "pro",
      organizationId: undefined,
    } as never);

    mockConvexMutation.mockResolvedValue({
      code: "UVVQDMV",
      active: true,
      referrerSubscriptionTier: "pro",
      attributedSignups: 0,
      paidConversions: 0,
      awardedDollars: 0,
    } as never);
  });

  it("returns invite-style referral URLs", async () => {
    const { GET } = await import("../route");

    const response = await GET({} as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.referralUrl).toBe("https://zhacker.ai/invite/UVVQDMV");
    expect(body.referrerSubscriptionTier).toBe("pro");
    expect(body.referredSignupBonusUnits).toBe(10);
    expect(mockConvexMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        codeCandidate: expect.stringMatching(/^[A-Z2-9]{7}$/),
      }),
    );
  });

  it("blocks free users from creating referral URLs", async () => {
    mockGetUserIDAndPro.mockResolvedValueOnce({
      userId: "user_free",
      subscription: "free",
      organizationId: undefined,
    } as never);
    const { GET } = await import("../route");

    const response = await GET({} as any);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      "Referral links are currently available to paid customers.",
    );
    expect(mockConvexMutation).not.toHaveBeenCalled();
  });

  it("returns the referrer tier reported by Convex", async () => {
    mockGetUserIDAndPro.mockResolvedValueOnce({
      userId: "user_123",
      subscription: "pro",
      organizationId: undefined,
    } as never);
    mockConvexMutation.mockResolvedValueOnce({
      code: "UVVQDMV",
      active: true,
      referrerSubscriptionTier: "free",
      attributedSignups: 0,
      paidConversions: 0,
      awardedDollars: 0,
    } as never);
    const { GET } = await import("../route");

    const response = await GET({} as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.referrerSubscriptionTier).toBe("free");
  });
});
