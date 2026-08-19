import {
  InProcessRelayClient,
  InProcessRelayLifecycle,
  RELAY_RESTART_BASE_DELAY_MS,
  RELAY_RESTART_MAX_ATTEMPTS,
} from "../cloud-relay-lifecycle";

describe("in-process cloud relay lifecycle", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts, suspends, resumes, and terminates clients exactly once", async () => {
    const clients: Array<
      InProcessRelayClient & { start: jest.Mock; cleanup: jest.Mock }
    > = [];
    const lifecycle = new InProcessRelayLifecycle(() => {
      const client = {
        start: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn().mockResolvedValue(undefined),
      };
      clients.push(client);
      return client;
    }, jest.fn());

    await lifecycle.run({ sessionId: "one" });
    expect(lifecycle.running).toBe(true);
    await lifecycle.suspend();
    expect(clients[0].cleanup).toHaveBeenCalledTimes(1);
    await lifecycle.resume();
    expect(clients).toHaveLength(2);
    await lifecycle.terminate();
    expect(clients[1].cleanup).toHaveBeenCalledTimes(1);
    expect(clients[1].cleanup).toHaveBeenCalledWith({ terminated: true });
    expect(lifecycle.running).toBe(false);
  });

  it("restarts after an unexpected in-process fatal callback", async () => {
    jest.useFakeTimers();
    const fatalCallbacks: Array<(error: Error) => void> = [];
    const clients: Array<{ start: jest.Mock; cleanup: jest.Mock }> = [];
    const onUnexpectedExit = jest.fn();
    const lifecycle = new InProcessRelayLifecycle((_config, onFatal) => {
      fatalCallbacks.push(onFatal);
      const client = {
        start: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn().mockResolvedValue(undefined),
      };
      clients.push(client);
      return client;
    }, onUnexpectedExit);

    await lifecycle.run({ sessionId: "one" });
    fatalCallbacks[0](new Error("relay disconnected"));
    await jest.advanceTimersByTimeAsync(RELAY_RESTART_BASE_DELAY_MS);

    expect(onUnexpectedExit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "relay disconnected" }),
    );
    expect(clients).toHaveLength(2);
    expect(clients[1].start).toHaveBeenCalledTimes(1);
    await lifecycle.terminate();
  });

  it("does not restart a client after suspension wins the transition", async () => {
    jest.useFakeTimers();
    let fatal: ((error: Error) => void) | undefined;
    const factory = jest.fn((_config, onFatal) => {
      fatal = onFatal;
      return {
        start: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn().mockResolvedValue(undefined),
      };
    });
    const lifecycle = new InProcessRelayLifecycle(factory, jest.fn());

    await lifecycle.run({ sessionId: "one" });
    await lifecycle.suspend();
    fatal?.(new Error("late fatal"));
    await jest.advanceTimersByTimeAsync(RELAY_RESTART_BASE_DELAY_MS);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(lifecycle.running).toBe(false);
  });

  it("backs off and stops after the bounded restart budget", async () => {
    jest.useFakeTimers();
    let fatal: ((error: Error) => void) | undefined;
    let starts = 0;
    const onRestartFailed = jest.fn();
    const lifecycle = new InProcessRelayLifecycle(
      (_config, onFatal) => {
        fatal = onFatal;
        return {
          start: jest.fn(async () => {
            starts++;
            if (starts > 1) throw new Error("restart failed");
          }),
          cleanup: jest.fn().mockResolvedValue(undefined),
        };
      },
      jest.fn(),
      onRestartFailed,
    );

    await lifecycle.run({ sessionId: "one" });
    fatal?.(new Error("relay exited"));
    await jest.advanceTimersByTimeAsync(20_000);

    expect(starts).toBe(1 + RELAY_RESTART_MAX_ATTEMPTS);
    expect(onRestartFailed).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("limit") }),
    );
    expect(lifecycle.running).toBe(false);
    await lifecycle.terminate();
  });

  it("retains a client when cleanup fails so a lifecycle retry can finish", async () => {
    const cleanup = jest
      .fn()
      .mockRejectedValueOnce(new Error("PTY still running"))
      .mockResolvedValueOnce(undefined);
    const lifecycle = new InProcessRelayLifecycle(
      () => ({ start: jest.fn().mockResolvedValue(undefined), cleanup }),
      jest.fn(),
    );

    await lifecycle.run({ sessionId: "one" });
    await expect(lifecycle.suspend()).rejects.toThrow("PTY still running");
    expect(lifecycle.running).toBe(true);

    await expect(lifecycle.suspend()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(lifecycle.running).toBe(false);
  });
});
