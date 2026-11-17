/**
 * @jest-environment node
 */
/**
 * Interactive local-relay PTYs outlive their connection token. These tests run
 * the actual adapter and the installed Centrifuge SDK against a loopback
 * WebSocket server that speaks the Centrifugo JSON protocol, so token expiry
 * and refresh follow the SDK's own timers and wire commands.
 */

import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AddressInfo } from "node:net";
import { CentrifugoSandbox } from "../centrifugo-sandbox";
import { createCentrifugoPtyHandle } from "../centrifugo-pty-adapter";
import { generateCentrifugoToken } from "@/lib/centrifugo/jwt";
import type { PtyHandle } from "../e2b-pty-adapter";

jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/centrifugo/jwt", () => ({
  generateCentrifugoToken: jest.fn(),
}));
jest.mock("@/lib/desktop/authorized-operation", () => ({
  authorizeDesktopOperation: jest.fn(),
}));

const PTY_TOKEN_TTL_SECONDS = 600;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const issueToken = jest.mocked(generateCentrifugoToken);

type Frame = { socket: number; command: Record<string, any> };

/** Minimal Centrifugo peer: connect/subscribe/publish/refresh/unsubscribe. */
class LoopbackCentrifugo {
  readonly frames: Frame[] = [];
  readonly sockets: WebSocket[] = [];
  private readonly waiters: Array<{
    match: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
  }> = [];
  private readonly closeWaiters = new Map<number, Array<() => void>>();
  private readonly closed = new Set<number>();

  private constructor(private readonly server: WebSocketServer) {
    server.on("connection", (socket) => {
      const index = this.sockets.push(socket) - 1;
      socket.on("message", (raw) => this.receive(index, socket, raw));
      socket.on("close", () => {
        this.closed.add(index);
        for (const resolve of this.closeWaiters.get(index) ?? []) resolve();
        this.closeWaiters.delete(index);
      });
    });
  }

