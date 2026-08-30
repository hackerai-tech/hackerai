import { protectIncompleteAutomaticContinuation } from "../agent-auto-continue-usage-protection";

describe("protectIncompleteAutomaticContinuation", () => {
  const refundWithResult = jest.fn();
  const write = jest.fn();
  const capture = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    refundWithResult.mockResolvedValue({
      status: "refunded",
      includedPointsRefunded: 1_000,
      extraUsagePointsRefunded: 200,
      includedPointsRemaining: 0,
      extraUsagePointsRemaining: 0,
    });
  });

  const run = (
    overrides: Partial<
      Parameters<typeof protectIncompleteAutomaticContinuation>[0]
    > = {},
  ) =>
    protectIncompleteAutomaticContinuation({
      assignment: "test",
      stopSource: "tool_calls_finish_reason",
      usageRefundTracker: { refundWithResult } as never,
      writer: { write } as never,
      posthog: { capture } as never,
      userId: "user-123",
      subscription: "pro",
      endpoint: "/api/agent-long",
      ...overrides,
    });

  it("restores and confirms the bounded recovery run for treatment", async () => {
    await run();

    expect(refundWithResult).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      type: "data-auto-continue-usage-protected",
      data: { status: "restored" },
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user-123",
        event: "agent_auto_continue_recovery_finished",
        properties: expect.objectContaining({
          experiment_variant: "test",
          refund_status: "refunded",
          included_points_refunded: 1_000,
          extra_usage_points_refunded: 200,
        }),
      }),
    );
  });

  it("records control exposure without refunding or showing protection", async () => {
    await run({ assignment: "control" });

    expect(refundWithResult).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          experiment_variant: "control",
          refund_status: "not_attempted",
        }),
      }),
    );
  });

  it("does not claim full protection after a partial refund", async () => {
    refundWithResult.mockResolvedValueOnce({
      status: "partial",
      includedPointsRefunded: 1_000,
      extraUsagePointsRefunded: 0,
      includedPointsRemaining: 0,
      extraUsagePointsRemaining: 200,
    });

    await run();

    expect(write).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          refund_status: "partial",
          extra_usage_points_remaining: 200,
        }),
      }),
    );
  });

  it("does nothing when the flag is unavailable or the recovery completed", async () => {
    await run({ assignment: undefined });
    await run({ stopSource: null });

    expect(refundWithResult).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
