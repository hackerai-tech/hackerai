import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { ChatSDKError } from "../errors";

const mockQuery = jest.fn();

jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/convex/_generated/api", () => ({
  api: {
    userSuspensions: {
      getActiveByUser: "getActiveByUser",
      getActiveChatAccessBlockByUser: "getActiveChatAccessBlockByUser",
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

  it("blocks billing transactions while any suspension is active", async () => {
    mockQuery.mockResolvedValueOnce({
      user_id: "user_123",
      status: "active",
      category: "dispute_billing_hold",
      source: "stripe",
      source_id: "dp_123",
    } as never);
    const { assertUserCanStartBillingTransaction } =
      await import("../suspensions");

    await expect(
      assertUserCanStartBillingTransaction("user_123"),
    ).rejects.toThrow(
      "Billing is disabled while this account has an active payment dispute or fraud hold.",
    );
  });

  it("blocks chat-history access for fraudulent disputes", async () => {
    const { assertUserCanAccessChatHistory } = await import("../suspensions");

    mockQuery.mockResolvedValueOnce(null as never);
    await expect(
      assertUserCanAccessChatHistory("user_123"),
    ).resolves.toBeUndefined();

    mockQuery.mockResolvedValueOnce({
      user_id: "user_123",
      status: "active",
      category: "dispute_fraudulent",
      source: "stripe",
      source_id: "dp_fraud",
    } as never);
    await expect(
      assertUserCanAccessChatHistory("user_123"),
    ).rejects.toMatchObject({
      type: "forbidden",
      surface: "chat",
      cause: expect.stringContaining("fraudulent payment dispute"),
      metadata: {
        suspensionCategory: "dispute_fraudulent",
        suspensionSource: "stripe",
      },
    });
    expect(mockQuery).toHaveBeenLastCalledWith(
      "getActiveChatAccessBlockByUser",
      {
        serviceKey: "test-service-key",
        userId: "user_123",
      },
    );
  });

  it("blocks chat-history access for support-confirmed fraud", async () => {
    const { assertUserCanAccessChatHistory } = await import("../suspensions");

    mockQuery.mockResolvedValueOnce({
      user_id: "user_123",
      status: "active",
      category: "support_confirmed_fraud",
      source: "support",
      source_id: "support_case:intercom_456",
    } as never);

    await expect(
      assertUserCanAccessChatHistory("user_123"),
    ).rejects.toMatchObject({
      type: "forbidden",
      surface: "chat",
      cause: expect.stringContaining("confirmed fraudulent payment"),
      metadata: {
        suspensionCategory: "support_confirmed_fraud",
        suspensionSource: "support",
      },
    });
  });
});

describe("web suspension-gate transport recovery", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it("retries one failed read with the same user and accepts an authoritative clear result", async () => {
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");
    mockQuery
      .mockRejectedValueOnce(new TypeError("fetch failed") as never)
      .mockResolvedValueOnce(null as never);
    await expect(
      assertUserCanMakeCostIncurringRequest("user_123", {
        retryNetworkFailure: true,
      }),
    ).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1]).toEqual(mockQuery.mock.calls[0]);
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"access":"allowed"'),
    );
  });

  it("still blocks a suspended account when the retry succeeds", async () => {
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");
    mockQuery
      .mockRejectedValueOnce(new TypeError("fetch failed") as never)
      .mockResolvedValueOnce({
        category: "dispute_billing_hold",
        source: "stripe",
        source_id: "private_source",
      } as never);
    await expect(
      assertUserCanMakeCostIncurringRequest("user_123", {
        retryNetworkFailure: true,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"access":"blocked"'),
    );
    expect(
      JSON.stringify((console.info as jest.Mock).mock.calls),
    ).not.toContain("private_source");
  });

  it("exhausts one retry and fails closed without another read", async () => {
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");
    const lastError = new TypeError("fetch failed");
    mockQuery
      .mockRejectedValueOnce(new TypeError("fetch failed") as never)
      .mockRejectedValueOnce(lastError as never)
      .mockResolvedValueOnce(null as never);
    await expect(
      assertUserCanMakeCostIncurringRequest("user_123", {
        retryNetworkFailure: true,
      }),
    ).rejects.toBe(lastError);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('"outcome":"exhausted"'),
    );
  });

  it.each([
    new Error("fetch failed"),
    new TypeError("unknown parser failure"),
    new ChatSDKError("forbidden:chat"),
  ])("does not retry application or unknown errors: %s", async (error) => {
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");
    mockQuery.mockRejectedValueOnce(error as never);
    await expect(
      assertUserCanMakeCostIncurringRequest("user_123", {
        retryNetworkFailure: true,
      }),
    ).rejects.toBe(error);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("keeps worker, billing, and history checks at their existing read budgets", async () => {
    const guards = await import("../suspensions");
    for (const guard of [
      guards.assertUserCanMakeCostIncurringRequest,
      guards.assertUserCanStartBillingTransaction,
      guards.assertUserCanAccessChatHistory,
    ]) {
      mockQuery.mockReset();
      const error = new TypeError("fetch failed");
      mockQuery.mockRejectedValueOnce(error as never);
      await expect(guard("user_123")).rejects.toBe(error);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry an already canceled request", async () => {
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");
    const controller = new AbortController();
    controller.abort(new Error("canceled"));
    mockQuery.mockRejectedValueOnce(new TypeError("fetch failed") as never);
    await expect(
      assertUserCanMakeCostIncurringRequest("user_123", {
        retryNetworkFailure: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow("canceled");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("cancels during backoff without issuing the retry", async () => {
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");
    const controller = new AbortController();
    mockQuery.mockRejectedValueOnce(new TypeError("fetch failed") as never);
    const result = assertUserCanMakeCostIncurringRequest("user_123", {
      retryNetworkFailure: true,
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await rejected;
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("does not accept a late clear result after the request is canceled", async () => {
    const { assertUserCanMakeCostIncurringRequest } =
      await import("../suspensions");
    const controller = new AbortController();
    let finishRead!: (value: never) => void;
    let startedRetry!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      startedRetry = resolve;
    });
    mockQuery
      .mockRejectedValueOnce(new TypeError("fetch failed") as never)
      .mockImplementationOnce(() => {
        startedRetry();
        return new Promise((resolve) => {
          finishRead = resolve;
        });
      });
    const result = assertUserCanMakeCostIncurringRequest("user_123", {
      retryNetworkFailure: true,
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow("canceled");
    await retryStarted;
    controller.abort(new Error("canceled"));
    finishRead(null as never);
    await rejected;
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(console.info).not.toHaveBeenCalled();
  });
});
