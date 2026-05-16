import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChatSDKError } from "../errors";

const mockQuery = jest.fn();

jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/convex/_generated/api", () => ({
  api: {
    userSuspensions: {
      getActiveByUser: "getActiveByUser",
    },
  },
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    query: mockQuery,
  }),
}));

process.env.CONVEX_SERVICE_ROLE_KEY = "test-service-key";

describe("suspensions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows cost-incurring requests when no active suspension exists", async () => {
    mockQuery.mockResolvedValueOnce(null as never);
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");

    await expect(
      assertUserCanMakeCostIncurringRequest("user_123"),
    ).resolves.toBeUndefined();

    expect(mockQuery).toHaveBeenCalledWith("getActiveByUser", {
      serviceKey: "test-service-key",
      userId: "user_123",
    });
  });

  it("blocks cost-incurring requests for active suspensions", async () => {
    mockQuery.mockResolvedValueOnce({
      user_id: "user_123",
      status: "active",
      category: "dispute_fraudulent",
      source: "stripe",
      source_id: "dp_123",
    } as never);
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");

    await expect(
      assertUserCanMakeCostIncurringRequest("user_123"),
    ).rejects.toMatchObject({
      type: "forbidden",
      surface: "chat",
      statusCode: 403,
      cause: expect.stringContaining("fraudulent payment dispute"),
      metadata: {
        suspensionCategory: "dispute_fraudulent",
        suspensionSource: "stripe",
      },
    });
  });

  it("does not leak raw source IDs in the user-facing block message", async () => {
    mockQuery.mockResolvedValueOnce({
      user_id: "user_123",
      status: "active",
      category: "dispute_billing_hold",
      source: "stripe",
      source_id: "dp_secret",
    } as never);
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");

    try {
      await assertUserCanMakeCostIncurringRequest("user_123");
      expect.fail("Expected suspension guard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatSDKError);
      expect((error as ChatSDKError).cause).toContain(
        "payment dispute under review",
      );
      expect((error as ChatSDKError).cause).not.toContain("dp_secret");
    }
  });
});
