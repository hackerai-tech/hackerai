import { AcknowledgedCommandOutput } from "../acknowledged-command-output";

describe("acknowledged command output", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("drains a native output burst with bounded windows and cumulative acknowledgements", async () => {
    let sender!: AcknowledgedCommandOutput;
    const delivered: number[] = [];
    sender = new AcknowledgedCommandOutput(
      "burst",
      Date.now() + 30_000,
      async (frame) => {
        delivered.push(frame.sequence);
        setTimeout(() => sender.acknowledge(frame.sequence), 25);
      },
      () => true,
    );
    for (let i = 0; i < 512; i++)
      sender.append({ type: "stdout", data: "x".repeat(4096) });
    sender.append({ type: "exit", exitCode: 0 });
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(sender.delivered).resolves.toBeUndefined();
    expect(delivered).toEqual(Array.from({ length: 513 }, (_, i) => i));
    expect(jest.getTimerCount()).toBe(0);
  });

  it("releases retained output immediately when ownership terminates", async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const sender = new AcknowledgedCommandOutput(
      "stop",
      Date.now() + 30_000,
      publish,
      () => true,
    );
    sender.append({ type: "stdout", data: "partial" });
    sender.stop();
    await expect(sender.delivered).rejects.toThrow("completion is unknown");
    await jest.advanceTimersByTimeAsync(30_000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("retains a lost final result after native exit, then releases it only on receipt", async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const sender = new AcknowledgedCommandOutput(
      "cmd",
      Date.now() + 5000,
      publish,
      () => true,
    );
    sender.append({ type: "exit", exitCode: 0 });
    await jest.advanceTimersByTimeAsync(1100);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0]).toEqual(publish.mock.calls[1][0]);
    sender.acknowledge(99); // Cannot discard the final result with a fabricated cursor.
    await jest.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(3);
    sender.acknowledge(0);
    await expect(sender.delivered).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(5000);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("ignores stale resume controls that arrive after a newer acknowledgement", async () => {
    const sender = new AcknowledgedCommandOutput(
      "cmd",
      Date.now() + 5000,
      async () => {},
      () => true,
    );
    sender.append({ type: "stdout", data: "received" });
    await jest.advanceTimersByTimeAsync(0);
    sender.acknowledge(0);
    sender.resume(-1);
    sender.append({ type: "exit", exitCode: 0 });
    await jest.advanceTimersByTimeAsync(0);
    sender.acknowledge(1);
    await expect(sender.delivered).resolves.toBeUndefined();
  });

  it("bounds queued native callbacks even while a publication is hung", async () => {
    const sender = new AcknowledgedCommandOutput(
      "cmd",
      Date.now() + 5000,
      () => new Promise(() => {}),
      () => true,
    );
    for (let i = 0; i < 4097; i++) sender.append({ type: "stdout", data: "x" });
    await expect(sender.delivered).rejects.toThrow("buffer exceeded");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("expires retained output without extending execution or leaking timers", async () => {
    const sender = new AcknowledgedCommandOutput(
      "cmd",
      Date.now() + 2000,
      async () => {
        throw new Error("offline");
      },
      () => true,
    );
    sender.append({ type: "stdout", data: "partial" });
    await jest.advanceTimersByTimeAsync(2000);
    await expect(sender.delivered).rejects.toThrow("deadline exceeded");
    expect(jest.getTimerCount()).toBe(0);
  });
});

it("discards retained output after confirmed cancellation without claiming full delivery", async () => {
  jest.useFakeTimers();
  const publish = jest.fn().mockResolvedValue(undefined);
  const sender = new AcknowledgedCommandOutput(
    "cancel",
    Date.now() + 30_000,
    publish,
    () => true,
  );
  sender.append({ type: "stdout", data: "partial" });
  sender.cancel();
  await expect(sender.delivered).rejects.toThrow("canceled");
  expect(sender.canceled).toBe(true);
  await jest.advanceTimersByTimeAsync(30_000);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

describe("receipt settlement evidence", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("reports recovered receipt once, independent of native execution completion", async () => {
    const settled = jest.fn();
    const publish = jest
      .fn()
      .mockRejectedValueOnce(new Error("private transport error"))
      .mockResolvedValue(undefined);
    const sender = new AcknowledgedCommandOutput(
      "receipt",
      Date.now() + 5000,
      publish,
      () => true,
      settled,
    );
    sender.append({ type: "stdout", data: "PRIVATE OUTPUT" });
    sender.append({ type: "error", message: "PRIVATE ERROR" });
    await jest.advanceTimersByTimeAsync(1000);
    sender.resume(-1);
    await jest.advanceTimersByTimeAsync(0);
    sender.acknowledge(1);
    await expect(sender.delivered).resolves.toBeUndefined();
    sender.acknowledge(1);
    sender.stop();
    sender.cancel();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0][0]).toMatchObject({
      outcome: "acknowledged",
      reason: "terminal_ack",
      terminalType: "error",
      terminalAcknowledged: true,
      observedFrames: 2,
      enqueuedFrames: 2,
      acknowledgedFrames: 2,
      pendingFrames: 0,
      pendingBytes: 0,
      publishFailures: 1,
      resumeRequests: 1,
    });
    expect(settled.mock.calls[0][0].replayAttempts).toBeGreaterThan(0);
    expect(JSON.stringify(settled.mock.calls)).not.toContain("PRIVATE");
    expect(Object.isFrozen(settled.mock.calls[0][0])).toBe(true);
  });

  it.each([
    "deadline_exceeded",
    "ownership_lost",
    "canceled",
    "stopped",
  ] as const)(
    "preserves incomplete counters for %s even while publish is hung",
    async (reason) => {
      const settled = jest.fn();
      let active = true;
      const sender = new AcknowledgedCommandOutput(
        "hung",
        Date.now() + 1000,
        () => new Promise(() => {}),
        () => active,
        settled,
      );
      sender.append({ type: "stdout", data: "abc" });
      sender.append({ type: "exit", exitCode: 0 });
      if (reason === "ownership_lost") active = false;
      if (reason === "canceled") sender.cancel();
      if (reason === "stopped") sender.stop();
      await jest.advanceTimersByTimeAsync(1000);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled.mock.calls[0][0]).toMatchObject({
        reason,
        outcome: reason === "canceled" ? "canceled" : "incomplete",
        pendingFrames: 2,
        pendingBytes: 3,
        peakPendingBytes: 3,
        acknowledgedFrames: 0,
        terminalAcknowledged: false,
        terminalType: "exit",
        publishAttempts: 1,
        replayAttempts: 0,
      });
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(["frames", "bytes"])(
    "reports %s overflow without losing the rejected-frame evidence",
    async (limit) => {
      const settled = jest.fn();
      const sender = new AcknowledgedCommandOutput(
        "overflow",
        Date.now() + 5000,
        () => new Promise(() => {}),
        () => true,
        settled,
      );
      if (limit === "frames") {
        for (let i = 0; i < 4096; i++)
          sender.append({ type: "stdout", data: "a" });
      } else {
        sender.append({ type: "stdout", data: "a".repeat(8 * 1024 * 1024) });
      }
      sender.append({ type: "error", message: "rejected" });
      expect(settled).toHaveBeenCalledTimes(1);
      const result = settled.mock.calls[0][0];
      expect(result).toMatchObject({
        reason: "buffer_limit",
        outcome: "incomplete",
        terminalType: "error",
        terminalAcknowledged: false,
      });
      expect(result.observedFrames).toBe(result.enqueuedFrames + 1);
      expect(result.pendingFrames).toBe(limit === "frames" ? 4096 : 1);
      expect(result.pendingBytes).toBe(
        limit === "frames" ? 4096 : 8 * 1024 * 1024,
      );
    },
  );

  it("does not let observer failure change receipt or rejection", async () => {
    const observer = () => {
      throw new Error("analytics failed");
    };
    const sender = new AcknowledgedCommandOutput(
      "ok",
      Date.now() + 5000,
      async () => {},
      () => true,
      observer,
    );
    sender.append({ type: "exit", exitCode: 0 });
    sender.acknowledge(0);
    await expect(sender.delivered).resolves.toBeUndefined();
    const failed = new AcknowledgedCommandOutput(
      "fail",
      Date.now() + 5000,
      async () => {},
      () => true,
      observer,
    );
    failed.stop();
    await expect(failed.delivered).rejects.toThrow("completion is unknown");
  });
});
