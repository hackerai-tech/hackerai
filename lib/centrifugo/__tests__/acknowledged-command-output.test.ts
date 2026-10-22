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
