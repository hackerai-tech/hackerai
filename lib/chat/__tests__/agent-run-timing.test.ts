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

  it("records first-turn startup milestones once", () => {
    let now = 1_300;
    const tracker = new AgentRunTimingTracker(() => now);
    tracker.initializeStartup({
      requestStartedAt: 1_000,
      triggerRequestedAt: 1_100,
      taskStartedAt: 1_300,
    });

    now = 1_800;
    tracker.startModelStream();
    now = 2_050;
    tracker.recordFirstModelChunk();

    now = 2_500;
    tracker.startModelStream();
    tracker.recordFirstModelChunk();

    expect(tracker.snapshot()).toEqual(
      expect.objectContaining({
        startupTimingVersion: 1,
        routePreTriggerDurationMs: 100,
        triggerTaskStartLatencyMs: 200,
        taskToFirstModelStartMs: 500,
        requestToFirstModelStartMs: 800,
        requestToFirstModelChunkMs: 1_050,
      }),
    );
  });

  it("records separate startup subphase durations", async () => {
    let now = 100;
    const tracker = new AgentRunTimingTracker(() => now);

    await tracker.measureStartupPhase("sandbox_context", async () => {
      now += 20;
    });
    tracker.recordStartupPhaseDuration("message_serialization", 5);
    tracker.recordStartupPhaseDuration("message_serialization", 7);
    tracker.recordStartupPhaseDuration("summary_generation", 80);
    tracker.recordStartupPhaseDuration("transcript_saving", 30);

    expect(tracker.snapshot()).toEqual(
      expect.objectContaining({
        startupSubphaseTimingVersion: 1,
        startupSummaryGenerationDurationMs: 80,
        startupTranscriptSavingDurationMs: 30,
        startupSandboxContextDurationMs: 20,
        startupMessageSerializationDurationMs: 12,
      }),
    );
  });

  it("ignores non-transcript subphases after the first model starts", () => {
    let now = 0;
    const tracker = new AgentRunTimingTracker(() => now);

    tracker.startModelStream();
    tracker.recordStartupPhaseDuration("message_serialization", 40);
    tracker.recordStartupPhaseDuration("summary_generation", 50);
    tracker.recordStartupPhaseDuration("transcript_saving", 60);

    expect(tracker.snapshot()).toEqual(
      expect.objectContaining({
        startupSubphaseTimingVersion: 1,
        startupTranscriptSavingDurationMs: 60,
      }),
    );
    expect(tracker.snapshot()).not.toHaveProperty(
      "startupMessageSerializationDurationMs",
    );
    expect(tracker.snapshot()).not.toHaveProperty(
      "startupSummaryGenerationDurationMs",
    );
  });

  it("ignores invalid startup ordering", () => {
    const tracker = new AgentRunTimingTracker(() => 2_000);
    tracker.initializeStartup({
      requestStartedAt: 1_500,
      triggerRequestedAt: 1_400,
      taskStartedAt: 1_600,
    });
    tracker.startModelStream();
    tracker.recordFirstModelChunk();

    expect(tracker.snapshot()).not.toHaveProperty("startupTimingVersion");
  });
});
