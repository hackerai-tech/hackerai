import { EventEmitter } from "events";
import {
  OperationChannelRouter,
  sandboxOperationChannel,
} from "../operation-channels";
import { CentrifugoMessageReassembler } from "../centrifugo-transport";

class Subscription extends EventEmitter {
  subscribe = jest.fn();
  unsubscribe = jest.fn();
  ready = jest.fn().mockResolvedValue(undefined);
  publish = jest.fn().mockResolvedValue(undefined);
}

const request = (id: string, type = "command") => ({
  type,
  [type.startsWith("file_")
    ? "requestId"
    : type === "pty_create"
      ? "sessionId"
      : "commandId"]: id,
  operationChannel: true,
  targetConnectionId: "conn-1",
});

describe("operation channels", () => {
  let subs: Subscription[];
  let client: { newSubscription: jest.Mock; removeSubscription: jest.Mock };
  let router: OperationChannelRouter<Subscription>;
  beforeEach(() => {
    jest.useFakeTimers();
    subs = [];
    client = {
      newSubscription: jest.fn(() => {
        const s = new Subscription();
        subs.push(s);
        return s;
      }),
      removeSubscription: jest.fn(),
    };
    router = new OperationChannelRouter<Subscription>(
      client,
      "user-1",
      "conn-1",
    );
  });
  afterEach(() => {
    router.stop();
    jest.useRealTimers();
  });

  it("isolates simultaneous command, file and PTY output including fragments", async () => {
    const handle = jest.fn();
    await Promise.all([
      router.dispatch(request("cmd"), handle),
      router.dispatch(request("file", "file_read"), handle),
      router.dispatch(request("pty", "pty_create"), handle),
    ]);
    expect(
      client.newSubscription.mock.calls.map(([channel]) => channel),
    ).toEqual([
      "sandbox:operation:conn-1:command:cmd#user-1",
      "sandbox:operation:conn-1:file:file#user-1",
      "sandbox:operation:conn-1:pty:pty#user-1",
    ]);
    for (const sub of subs) sub.publish.mockClear();
    const data = "large-output-".repeat(10000);
    await router.publish({
      type: "stdout",
      commandId: "cmd",
      data,
      sequence: 0,
    });
    expect(subs[0].publish.mock.calls.length).toBeGreaterThan(1);
    expect(subs[1].publish).not.toHaveBeenCalled();
    expect(subs[2].publish).not.toHaveBeenCalled();
    const reassembler = new CentrifugoMessageReassembler();
    const decoded = subs[0].publish.mock.calls
      .map(([fragment]) => reassembler.accept(fragment))
      .filter(Boolean);
    expect(decoded).toEqual([
      { type: "stdout", commandId: "cmd", data, sequence: 0 },
    ]);
    await router.publish({
      type: "file_read_result",
      requestId: "file",
      content: "file",
    });
    expect(subs[1].unsubscribe).toHaveBeenCalledTimes(1);
    expect(subs[0].unsubscribe).not.toHaveBeenCalled();
    await expect(
      router.publish({
        type: "file_error",
        requestId: "file",
        message: "late",
      }),
    ).resolves.toBeUndefined();
    expect(subs[1].publish).toHaveBeenCalledTimes(1);
  });

  it("waits for readiness, acknowledges before execution, and never replays a start", async () => {
    let ready!: () => void;
    const sub = new Subscription();
    sub.ready.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    client.newSubscription.mockReturnValue(sub);
    const handle = jest.fn(() =>
      expect(sub.publish).toHaveBeenCalledWith({
        type: "operation_ready",
        commandId: "cmd",
      }),
    );
    const pending = router.dispatch(request("cmd"), handle);
    await router.dispatch(request("cmd"), handle);
    expect(handle).not.toHaveBeenCalled();
    ready();
    await pending;
    sub.emit("subscribed");
    await router.dispatch(request("cmd"), handle);
    expect(handle).toHaveBeenCalledTimes(1);
    await router.publish({ type: "exit", commandId: "cmd", exitCode: 0 });
    await router.dispatch(request("cmd"), handle);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("buffers cancellation until the initial handler starts when the ready ACK is still in flight", async () => {
    let published!: () => void;
    const sub = new Subscription();
    sub.publish.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        published = resolve;
      }),
    );
    client.newSubscription.mockReturnValue(sub);
    const handle = jest.fn();
    const pending = router.dispatch(request("cmd"), handle);
    await Promise.resolve();
    await Promise.resolve();
    sub.emit("publication", {
      data: {
        type: "command_cancel",
        commandId: "cmd",
        targetConnectionId: "conn-1",
      },
    });
    expect(handle).not.toHaveBeenCalled();
    published();
    await pending;
    expect(handle.mock.calls.map(([message]) => message.type)).toEqual([
      "command",
      "command_cancel",
    ]);
  });

  it("routes only same-operation controls and rejects cross-connection/destination injection", async () => {
    const handle = jest.fn();
    await router.dispatch(request("pty", "pty_create"), handle);
    handle.mockClear();
    subs[0].emit("publication", {
      data: {
        type: "pty_input",
        sessionId: "other",
        targetConnectionId: "conn-1",
      },
    });
    subs[0].emit("publication", {
      data: {
        type: "pty_input",
        sessionId: "pty",
        targetConnectionId: "other",
      },
    });
    subs[0].emit("publication", {
      data: { ...request("evil"), type: "command" },
    });
    expect(handle).not.toHaveBeenCalled();
    const input = {
      type: "pty_input",
      sessionId: "pty",
      targetConnectionId: "conn-1",
      data: "hello",
    };
    subs[0].emit("publication", { data: input });
    expect(handle).toHaveBeenCalledWith(input);
    await router.dispatch(
      { ...request("other"), targetConnectionId: "other" },
      handle,
    );
    expect(client.newSubscription).toHaveBeenCalledTimes(1);
    await expect(router.dispatch(request("x#victim"), handle)).rejects.toThrow(
      "Invalid relay operation identity",
    );
    expect(() =>
      sandboxOperationChannel("user#victim", "conn-1", "file", "id"),
    ).toThrow();
  });

  it("preserves legacy requests and responses", async () => {
    const handle = jest.fn();
    const legacy = { ...request("old"), operationChannel: undefined };
    await router.dispatch(legacy, handle);
    expect(handle).toHaveBeenCalledWith(legacy);
    expect(client.newSubscription).not.toHaveBeenCalled();
    const legacyPublish = jest.fn().mockResolvedValue(undefined);
    await router.publish(
      { type: "stdout", commandId: "old", data: "old" },
      legacyPublish,
    );
    expect(legacyPublish).toHaveBeenCalledWith({
      type: "stdout",
      commandId: "old",
      data: "old",
    });
  });

  it("does not publish unknown or previous-connection output through the legacy callback", async () => {
    const legacyPublish = jest.fn().mockResolvedValue(undefined);
    await router.publish(
      { type: "stdout", commandId: "from-old-connection", data: "late" },
      legacyPublish,
    );
    await router.dispatch(request("cmd"), jest.fn());
    await router.publish(
      { type: "exit", commandId: "cmd", exitCode: 0 },
      legacyPublish,
    );
    await router.publish(
      { type: "stdout", commandId: "cmd", data: "late" },
      legacyPublish,
    );
    expect(legacyPublish).not.toHaveBeenCalled();
  });

  it("cleans up failed readiness and abandoned routes without executing or broadcasting", async () => {
    const sub = new Subscription();
    sub.ready.mockRejectedValue(new Error("denied"));
    client.newSubscription.mockReturnValueOnce(sub);
    const handle = jest.fn();
    await expect(router.dispatch(request("bad"), handle)).rejects.toThrow(
      "denied",
    );
    expect(handle).not.toHaveBeenCalled();
    expect(client.removeSubscription).toHaveBeenCalledWith(sub);
    await router.dispatch(request("file", "file_read"), handle);
    await jest.advanceTimersByTimeAsync(180000);
    expect(subs[0].unsubscribe).toHaveBeenCalled();
    await expect(
      router.publish({ type: "file_ok", requestId: "file" }),
    ).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps a long-lived PTY subscribed for the server's one-hour session lifetime", async () => {
    await router.dispatch(request("long", "pty_create"), jest.fn());
    await jest.advanceTimersByTimeAsync(60 * 60000);
    expect(subs[0].unsubscribe).not.toHaveBeenCalled();
    await router.publish({
      type: "pty_data",
      sessionId: "long",
      data: "still active",
    });
    expect(subs[0].publish).toHaveBeenLastCalledWith({
      type: "pty_data",
      sessionId: "long",
      data: "still active",
    });
    await router.publish({ type: "pty_exit", sessionId: "long", exitCode: 0 });
    expect(subs[0].unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("stop during readiness prevents execution and releases every subscription", async () => {
    let ready!: () => void;
    const sub = new Subscription();
    sub.ready.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    client.newSubscription.mockReturnValue(sub);
    const handle = jest.fn();
    const pending = router.dispatch(request("cmd"), handle);
    router.stop();
    ready();
    await pending;
    expect(handle).not.toHaveBeenCalled();
    expect(client.removeSubscription).toHaveBeenCalledWith(sub);
    expect(jest.getTimerCount()).toBe(0);
  });
});