  static async start(): Promise<LoopbackCentrifugo> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    return new LoopbackCentrifugo(server);
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/connection/websocket`;
  }

  /** Runner-side reaction to a client publication on the PTY channel. */
  onPublish: (data: Record<string, any>, channel: string) => void = () => {};

  refreshError?: { code: number; message: string };

  /** Reject a client publication of this type after receiving it. */
  rejectPublish?: string;

  next(match: (frame: Frame) => boolean): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  socketClosed(index: number): Promise<void> {
    if (this.closed.has(index)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.closeWaiters.get(index) ?? [];
      list.push(resolve);
      this.closeWaiters.set(index, list);
    });
  }

  publications(type: string): Record<string, any>[] {
    return this.frames
      .filter((f) => f.command.publish?.data?.type === type)
      .map((f) => f.command.publish.data);
  }

  push(channel: string, data: Record<string, unknown>): void {
    this.send(this.sockets.length - 1, { push: { channel, pub: { data } } });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private send(index: number, reply: Record<string, unknown>): void {
    this.sockets[index].send(JSON.stringify(reply));
  }

  private receive(index: number, socket: WebSocket, raw: RawData): void {
    for (const line of raw.toString().split("\n")) {
      if (!line.trim()) continue;
      const command = JSON.parse(line) as Record<string, any>;
      const frame = { socket: index, command };
      this.frames.push(frame);
      const { id } = command;
      if (command.refresh && this.refreshError) {
        this.send(index, { id, error: this.refreshError });
      } else if (command.connect || command.refresh) {
        // Centrifugo reports the token's remaining lifetime; the SDK schedules
        // its refresh from this TTL.
        const result = {
          client: "client-1",
          version: "loopback",
          expires: true,
          ttl: PTY_TOKEN_TTL_SECONDS,
        };
        this.send(
          index,
          command.connect ? { id, connect: result } : { id, refresh: result },
        );
      } else if (command.subscribe) {
        this.send(index, { id, subscribe: {} });
      } else if (command.unsubscribe) {
        this.send(index, { id, unsubscribe: {} });
      } else if (
        command.publish &&
        command.publish.data?.type === this.rejectPublish
      ) {
        this.send(index, { id, error: { code: 100, message: "internal" } });
      } else if (command.publish) {
        this.send(index, { id, publish: {} });
        if (socket.readyState === WebSocket.OPEN)
          this.onPublish(command.publish.data, command.publish.channel);
      }
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(frame)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  }
}

/** Bound waits on real I/O with a real clock; SDK timers stay fake. */
function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = realSetTimeout(
      () => reject(new Error(`Timed out waiting for ${label}`)),
      5_000,
    );
  });
  return Promise.race([promise, deadline]).finally(() =>
    realClearTimeout(timer),
  );
}

const isRefresh = (frame: Frame) => Boolean(frame.command.refresh);

let server: LoopbackCentrifugo;
const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(async () => {
  server = await LoopbackCentrifugo.start();
  // The SDK resolves its WebSocket constructor from globals, as in production.
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  let issued = 0;
  issueToken.mockReset();
  issueToken.mockImplementation(async () => `token-${++issued}`);
  // Promise and socket callbacks stay real; only timer-driven SDK work is fake.
  jest.useFakeTimers({
    doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
  });
});

afterEach(async () => {
  jest.useRealTimers();
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  await server.stop();
});

function createSandbox(): CentrifugoSandbox {
  return new CentrifugoSandbox(
    "user-1",
    { connectionId: "conn-1", name: "loopback", isDesktop: false },
    { wsUrl: server.url, tokenSecret: "unused" },
  );
}

/** Runner side: acknowledge creation, echo input, exit on kill. */
function runPtyRunner(): void {
  server.onPublish = (data, channel) => {
    if (data.type === "pty_create")
      server.push(channel, {
        type: "pty_ready",
        sessionId: data.sessionId,
        pid: 4242,
      });
    else if (data.type === "pty_input")
      server.push(channel, {
        type: "pty_data",
        sessionId: data.sessionId,
        data: `echo:${data.data}`,
      });
    else if (data.type === "pty_kill")
      server.push(channel, {
        type: "pty_exit",
        sessionId: data.sessionId,
        exitCode: 130,
      });
  };
}

async function openPty(): Promise<PtyHandle> {
  runPtyRunner();
  return within(
    createCentrifugoPtyHandle(createSandbox(), {
      command: "bounded-shell",
      cols: 80,
      rows: 24,
    }),
    "pty_ready",
  );
}

function nextOutput(handle: PtyHandle): Promise<string> {
  return new Promise((resolve) => {
    const off = handle.onData((bytes) => {
      off();
      resolve(new TextDecoder().decode(bytes));
    });
  });
}

describe("local relay PTY connection token refresh", () => {
  it("keeps an existing PTY session usable after its connection token expires", async () => {
    const handle = await openPty();
    const [create] = server.publications("pty_create");

    // Reach the server-advertised token TTL. The SDK must renew the token on
    // the same connection rather than abandoning the session.
    const refreshed = server.next(isRefresh);
    await jest.advanceTimersByTimeAsync(PTY_TOKEN_TTL_SECONDS * 1000);
    const outcome = await within(
      Promise.race([
        refreshed.then((frame) => ({
          refreshToken: frame.command.refresh.token,
        })),
        handle.exited.then((exit) => ({ exitedBeforeRefresh: exit })),
      ]),
      "token refresh or PTY exit",
    );
    expect(outcome).toEqual({ refreshToken: "token-2" });

    const output = nextOutput(handle);
    await handle.sendInput(new TextEncoder().encode("id\n"));
    await expect(within(output, "pty_data after refresh")).resolves.toBe(
      "echo:id\n",
    );

    const [input] = server.publications("pty_input");
    expect(input.sessionId).toBe(create.sessionId);
    expect(server.publications("pty_create")).toHaveLength(1);
    // Same connection throughout: no reconnect, no replayed connect.
    expect(server.sockets).toHaveLength(1);
    expect(server.frames.filter((f) => f.command.connect)).toHaveLength(1);
    expect(issueToken.mock.calls).toEqual([
      ["user-1", PTY_TOKEN_TTL_SECONDS],
      ["user-1", PTY_TOKEN_TTL_SECONDS],
    ]);

    server.push(channelOf(create), {
      type: "pty_exit",
      sessionId: create.sessionId,
      exitCode: 0,
    });
    await expect(within(handle.exited, "pty_exit")).resolves.toEqual({
      exitCode: 0,
    });
    await within(server.socketClosed(0), "client disconnect");

    // A finished session schedules no further renewal.
    await jest.advanceTimersByTimeAsync(PTY_TOKEN_TTL_SECONDS * 1000 * 2);
    expect(issueToken).toHaveBeenCalledTimes(2);
    expect(server.frames.filter(isRefresh)).toHaveLength(1);
  });

  it("ends the session as a failed observation when a replacement token cannot be issued", async () => {
    const handle = await openPty();
    issueToken.mockRejectedValueOnce(new Error("signing unavailable"));

    await jest.advanceTimersByTimeAsync(PTY_TOKEN_TTL_SECONDS * 1000);
    await expect(within(handle.exited, "PTY teardown")).resolves.toEqual({
      exitCode: null,
      observationFailed: true,
    });
    await within(server.socketClosed(0), "client disconnect");

    // No retry, reconnect, or new PTY after teardown.
    await jest.advanceTimersByTimeAsync(PTY_TOKEN_TTL_SECONDS * 1000 * 2);
    expect(issueToken).toHaveBeenCalledTimes(2);
    expect(server.frames.filter(isRefresh)).toHaveLength(0);
    expect(server.publications("pty_create")).toHaveLength(1);
    expect(server.sockets).toHaveLength(1);
  });

  it("settles a failed observation when the relay permanently rejects renewal", async () => {
    const handle = await openPty();
    server.refreshError = { code: 101, message: "unauthorized" };

    await jest.advanceTimersByTimeAsync(PTY_TOKEN_TTL_SECONDS * 1000);
    await within(server.next(isRefresh), "replacement token sent");
    await within(server.socketClosed(0), "SDK terminal disconnect");
    await expect(
      within(handle.exited, "rejected renewal exit"),
    ).resolves.toEqual({
      exitCode: null,
      observationFailed: true,
    });

    await jest.advanceTimersByTimeAsync(PTY_TOKEN_TTL_SECONDS * 1000 * 2);
    expect(issueToken).toHaveBeenCalledTimes(2);
    expect(server.frames.filter(isRefresh)).toHaveLength(1);
    expect(server.publications("pty_create")).toHaveLength(1);
    expect(server.sockets).toHaveLength(1);
  }, 10_000);

  it("issues no token after kill tears the session down", async () => {
    const handle = await openPty();

    const killed = handle.kill();
    await expect(within(handle.exited, "pty_exit")).resolves.toEqual({
      exitCode: 130,
    });
    await within(server.socketClosed(0), "client disconnect");
    await jest.advanceTimersByTimeAsync(PTY_TOKEN_TTL_SECONDS * 1000 * 2);
    await killed;

    expect(issueToken).toHaveBeenCalledTimes(1);
    expect(server.frames.filter(isRefresh)).toHaveLength(0);
    expect(server.publications("pty_create")).toHaveLength(1);
  });

  it("delegates to a sandbox-native PTY without issuing a relay token", async () => {
    const nativeHandle = { pid: 7 } as PtyHandle;
    const createPtyHandle = jest.fn().mockResolvedValue(nativeHandle);
    const sandbox = Object.assign(createSandbox(), { createPtyHandle });
    const opts = { command: "native", cols: 80, rows: 24 };

    await expect(createCentrifugoPtyHandle(sandbox, opts)).resolves.toBe(
      nativeHandle,
    );
    expect(createPtyHandle).toHaveBeenCalledWith(opts);
    expect(issueToken).not.toHaveBeenCalled();
    expect(server.sockets).toHaveLength(0);
  });
});

/** The run's live readiness, opened and closed by the test. */
function controllableGate() {
  let ready = false;
  const waiters = new Set<() => void>();
  return {
    gate: {
      failUncertainExecution: jest.fn(),
      isReady: () => ready,
      waitUntilReady: (signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          const done = () => {
            waiters.delete(done);
            resolve();
          };
          waiters.add(done);
          signal?.addEventListener(
            "abort",
            () => {
              waiters.delete(done);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    },
    open() {
      ready = true;
      for (const waiter of [...waiters]) waiter();
    },
    close() {
      ready = false;
    },
  };
}

/** Let real socket I/O run; a gated publication must still not appear. */
const ioSettles = () =>
  new Promise<void>((resolve) => realSetTimeout(resolve, 100));

describe("run readiness for interactive terminals", () => {
  it("creates only once the selected host is verified, and tracks the session until it exits", async () => {
    runPtyRunner();
    const sandbox = createSandbox();
    const readiness = controllableGate();
    sandbox.setDispatchGate(readiness.gate);
    const pending = createCentrifugoPtyHandle(sandbox, {
      command: "bounded-shell",
      cols: 80,
      rows: 24,
    });
    await within(
      server.next((frame) => Boolean(frame.command.subscribe)),
      "PTY subscription",
    );
    await ioSettles();
    expect(server.publications("pty_create")).toHaveLength(0);
    expect(sandbox.getPublishedCommands()).toEqual([]);

    readiness.open();
    const handle = await within(pending, "pty_ready");
    const [create] = server.publications("pty_create");
    expect(server.publications("pty_create")).toHaveLength(1);
    const [active] = sandbox.getPublishedCommands();
    expect(active.commandId).toBe(create.sessionId);
    // Unsequenced output: never complete, never resumed.
    expect(active.outputComplete()).toBe(false);

    server.push(channelOf(create), {
      type: "pty_exit",
      sessionId: create.sessionId,
      exitCode: 0,
    });
    await within(handle.exited, "pty_exit");
    expect(sandbox.getPublishedCommands()).toEqual([]);
    // A host-reported exit is a known outcome.
    expect(readiness.gate.failUncertainExecution).not.toHaveBeenCalled();
  });

  it("holds input while unverified; kill stays available, ends the wait and the input is never sent", async () => {
    runPtyRunner();
    const sandbox = createSandbox();
    const readiness = controllableGate();
    readiness.open();
    sandbox.setDispatchGate(readiness.gate);
    const handle = await within(
      createCentrifugoPtyHandle(sandbox, {
        command: "bounded-shell",
        cols: 80,
        rows: 24,
      }),
      "pty_ready",
    );

    readiness.close();
    const input = handle.sendInput(new TextEncoder().encode("rm -rf x\n"));
    void input.catch(() => {});
    await ioSettles();
    expect(server.publications("pty_input")).toHaveLength(0);

    const killed = handle.kill();
    await expect(within(input, "input rejection")).rejects.toBeDefined();
    await expect(within(handle.exited, "pty_exit")).resolves.toEqual({
      exitCode: 130,
    });
    await killed;
    expect(server.publications("pty_kill")).toHaveLength(1);

    readiness.open();
    await ioSettles();
    expect(server.publications("pty_input")).toHaveLength(0);
    expect(server.publications("pty_create")).toHaveLength(1);
    expect(sandbox.getPublishedCommands()).toEqual([]);
    // The held input never left. The kill's exit arrived while the host was
    // unverified, so earlier unsequenced output may be missing: the run stops.
    expect(readiness.gate.failUncertainExecution).toHaveBeenCalledTimes(1);
  });

  it("stops the run when a session's exit arrives while the host is unverified", async () => {
    runPtyRunner();
    const sandbox = createSandbox();
    const readiness = controllableGate();
    readiness.open();
    sandbox.setDispatchGate(readiness.gate);
    const handle = await within(
      createCentrifugoPtyHandle(sandbox, {
        command: "bounded-shell",
        cols: 80,
        rows: 24,
      }),
      "pty_ready",
    );
    const [create] = server.publications("pty_create");
    readiness.close();
    server.push(channelOf(create), {
      type: "pty_exit",
      sessionId: create.sessionId,
      exitCode: 0,
    });
    await expect(within(handle.exited, "pty_exit")).resolves.toEqual({
      exitCode: 0,
    });
    expect(readiness.gate.failUncertainExecution).toHaveBeenCalledTimes(1);
    expect(sandbox.getPublishedCommands()).toEqual([]);
  });

  it("stops the run when input delivery fails after publication began", async () => {
    runPtyRunner();
    const sandbox = createSandbox();
    const readiness = controllableGate();
    readiness.open();
    sandbox.setDispatchGate(readiness.gate);
    const handle = await within(
      createCentrifugoPtyHandle(sandbox, {
        command: "bounded-shell",
        cols: 80,
        rows: 24,
      }),
      "pty_ready",
    );
    server.rejectPublish = "pty_input";
    await expect(
      within(handle.sendInput(new TextEncoder().encode("ls\n")), "input"),
    ).rejects.toBeDefined();
    expect(readiness.gate.failUncertainExecution).toHaveBeenCalledTimes(1);
    // Never sent again; kill remains available.
    server.rejectPublish = undefined;
    await within(handle.kill(), "PTY teardown");
    expect(server.publications("pty_input")).toHaveLength(1);
    expect(server.publications("pty_kill")).toHaveLength(1);
  });

  it("stops the run when a published session ends without a host-reported exit", async () => {
    runPtyRunner();
    const runner = server.onPublish;
    // The host never confirms this kill.
    server.onPublish = (data, channel) => {
      if (data.type !== "pty_kill") runner(data, channel);
    };
    const sandbox = createSandbox();
    const readiness = controllableGate();
    readiness.open();
    sandbox.setDispatchGate(readiness.gate);
    const handle = await within(
      createCentrifugoPtyHandle(sandbox, {
        command: "bounded-shell",
        cols: 80,
        rows: 24,
      }),
      "pty_ready",
    );
    const killed = handle.kill();
    await within(
      server.next((f) => f.command.publish?.data?.type === "pty_kill"),
      "kill",
    );
    // The kill's exit wait starts after its publish reply arrives over real
    // I/O; only then can its (fake) 1.5s fallback elapse.
    let settled = false;
    void killed.then(() => (settled = true));
    for (let step = 0; step < 30 && !settled; step++) {
      await ioSettles();
      await jest.advanceTimersByTimeAsync(500);
    }
    await within(killed, "kill settles");
    await expect(handle.exited).resolves.toEqual({
      exitCode: null,
      observationFailed: true,
    });
    expect(readiness.gate.failUncertainExecution).toHaveBeenCalledTimes(1);
    expect(sandbox.getPublishedCommands()).toEqual([]);
  });

  it("requires readiness again after Desktop authorization before creating", async () => {
    runPtyRunner();
    const sandbox = new CentrifugoSandbox(
      "user-1",
      { connectionId: "conn-1", name: "loopback", isDesktop: true },
      { wsUrl: server.url, tokenSecret: "unused" },
    );
    const readiness = controllableGate();
    readiness.open();
    sandbox.setDispatchGate(readiness.gate);
    const { authorizeDesktopOperation } = jest.requireMock(
      "@/lib/desktop/authorized-operation",
    ) as { authorizeDesktopOperation: jest.Mock };
    // The host leaves while authorization is pending.
    authorizeDesktopOperation.mockImplementationOnce(async () => {
      readiness.close();
      return "a".repeat(64);
    });
    const pending = createCentrifugoPtyHandle(sandbox, {
      command: "bounded-shell",
      cols: 80,
      rows: 24,
    });
    await within(
      server.next((frame) => Boolean(frame.command.subscribe)),
      "PTY subscription",
    );
    await ioSettles();
    expect(authorizeDesktopOperation).toHaveBeenCalledTimes(1);
    expect(server.publications("pty_create")).toHaveLength(0);

    readiness.open();
    const handle = await within(pending, "pty_ready");
    expect(server.publications("pty_create")).toEqual([
      expect.objectContaining({ authorizationId: "a".repeat(64) }),
    ]);
    await within(handle.kill(), "PTY teardown");
  });
});

function channelOf(create: Record<string, any>): string {
  const frame = server.frames.find(
    (f) => f.command.publish?.data?.sessionId === create.sessionId,
  );
  return frame!.command.publish.channel;
}
