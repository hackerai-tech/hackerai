/** @jest-environment node */
import { Centrifuge } from "centrifuge";
import { watchLocalRunConnection } from "../watch-local-run-connection";
import { sandboxConnectionChannel } from "../types";
import { AcknowledgedCommandOutput } from "../acknowledged-command-output";
import { OperationChannelRouter } from "@/packages/local/src/operation-channels";
import { CentrifugoSandbox } from "@/lib/ai/tools/utils/centrifugo-sandbox";
import { getLocalStopDiagnostic } from "@/lib/chat/local-connection-stop";

// Every client here is the installed SDK: the run's observer, the command
// receiver and a Desktop host built from its own router and output window.
// Only the relay node behind the sockets, tokens and authorization are fixtures.
jest.mock("../jwt", () => ({
  generateCentrifugoToken: jest.fn().mockResolvedValue("worker-token"),
}));
jest.mock("@/lib/desktop/authorized-operation", () => ({
  authorizeDesktopOperation: jest.fn().mockResolvedValue("a".repeat(64)),
}));

const USER = "u";
const SELECTED = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const REPLACEMENT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CHANNEL = sandboxConnectionChannel(USER, SELECTED);
const RELAY_URL = "ws://relay.invalid/connection/websocket";
const HOST_TOKENS: Record<string, string> = {
  [`host:${SELECTED}`]: SELECTED,
  [`host:${REPLACEMENT}`]: REPLACEMENT,
};

type Frame = Record<string, unknown>;
type Command = { id?: number } & Record<string, Frame | undefined>;

const closeEvent = (code: number, wasClean: boolean) =>
  Object.assign(new Event("close"), { code, wasClean, reason: "" });

/** A Centrifugo node over the JSON protocol: presence, leave and fanout. */
class Relay {
  readonly sockets = new Set<RelaySocket>();
  readonly publications: { channel: string; data: Frame }[] = [];
  /** New transports open while true; otherwise they fail as unreachable. */
  accepting = true;
  presence: "answer" | "fail" = "answer";
  presenceReplies = 0;
  presenceFailures = 0;
  private clients = 0;

  handle(socket: RelaySocket, { id, ...command }: Command) {
    const reply = (result: Frame) => socket.push({ id, ...result });
    if (command.connect) {
      socket.client = `client-${++this.clients}`;
      const connectionId = HOST_TOKENS[String(command.connect.token)];
      if (connectionId) socket.connInfo = { connectionId };
      this.sockets.add(socket);
      reply({ connect: { client: socket.client, version: "relay" } });
    } else if (command.subscribe) {
      const { channel, join_leave } = command.subscribe;
      socket.channels.set(String(channel), join_leave === true);
      reply({ subscribe: {} });
    } else if (command.unsubscribe) {
      this.leave(socket, String(command.unsubscribe.channel));
      reply({ unsubscribe: {} });
    } else if (command.publish) {
      const channel = String(command.publish.channel);
      const data = command.publish.data as Frame;
      this.publications.push({ channel, data });
      reply({ publish: {} });
      for (const subscriber of this.subscribers(channel))
        subscriber.push({ push: { channel, pub: { data } } });
    } else if (command.presence) {
      if (this.presence === "fail") {
        this.presenceFailures++;
        reply({ error: { code: 100, message: "internal server error" } });
        return;
      }
      const channel = String(command.presence.channel);
      const presence: Record<string, Frame> = {};
      for (const member of this.subscribers(channel))
        presence[member.client!] = member.info();
      if (channel === CHANNEL) this.presenceReplies++;
      reply({ presence: { presence } });
    }
  }

  subscribers(channel: string) {
    return [...this.sockets].filter((socket) => socket.channels.has(channel));
  }

  private leave(socket: RelaySocket, channel: string) {
    if (!socket.channels.delete(channel)) return;
    for (const subscriber of this.subscribers(channel))
      if (subscriber.channels.get(channel))
        subscriber.push({ push: { channel, leave: { info: socket.info() } } });
  }

