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
    process.env.NEXT_PUBLIC_BASE_URL = "https://hackerai.co";
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";

    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "pro",
      organizationId: undefined,
    } as never);

    mockConvexMutation.mockResolvedValue({
      code: "UVVQDMV",
      active: true,
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
    expect(body.referralUrl).toBe("https://hackerai.co/invite/UVVQDMV");
    expect(mockConvexMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        codeCandidate: expect.stringMatching(/^[A-Z2-9]{7}$/),
      }),
    );
  });
});
