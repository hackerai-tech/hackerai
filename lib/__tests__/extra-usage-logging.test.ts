import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockConvexCall = jest.fn<(...args: unknown[]) => Promise<never>>();
const mockCaptureException = jest.fn();
const mockEmitPostHogLog = jest.fn<(_record: unknown) => boolean>(() => true);

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    query: mockConvexCall,
    mutation: mockConvexCall,
    action: mockConvexCall,
  }),
}));
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({ captureException: mockCaptureException }),
}));
jest.mock("@/lib/posthog/logs", () => ({
  emitPostHogLog: mockEmitPostHogLog,
}));

const {
  deductFromBalance,
  deductFromTeamBalance,
  getExtraUsageBalance,
  getTeamExtraUsageState,
  refundToBalance,
  refundToTeamBalance,
} = require("../extra-usage") as typeof import("../extra-usage");

describe("Extra Usage failure capture through phLogger", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConvexCall.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("private connection details"), {
          code: "ECONNRESET",
        }),
      }),
    );
  });

  it.each([
    [
      "extra_usage_balance_fetch_failed",
      () => getExtraUsageBalance("user_123"),
    ],
    ["extra_usage_deduction_failed", () => deductFromBalance("user_123", 100)],
    ["extra_usage_refund_failed", () => refundToBalance("user_123", 100)],
    [
      "team_extra_usage_state_fetch_failed",
      () => getTeamExtraUsageState("org_123", "user_123"),
    ],
    [
      "team_extra_usage_deduction_failed",
      () => deductFromTeamBalance("org_123", "user_123", 100),
    ],
    [
      "team_extra_usage_refund_failed",
      () => refundToTeamBalance("org_123", "user_123", 100),
    ],
  ] as const)("preserves the Convex cause for %s", async (event, call) => {
    await call();

    expect(mockConvexCall).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [exception, distinctId, properties] = mockCaptureException.mock
      .calls[0] as [Error, string, Record<string, unknown>];
    const log = mockEmitPostHogLog.mock.calls[0][0] as {
      body: string;
      attributes: Record<string, unknown>;
    };
    const expectedCause = {
      event,
      convex_error_name: "TypeError",
      convex_error_message: "fetch failed",
      convex_network_error_codes: ["ECONNRESET"],
    };
    expect(properties).toMatchObject(expectedCause);
    expect(log.attributes).toMatchObject(expectedCause);
    expect(distinctId).toBe("user_123");
    expect(properties.error_message).toBe(log.body);
    expect(exception.message).toBe(log.body);
    expect(exception.message).not.toBe("fetch failed");
  });

  it("captures distinct network codes through nested aggregate causes in both sinks", async () => {
    const connectionError = (code: string) =>
      Object.assign(new Error("PRIVATE_HOST_AND_ADDRESS"), { code });
    mockConvexCall.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: new AggregateError([
          connectionError("ENETUNREACH"),
          new Error("PRIVATE_WRAPPER", {
            cause: connectionError("ETIMEDOUT"),
          }),
          connectionError("ENETUNREACH"),
          connectionError("PRIVATE_ARBITRARY_CODE"),
        ]),
      }),
    );

    await expect(deductFromBalance("user_123", 100)).resolves.toMatchObject({
      success: false,
      insufficientFunds: false,
    });
    const properties = mockCaptureException.mock.calls[0][2] as Record<
      string,
      unknown
    >;
    const log = mockEmitPostHogLog.mock.calls[0][0] as {
      attributes: Record<string, unknown>;
    };
    expect(properties.convex_network_error_codes).toEqual([
      "ENETUNREACH",
      "ETIMEDOUT",
    ]);
    expect(log.attributes.convex_network_error_codes).toEqual([
      "ENETUNREACH",
      "ETIMEDOUT",
    ]);
    expect(JSON.stringify([properties, log])).not.toContain("PRIVATE_");
    expect(mockConvexCall).toHaveBeenCalledTimes(1);
  });

  it("bounds the whole diagnostic traversal across aggregate errors and causes", async () => {
    const root: { cause?: unknown; errors?: unknown[] } = {};
    const cycle = { code: "ECONNREFUSED", cause: root };
    root.cause = cycle;
    const outsideBudget = jest.fn(() => "PRIVATE_CODE");
    root.errors = Array.from({ length: 100 }, () =>
      Object.defineProperty({}, "code", { get: outsideBudget }),
    );
    mockConvexCall.mockRejectedValue(
      new TypeError("fetch failed", { cause: root }),
    );

    await deductFromTeamBalance("org_123", "user_123", 100);

    expect(outsideBudget.mock.calls.length).toBeLessThanOrEqual(13);
    expect(mockCaptureException.mock.calls[0][2]).toMatchObject({
      convex_network_error_codes: ["ECONNREFUSED"],
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(
      "PRIVATE_CODE",
    );
  });

  it("keeps a diagnostic getter failure from changing the billing result", async () => {
    const cause = Object.defineProperty({}, "code", {
      get() {
        throw new Error("PRIVATE_GETTER_ERROR");
      },
    });
    mockConvexCall.mockRejectedValue(new TypeError("fetch failed", { cause }));

    await expect(deductFromBalance("user_123", 100)).resolves.toMatchObject({
      success: false,
      insufficientFunds: false,
      monthlyCapExceeded: false,
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(
      "PRIVATE_GETTER_ERROR",
    );
  });

  it("redacts before bounding the cause without capturing raw Error payloads", async () => {
    const signedUrl =
      "https://bucket.s3.amazonaws.com/user-files/private.png?X-Amz-Signature=synthetic-signature";
    const error = Object.assign(
      new Error(
        `fetch failed ${signedUrl} serviceKey=synthetic-key ${"x".repeat(3000)}`,
      ),
      {
        name: `Upstream${"x".repeat(200)}`,
        responseBody: "PRIVATE_PROVIDER_PAYLOAD",
        cause: { payload: "PRIVATE_CAUSE_PAYLOAD" },
      },
    );
    mockConvexCall.mockRejectedValue(error);

    await expect(
      deductFromBalance("user_123", 100, "settlement_123"),
    ).resolves.toMatchObject({
      success: false,
      insufficientFunds: false,
      monthlyCapExceeded: false,
    });

    const properties = mockCaptureException.mock.calls[0][2] as Record<
      string,
      unknown
    >;
    expect(properties.convex_error_name).toHaveLength(128);
    expect(properties.convex_error_message).toHaveLength(2000);
    expect(properties.usage_settlement_id).toBe("settlement_123");
    const captured = JSON.stringify([
      mockCaptureException.mock.calls,
      mockEmitPostHogLog.mock.calls,
    ]);
    expect(captured).toContain("[Redacted signed URL]");
    expect(captured).toContain("[Redacted]");
    for (const secret of [
      "synthetic-signature",
      "synthetic-key",
      "user-files",
      "PRIVATE_PROVIDER_PAYLOAD",
      "PRIVATE_CAUSE_PAYLOAD",
    ]) {
      expect(captured).not.toContain(secret);
    }
  });

  it("preserves string failures without changing the deduction result", async () => {
    mockConvexCall.mockRejectedValue("upstream unavailable");
    await expect(
      deductFromTeamBalance("org_123", "user_123", 100),
    ).resolves.toMatchObject({
      success: false,
      insufficientFunds: false,
    });
    expect(mockCaptureException.mock.calls[0][2]).toMatchObject({
      convex_error_name: "UnknownError",
      convex_error_message: "upstream unavailable",
    });
    expect(mockCaptureException.mock.calls[0][2]).toHaveProperty(
      "convex_network_error_codes",
      undefined,
    );
  });
});