  detach(socket: RelaySocket) {
    for (const channel of [...socket.channels.keys()])
      this.leave(socket, channel);
    this.sockets.delete(socket);
  }

  /** The run's observer: the only join/leave subscriber of the channel. */
  observer() {
    return [...this.sockets].find((socket) => socket.channels.get(CHANNEL));
  }

  /** The worker's own connections, as when its network path blips. */
  dropWorker() {
    for (const socket of [...this.sockets])
      if (!socket.connInfo) socket.drop(1006);
  }
}

let relay: Relay;
const created: RelaySocket[] = [];

class RelaySocket extends EventTarget {
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: (event: unknown) => void;
  client?: string;
  connInfo?: Frame;
  readonly channels = new Map<string, boolean>();
  closed = false;
  #onclose?: (event: Event) => void;

  constructor(readonly url: string) {
    super();
    created.push(this);
    const reachable = relay.accepting;
    void Promise.resolve().then(() => {
      if (this.closed) return;
      if (reachable) this.onopen?.();
      else this.drop(1006);
    });
  }

  // As a native handler attribute: its listener slot is taken when first set.
  get onclose() {
    return this.#onclose;
  }
  set onclose(handler) {
    if (!this.#onclose)
      this.addEventListener("close", (event) => this.#onclose?.(event));
    this.#onclose = handler;
  }

  info(): Frame {
    return {
      client: this.client,
      user: USER,
      ...(this.connInfo && { conn_info: this.connInfo }),
    };
  }

  send(data: string) {
    for (const line of data.split("\n"))
      if (line) relay.handle(this, JSON.parse(line) as Command);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    relay.detach(this);
    void Promise.resolve().then(() =>
      this.dispatchEvent(closeEvent(1005, true)),
    );
  }

  drop(code: number) {
    if (this.closed) return;
    this.closed = true;
    relay.detach(this);
    this.dispatchEvent(closeEvent(code, false));
  }

  push(frame: Frame) {
    void Promise.resolve().then(() => {
      if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }
}

/** A Desktop host: the actual operation router and acknowledged output window. */
function startHost(connectionId = SELECTED) {
  const executions: string[] = [];
  const outputs = new Map<string, AcknowledgedCommandOutput>();
  const client = new Centrifuge(RELAY_URL, {
    token: `host:${connectionId}`,
    websocket: RelaySocket,
  });
  const router = new OperationChannelRouter(client, USER, connectionId);
  const handle = (message: Frame) => {
    const commandId = String(message.commandId);
    if (message.type === "command") {
      executions.push(commandId);
      router.retainCommandOutput(commandId);
      const output = new AcknowledgedCommandOutput(
        commandId,
        Date.now() + 120_000,
        (frame) => router.publish({ ...frame }),
        () => true,
      );
      outputs.set(commandId, output);
      void output.delivered.then(
        () => router.closeCommand(commandId),
        () => {},
      );
    } else if (message.type === "command_output_ack")
      outputs.get(commandId)?.acknowledge(Number(message.sequence));
    else if (message.type === "command_output_resume")
      outputs.get(commandId)?.resume(Number(message.sequence));
  };
  const subscription = client.newSubscription(
    sandboxConnectionChannel(USER, connectionId),
  );
  subscription.on("publication", ({ data }) => {
    void router.dispatch(data, handle).catch(() => {});
  });
  subscription.subscribe();
  client.connect();
  return {
    executions,
    output: (commandId: string) => outputs.get(commandId)!,
    stop() {
      router.stop();
      for (const output of outputs.values()) output.stop();
      client.disconnect();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
async function until(condition: () => boolean, limitMs = 20_000) {
  for (let waited = 0; !condition(); waited += 50) {
    if (waited >= limitMs) throw new Error("Condition not reached");
    await jest.advanceTimersByTimeAsync(50);
  }
  await settle();
}

const originalWebSocket = globalThis.WebSocket;
const stops: (() => void)[] = [];
beforeEach(() => {
  jest.useFakeTimers();
  // The receiver's own phase diagnostics, not under test here.
  jest.spyOn(console, "info").mockImplementation(() => {});
  relay = new Relay();
  created.length = 0;
  globalThis.WebSocket = RelaySocket as unknown as typeof WebSocket;
  process.env.CENTRIFUGO_WS_URL = RELAY_URL;
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  globalThis.WebSocket = originalWebSocket;
  delete process.env.CENTRIFUGO_WS_URL;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function startRun() {
  const host = startHost();
  stops.push(() => host.stop());
  const onLost = jest.fn();
  const stop = watchLocalRunConnection({
    userId: USER,
    connectionId: SELECTED,
    onLost,
  });
  stops.push(stop);
  await until(() => relay.presenceReplies === 1);
  expect(onLost).not.toHaveBeenCalled();
  const cause = () => {
    expect(onLost).toHaveBeenCalledTimes(1);
    return getLocalStopDiagnostic(onLost.mock.calls[0][0]);
  };
  return { host, onLost, stop, cause, observer: relay.observer()! };
}

test("keeps a verified host selected across a brief observer-only reset", async () => {
  const { host, onLost, observer, cause } = await startRun();
  const reads = relay.presenceReplies;
  observer.drop(1006);
  // A new observer transport and subscription, then a new presence lookup.
  await until(() => relay.presenceReplies > reads, 5_000);
  const recovered = relay.observer()!;
  expect(recovered).not.toBe(observer);
  expect(onLost).not.toHaveBeenCalled();
  // Monitoring continues at the normal cadence, well past the window.
  await jest.advanceTimersByTimeAsync(60_000);
  expect(onLost).not.toHaveBeenCalled();
  expect(relay.presenceReplies).toBeGreaterThanOrEqual(reads + 12);
  // A positively observed departure still ends the run, once.
  host.stop();
  await settle();
  expect(cause()).toMatchObject({
    reason: "selected_host_left",
    connectionId: SELECTED,
    hadPositivePresence: true,
  });
  await jest.advanceTimersByTimeAsync(60_000);
  expect(onLost).toHaveBeenCalledTimes(1);
});

test("a reconnected subscription alone never restores readiness", async () => {
  const { onLost, observer, cause } = await startRun();
  relay.presence = "fail";
  const interruptedAt = jest.now();
  observer.drop(1006);
  await until(() => relay.observer() !== undefined, 5_000);
  // Subscribed again, but every lookup fails: none extends the window.
  await jest.advanceTimersByTimeAsync(interruptedAt + 14_999 - jest.now());
  expect(relay.observer()).toBeDefined();
  expect(relay.presenceFailures).toBeGreaterThanOrEqual(2);
  expect(onLost).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(cause()).toEqual({
    reason: "observer_recovery_expired",
    connectionId: SELECTED,
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: expect.any(Number),
    clientState: "connected",
    socketCloseCode: 1006,
    socketCloseWasClean: false,
  });
});

test("a sustained relay outage stops the run once, at the fixed deadline, and stops retrying", async () => {
  const { onLost, observer, cause } = await startRun();
  relay.accepting = false;
  const before = created.length;
  observer.drop(1006);
  await jest.advanceTimersByTimeAsync(14_999);
  expect(onLost).not.toHaveBeenCalled();
  // The SDK alone retried, with bounded delays.
  expect(created.length - before).toBeGreaterThanOrEqual(4);
  await jest.advanceTimersByTimeAsync(1);
  expect(cause()).toMatchObject({
    reason: "observer_recovery_expired",
    clientState: "connecting",
    socketCloseCode: 1006,
    socketCloseWasClean: false,
  });
  const attempts = created.length;
  relay.accepting = true;
  await jest.advanceTimersByTimeAsync(60_000);
  expect(created.length).toBe(attempts);
  expect(onLost).toHaveBeenCalledTimes(1);
});

test("a replacement Desktop session seen after the outage never continues the run", async () => {
  const { host, observer, cause } = await startRun();
  // The selected host leaves while the observer is away and cannot see it.
  observer.drop(1006);
  host.stop();
  stops.push(startHost(REPLACEMENT).stop);
  await until(() => relay.presenceReplies > 1, 5_000);
  expect(cause()).toMatchObject({
    reason: "selected_presence_absent",
    connectionId: SELECTED,
    hadPositivePresence: true,
  });
});

describe("a wake after the deadline, before its delayed timer", () => {
  test.each([
    ["the wall clock", () => jest.setSystemTime(Date.now() + 20_000)],
    [
      "the monotonic clock",
      () => {
        const now = performance.now.bind(performance);
        jest.spyOn(performance, "now").mockImplementation(() => now() + 20_000);
      },
    ],
  ])("cannot regain readiness when %s passed it", async (_clock, sleep) => {
    const { onLost, observer, cause } = await startRun();
    relay.accepting = false;
    observer.drop(1006);
    await jest.advanceTimersByTimeAsync(2_000);
    // Suspended: the clock moves past the window, but no timer has fired.
    sleep();
    relay.accepting = true;
    const reads = relay.presenceReplies;
    await until(() => relay.presenceReplies > reads, 5_000);
    // Well before the window's own timer: the positive lookup came too late.
    expect(cause()?.reason).toBe("observer_recovery_expired");
    await jest.advanceTimersByTimeAsync(60_000);
    expect(onLost).toHaveBeenCalledTimes(1);
  });
});

test("explicit completion during recovery disposes the observer silently", async () => {
  const { onLost, stop, observer } = await startRun();
  relay.accepting = false;
  observer.drop(1006);
  await jest.advanceTimersByTimeAsync(3_000);
  stop();
  const attempts = created.length;
  relay.accepting = true;
  await jest.advanceTimersByTimeAsync(60_000);
  expect(onLost).not.toHaveBeenCalled();
  expect(created.length).toBe(attempts);
  expect(relay.observer()).toBeUndefined();
});

test("one dispatched command survives an observer reset and receiver reconnect without a second execution", async () => {
  const { host, onLost } = await startRun();
  const sandbox = new CentrifugoSandbox(
    USER,
    {
      connectionId: SELECTED,
      name: "Desktop",
      isDesktop: true,
      capabilities: {
        commands: true,
        pty: true,
        files: true,
        operationChannels: true,
      },
    },
    { wsUrl: RELAY_URL, tokenSecret: "unused" },
  );
  const stdout: string[] = [];
  let result: unknown;
  const run = sandbox.commands
    .run("printf once", { onStdout: (data) => stdout.push(data) })
    .then((value) => (result = value));
  await until(() => host.executions.length === 1);
  const output = host.output(host.executions[0]);
  output.append({ type: "stdout", data: "first\n" });
  await until(() => stdout.length === 1);
  await jest.advanceTimersByTimeAsync(500);

  // The worker's network path blips: observer and receiver both drop, while
  // the selected host keeps running and finishes the command meanwhile.
  relay.accepting = false;
  relay.dropWorker();
  output.append({ type: "stdout", data: "second\n" });
  output.append({ type: "exit", exitCode: 0 });
  await jest.advanceTimersByTimeAsync(2_000);
  relay.accepting = true;
  await until(() => result !== undefined);
  await run;

  expect(result).toMatchObject({ stdout: "first\nsecond\n", exitCode: 0 });
  // Output recovered by cursor, never by replaying execution.
  expect(
    relay.publications.some(
      ({ data }) => data.type === "command_output_resume",
    ),
  ).toBe(true);
  expect(host.executions).toHaveLength(1);
  expect(
    relay.publications.filter(({ data }) => data.type === "command"),
  ).toHaveLength(1);
  // The run's observer recovered rather than stopping it.
  await until(() => relay.observer() !== undefined);
  await jest.advanceTimersByTimeAsync(20_000);
  expect(onLost).not.toHaveBeenCalled();
});
