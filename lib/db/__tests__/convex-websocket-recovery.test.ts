import path from "node:path";
import type { BaseConvexClient } from "convex/browser";

const convexRoot = path.dirname(require.resolve("convex/package.json"));

class TestSocket {
  static instances: TestSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = jest.fn<void, [string]>();
  close = jest.fn(() => this.onclose?.({ code: 1000, reason: "" }));

  constructor() {
    TestSocket.instances.push(this);
  }

  open() {
    this.onopen?.();
  }

  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}

const malformed = '{"synthetic_canary":"unterminated';
const chunk = (text: string, partNumber = 0, totalParts = 1) =>
  JSON.stringify({
    type: "TransitionChunk",
    transitionId: "synthetic-transition",
    chunk: text,
    partNumber,
    totalParts,
  });
const timestamp = (value: number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes.toString("base64");
};
const transition = (start = 0, end = 1, queryId?: number, value = 0) => ({
  type: "Transition",
  startVersion: {
    querySet: start === 0 ? 0 : 1,
    ts: timestamp(start),
    identity: 0,
  },
  endVersion: { querySet: 1, ts: timestamp(end), identity: 0 },
  modifications:
    queryId === undefined
      ? []
      : [{ type: "QueryUpdated", queryId, value, logLines: [], journal: null }],
});
const logger = () => ({
  log: jest.fn(),
  logVerbose: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

interface Manager {
  socketState(): string;
  terminate(): Promise<void>;
}

describe("Convex CommonJS malformed JSON recovery", () => {
  const format = "cjs";
  // Exercise the installed package exports, not a reimplementation of its parser.
  const { WebSocketManager } = require(
    path.join(convexRoot, `dist/${format}/browser/sync/web_socket_manager.js`),
  ) as { WebSocketManager: new (...args: unknown[]) => Manager };
  const { BaseConvexClient: Client } = require(
    path.join(convexRoot, `dist/${format}/browser/sync/client.js`),
  ) as { BaseConvexClient: typeof BaseConvexClient };
  let managers: Manager[];
  let clients: BaseConvexClient[];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    TestSocket.instances = [];
    managers = [];
    clients = [];
  });

  afterEach(async () => {
    for (const manager of managers) await manager.terminate();
    for (const client of clients) await client.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const setup = () => {
    const log = logger();
    const callbacks = {
      onOpen: jest.fn(),
      onResume: jest.fn(),
      onMessage: jest.fn(() => ({ hasSyncedPastLastReconnect: false })),
    };
    const manager = new WebSocketManager(
      "wss://synthetic.invalid",
      callbacks,
      TestSocket as unknown as typeof WebSocket,
      log,
      () => {},
      false,
    );
    managers.push(manager);
    const socket = TestSocket.instances[0];
    socket.open();
    return { manager, socket, log, callbacks };
  };

  it.each(["message", "assembled_transition"])(
    "reconnects after malformed %s without leaking its contents",
    (stage) => {
      const { manager, socket, log, callbacks } = setup();
      expect(() =>
        socket.receive(stage === "message" ? malformed : chunk(malformed)),
      ).not.toThrow();
      expect(manager.socketState()).toBe("disconnected");
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(callbacks.onMessage).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain(
        "synthetic_canary",
      );

      // Already queued old frames and close events must not create more retries.
      socket.receive(JSON.stringify(transition()));
      socket.onclose?.({ code: 1000, reason: "" });
      expect(callbacks.onMessage).not.toHaveBeenCalled();
      jest.advanceTimersByTime(99);
      expect(TestSocket.instances).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(TestSocket.instances).toHaveLength(2);
      TestSocket.instances[1].open();
      expect(callbacks.onOpen).toHaveBeenLastCalledWith(
        expect.objectContaining({ lastCloseReason: "MalformedServerJson" }),
      );
    },
  );

  it("passes valid Ping and assembled transitions without reconnecting", () => {
    const { socket, callbacks, log } = setup();
    socket.receive(JSON.stringify({ type: "Ping" }));
    const text = JSON.stringify(transition());
    const cut = Math.floor(text.length / 2);
    socket.receive(chunk(text.slice(0, cut), 0, 2));
    expect(callbacks.onMessage).not.toHaveBeenCalled();
    socket.receive(chunk(text.slice(cut), 1, 2));
    expect(callbacks.onMessage).toHaveBeenCalledTimes(1);
    expect(callbacks.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "Transition" }),
    );
    expect(socket.close).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("clears an unfinished chunk before reconnecting", () => {
    const { socket, callbacks } = setup();
    socket.receive(chunk('{"old":', 0, 2));
    socket.receive(malformed);
    jest.advanceTimersByTime(100);
    const replacement = TestSocket.instances[1];
    replacement.open();
    replacement.receive(chunk(JSON.stringify(transition())));
    expect(callbacks.onMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["message", "assembled_transition"])(
    "does not swallow a downstream observer SyntaxError for valid %s",
    (stage) => {
      const { manager, socket, callbacks, log } = setup();
      callbacks.onMessage.mockImplementation(() => {
        throw new SyntaxError("synthetic observer failure");
      });
      const text = JSON.stringify(transition());
      expect(() =>
        socket.receive(stage === "message" ? text : chunk(text)),
      ).toThrow("synthetic observer failure");
      expect(manager.socketState()).toBe("ready");
      expect(socket.close).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it("keeps protocol and chunk validation errors visible", () => {
    const { socket, log } = setup();
    expect(() => socket.receive('{"type":"Transition"}')).toThrow(TypeError);
    expect(() => socket.receive(chunk("{}", 1, 2))).toThrow("out of order");
    expect(socket.close).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not convert a non-SyntaxError parser failure into a retry", () => {
    const { socket, log } = setup();
    const parse = jest.spyOn(JSON, "parse").mockImplementation(() => {
      throw new RangeError("synthetic resource failure");
    });
    expect(() => socket.receive("{}")).toThrow("synthetic resource failure");
    parse.mockRestore();
    expect(socket.close).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("preserves increasing backoff and cancels it on termination", async () => {
    const { socket, manager } = setup();
    socket.receive(malformed);
    jest.advanceTimersByTime(100);
    const second = TestSocket.instances[1];
    second.open();
    second.receive(malformed);
    jest.advanceTimersByTime(199);
    expect(TestSocket.instances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    const third = TestSocket.instances[2];
    third.open();
    third.receive(malformed);
    jest.advanceTimersByTime(399);
    expect(TestSocket.instances).toHaveLength(3);
    await manager.terminate();
    jest.advanceTimersByTime(60_000);
    expect(TestSocket.instances).toHaveLength(3);
  });

  it.each(["message", "assembled_transition"])(
    "restores subscriptions and pending mutation IDs after malformed %s without replaying Actions",
    async (stage) => {
      const client = new Client("https://synthetic.convex.cloud", () => {}, {
        webSocketConstructor: TestSocket as unknown as typeof WebSocket,
        unsavedChangesWarning: false,
        logger: logger(),
      });
      clients.push(client);
      client.subscribe("probe:read", {});
      const mutation = client.mutation("probe:write", {});
      const action = client
        .action("probe:action", {})
        .catch((error: Error) => error.message);
      const first = TestSocket.instances[0];
      first.open();
      const sent = first.send.mock.calls.map(([text]) => JSON.parse(text));
      const original = sent.find((message) => message.type === "Mutation");
      const query = sent.find((message) => message.type === "ModifyQuerySet");
      first.receive(
        JSON.stringify(transition(0, 1, query.modifications[0].queryId)),
      );
      first.receive(stage === "message" ? malformed : chunk(malformed));
      jest.advanceTimersByTime(100);
      const second = TestSocket.instances[1];
      second.open();
      const resent = second.send.mock.calls.map(([text]) => JSON.parse(text));
      expect(
        resent.find((message) => message.type === "Connect").sessionId,
      ).toBe(sent.find((message) => message.type === "Connect").sessionId);
      expect(resent.filter((message) => message.type === "Mutation")).toEqual([
        original,
      ]);
      expect(resent.filter((message) => message.type === "Action")).toEqual([]);
      const restoredQuery = resent.find(
        (message) => message.type === "ModifyQuerySet",
      );
      expect(restoredQuery.modifications[0].udfPath).toBe("probe:read");
      const id = restoredQuery.modifications[0].queryId;
      second.receive(JSON.stringify(transition(0, 1, id, 1)));
      second.receive(
        JSON.stringify({
          type: "MutationResponse",
          requestId: original.requestId,
          success: true,
          result: 1,
          ts: timestamp(2),
          logLines: [],
        }),
      );
      second.receive(JSON.stringify(transition(1, 2, id, 1)));
      await expect(mutation).resolves.toBe(1);
      await expect(action).resolves.toContain(
        "Connection lost while action was in flight",
      );
      expect(client.localQueryResult("probe:read", {})).toBe(1);
    },
  );
});
