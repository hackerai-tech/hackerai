import type { RateLimitInfo } from "@/types";

describe("UsageRefundTracker", () => {
  const refundUsage = jest.fn(
    async (
      _userId: string,
      _subscription: string,
      includedPoints: number,
      extraUsagePoints: number,
    ) => ({
      includedPointsRefunded: includedPoints,
      extraUsagePointsRefunded: extraUsagePoints,
      includedRefundFailed: false,
      extraUsageRefundFailed: false,
    }),
  );

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    refundUsage.mockImplementation(
      async (
        _userId: string,
        _subscription: string,
        includedPoints: number,
        extraUsagePoints: number,
      ) => ({
        includedPointsRefunded: includedPoints,
        extraUsagePointsRefunded: extraUsagePoints,
        includedRefundFailed: false,
        extraUsageRefundFailed: false,
      }),
    );
  });

  const createTracker = () => {
    let RefundTracker: typeof import("../refund").UsageRefundTracker;
    jest.isolateModules(() => {
      jest.doMock("../token-bucket", () => ({ refundUsage }));
      RefundTracker = require("../refund").UsageRefundTracker;
    });
    const tracker = new RefundTracker!();
    tracker.setUser("user-123", "pro");
    tracker.recordDeductions({
      remaining: 900,
      resetTime: new Date(),
      limit: 1_000,
      pointsDeducted: 100,
      extraUsagePointsDeducted: 50,
    });
    return tracker;
  };

  const createEmptyTracker = () => {
    let RefundTracker: typeof import("../refund").UsageRefundTracker;
    jest.isolateModules(() => {
      jest.doMock("../token-bucket", () => ({ refundUsage }));
      RefundTracker = require("../refund").UsageRefundTracker;
    });
    return new RefundTracker!();
  };

  it("records deductions and handles missing deduction fields", () => {
    const tracker = createEmptyTracker();
    const emptyRateLimitInfo: RateLimitInfo = {
      remaining: 1_000,
      resetTime: new Date(),
      limit: 1_000,
    };

    tracker.recordDeductions(emptyRateLimitInfo);
    expect(tracker.hasDeductions()).toBe(false);

    tracker.recordDeductions({
      ...emptyRateLimitInfo,
      pointsDeducted: 100,
    });
    expect(tracker.hasDeductions()).toBe(true);
  });

  it("adds mid-run deductions to the refundable totals", async () => {
    const tracker = createTracker();
    tracker.addDeductions({
      includedPointsDeducted: 25,
      extraUsagePointsDeducted: 75,
    });

    await tracker.refund();

    expect(refundUsage).toHaveBeenCalledWith(
      "user-123",
      "pro",
      125,
      125,
      undefined,
      expect.any(String),
    );
  });

  it("does not refund without deductions or user context", async () => {
    const noDeductions = createEmptyTracker();
    noDeductions.setUser("user-123", "pro");
    await expect(noDeductions.refundWithResult()).resolves.toMatchObject({
      status: "skipped",
    });

    const noUser = createEmptyTracker();
    noUser.recordDeductions({
      remaining: 900,
      resetTime: new Date(),
      limit: 1_000,
      pointsDeducted: 100,
    });
    await expect(noUser.refundWithResult()).resolves.toMatchObject({
      status: "skipped",
      includedPointsRemaining: 100,
    });

    expect(refundUsage).not.toHaveBeenCalled();
  });

  it("is idempotent after a confirmed refund", async () => {
    const tracker = createTracker();

    await tracker.refund();
    await tracker.refund();
    await tracker.refund();

    expect(refundUsage).toHaveBeenCalledTimes(1);
    expect(tracker.hasDeductions()).toBe(false);
  });

  it("keeps deductions retryable when the refund call rejects", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    refundUsage
      .mockRejectedValueOnce(new Error("Network error"))
      .mockImplementationOnce(
        async (
          _userId: string,
          _subscription: string,
          includedPoints: number,
          extraUsagePoints: number,
        ) => ({
          includedPointsRefunded: includedPoints,
          extraUsagePointsRefunded: extraUsagePoints,
          includedRefundFailed: false,
          extraUsageRefundFailed: false,
        }),
      );
    const tracker = createTracker();

    await expect(tracker.refundWithResult()).resolves.toMatchObject({
      status: "failed",
      includedPointsRemaining: 100,
      extraUsagePointsRemaining: 50,
    });
    await expect(tracker.refundWithResult()).resolves.toMatchObject({
      status: "refunded",
    });
    await tracker.refund();

    expect(refundUsage).toHaveBeenCalledTimes(2);
    expect(refundUsage.mock.calls[0]?.[5]).toEqual(
      refundUsage.mock.calls[1]?.[5],
    );
    consoleError.mockRestore();
  });

  it("retries only the component that failed to refund", async () => {
    refundUsage
      .mockResolvedValueOnce({
        includedPointsRefunded: 100,
        extraUsagePointsRefunded: 0,
        includedRefundFailed: false,
        extraUsageRefundFailed: true,
      })
      .mockResolvedValueOnce({
        includedPointsRefunded: 0,
        extraUsagePointsRefunded: 50,
        includedRefundFailed: false,
        extraUsageRefundFailed: false,
      });
    const tracker = createTracker();

    await expect(tracker.refundWithResult()).resolves.toMatchObject({
      status: "partial",
      includedPointsRefunded: 100,
      extraUsagePointsRemaining: 50,
    });
    await expect(tracker.refundWithResult()).resolves.toMatchObject({
      status: "refunded",
      extraUsagePointsRefunded: 50,
      includedPointsRemaining: 0,
      extraUsagePointsRemaining: 0,
    });
    await expect(tracker.refundWithResult()).resolves.toMatchObject({
      status: "skipped",
    });

    expect(refundUsage).toHaveBeenNthCalledWith(
      1,
      "user-123",
      "pro",
      100,
      50,
      undefined,
      expect.any(String),
    );
    expect(refundUsage).toHaveBeenNthCalledWith(
      2,
      "user-123",
      "pro",
      0,
      50,
      undefined,
      undefined,
    );
  });

  it("serializes concurrent refund calls", async () => {
    let resolveRefund:
      | ((value: {
          includedPointsRefunded: number;
          extraUsagePointsRefunded: number;
          includedRefundFailed: boolean;
          extraUsageRefundFailed: boolean;
        }) => void)
      | undefined;
    refundUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefund = resolve;
        }),
    );
    const tracker = createTracker();

    const first = tracker.refundWithResult();
    const second = tracker.refundWithResult();
    expect(refundUsage).toHaveBeenCalledTimes(1);
    resolveRefund?.({
      includedPointsRefunded: 100,
      extraUsagePointsRefunded: 50,
      includedRefundFailed: false,
      extraUsageRefundFailed: false,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "refunded" }),
      expect.objectContaining({ status: "refunded" }),
    ]);
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });
});
