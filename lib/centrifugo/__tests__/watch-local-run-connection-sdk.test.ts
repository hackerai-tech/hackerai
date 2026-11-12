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

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: (event: unknown) => void;
  commands: Command[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
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

  close() {
    this.closed = true;
  }

  // Server frames arrive after the current task, as from a real socket.
  push(frame: object) {
    void Promise.resolve().then(() => {
      if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }

  serverClose(code: number) {
    this.closed = true;
    this.onclose?.({ code, reason: "" });
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

test.each([
  [
    "a transport close",
    (socket: FakeSocket) => socket.serverClose(1006),
    "subscription_reconnecting",
    1,
    "connecting",
  ],
  [
    "a permanent server disconnect",
    (socket: FakeSocket) =>
      socket.push({
        push: {
          disconnect: { code: 3501, reason: "PRIVATE", reconnect: false },
        },
      }),
    "subscription_reconnecting",
    1,
    "disconnected",
  ],
  [
    "a server resubscribe 2500",
    unsubscribe(2500),
    "subscription_reconnecting",
    2500,
    "connected",
  ],
  [
    "a server resubscribe 2502",
    unsubscribe(2502),
    "subscription_reconnecting",
    2502,
    "connected",
  ],
  [
    "a server unsubscribe",
    unsubscribe(2000),
    "subscription_unsubscribed",
    2000,
    "connected",
  ],
])(
  "classifies %s by the first callback and the state before its own disconnect",
  async (_name, trigger, reason, callbackCode, clientState) => {
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
    });
    expect(JSON.stringify(cause)).not.toContain("PRIVATE");
    await expectDisposed(watcher, sent);
    expect(watcher.onLost).toHaveBeenCalledTimes(1);
  },
);

test("explicit completion disposes the actual client silently", async () => {
  const watcher = await start();
  const sent = watcher.socket.commands.length;
  expect(watcher.stop()).toBeUndefined();
  expect(watcher.stop()).toBeUndefined();
  await expectDisposed(watcher, sent);
  expect(watcher.onLost).not.toHaveBeenCalled();
});
