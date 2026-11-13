/** @jest-environment node */
import type { EventEmitter } from "events";
import { Centrifuge, type Subscription } from "centrifuge";
import { watchLocalRunConnection } from "../watch-local-run-connection";
import { sandboxConnectionChannel } from "../types";
import { getLocalStopDiagnostic } from "@/lib/chat/local-connection-stop";

// Runs the installed SDK's event order against the actual watcher. Only the
// token and the socket are fixtures: a scripted server answers over JSON.
jest.mock("../jwt", () => ({
  generateCentrifugoToken: jest.fn().mockResolvedValue("token"),
}));

const SELECTED = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CHANNEL = sandboxConnectionChannel("u", SELECTED);

type Command = { id: number } & Record<string, unknown>;

// Its getters, like a native CloseEvent's.
class FakeCloseEvent extends Event {
  constructor(
    readonly init: { code: number; wasClean: boolean; reason: string },
  ) {
    super("close");
  }
  get code() {
    return this.init.code;
  }
  get wasClean() {
    return this.init.wasClean;
  }
  get reason() {
    return this.init.reason;
  }
}

class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: (event: unknown) => void;
  commands: Command[] = [];
  closed = false;
  #onclose?: (event: Event) => void;

  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }

  // As a native event handler attribute, it takes its listener slot when first
  // set, after any listener added before then.
  get onclose() {
    return this.#onclose;
  }
  set onclose(handler) {
    if (!this.#onclose)
      this.addEventListener("close", (event) => this.#onclose?.(event));
    this.#onclose = handler;
  }

  send(data: string) {
    for (const line of data.split("\n")) {
      const command = JSON.parse(line) as Command;
      this.commands.push(command);
      if (command.connect)
        this.push({ id: command.id, connect: { client: "observer" } });
      else if (command.subscribe) this.push({ id: command.id, subscribe: {} });
      else if (command.presence)
        this.push({
          id: command.id,
          presence: {
            presence: {
              host: { client: "host", conn_info: { connectionId: SELECTED } },
            },
          },
        });
    }
  }

  // The client's own close completes later, without a status code.
  close() {
    if (this.closed) return;
    this.closed = true;
    void Promise.resolve().then(() =>
      this.dispatchEvent(
        new FakeCloseEvent({ code: 1005, wasClean: true, reason: "" }),
      ),
    );
  }

  // Server frames arrive after the current task, as from a real socket.
  push(frame: object) {
    void Promise.resolve().then(() => {
      if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }

  serverClose(code: number, wasClean = false) {
    this.closed = true;
    this.dispatchEvent(
      new FakeCloseEvent({ code, wasClean, reason: "PRIVATE" }),
    );
  }

  presenceReads() {
    return this.commands.filter((command) => command.presence).length;
  }
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const originalWebSocket = globalThis.WebSocket;
let created: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  process.env.CENTRIFUGO_WS_URL = "ws://relay.invalid/connection";
  created = jest.spyOn(Centrifuge.prototype, "newSubscription");
});
afterEach(() => {
  created.mockRestore();
  globalThis.WebSocket = originalWebSocket;
  delete process.env.CENTRIFUGO_WS_URL;
  jest.useRealTimers();
});

async function start() {
  const onLost = jest.fn();
  const stop = watchLocalRunConnection({
    userId: "u",
    connectionId: SELECTED,
    onLost,
  });
  await settle();
  expect(FakeSocket.all).toHaveLength(1);
  const socket = FakeSocket.all[0];
  socket.onopen!();
  await settle();
  const client = created.mock.contexts[0] as Centrifuge;
  const subscription = created.mock.results[0].value as Subscription;
  expect(client.state).toBe("connected");
  expect(subscription.state).toBe("subscribed");
  expect(socket.presenceReads()).toBe(1);
  return { onLost, stop, socket, client, subscription };
}

async function expectDisposed(
  { socket, client, subscription }: Awaited<ReturnType<typeof start>>,
  sent: number,
) {
  expect(client.state).toBe("disconnected");
  for (const emitter of [client, subscription])
    expect((emitter as unknown as EventEmitter).eventNames()).toEqual([]);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(FakeSocket.all).toHaveLength(1);
  expect(socket.commands).toHaveLength(sent);
  expect(jest.getTimerCount()).toBe(0);
}

const unsubscribe = (code: number) => (socket: FakeSocket) =>
  socket.push({
    push: { channel: CHANNEL, unsubscribe: { code, reason: "PRIVATE" } },
  });

// A terminal callback is classified by itself, even when the SDK first moves
// its subscription to subscribing in the same teardown.
test.each([
  [
    "a permanent server disconnect",
    (socket: FakeSocket) =>
      socket.push({
        push: {
          disconnect: { code: 3501, reason: "PRIVATE", reconnect: false },
        },
      }),
    "observer_disconnected",
    3501,
    "disconnected",
    {},
  ],
  [
    "a server unsubscribe",
    unsubscribe(2000),
    "subscription_unsubscribed",
    2000,
    "connected",
    {},
  ],
])(
  "classifies %s by the first callback and the state before its own disconnect",
  async (_name, trigger, reason, callbackCode, clientState, socketClose) => {
    const watcher = await start();
    const sent = watcher.socket.commands.length;
    trigger(watcher.socket);
    await settle();
    expect(watcher.onLost).toHaveBeenCalledTimes(1);
    const cause = getLocalStopDiagnostic(watcher.onLost.mock.calls[0][0]);
    // A later original client event must not replace the first cause or code.
    expect(cause).toEqual({
      reason,
      connectionId: SELECTED,
      hadPositivePresence: true,
      lastPositivePresenceAgeMs: 0,
      callbackCode,
      clientState,
      ...socketClose,
    });
    expect(JSON.stringify(cause)).not.toContain("PRIVATE");
    await expectDisposed(watcher, sent);
    expect(watcher.onLost).toHaveBeenCalledTimes(1);
  },
);

// The SDK's own reconnect or resubscribe, then a new lookup confirming the
// host: the run continues on the same subscription channel.
test.each([
  ["a transport close", (socket: FakeSocket) => socket.serverClose(1006)],
  // An observed normal closure, not itself evidence of an outage.
  [
    "a clean server close",
    (socket: FakeSocket) => socket.serverClose(1000, true),
  ],
  ["a server resubscribe 2500", unsubscribe(2500)],
  ["a server resubscribe 2502", unsubscribe(2502)],
])(
  "recovers from %s through the SDK and a new presence read",
  async (_name, trigger) => {
    const watcher = await start();
    trigger(watcher.socket);
    await settle();
    expect(watcher.onLost).not.toHaveBeenCalled();
    // A closed transport is reopened by the SDK after its bounded backoff.
    await jest.advanceTimersByTimeAsync(3_000);
    const socket = FakeSocket.all.at(-1)!;
    if (socket !== watcher.socket) {
      expect(FakeSocket.all).toHaveLength(2);
      socket.onopen!();
      await settle();
    }
    expect(watcher.subscription.state).toBe("subscribed");
    expect(
      FakeSocket.all.reduce((reads, each) => reads + each.presenceReads(), 0),
    ).toBe(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(watcher.onLost).not.toHaveBeenCalled();
    // A positively observed departure still ends the run, once.
    socket.push({
      push: {
        channel: CHANNEL,
        leave: {
          info: { client: "host", conn_info: { connectionId: SELECTED } },
        },
      },
    });
    await settle();
    expect(watcher.onLost).toHaveBeenCalledTimes(1);
    expect(
      getLocalStopDiagnostic(watcher.onLost.mock.calls[0][0])?.reason,
    ).toBe("selected_host_left");
    watcher.stop();
  },
);

test("an outage outlasting the window stops once with the interrupting close", async () => {
  const watcher = await start();
  watcher.socket.serverClose(1006);
  await settle();
  // Every SDK attempt fails before opening.
  for (let elapsed = 0; elapsed < 14_900; elapsed += 100) {
    await jest.advanceTimersByTimeAsync(100);
    const socket = FakeSocket.all.at(-1)!;
    if (!socket.closed) socket.serverClose(1006);
  }
  expect(watcher.onLost).not.toHaveBeenCalled();
  expect(FakeSocket.all.length).toBeGreaterThanOrEqual(4);
  await jest.advanceTimersByTimeAsync(100);
  expect(getLocalStopDiagnostic(watcher.onLost.mock.calls[0][0])).toEqual({
    reason: "observer_recovery_expired",
    connectionId: SELECTED,
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: 15_000,
    clientState: "connecting",
    socketCloseCode: 1006,
    socketCloseWasClean: false,
  });
  const attempts = FakeSocket.all.length;
  await jest.advanceTimersByTimeAsync(60_000);
  expect(FakeSocket.all).toHaveLength(attempts);
  expect(watcher.onLost).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test("explicit completion disposes the actual client silently", async () => {
  const watcher = await start();
  const sent = watcher.socket.commands.length;
  expect(watcher.stop()).toBeUndefined();
  expect(watcher.stop()).toBeUndefined();
  await expectDisposed(watcher, sent);
  expect(watcher.onLost).not.toHaveBeenCalled();
});

test("a selected host leave stops without the following own socket close", async () => {
  const watcher = await start();
  const sent = watcher.socket.commands.length;
  watcher.socket.push({
    push: {
      channel: CHANNEL,
      leave: {
        info: { client: "host", conn_info: { connectionId: SELECTED } },
      },
    },
  });
  await settle();
  expect(getLocalStopDiagnostic(watcher.onLost.mock.calls[0][0])).toEqual({
    reason: "selected_host_left",
    connectionId: SELECTED,
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: 0,
  });
  await expectDisposed(watcher, sent);
  expect(watcher.onLost).toHaveBeenCalledTimes(1);
});

test("a close during initial setup is not the run's socket close", async () => {
  const onLost = jest.fn();
  watchLocalRunConnection({ userId: "u", connectionId: SELECTED, onLost });
  await settle();
  // The first attempt fails before it opens; the SDK retries with a new socket.
  FakeSocket.all[0].serverClose(1006);
  await settle();
  await jest.advanceTimersByTimeAsync(1_000);
  expect(FakeSocket.all).toHaveLength(2);
  expect(onLost).not.toHaveBeenCalled();
  const socket = FakeSocket.all[1];
  socket.onopen!();
  await settle();
  expect(socket.presenceReads()).toBe(1);
  socket.push({
    push: { disconnect: { code: 3501, reason: "PRIVATE", reconnect: false } },
  });
  await settle();
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(getLocalStopDiagnostic(onLost.mock.calls[0][0])).toEqual({
    reason: "observer_disconnected",
    connectionId: SELECTED,
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: 0,
    callbackCode: 3501,
    clientState: "disconnected",
  });
});
