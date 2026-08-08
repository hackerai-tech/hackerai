import { createProviderContentBlockedFinishReasonError } from "@/lib/utils/error-utils";
import { createProviderContentBlockedRefundLifecycle } from "../provider-content-blocked-refund";

describe("provider content-blocked refund lifecycle", () => {
  const refundUsage = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    refundUsage.mockResolvedValue(undefined);
  });

  const createLifecycle = (hasUsage: () => boolean) => {
    let refundModule: typeof import("@/lib/rate-limit/refund") | undefined;
    let lifecycleModule:
      typeof import("../provider-content-blocked-refund") | undefined;

    jest.isolateModules(() => {
      jest.doMock("@/lib/rate-limit/token-bucket", () => ({ refundUsage }));
      refundModule = require("@/lib/rate-limit/refund");
      lifecycleModule = require("../provider-content-blocked-refund");
    });
    if (!refundModule || !lifecycleModule) {
      throw new Error("Failed to initialize refund lifecycle test modules");
    }

    const tracker = new refundModule.UsageRefundTracker();
    tracker.setUser("user-123", "pro");
    tracker.recordDeductions({
      remaining: 900,
      resetTime: new Date(),
      limit: 1000,
      pointsDeducted: 100,
    });

    return lifecycleModule.createProviderContentBlockedRefundLifecycle({
      hasUsage,
      refund: () => tracker.refund(),
    });
  };

  it("refunds once after a zero-usage blocked response settles", async () => {
    const lifecycle = createLifecycle(() => false);
    const error = createProviderContentBlockedFinishReasonError();

    await lifecycle({ error, settled: false });
    expect(refundUsage).not.toHaveBeenCalled();

    await lifecycle({ finishReason: "content-filter", settled: true });
    await lifecycle({ error, settled: true });

    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent settled callbacks into one external refund", async () => {
    let completeRefund: (() => void) | undefined;
    refundUsage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeRefund = resolve;
        }),
    );
    const lifecycle = createLifecycle(() => false);
    const error = createProviderContentBlockedFinishReasonError();

    await lifecycle({ error, settled: false });
    const finishRefund = lifecycle({
      finishReason: "content-filter",
      settled: true,
    });
    const abortRefund = lifecycle({ error, settled: true });

    expect(refundUsage).toHaveBeenCalledTimes(1);
    completeRefund?.();
    await Promise.all([finishRefund, abortRefund]);
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it("allows a later settled callback to retry a failed refund", async () => {
    const refund = jest
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("temporary refund failure"));
    const lifecycle = createProviderContentBlockedRefundLifecycle({
      hasUsage: () => false,
      refund,
    });

    await expect(
      lifecycle({ finishReason: "content-filter", settled: true }),
    ).rejects.toThrow("temporary refund failure");
    await expect(
      lifecycle({ finishReason: "content-filter", settled: true }),
    ).resolves.toBeUndefined();

    expect(refund).toHaveBeenCalledTimes(2);
  });

  it("refunds when a blocked stream aborts before finish", async () => {
    const lifecycle = createLifecycle(() => false);
    const error = createProviderContentBlockedFinishReasonError();

    await lifecycle({ error, settled: false });
    await lifecycle({ error, settled: true });

    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it("does not refund a blocked response with observed usage", async () => {
    const lifecycle = createLifecycle(() => true);
    const error = createProviderContentBlockedFinishReasonError();

    await lifecycle({ error, settled: false });
    await lifecycle({ finishReason: "content-filter", settled: true });
    await lifecycle({ error, settled: true });

    expect(refundUsage).not.toHaveBeenCalled();
  });
});
