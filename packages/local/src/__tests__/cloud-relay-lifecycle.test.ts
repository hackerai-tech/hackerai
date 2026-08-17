import {
  InProcessRelayClient,
  InProcessRelayLifecycle,
} from "../cloud-relay-lifecycle";

describe("in-process cloud relay lifecycle", () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUnexpectedExit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "relay disconnected" }),
    );
    expect(clients).toHaveLength(2);
    expect(clients[1].start).toHaveBeenCalledTimes(1);
    await lifecycle.terminate();
  });

  it("does not restart a client after suspension wins the transition", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(lifecycle.running).toBe(false);
  });
});
