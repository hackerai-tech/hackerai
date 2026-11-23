/** @jest-environment node */
import { Centrifuge, type Subscription } from "centrifuge";
import { watchLocalRunConnection } from "../watch-local-run-connection";
import { sandboxConnectionChannel } from "../types";
import { AcknowledgedCommandOutput } from "../acknowledged-command-output";
import {
  DESKTOP_SESSION_CHALLENGE,
  answerDesktopSessionChallenge,
  parseDesktopSessionChallenge,
  type DesktopSessionIdentity,
} from "../desktop-session";
import { OperationChannelRouter } from "@/packages/local/src/operation-channels";
import { CentrifugoSandbox } from "@/lib/ai/tools/utils/centrifugo-sandbox";
import { createCentrifugoPtyHandle } from "@/lib/ai/tools/utils/centrifugo-pty-adapter";
import {
  LocalConnectionLostError,
  getLocalStopDiagnostic,
} from "@/lib/chat/local-connection-stop";
import { LOCAL_SANDBOX_PRESENCE_GRACE_MS } from "../presence";

// A proven session may return for as long as the backend keeps its connection.
const SESSION_WINDOW_MS = LOCAL_SANDBOX_PRESENCE_GRACE_MS;

// Every client is the installed SDK: the run's observer, the command receiver
// and a Desktop host built from the actual operation router, acknowledged
// output window and session answer. Only the relay node behind the sockets,
// tokens, authorization and the host's native identity read are fixtures.
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
const SESSION: DesktopSessionIdentity = {
  launchId: "c".repeat(32),
  pageGeneration: 1,
};

type Frame = Record<string, unknown>;
type Command = { id?: number } & Record<string, Frame | undefined>;

const closeEvent = (code: number, wasClean: boolean) =>
  Object.assign(new Event("close"), { code, wasClean, reason: "" });

/** A Centrifugo node over the JSON protocol: presence, join/leave, fanout. */
class Relay {
  readonly sockets = new Set<RelaySocket>();
  readonly publications: { channel: string; data: Frame }[] = [];
  readonly subscribes: { channel: string; host: boolean }[] = [];
  /** New transports open while true; otherwise they fail as unreachable. */
  accepting = true;
  /** Hosts whose reconnects are refused, while every other client works. */
  readonly refused = new Set<string>();
  /** Centrifugo attaches the publisher's signed ClientInfo to publications. */
  publisherInfo = true;
  presenceReplies = 0;
  private clients = 0;

