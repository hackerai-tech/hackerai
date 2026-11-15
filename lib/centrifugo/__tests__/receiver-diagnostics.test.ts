import { createReceiverDiagnostics } from "../receiver-diagnostics";

describe("receiver diagnostics", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not leave a wait snapshot after command cleanup", () => {
    jest.useFakeTimers();
    try {
      const log = jest.spyOn(console, "info").mockImplementation(() => {});
      const diagnostics = createReceiverDiagnostics(
        { enabled: true, commandId: "id" },
        () => ({
          sequence: -1,
          terminalReceived: false,
          cancelRequested: false,
          dispatched: false,
        }),
      );
      diagnostics.start();
      jest.advanceTimersByTime(5000);
      diagnostics.finish("canceled");
      jest.advanceTimersByTime(10_000);
      expect(log.mock.calls.map(([value]) => JSON.parse(value).phase)).toEqual([
        "started",
        "cleanup",
      ]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("bounds a retry storm but preserves its final failure state without content", () => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const state = {
      sequence: 7,
      terminalReceived: true,
      cancelRequested: false,
      dispatched: true,
      output: "PRIVATE_OUTPUT",
      command: "PRIVATE_COMMAND",
    };
    const diagnostics = createReceiverDiagnostics(
      { enabled: true, commandId: "command-id", triggerRunId: "run-id" },
      () => state,
    );
    diagnostics.start();
    diagnostics.subscribed(false);
    diagnostics.terminal("exit");
    for (let i = 0; i < 1000; i++) {
      diagnostics.cursorAttempt(false);
      diagnostics.cursorResult(false, 7, false, true);
    }
    diagnostics.finish("deadline");
    diagnostics.finish("canceled");
    expect(log).toHaveBeenCalledTimes(13);
    const records = log.mock.calls.map(([value]) => JSON.parse(value));
    expect(records.at(-1)).toMatchObject({
      phase: "cleanup",
      reason: "deadline",
      ack_attempts: 1000,
      cursor_publish_failures: 1000,
      last_cursor_publish_error: "timeout",
      last_received_sequence: 7,
      last_published_sequence: -1,
      terminal_received: true,
      terminal_type: "exit",
      suppressed_transitions: 991,
    });
    expect(records.at(-1)).not.toHaveProperty("dispatch_uncertain_version");
    expect(records.at(-1)).not.toHaveProperty("dispatch_uncertain_reason");
    expect(JSON.stringify(records)).not.toMatch(
      /PRIVATE_OUTPUT|PRIVATE_COMMAND/,
    );
  });

  it("attributes uncertain dispatch on its transition, passive snapshot and cleanup", () => {
    jest.useFakeTimers();
    try {
      const log = jest.spyOn(console, "info").mockImplementation(() => {});
      const diagnostics = createReceiverDiagnostics(
        { enabled: true, commandId: "id" },
        () => ({
          sequence: -1,
          terminalReceived: false,
          cancelRequested: false,
          dispatched: true,
          command: "PRIVATE_COMMAND",
        }),
      );
      diagnostics.start();
      diagnostics.dispatchPhase("operation_ready");
      diagnostics.dispatchUncertain("operation_ready_timeout");
      jest.advanceTimersByTime(10_000);
      diagnostics.finish("deadline");
      const records = log.mock.calls.map(([value]) => JSON.parse(value));
      const uncertain = {
        dispatch_uncertain_version: 1,
        dispatch_uncertain_reason: "operation_ready_timeout",
      };
      expect(records).toEqual([
        expect.objectContaining({ phase: "started" }),
        expect.objectContaining({ phase: "dispatch_uncertain", ...uncertain }),
        expect.objectContaining({
          phase: "command_wait",
          dispatch_phase: "uncertain",
          ...uncertain,
        }),
        expect.objectContaining({
          phase: "cleanup",
          reason: "deadline",
          ...uncertain,
        }),
      ]);
      expect(records[0]).not.toHaveProperty("dispatch_uncertain_version");
      expect(records[0]).not.toHaveProperty("dispatch_uncertain_reason");
      expect(JSON.stringify(records)).not.toContain("PRIVATE_COMMAND");
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps the uncertain dispatch reason on cleanup after its transition is capped", () => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const diagnostics = createReceiverDiagnostics(
      { enabled: true, commandId: "id" },
      () => ({
        sequence: -1,
        terminalReceived: false,
        cancelRequested: false,
        dispatched: true,
      }),
    );
    diagnostics.start();
    for (let i = 0; i < 20; i++) diagnostics.transition("client_retry");
    diagnostics.dispatchUncertain("publish_timeout");
    diagnostics.finish("deadline");
    const records = log.mock.calls.map(([value]) => JSON.parse(value));
    expect(records).toHaveLength(13);
    expect(records.map((record) => record.phase)).not.toContain(
      "dispatch_uncertain",
    );
    expect(records.at(-1)).toMatchObject({
      event: "desktop_command_receiver",
      schema_version: 1,
      phase: "cleanup",
      suppressed_transitions: 10,
      dispatch_uncertain_version: 1,
      dispatch_uncertain_reason: "publish_timeout",
    });
  });

  const idleState = () => ({
    sequence: -1,
    terminalReceived: false,
    cancelRequested: false,
    dispatched: false,
  });
  const intentKeys = [
    "request_intent_version",
    "request_background",
    "request_timeout_ms",
  ];

  it.each([
    [false, 30_000],
    [true, 120_000],
    [false, 1],
    [true, Number.MAX_SAFE_INTEGER],
  ])(
    "records requested background=%s timeout=%s on the first started event only",
    (requestedBackground, requestedTimeoutMs) => {
      jest.useFakeTimers();
      try {
        const log = jest.spyOn(console, "info").mockImplementation(() => {});
        const diagnostics = createReceiverDiagnostics(
          {
            enabled: true,
            commandId: "id",
            requestedBackground,
            requestedTimeoutMs,
          },
          idleState,
        );
        diagnostics.start();
        diagnostics.start();
        diagnostics.transition("subscribing");
        diagnostics.subscribed(false);
        jest.advanceTimersByTime(10_000);
        diagnostics.dispatchUncertain("publish_timeout");
        diagnostics.terminal("exit");
        diagnostics.cursorResult(false, 0, true);
        diagnostics.finish("terminal_ack_published");
        const records = log.mock.calls.map(([value]) => JSON.parse(value));
        expect(records[0]).toMatchObject({
          phase: "started",
          request_intent_version: 1,
          request_background: requestedBackground,
          request_timeout_ms: requestedTimeoutMs,
        });
        expect(records.map((record) => record.phase)).toEqual([
          "started",
          "started",
          "subscribing",
          "subscribed",
          "command_wait",
          "dispatch_uncertain",
          "terminal_received",
          "cleanup",
        ]);
        // A repeated start is not a first started record.
        for (const record of records.slice(1))
          for (const key of intentKeys) expect(record).not.toHaveProperty(key);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([
    ["legacy context", {}],
    ["missing background", { requestedTimeoutMs: 30_000 }],
    ["missing timeout", { requestedBackground: false }],
    [
      "string background",
      { requestedBackground: "true", requestedTimeoutMs: 1 },
    ],
    ["numeric background", { requestedBackground: 1, requestedTimeoutMs: 1 }],
    ["NaN timeout", { requestedBackground: true, requestedTimeoutMs: NaN }],
    [
      "infinite timeout",
      { requestedBackground: true, requestedTimeoutMs: Infinity },
    ],
    [
      "fractional timeout",
      { requestedBackground: true, requestedTimeoutMs: 1.5 },
    ],
    ["zero timeout", { requestedBackground: false, requestedTimeoutMs: 0 }],
    [
      "negative timeout",
      { requestedBackground: false, requestedTimeoutMs: -1 },
    ],
    [
      "unsafe timeout",
      {
        requestedBackground: false,
        requestedTimeoutMs: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
    [
      "string timeout",
      { requestedBackground: false, requestedTimeoutMs: "30000" },
    ],
  ])("omits the whole request intent group for %s", (_name, request) => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const diagnostics = createReceiverDiagnostics(
      { enabled: true, commandId: "id", ...(request as object) },
      idleState,
    );
    diagnostics.start();
    diagnostics.finish("deadline");
    const records = log.mock.calls.map(([value]) => JSON.parse(value));
    expect(records.map((record) => record.phase)).toEqual([
      "started",
      "cleanup",
    ]);
    for (const record of records)
      for (const key of intentKeys) expect(record).not.toHaveProperty(key);
  });

  it("keeps lifecycle logs when reading a request field throws", () => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const context = { enabled: true, commandId: "id", requestedTimeoutMs: 1 };
    Object.defineProperty(context, "requestedBackground", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_GETTER");
      },
    });
    const diagnostics = createReceiverDiagnostics(
      context as typeof context & { requestedBackground: boolean },
      idleState,
    );
    expect(() => {
      diagnostics.start();
      diagnostics.finish("deadline");
    }).not.toThrow();
    const records = log.mock.calls.map(([value]) => JSON.parse(value));
    expect(records.map((record) => record.phase)).toEqual([
      "started",
      "cleanup",
    ]);
    for (const key of intentKeys) expect(records[0]).not.toHaveProperty(key);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_GETTER");
  });

  it("does not emit request intent when receiver logs are disabled", () => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const diagnostics = createReceiverDiagnostics(
      {
        enabled: false,
        commandId: "id",
        requestedBackground: true,
        requestedTimeoutMs: 30_000,
      },
      idleState,
    );
    diagnostics.start();
    diagnostics.finish("deadline");
    expect(log).not.toHaveBeenCalled();
  });

  it("does not emit for legacy transports and tolerates a failing log sink", () => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {
      throw new Error("sink down");
    });
    const state = () => ({
      sequence: -1,
      terminalReceived: false,
      cancelRequested: false,
      dispatched: false,
    });
    const disabled = createReceiverDiagnostics(
      { enabled: false, commandId: "id" },
      state,
    );
    disabled.start();
    disabled.dispatchUncertain("publish_timeout");
    disabled.finish("deadline");
    expect(log).not.toHaveBeenCalled();
    const enabled = createReceiverDiagnostics(
      { enabled: true, commandId: "id" },
      state,
    );
    expect(() => {
      enabled.start();
      enabled.dispatchUncertain("operation_ready_timeout");
      enabled.finish("deadline");
    }).not.toThrow();
    expect(log).toHaveBeenCalledTimes(3);
  });
});
