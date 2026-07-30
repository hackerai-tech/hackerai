import { describe, expect, it } from "@jest/globals";

import { AgentRunTimingTracker } from "../agent-run-timing";

describe("AgentRunTimingTracker", () => {
  it("aggregates approval waits and active categories", async () => {
    let now = 1_000;
    const tracker = new AgentRunTimingTracker(() => now);

    tracker.recordApprovalWait(8_000, true);
    tracker.recordApprovalWait(2_000, false);
    tracker.recordApprovalWait(1_000, true);

    tracker.startModelStream();
    now += 4_000;
    tracker.finishModelStream();

    await tracker.measureActiveTime("terminal_wait", async () => {
      now += 3_000;
    });
    await tracker.measureActiveTime("sandbox_recovery", async () => {
      now += 2_000;
    });

    expect(tracker.snapshot()).toEqual({
      approvalWaitCount: 2,
      approvalWaitDurationMs: 11_000,
      activeModelStreamDurationMs: 4_000,
      activeTerminalWaitDurationMs: 3_000,
      activeSandboxRecoveryDurationMs: 2_000,
    });
  });

  it("closes a previous model phase when a new step starts", () => {
    let now = 0;
    const tracker = new AgentRunTimingTracker(() => now);

    tracker.startModelStream();
    now = 500;
    tracker.startModelStream();
    now = 1_250;

    expect(tracker.snapshot().activeModelStreamDurationMs).toBe(1_250);
  });

  it("records active duration when an operation fails", async () => {
    let now = 0;
    const tracker = new AgentRunTimingTracker(() => now);

    await expect(
      tracker.measureActiveTime("terminal_wait", async () => {
        now = 750;
        throw new Error("terminal failed");
      }),
    ).rejects.toThrow("terminal failed");

    expect(tracker.snapshot().activeTerminalWaitDurationMs).toBe(750);
  });
});