  handle(socket: RelaySocket, { id, ...command }: Command) {
    const reply = (result: Frame) => socket.push({ id, ...result });
    // The SDK batches subscriptions behind its connect; a refused one has none.
    if (!command.connect && !this.sockets.has(socket)) return;
    if (command.connect) {
      const connectionId = HOST_TOKENS[String(command.connect.token)];
      if (connectionId && this.refused.has(connectionId)) {
        void Promise.resolve().then(() => socket.drop(1006));
        return;
      }
      socket.client = `client-${++this.clients}`;
      if (connectionId) socket.connInfo = { connectionId };
      this.sockets.add(socket);
      reply({ connect: { client: socket.client, version: "relay" } });
    } else if (command.subscribe) {
      const { channel, join_leave } = command.subscribe;
      const name = String(channel);
      socket.channels.set(name, join_leave === true);
      this.subscribes.push({ channel: name, host: Boolean(socket.connInfo) });
      reply({ subscribe: {} });
      for (const subscriber of this.subscribers(name))
        if (subscriber !== socket && subscriber.channels.get(name))
          subscriber.push({
            push: { channel: name, join: { info: socket.info() } },
          });
    } else if (command.unsubscribe) {
      this.leave(socket, String(command.unsubscribe.channel));
      reply({ unsubscribe: {} });
    } else if (command.publish) {
      const channel = String(command.publish.channel);
      const data = command.publish.data as Frame;
      this.publications.push({ channel, data });
      reply({ publish: {} });
      // A client publication names its publisher, as Centrifugo's does.
      for (const subscriber of this.subscribers(channel))
        subscriber.push({
          push: {
            channel,
            pub: { data, ...(this.publisherInfo && { info: socket.info() }) },
          },
        });
    } else if (command.presence) {
      const channel = String(command.presence.channel);
      const presence: Record<string, Frame> = {};
      for (const member of this.subscribers(channel))
        presence[member.client!] = member.info();
      this.presenceReplies++;
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

  /** The selected host's own transport fails; the worker stays connected. */
  dropHost(connectionId = SELECTED) {
    this.refused.add(connectionId);
    for (const socket of [...this.sockets])
      if (socket.connInfo?.connectionId === connectionId) socket.drop(1006);
  }

  /** The worker's own connections, as when its network path blips. */
  dropWorker() {
    for (const socket of [...this.sockets])
      if (!socket.connInfo) socket.drop(1006);
  }

  observer() {
    return [...this.sockets].find((socket) => socket.channels.get(CHANNEL));
  }

  published(type: string) {
    return this.publications.filter(({ data }) => data.type === type);
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

/**
 * A Desktop host: the actual router and output window, answering challenges
 * with the actual session answer. `native` is what get_desktop_os_info would
 * return now; `startup` what it returned when this page started.
 */
function startHost({
  connectionId = SELECTED,
  // null: an older binary whose get_desktop_os_info has no lifecycle.
  startup = SESSION as DesktopSessionIdentity | null,
  ptyCreationError = false,
} = {}) {
  const executions: string[] = [];
  const terminals: string[] = [];
  const outputs = new Map<string, AcknowledgedCommandOutput>();
  const native = {
    lifecycle: (startup ?? undefined) as DesktopSessionIdentity | undefined,
  };
  const client = new Centrifuge(RELAY_URL, {
    token: `host:${connectionId}`,
    websocket: RelaySocket,
    maxReconnectDelay: 1_000,
  });
  const router = new OperationChannelRouter(client, USER, connectionId);
  let subscription: Subscription;
  const answer = async (message: Frame) => {
    const challenge = parseDesktopSessionChallenge(message);
    if (!challenge) return;
    const proof = await answerDesktopSessionChallenge(challenge, {
      connectionId,
      startup: startup ?? undefined,
      readNativeOsInfo: async () => ({ lifecycle: native.lifecycle }),
      retainsOutput: (id) => outputs.get(id)?.resumable === true,
    });
    if (proof) await subscription.publish(proof).catch(() => {});
  };
  const handle = (message: Frame) => {
    if (message.type === DESKTOP_SESSION_CHALLENGE) {
      void answer(message);
      return;
    }
    if (message.type === "pty_create") {
      const sessionId = String(message.sessionId);
      terminals.push(sessionId);
      void router
        .publish(
          ptyCreationError
            ? {
                type: "pty_error",
                sessionId,
                message: "Native PID unavailable",
              }
            : { type: "pty_ready", sessionId, pid: 7 },
        )
        .catch(() => {});
      return;
    }
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
      // As in the bridge, a failed window stays mapped until the native
      // invocation settles; this fixture's invocations never do.
      void output.delivered.then(
        () => {
          outputs.delete(commandId);
          router.closeCommand(commandId);
        },
        () => {},
      );
    } else if (message.type === "command_cancel") {
      // Native Stop confirmed: the window is released, never replayed.
      outputs.get(commandId)?.cancel();
      void router
        .publish({ type: "command_cancel_result", commandId, canceled: true })
        .catch(() => {});
    } else if (message.type === "command_output_ack")
      outputs.get(commandId)?.acknowledge(Number(message.sequence));
    else if (message.type === "command_output_resume")
      outputs.get(commandId)?.resume(Number(message.sequence));
  };
  subscription = client.newSubscription(
    sandboxConnectionChannel(USER, connectionId),
  );
  subscription.on("publication", ({ data }) => {
    void router.dispatch(data, handle).catch(() => {});
  });
  subscription.subscribe();
  client.connect();
  return {
    executions,
    terminals,
    native,
    output: (commandId: string) => outputs.get(commandId)!,
    /**
     * The command's output window closed (e.g. overflow) while its native
     * invocation is still pending, so the entry remains mapped.
     */
    loseOutput(commandId: string) {
      outputs.get(commandId)?.stop();
    },
    /** The receiver fails without any terminal, as the bridge reports it. */
    reportUnavailable(commandId: string) {
      void router
        .publish({
          type: "command_output_unavailable",
          commandId,
          message: "Command output recovery failed",
        })
        .catch(() => {});
    },
    reportTerminalError(sessionId: string) {
      void router
        .publish({ type: "pty_error", sessionId, message: "session failed" })
        .catch(() => {});
    },
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
  // The receiver's own phase and cursor diagnostics, not under test here.
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
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

async function startRun(host = startHost()) {
  stops.push(() => host.stop());
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
  stops.push(() => void sandbox.close());
  const onLost = jest.fn();
  const watch = watchLocalRunConnection({
    userId: USER,
    connectionId: SELECTED,
    onLost,
    desktopSession: { publishedCommands: () => sandbox.getPublishedCommands() },
  });
  stops.push(() => watch.stop());
  sandbox.setDispatchGate(watch);
  await until(() => watch.isReady());
  // The baseline proof was answered while the host was positively present.
  await until(() => relay.published("desktop_session_proof").length === 1);
  const cause = () => {
    expect(onLost).toHaveBeenCalledTimes(1);
    return getLocalStopDiagnostic(onLost.mock.calls[0][0]);
  };
  return { host, sandbox, watch, onLost, cause };
}

/** One running command with its first chunk received by the worker. */
async function runCommand(run: Awaited<ReturnType<typeof startRun>>) {
  const stdout: string[] = [];
  const outcome: { result?: unknown; error?: unknown } = {};
  const done = run.sandbox.commands
    .run("printf once", { onStdout: (data) => stdout.push(data) })
    .then(
      (result) => (outcome.result = result),
      (error) => (outcome.error = error),
    );
  await until(() => run.host.executions.length === 1);
  const commandId = run.host.executions[0];
  run.host.output(commandId).append({ type: "stdout", data: "first\n" });
  await until(() => stdout.length === 1);
  await jest.advanceTimersByTimeAsync(500);
  return { commandId, stdout, outcome, done };
}

const commandsPublished = () => relay.published("command").length;

test("a host-only relay drop recovers the same session: the run continues, output replays by cursor, nothing executes twice", async () => {
  const run = await startRun();
  const { commandId, outcome, done } = await runCommand(run);
  const receiverChannel = `sandbox:operation:${SELECTED}:command:${commandId}#${USER}`;
  const receiverSubscribes = () =>
    relay.subscribes.filter(
      ({ channel, host }) => channel === receiverChannel && !host,
    ).length;
  expect(receiverSubscribes()).toBe(1);

  // Only the host's transport fails. It finishes the command meanwhile and
  // retains the output it cannot deliver.
  relay.dropHost();
  run.host.output(commandId).append({ type: "stdout", data: "second\n" });
  run.host.output(commandId).append({ type: "exit", exitCode: 0 });
  await until(() => !run.watch.isReady());

  // Unverified: a new command waits before any publication.
  let laterSettled = false;
  const later = run.sandbox.commands.run("printf later").finally(() => {
    laterSettled = true;
  });
  await jest.advanceTimersByTimeAsync(3_000);
  expect(commandsPublished()).toBe(1);
  expect(laterSettled).toBe(false);
  expect(outcome).toEqual({});

  // The same connection, launch and page return well within the window.
  relay.refused.clear();
  await until(() => outcome.result !== undefined || !!outcome.error);
  await done;
  expect(outcome.result).toMatchObject({
    stdout: "first\nsecond\n",
    exitCode: 0,
  });
  // The receiver's own subscription never changed, so nothing on its side
  // would ask for replay: the session recovery requested it explicitly.
  expect(receiverSubscribes()).toBe(1);
  expect(
    relay
      .published("command_output_resume")
      .some(({ data }) => data.commandId === commandId),
  ).toBe(true);
  expect(relay.published("desktop_session_proof")).toHaveLength(2);

  // Readiness reopened: the waiting command is published once and runs once.
  await until(() => run.host.executions.length === 2);
  run.host.output(run.host.executions[1]).append({ type: "exit", exitCode: 0 });
  await expect(later).resolves.toMatchObject({ exitCode: 0 });
  expect(run.host.executions).toEqual([commandId, run.host.executions[1]]);
  expect(commandsPublished()).toBe(2);
  await jest.advanceTimersByTimeAsync(30_000);
  expect(run.onLost).not.toHaveBeenCalled();
});

test("a whole observer and host outage recovers the same session without a second execution", async () => {
  const run = await startRun();
  const { commandId, outcome, done } = await runCommand(run);

  relay.accepting = false;
  relay.dropWorker();
  relay.dropHost();
  run.host.output(commandId).append({ type: "stdout", data: "second\n" });
  run.host.output(commandId).append({ type: "exit", exitCode: 0 });
  await jest.advanceTimersByTimeAsync(2_000);
  relay.accepting = true;
  relay.refused.clear();

  await until(() => outcome.result !== undefined || !!outcome.error);
  await done;
  expect(outcome.result).toMatchObject({
    stdout: "first\nsecond\n",
    exitCode: 0,
  });
  expect(run.host.executions).toEqual([commandId]);
  expect(commandsPublished()).toBe(1);
  await until(() => run.watch.isReady());
  await jest.advanceTimersByTimeAsync(30_000);
  expect(run.onLost).not.toHaveBeenCalled();
});

test("a host outage longer than the observer's own window still recovers the same session without a second execution", async () => {
  const run = await startRun();
  const stdout: string[] = [];
  const outcome: { result?: unknown; error?: unknown } = {};
  const done = run.sandbox.commands
    .run("printf once", {
      onStdout: (data) => stdout.push(data),
      timeoutMs: SESSION_WINDOW_MS + 60_000,
    })
    .then(
      (result) => (outcome.result = result),
      (error) => (outcome.error = error),
    );
  await until(() => run.host.executions.length === 1);
  const [commandId] = run.host.executions;
  run.host.output(commandId).append({ type: "stdout", data: "first\n" });
  await until(() => stdout.length === 1);

  // A laptop sleep or network change: the host is gone well past 15 seconds
  // and finishes the command meanwhile, retaining its undelivered output.
  relay.dropHost();
  run.host.output(commandId).append({ type: "stdout", data: "second\n" });
  run.host.output(commandId).append({ type: "exit", exitCode: 0 });
  await until(() => !run.watch.isReady());
  const lookups = relay.presenceReplies;
  await jest.advanceTimersByTimeAsync(SESSION_WINDOW_MS - 30_000);
  expect(run.onLost).not.toHaveBeenCalled();
  expect(outcome).toEqual({});
  // Lookups back off once the outage is long; the host's join still counts.
  expect(relay.presenceReplies - lookups).toBeLessThan(40);

  relay.refused.clear();
  await until(() => outcome.result !== undefined || !!outcome.error);
  await done;
  expect(outcome.result).toMatchObject({
    stdout: "first\nsecond\n",
    exitCode: 0,
  });
  expect(run.host.executions).toEqual([commandId]);
  expect(commandsPublished()).toBe(1);
  await until(() => run.watch.isReady());
  expect(run.watch.recoverySummary()).toEqual({
    recoveredOutages: 1,
    maxRecoveredOutageMs: expect.any(Number),
  });
  expect(run.watch.recoverySummary().maxRecoveredOutageMs).toBeGreaterThan(
    SESSION_WINDOW_MS - 30_000,
  );
  await jest.advanceTimersByTimeAsync(SESSION_WINDOW_MS + 30_000);
  expect(run.onLost).not.toHaveBeenCalled();
});

test("a different native session returning after a long outage still never revives the run", async () => {
  const run = await startRun();
  relay.dropHost();
  await until(() => !run.watch.isReady());
  await jest.advanceTimersByTimeAsync(60_000);
  run.host.stop();
  const successor = startHost({
    startup: { ...SESSION, launchId: "d".repeat(32) },
  });
  stops.push(() => successor.stop());
  relay.refused.clear();
  await until(() => run.onLost.mock.calls.length > 0);
  expect(run.cause()).toMatchObject({
    reason: "desktop_session_replaced",
    recoveryWindowMs: SESSION_WINDOW_MS,
  });
  expect(run.watch.isReady()).toBe(false);
  expect(successor.executions).toEqual([]);
});

describe("a returning connection that cannot prove the same session is terminal", () => {
  // The original page is gone; a new one holds the same connection ID.
  test.each([
    [
      "a replaced page",
      { ...SESSION, pageGeneration: SESSION.pageGeneration + 1 },
      "desktop_session_replaced",
    ],
    [
      "a restarted native app",
      { ...SESSION, launchId: "d".repeat(32) },
      "desktop_session_replaced",
    ],
    ["a page without native identity", null, "desktop_session_unverified"],
  ])("%s", async (_name, startup, reason) => {
    const run = await startRun();
    const { commandId, outcome, done } = await runCommand(run);
    relay.dropHost();
    await until(() => !run.watch.isReady());
    const waiting = run.watch.waitUntilReady();
    void waiting.catch(() => {});
    const later = run.sandbox.commands.run("printf later");
    void later.catch(() => {});
    run.host.stop();
    const successor = startHost({ startup });
    stops.push(() => successor.stop());
    relay.refused.clear();

    await until(() => run.onLost.mock.calls.length > 0);
    expect(run.cause()).toMatchObject({ reason, connectionId: SELECTED });
    const lost = run.onLost.mock.calls[0][0];
    await expect(waiting).rejects.toBe(lost);
    // The gated command fails with that cause, never reaching any host.
    await expect(later).rejects.toMatchObject({ cause: lost });
    expect(commandsPublished()).toBe(1);
    expect(run.host.executions).toEqual([commandId]);
    expect(successor.executions).toEqual([]);
    // Nothing later revives readiness or the interrupted command.
    await jest.advanceTimersByTimeAsync(30_000);
    expect(run.watch.isReady()).toBe(false);
    expect(run.onLost).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBeUndefined();
    void run.sandbox.close();
    await done;
  });
});

test("a returning session whose output window closed while execution is pending stops without replaying it", async () => {
  const run = await startRun();
  const { commandId, outcome, done } = await runCommand(run);
  relay.dropHost();
  await until(() => !run.watch.isReady());
  // Still mapped (native invocation pending), but no longer resumable.
  run.host.loseOutput(commandId);
  expect(run.host.output(commandId)).toBeDefined();
  const later = run.sandbox.commands.run("printf later");
  void later.catch(() => {});
  relay.refused.clear();
  await until(() => run.onLost.mock.calls.length > 0);
  expect(run.cause()).toMatchObject({
    reason: "desktop_command_unreconciled",
    hadPositivePresence: true,
  });
  expect(relay.published("desktop_session_proof").at(-1)?.data).toMatchObject({
    retainedCommandIds: [],
  });
  await expect(later).rejects.toBeDefined();
  expect(run.host.executions).toEqual([commandId]);
  expect(commandsPublished()).toBe(1);
  expect(relay.published("command_output_resume")).toHaveLength(0);
  expect(outcome.result).toBeUndefined();
  run.sandbox.close();
  await done;
});

test("an active interactive terminal makes a returning host stop the run, never replaying its creation", async () => {
  const run = await startRun();
  const handle = await createCentrifugoPtyHandle(run.sandbox, {
    command: "bounded-shell",
    cols: 80,
    rows: 24,
  });
  expect(run.host.terminals).toHaveLength(1);
  // Unsequenced output with no replay protocol cannot be reconciled.
  expect(run.sandbox.getPublishedCommands()).toEqual([
    expect.objectContaining({ commandId: run.host.terminals[0] }),
  ]);
  relay.dropHost();
  await until(() => !run.watch.isReady());
  relay.refused.clear();
  await until(() => run.onLost.mock.calls.length > 0);
  expect(run.cause()).toMatchObject({
    reason: "desktop_command_unreconciled",
  });
  expect(
    relay.published("desktop_session_challenge").at(-1)?.data,
  ).toMatchObject({ commandIds: [run.host.terminals[0]] });
  await jest.advanceTimersByTimeAsync(10_000);
  expect(relay.published("pty_create")).toHaveLength(1);
  expect(run.host.terminals).toHaveLength(1);
  void handle.kill();
  await jest.advanceTimersByTimeAsync(2_000);
  expect(run.sandbox.getPublishedCommands()).toEqual([]);
});

test("a host that never returns, or returns as a replacement connection, expires at the fixed window", async () => {
  const run = await startRun();
  const interruptedAt = jest.now();
  relay.dropHost();
  await until(() => !run.watch.isReady());
  // A replacement registration is a different connection, never this one.
  stops.push(startHost({ connectionId: REPLACEMENT }).stop);
  const aborted = new AbortController();
  const waiter = run.watch.waitUntilReady(aborted.signal);
  const expiring = run.watch.waitUntilReady();
  void expiring.catch(() => {});
  aborted.abort(new Error("canceled"));
  await expect(waiter).rejects.toThrow("canceled");
  // The window began with the observed leave, within one polling step.
  await jest.advanceTimersByTimeAsync(
    interruptedAt + SESSION_WINDOW_MS - 100 - jest.now(),
  );
  expect(run.onLost).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(200);
  expect(run.cause()).toMatchObject({
    reason: "selected_host_recovery_expired",
    hadPositivePresence: true,
    recoveryWindowMs: SESSION_WINDOW_MS,
  });
  await expect(expiring).rejects.toBeInstanceOf(LocalConnectionLostError);
  // The original session returning late cannot revive the run.
  relay.refused.clear();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(run.onLost).toHaveBeenCalledTimes(1);
  expect(relay.published("desktop_session_challenge")).toHaveLength(
    relay.published("desktop_session_proof").length,
  );
});

test("a native binary without session identity keeps fail-closed host departure", async () => {
  const run = await startRun(startHost({ startup: null }));
  expect(relay.published("desktop_session_proof")[0].data).toMatchObject({
    unavailable: true,
  });
  relay.dropHost();
  await until(() => run.onLost.mock.calls.length > 0);
  expect(run.cause()?.reason).toBe("selected_host_left");
});

test("a proof without the relay's publisher identity grants no host grace", async () => {
  relay.publisherInfo = false;
  const run = await startRun();
  // Answered with the right nonce and identity, but unattributable.
  expect(relay.published("desktop_session_proof")[0].data).toMatchObject({
    launchId: SESSION.launchId,
  });
  relay.dropHost();
  await until(() => run.onLost.mock.calls.length > 0);
  expect(run.cause()?.reason).toBe("selected_host_left");
});

test("a run-owned sandbox captured after monitoring stops can never publish again", async () => {
  const run = await startRun();
  run.watch.stop();
  const later = run.sandbox.commands.run("printf after-stop");
  await expect(later).rejects.toThrow("monitoring has stopped");
  await jest.advanceTimersByTimeAsync(10_000);
  expect(commandsPublished()).toBe(0);
  expect(run.host.executions).toEqual([]);
});

test("readiness that lapses during authorization is required again before publication", async () => {
  const run = await startRun();
  const { authorizeDesktopOperation } = jest.requireMock(
    "@/lib/desktop/authorized-operation",
  ) as { authorizeDesktopOperation: jest.Mock };
  let authorizing = false;
  let authorize!: (id: string) => void;
  authorizeDesktopOperation.mockImplementationOnce(() => {
    authorizing = true;
    return new Promise((resolve) => (authorize = resolve));
  });
  const pending = run.sandbox.commands.run("printf once");
  await until(() => authorizing);
  relay.dropHost();
  await until(() => !run.watch.isReady());
  authorize("a".repeat(64));
  await jest.advanceTimersByTimeAsync(3_000);
  expect(commandsPublished()).toBe(0);

  relay.refused.clear();
  await until(() => run.host.executions.length === 1);
  run.host.output(run.host.executions[0]).append({ type: "exit", exitCode: 0 });
  await expect(pending).resolves.toMatchObject({ exitCode: 0 });
  expect(commandsPublished()).toBe(1);
  expect(run.onLost).not.toHaveBeenCalled();
});

test("Stop before publication ends a readiness wait at once without dispatching", async () => {
  const run = await startRun();
  relay.dropHost();
  await until(() => !run.watch.isReady());
  const stop = new AbortController();
  const pending = run.sandbox.commands.run("printf never", {
    signal: stop.signal,
  });
  await jest.advanceTimersByTimeAsync(1_000);
  stop.abort();
  await expect(pending).resolves.toMatchObject({ exitCode: 130 });
  relay.refused.clear();
  await until(() => run.watch.isReady());
  await jest.advanceTimersByTimeAsync(5_000);
  expect(commandsPublished()).toBe(0);
  expect(run.host.executions).toEqual([]);
  // Nothing was published, so nothing is uncertain: the run continues.
  expect(run.onLost).not.toHaveBeenCalled();
});

describe("a published execution whose outcome becomes unknown", () => {
  /** Later work on the captured sandbox never reaches the host. */
  async function expectDispatchClosed(
    run: Awaited<ReturnType<typeof startRun>>,
  ) {
    const executed = run.host.executions.length;
    const published = commandsPublished();
    await expect(
      run.sandbox.commands.run("printf after"),
    ).rejects.toBeDefined();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(commandsPublished()).toBe(published);
    expect(run.host.executions).toHaveLength(executed);
  }

  test("a receiver failure without a terminal stops the run while the observer stays healthy", async () => {
    const run = await startRun();
    const { commandId, outcome, done } = await runCommand(run);
    run.host.reportUnavailable(commandId);
    await until(() => !!outcome.error);
    await done;
    expect(run.cause()).toMatchObject({
      reason: "desktop_command_unreconciled",
      connectionId: SELECTED,
    });
    expect(run.watch.isReady()).toBe(false);
    await expectDispatchClosed(run);
  });

  test("an interactive terminal that fails after ready stops the run", async () => {
    const run = await startRun();
    const handle = await createCentrifugoPtyHandle(run.sandbox, {
      command: "bounded-shell",
      cols: 80,
      rows: 24,
    });
    run.host.reportTerminalError(run.host.terminals[0]);
    await expect(handle.exited).resolves.toMatchObject({
      observationFailed: true,
    });
    expect(run.cause()?.reason).toBe("desktop_command_unreconciled");
    await expectDispatchClosed(run);
    expect(run.host.terminals).toHaveLength(1);
  });

  test("an error before PTY readiness does not prove native execution never started", async () => {
    const run = await startRun(startHost({ ptyCreationError: true }));
    await expect(
      createCentrifugoPtyHandle(run.sandbox, {
        command: "bounded-shell",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow("Native PID unavailable");
    expect(run.cause()?.reason).toBe("desktop_command_unreconciled");
    await expectDispatchClosed(run);
    expect(run.host.terminals).toHaveLength(1);
  });

  test("a terminal torn down during a whole outage is never forgotten before the session proof", async () => {
    const run = await startRun();
    const handle = await createCentrifugoPtyHandle(run.sandbox, {
      command: "bounded-shell",
      cols: 80,
      rows: 24,
    });
    let exitedAt: number | undefined;
    void handle.exited.then(() => (exitedAt = jest.now()));
    relay.accepting = false;
    relay.dropWorker();
    relay.dropHost();
    await until(() => exitedAt !== undefined);
    // Its teardown itself stopped the run, before any recovery proof could
    // see an empty in-flight list.
    expect(run.cause()?.reason).toBe("desktop_command_unreconciled");
    expect(relay.published("desktop_session_proof")).toHaveLength(1);
    relay.accepting = true;
    relay.refused.clear();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(run.onLost).toHaveBeenCalledTimes(1);
    expect(run.watch.isReady()).toBe(false);
    expect(relay.published("pty_create")).toHaveLength(1);
  });

  test("a confirmed Stop and a failure before publication leave the run going", async () => {
    const run = await startRun();
    const stop = new AbortController();
    const canceled = run.sandbox.commands.run("printf long", {
      signal: stop.signal,
    });
    await until(() => run.host.executions.length === 1);
    stop.abort();
    await expect(canceled).resolves.toMatchObject({ exitCode: 130 });

    const { authorizeDesktopOperation } = jest.requireMock(
      "@/lib/desktop/authorized-operation",
    ) as { authorizeDesktopOperation: jest.Mock };
    authorizeDesktopOperation.mockRejectedValueOnce(new Error("denied"));
    await expect(run.sandbox.commands.run("printf denied")).rejects.toThrow(
      "denied",
    );
    expect(commandsPublished()).toBe(1);

    // Both outcomes are known: the run is still admitted to dispatch.
    const next = run.sandbox.commands.run("printf next");
    await until(() => run.host.executions.length === 2);
    run.host
      .output(run.host.executions[1])
      .append({ type: "exit", exitCode: 0 });
    await expect(next).resolves.toMatchObject({ exitCode: 0 });
    expect(run.onLost).not.toHaveBeenCalled();
  });
});

describe("completion confirmation after the model finished", () => {
  const track = (promise: Promise<void>) => {
    const outcome = { done: false, error: undefined as unknown };
    promise.then(
      () => (outcome.done = true),
      (error) => Object.assign(outcome, { done: true, error }),
    );
    return outcome;
  };

  test("a healthy host is confirmed by a fresh proof, never the cached readiness", async () => {
    const run = await startRun();
    expect(run.watch.isReady()).toBe(true);
    const confirmed = track(run.watch.confirmReady());
    // The cached state is dropped at once; only a new proof restores it.
    expect(run.watch.isReady()).toBe(false);
    await until(() => confirmed.done);
    expect(confirmed.error).toBeUndefined();
    expect(relay.published("desktop_session_proof")).toHaveLength(2);
    expect(run.watch.isReady()).toBe(true);
    expect(run.onLost).not.toHaveBeenCalled();
    // A completion check is not an outage the run recovered from.
    expect(run.watch.recoverySummary()).toEqual({ recoveredOutages: 0 });
  });

  test("confirmation during recovery rejects a proof issued before the completion boundary", async () => {
    const run = await startRun();
    const observer = relay.observer()!;
    const deliver = observer.push.bind(observer);
    const held: Frame[] = [];
    jest.spyOn(observer, "push").mockImplementation((frame) => {
      const push = frame.push as { pub?: { data?: Frame } } | undefined;
      if (push?.pub?.data?.type === "desktop_session_proof") held.push(frame);
      else deliver(frame);
    });
    relay.dropHost();
    await until(() => !run.watch.isReady());
    relay.refused.clear();
    await until(() => held.length === 1);
    const confirmed = track(run.watch.confirmReady());
    deliver(held[0]);
    await settle();
    expect(confirmed.done).toBe(false);
    expect(run.watch.isReady()).toBe(false);

    await until(() => held.length === 2);
    deliver(held[1]);
    await until(() => confirmed.done);
    expect(confirmed.error).toBeUndefined();
    expect(run.watch.isReady()).toBe(true);
    expect(run.onLost).not.toHaveBeenCalled();
    expect(commandsPublished()).toBe(0);
  });

  test("fresh completion verification never extends an outage already in progress", async () => {
    const run = await startRun();
    relay.dropHost();
    await until(() => !run.watch.isReady());
    const interruptedAt = jest.now();
    await jest.advanceTimersByTimeAsync(SESSION_WINDOW_MS - 5_000);
    const confirmed = track(run.watch.confirmReady());
    await jest.advanceTimersByTimeAsync(5_100);
    expect(confirmed.error).toBeInstanceOf(LocalConnectionLostError);
    expect(run.cause()?.reason).toBe("selected_host_recovery_expired");
    expect(jest.now() - interruptedAt).toBeLessThanOrEqual(
      SESSION_WINDOW_MS + 100,
    );
    expect(run.onLost).toHaveBeenCalledTimes(1);
  });

  test("cached readiness cannot win a departure whose leave is still pending, and the same session completes once it returns", async () => {
    const run = await startRun();
    const { commandId, outcome, done } = await runCommand(run);
    run.host.output(commandId).append({ type: "exit", exitCode: 0 });
    await until(() => outcome.result !== undefined);
    await done;
    // The host leaves; the observer has not processed the leave yet.
    relay.dropHost();
    expect(run.watch.isReady()).toBe(true);
    const confirmed = track(run.watch.confirmReady());
    await jest.advanceTimersByTimeAsync(5_000);
    expect(confirmed.done).toBe(false);
    expect(run.watch.isReady()).toBe(false);

    relay.refused.clear();
    await until(() => confirmed.done);
    expect(confirmed.error).toBeUndefined();
    expect(run.host.executions).toEqual([commandId]);
    expect(commandsPublished()).toBe(1);
    expect(run.onLost).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a replaced page",
      { ...SESSION, pageGeneration: SESSION.pageGeneration + 1 },
      "desktop_session_replaced",
    ],
    ["a host that never returns", undefined, "selected_host_recovery_expired"],
  ])(
    "%s ends the confirmation with the run's loss",
    async (_name, successor, reason) => {
      const run = await startRun();
      const interruptedAt = jest.now();
      relay.dropHost();
      const confirmed = track(run.watch.confirmReady());
      if (successor) {
        run.host.stop();
        stops.push(startHost({ startup: successor }).stop);
        relay.refused.clear();
      }
      await until(() => confirmed.done, SESSION_WINDOW_MS + 5_000);
      expect(confirmed.error).toBeInstanceOf(LocalConnectionLostError);
      expect(confirmed.error).toBe(run.onLost.mock.calls[0][0]);
      expect(run.cause()?.reason).toBe(reason);
      // Confirmation shares the fixed window; it never extends an outage.
      expect(jest.now() - interruptedAt).toBeLessThanOrEqual(
        SESSION_WINDOW_MS + 100,
      );
      await expect(run.watch.confirmReady()).rejects.toBe(confirmed.error);
    },
  );

  test("a host without session identity is confirmed by fresh presence only, never granted grace", async () => {
    const run = await startRun(startHost({ startup: null }));
    await run.watch.confirmReady();
    relay.dropHost();
    const confirmed = track(run.watch.confirmReady());
    await until(() => confirmed.done);
    expect(confirmed.error).toBeInstanceOf(LocalConnectionLostError);
    expect(run.cause()?.reason).toMatch(
      /^(selected_host_left|selected_presence_absent)$/,
    );
  });

  test("a Stop during confirmation ends it at once without a local loss", async () => {
    const run = await startRun();
    relay.dropHost();
    const stop = new AbortController();
    const confirmed = track(run.watch.confirmReady(stop.signal));
    await jest.advanceTimersByTimeAsync(1_000);
    stop.abort(new Error("Stopped by user"));
    await settle();
    expect(confirmed.error).toEqual(new Error("Stopped by user"));
    expect(run.onLost).not.toHaveBeenCalled();
  });
});
