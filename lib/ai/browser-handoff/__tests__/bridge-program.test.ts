import { runInNewContext } from "node:vm";
import {
  BROWSER_BRIDGE_PROGRAM,
  browserBridgeFailureContext,
} from "../bridge-program";

/** Exercise the actual helper while withholding private transport event contents. */
function transportFailure(
  event: "error" | "close" | "deadline",
  phase: "connecting" | "awaiting_frame" | "message_received",
  code: unknown = 1006,
  mode = "frame",
  failOutput = false,
  error: unknown = "PRIVATE",
) {
  const listeners = new Map<string, (value?: unknown) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let output = "";
  let exitCode: number | undefined;
  const stdin = new Map<string, () => void>();
  runInNewContext(BROWSER_BRIDGE_PROGRAM, {
    WebSocket: class {
      addEventListener(name: string, listener: (value?: unknown) => void) {
        listeners.set(name, listener);
      }
      close() {}
    },
    process: {
      argv: ["node", "1234", mode],
      versions: { node: "22.23.3" },
      stdin: {
        setEncoding() {},
        on: (name: string, listener: () => void) => stdin.set(name, listener),
      },
      stdout: {
        write: (value: string) => {
          if (failOutput) throw new Error("PRIVATE output failure");
          output += value;
        },
      },
      exit: (value: number) => {
        exitCode = value;
      },
    },
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  if (mode === "input") stdin.get("end")!();
  if (phase !== "connecting") listeners.get("open")!();
  if (phase === "message_received")
    listeners.get("message")!({
      data: JSON.stringify({ type: "PRIVATE_NON_FRAME", data: "PRIVATE" }),
    });
  if (event === "deadline") {
    timers.values().next().value!();
    listeners.get("error")!({ error });
    listeners.get("close")!({ code: 1000, reason: "PRIVATE" });
  } else {
    listeners.get(event)!({ code, reason: "PRIVATE reason", error });
    // Both events can arrive for one failure; only the first may produce a receipt.
    listeners.get(event === "error" ? "close" : "error")!({ code: 1000 });
  }
  for (const callback of timers.values()) callback();
  return { exitCode, output, receipt: output ? JSON.parse(output) : null };
}

it("reports a closed WebSocket protocol reason after an earlier non-frame message", () => {
  const result = transportFailure(
    "error",
    "message_received",
    1006,
    "frame",
    false,
    new Error("Frame cannot be masked"),
  );
  expect(result.exitCode).toBe(6);
  expect(result.receipt).toEqual({
    bridge_failure: [
      2,
      "error",
      "message_received",
      "none",
      "protocol_masked",
      22,
    ],
  });
  expect(
    browserBridgeFailureContext({ exitCode: 6, stdout: result.output }),
  ).toMatchObject({
    capture_bridge_diagnostic_version: 2,
    capture_bridge_error_reason: "protocol_masked",
    capture_bridge_node_major: 22,
  });
  expect(result.output.length).toBeLessThanOrEqual(128);
  expect(result.output).not.toMatch(/PRIVATE|Frame cannot/);
});

it.each([
  ["error", "connecting", 1006, "none"],
  ["error", "awaiting_frame", 1006, "none"],
  ["error", "message_received", 1006, "none"],
  ["close", "connecting", 1006, 1006],
  ["close", "awaiting_frame", 1000, 1000],
  ["close", "message_received", 1001, 1001],
  ["close", "awaiting_frame", 4001, "other"],
  ["close", "awaiting_frame", "PRIVATE", "other"],
] as const)(
  "distinguishes %s at %s without exporting private transport contents (%#)",
  (event, phase, code, expected) => {
    const result = transportFailure(event, phase, code);
    expect(result.exitCode).toBe(6);
    expect(result.receipt).toEqual({
      bridge_failure: [
        event === "error" ? 2 : 1,
        event === "error" ? "error" : "early_close",
        phase,
        expected,
        ...(event === "error" ? ["other", 22] : []),
      ],
    });
    expect(result.output.length).toBeLessThanOrEqual(128);
    expect(result.output).not.toContain("PRIVATE");
  },
);

it("preserves input failures and tolerates unavailable diagnostic output", () => {
  expect(transportFailure("error", "connecting", 1006, "input")).toEqual({
    exitCode: 6,
    output: "",
    receipt: null,
  });
  expect(transportFailure("error", "connecting", 1006, "frame", true)).toEqual({
    exitCode: 6,
    output: "",
    receipt: null,
  });
});

it.each([
  undefined,
  ["1", "error", "connecting", "none"],
  [2, "error", "connecting", "none"],
  [1, "PRIVATE", "connecting", "none"],
  [1, "error", "PRIVATE", "none"],
  [1, "error", "connecting", 1006],
  [1, "early_close", "awaiting_frame", "none"],
  [1, "early_close", "awaiting_frame", "1006"],
  [1, "early_close", "awaiting_frame", 4001],
  [1, "error", "connecting", "none", "PRIVATE"],
])("rejects unversioned or unbounded bridge metadata (%#)", (tuple) => {
  expect(
    browserBridgeFailureContext({
      exitCode: 6,
      stdout: JSON.stringify({ bridge_failure: tuple }),
    }),
  ).toEqual({});
});

it("bounds failure bytes and never invokes output getters or reads successful frames", () => {
  const stdout = JSON.stringify({
    bridge_failure: [1, "error", "connecting", "none"],
  });
  expect(
    browserBridgeFailureContext({ exitCode: 6, stdout: stdout.padEnd(128) }),
  ).toHaveProperty("capture_bridge_diagnostic_version", 1);
  expect(
    browserBridgeFailureContext({ exitCode: 6, stdout: stdout.padEnd(129) }),
  ).toEqual({});
  const getter = jest.fn(() => {
    throw new Error("PRIVATE");
  });
  for (const exitCode of [0, 2, 3, 5, 6]) {
    const result = Object.defineProperty({ exitCode }, "stdout", {
      get: getter,
    });
    expect(browserBridgeFailureContext(result)).toEqual({});
  }
  expect(getter).not.toHaveBeenCalled();
  expect(browserBridgeFailureContext({ exitCode: 0, stdout })).toEqual({});
});

it("applies the unchanged 128-byte cap to the largest v5 watchdog packet", () => {
  const stdout = JSON.stringify({
    bridge_failure: [
      5,
      "deadline",
      "message_received",
      "none",
      16,
      "not_observed",
      "not_observed",
    ],
  });
  expect(
    browserBridgeFailureContext({ exitCode: 3, stdout: stdout.padEnd(128) }),
  ).toHaveProperty(
    "capture_bridge_status_message_screencasting",
    "not_observed",
  );
  expect(
    browserBridgeFailureContext({ exitCode: 3, stdout: stdout.padEnd(129) }),
  ).toEqual({});
});

function receiveFrame(timestamp: unknown) {
  const listeners = new Map<string, (event: { data: string }) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let output = "";
  let exitCode: number | undefined;
  runInNewContext(BROWSER_BRIDGE_PROGRAM, {
    WebSocket: class {
      addEventListener(
        name: string,
        listener: (event: { data: string }) => void,
      ) {
        listeners.set(name, listener);
      }
      close() {}
    },
    process: {
      argv: ["node", "1234", "frame"],
      stdout: {
        write: (value: string, written?: (error?: Error | null) => void) => {
          output += value;
          written?.(null);
        },
      },
      exit: (code: number) => {
        exitCode = code;
      },
    },
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  listeners.get("message")!({
    data: JSON.stringify({
      type: "frame",
      data: "image",
      metadata: { deviceWidth: 800, deviceHeight: 600, timestamp },
    }),
  });
  for (const callback of timers.values()) callback();
  return { exitCode, frame: output ? JSON.parse(output) : null };
}

it.each([undefined, null, 0, -1, "not-a-time", "Infinity"])(
  "never makes an undated preview frame appear fresh: %p",
  (timestamp) => {
    const result = receiveFrame(timestamp);
    expect(result.exitCode).toBe(0);
    expect(result.frame.capturedAt).toBe(0);
  },
);

it("preserves the producer timestamp so a cached frame does not become fresh", () => {
  const timestamp = Date.now() - 60_000;
  const result = receiveFrame(timestamp);
  expect(result.exitCode).toBe(0);
  expect(result.frame).toMatchObject({
    capturedAt: timestamp,
    width: 800,
    height: 600,
  });
});

it.each([
  [2, "error", "connecting", "none", "PRIVATE", 22],
  [2, "early_close", "connecting", "none", "other", 22],
  [2, "error", "connecting", 1006, "other", 22],
  [2, "error", "connecting", "none", "other", 0],
  [2, "error", "connecting", "none", "other", 256],
  [2, "error", "connecting", "none", "other", 22.5],
  [2, "error", "connecting", "none", "other", "22"],
  [2, "error", "connecting", "none", "other", 22, "PRIVATE"],
])("rejects invalid v2 categories or runtime versions (%#)", (tuple) => {
  expect(
    browserBridgeFailureContext({
      exitCode: 6,
      stdout: JSON.stringify({ bridge_failure: tuple }),
    }),
  ).toEqual({});
});

it("does not invoke error message accessors or export unknown error text", () => {
  const getter = jest.fn(() => "Frame cannot be masked");
  const error = Object.defineProperty({}, "message", { get: getter });
  for (const value of [
    error,
    new Error("PRIVATE_URL_TOKEN"),
    new Error("Frame cannot be masked PRIVATE"),
  ]) {
    const result = transportFailure(
      "error",
      "awaiting_frame",
      1006,
      "frame",
      false,
      value,
    );
    expect(result.receipt.bridge_failure).toEqual([
      2,
      "error",
      "awaiting_frame",
      "none",
      "other",
      22,
    ]);
    expect(result.output).not.toMatch(/PRIVATE|Frame cannot/);
  }
  expect(getter).not.toHaveBeenCalled();
});

it.each([
  ["connecting", 0],
  ["awaiting_frame", 0],
  ["message_received", 1],
] as const)(
  "attributes the existing frame watchdog at %s without changing exit3 or allowing a late event to replace it",
  (phase, count) => {
    const result = transportFailure("deadline", phase);
    expect(result.exitCode).toBe(3);
    expect(result.receipt).toEqual({
      bridge_failure: [
        5,
        "deadline",
        phase,
        "none",
        count,
        "not_observed",
        "not_observed",
      ],
    });
    expect(
      browserBridgeFailureContext({ exitCode: 3, stdout: result.output }),
    ).toEqual({
      capture_bridge_diagnostic_version: 5,
      capture_bridge_failure: "deadline",
      capture_bridge_phase: phase,
      capture_bridge_close_code: "none",
      capture_bridge_nonframe_message_count: count,
      capture_bridge_status_message_connected: "not_observed",
      capture_bridge_status_message_screencasting: "not_observed",
    });
    expect(result.output.length).toBeLessThanOrEqual(128);
    expect(result.output).not.toContain("PRIVATE");
  },
);

it.each([
  [4, "deadline", "connecting", "none", 0, "not_observed"],
  [4, "deadline", "message_received", "none", 7, "true"],
  [4, "deadline", "message_received", "none", 16, "other"],
] as const)(
  "still reads v4 status summaries from older helpers without inventing a screencasting claim (%#)",
  (...tuple) => {
    expect(
      browserBridgeFailureContext({
        exitCode: 3,
        stdout: JSON.stringify({ bridge_failure: tuple }),
      }),
    ).toEqual({
      capture_bridge_diagnostic_version: 4,
      capture_bridge_failure: "deadline",
      capture_bridge_phase: tuple[2],
      capture_bridge_close_code: "none",
      capture_bridge_nonframe_message_count: tuple[4],
      capture_bridge_status_message_connected: tuple[5],
    });
  },
);

it.each(["connecting", "awaiting_frame", "message_received"] as const)(
  "still reads v3 watchdog packets from older helpers at %s",
  (phase) => {
    expect(
      browserBridgeFailureContext({
        exitCode: 3,
        stdout: JSON.stringify({
          bridge_failure: [3, "deadline", phase, "none"],
        }),
      }),
    ).toEqual({
      capture_bridge_diagnostic_version: 3,
      capture_bridge_failure: "deadline",
      capture_bridge_phase: phase,
      capture_bridge_close_code: "none",
    });
  },
);

/** Deliver raw daemon messages to the actual frame helper, then fire its watchdog. */
function frameMessages(messages: string[], deadline = true) {
  const listeners = new Map<string, (value?: unknown) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let output = "";
  let exitCode: number | undefined;
  runInNewContext(BROWSER_BRIDGE_PROGRAM, {
    WebSocket: class {
      addEventListener(name: string, listener: (value?: unknown) => void) {
        listeners.set(name, listener);
      }
      close() {}
    },
    process: {
      argv: ["node", "1234", "frame"],
      stdout: {
        write: (value: string, written?: (error?: Error | null) => void) => {
          output += value;
          written?.(null);
        },
      },
      exit: (value: number) => {
        exitCode = value;
      },
    },
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  listeners.get("open")!();
  for (const data of messages) listeners.get("message")!({ data });
  // The 6.5s watchdog is the first timer; an outcome before it clears it.
  const watchdogPending = timers.has(1);
  if (deadline) timers.get(1)!();
  // Late daemon events cannot replace the first receipt.
  listeners.get("message")!({
    data: JSON.stringify({
      type: "status",
      connected: true,
      screencasting: true,
    }),
  });
  listeners.get("message")!({
    data: JSON.stringify({ type: "frame", data: "PRIVATE_LATE" }),
  });
  listeners.get("close")!({ code: 1000 });
  for (const callback of timers.values()) callback();
  return {
    exitCode,
    output,
    receipt: output ? JSON.parse(output) : null,
    watchdogPending,
  };
}

const status = (connected?: unknown, screencasting?: unknown) =>
  JSON.stringify({
    type: "status",
    connected,
    screencasting,
    url: "PRIVATE_URL",
    port: 9223,
    session: "PRIVATE_SESSION",
  });
const other = JSON.stringify({ type: "PRIVATE_TYPE", data: "PRIVATE" });

it.each([
  [
    "claimed connected and screencasting",
    [status(true, true)],
    1,
    "true",
    "true",
  ],
  [
    "claimed connected but not screencasting",
    [status(true, false)],
    1,
    "true",
    "false",
  ],
  [
    "claimed connected and omitted screencasting",
    [status(true)],
    1,
    "true",
    "other",
  ],
  [
    "sent a non-boolean screencasting flag",
    [status(true, "true")],
    1,
    "true",
    "other",
  ],
  ["sent a numeric screencasting flag", [status(true, 1)], 1, "true", "other"],
  ["omitted both claims", [status()], 1, "other", "other"],
  ["sent a non-boolean", [status("false")], 1, "other", "other"],
  ["sent a numeric flag", [status(1)], 1, "other", "other"],
  [
    "sent only other messages",
    [other, '"PRIVATE"', "[]", "7"],
    4,
    "not_observed",
    "not_observed",
  ],
  [
    "sent both claims on a non-status message",
    [
      JSON.stringify({
        type: "PRIVATE_TYPE",
        connected: false,
        screencasting: true,
      }),
    ],
    1,
    "not_observed",
    "not_observed",
  ],
  [
    "exceeded the count cap",
    Array(20).fill(other),
    16,
    "not_observed",
    "not_observed",
  ],
] as const)(
  "summarizes a deadline after the daemon %s without exporting message contents",
  (_case, messages, count, connected, screencasting) => {
    const result = frameMessages([...messages]);
    expect(result.exitCode).toBe(3);
    expect(result.receipt).toEqual({
      bridge_failure: [
        5,
        "deadline",
        "message_received",
        "none",
        count,
        connected,
        screencasting,
      ],
    });
    expect(
      browserBridgeFailureContext({ exitCode: 3, stdout: result.output }),
    ).toMatchObject({
      capture_bridge_diagnostic_version: 5,
      capture_bridge_nonframe_message_count: count,
      capture_bridge_status_message_connected: connected,
      capture_bridge_status_message_screencasting: screencasting,
    });
    expect(result.output.length).toBeLessThanOrEqual(128);
    expect(result.output).not.toMatch(
      /PRIVATE|url|9223|connected|screencasting/,
    );
  },
);

it.each([
  // An omitted field resets to other instead of keeping an earlier claim.
  [
    [status(true, true), ...Array(18).fill(other), status(true)],
    "true",
    "other",
  ],
  [
    [status(true, false), ...Array(18).fill(other), status(true, true)],
    "true",
    "true",
  ],
  [
    [status("false", true), ...Array(18).fill(other), status(true, false)],
    "true",
    "false",
  ],
])(
  "keeps only the latest status claims after the count reaches its cap (%#)",
  (messages, connected, screencasting) => {
    const result = frameMessages(messages);
    expect(result.exitCode).toBe(3);
    expect(result.receipt.bridge_failure.slice(4)).toEqual([
      16,
      connected,
      screencasting,
    ]);
    expect(result.output.length).toBeLessThanOrEqual(128);
  },
);

it.each([
  ["a connected status", [status(true, false), other]],
  ["an omitted claim", [status()]],
  ["a non-boolean claim", [status("false")]],
  ["no status", [other]],
])(
  "returns a later frame with its producer age after %s",
  (_case, messages) => {
    const timestamp = Date.now() - 60_000;
    const result = frameMessages(
      [
        ...messages,
        JSON.stringify({
          type: "frame",
          data: "image",
          metadata: { deviceWidth: 800, deviceHeight: 600, timestamp },
        }),
      ],
      false,
    );
    expect(result).toEqual({
      exitCode: 0,
      output: expect.any(String),
      receipt: {
        data: "image",
        width: 800,
        height: 600,
        capturedAt: timestamp,
      },
      watchdogPending: false,
    });
  },
);

// The stream_status admission, relay and handoff checks already treat this
// daemon claim as closed; a frame request must not wait out its watchdog.
it.each([
  ["reported disconnected", [status(false)]],
  ["claimed screencasting while disconnected", [status(false, true)]],
  ["reported disconnected after other messages", [other, status(false, false)]],
  [
    "reported disconnected after a connected status",
    [status(true, true), status(false, false)],
  ],
  [
    "reported disconnected before a frame",
    [
      status(false, false),
      JSON.stringify({
        type: "frame",
        data: "PRIVATE_FRAME",
        metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 1 },
      }),
    ],
  ],
])(
  "ends a frame request as closed before its watchdog when the daemon %s",
  (_case, messages) => {
    // Late status, frame and close events follow and cannot replace exit 7.
    expect(frameMessages(messages, false)).toEqual({
      exitCode: 7,
      output: "",
      receipt: null,
      watchdogPending: false,
    });
  },
);

it("keeps the frame watchdog pending after a status without a strict false claim", () => {
  for (const messages of [
    [status(true, false)],
    [status()],
    [status("false")],
    [status(0)],
    [JSON.stringify({ type: "PRIVATE_TYPE", connected: false })],
  ])
    expect(frameMessages(messages)).toMatchObject({
      exitCode: 3,
      watchdogPending: true,
    });
});

it("keeps input mode independent of daemon status messages", () => {
  const listeners = new Map<string, (value?: unknown) => void>();
  const timers = new Map<number, () => void>();
  const stdin = new Map<string, (value?: unknown) => void>();
  const sent: string[] = [];
  let nextTimer = 0;
  let output = "";
  let exitCode: number | undefined;
  runInNewContext(BROWSER_BRIDGE_PROGRAM, {
    WebSocket: class {
      addEventListener(name: string, listener: (value?: unknown) => void) {
        listeners.set(name, listener);
      }
      send(value: string) {
        sent.push(value);
      }
      close() {}
    },
    process: {
      argv: ["node", "1234", "input"],
      stdin: {
        setEncoding() {},
        on: (name: string, listener: (value?: unknown) => void) =>
          stdin.set(name, listener),
      },
      stdout: {
        write: (value: string, written?: (error?: Error | null) => void) => {
          output += value;
          written?.(null);
        },
      },
      exit: (value: number) => {
        exitCode ??= value;
      },
    },
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  stdin.get("data")!(JSON.stringify([{ type: "input_keyboard", key: "a" }]));
  stdin.get("end")!();
  listeners.get("open")!();
  listeners.get("message")!({ data: status(false, false) });
  // The 120ms send-drain timer (2) precedes the watchdog (1) and then exits.
  timers.get(2)!();
  for (const callback of timers.values()) callback();
  expect(sent).toEqual([JSON.stringify({ type: "input_keyboard", key: "a" })]);
  expect({ exitCode, output }).toEqual({
    exitCode: 0,
    output: JSON.stringify({ ok: true }),
  });
});

/** Reach a frame or input success whose stdout write has not completed yet. */
function pendingSuccess(mode: "frame" | "input", writeThrows = false) {
  const listeners = new Map<string, (value?: unknown) => void>();
  const timers = new Map<number, () => void>();
  const stdin = new Map<string, (value?: unknown) => void>();
  const exits: number[] = [];
  const writes: string[] = [];
  let written: ((error?: Error | null) => void) | undefined;
  let nextTimer = 0;
  runInNewContext(BROWSER_BRIDGE_PROGRAM, {
    WebSocket: class {
      addEventListener(name: string, listener: (value?: unknown) => void) {
        listeners.set(name, listener);
      }
      send() {}
      close() {}
    },
    process: {
      argv: ["node", "1234", mode],
      stdin: {
        setEncoding() {},
        on: (name: string, listener: (value?: unknown) => void) =>
          stdin.set(name, listener),
      },
      stdout: {
        write: (value: string, callback: (error?: Error | null) => void) => {
          if (writeThrows) throw new Error("PRIVATE output failure");
          writes.push(value);
          written = callback;
        },
      },
      exit: (value: number) => exits.push(value),
    },
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  // Timer 1 is the 6.5s watchdog; later timers are short exit/send delays.
  const runTimers = (watchdog: boolean) => {
    for (const [id, callback] of [...timers]) {
      if (id === 1 && !watchdog) continue;
      timers.delete(id);
      callback();
    }
  };
  if (mode === "input") {
    stdin.get("data")!(JSON.stringify([{ type: "input_keyboard", key: "a" }]));
    stdin.get("end")!();
  }
  listeners.get("open")!();
  if (mode === "frame")
    listeners.get("message")!({
      data: JSON.stringify({
        type: "frame",
        data: "image",
        metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 1 },
      }),
    });
  else runTimers(false);
  return {
    exits,
    writes,
    runTimers,
    watchdogPending: () => timers.has(1),
    complete: (error?: Error) => written!(error ?? null),
    lateEvents: () => {
      listeners.get("error")!({ error: new Error("PRIVATE") });
      listeners.get("close")!({ code: 1006 });
    },
  };
}

describe.each(["frame", "input"] as const)("%s success output", (mode) => {
  it("reports exit 0 only after stdout accepts the whole result", () => {
    const bridge = pendingSuccess(mode);
    bridge.lateEvents();
    bridge.runTimers(false);
    expect(bridge.exits).toEqual([]);
    expect(bridge.watchdogPending()).toBe(true);
    bridge.complete();
    expect(bridge.watchdogPending()).toBe(false);
    bridge.runTimers(false);
    expect(bridge.exits).toEqual([0]);
    expect(bridge.writes).toHaveLength(1);
    expect(JSON.parse(bridge.writes[0])).toEqual(
      mode === "frame"
        ? { data: "image", width: 800, height: 600, capturedAt: 1 }
        : { ok: true },
    );
  });

  it("ends an undrained result at the existing deadline without appending a packet", () => {
    const bridge = pendingSuccess(mode);
    bridge.runTimers(true);
    expect(bridge.exits).toEqual([3]);
    expect(bridge.writes).toHaveLength(1);
    expect(bridge.writes[0]).not.toContain("bridge_failure");
  });

  it("exits 1 when stdout rejects the result", () => {
    const bridge = pendingSuccess(mode);
    bridge.complete(new Error("PRIVATE EPIPE"));
    expect(bridge.exits).toEqual([1]);
    expect(pendingSuccess(mode, true).exits).toEqual([1]);
  });
});

it.each(["PRIVATE not json", "null"])(
  "keeps exit5 for an unreadable daemon message after a status: %p",
  (data) => {
    expect(frameMessages([status(true), data], false)).toEqual({
      exitCode: 5,
      output: "",
      receipt: null,
      watchdogPending: false,
    });
  },
);

it("keeps input watchdog output empty and contains failure-packet write errors", () => {
  expect(transportFailure("deadline", "connecting", 1006, "input")).toEqual({
    exitCode: 3,
    output: "",
    receipt: null,
  });
  expect(
    transportFailure("deadline", "message_received", 1006, "frame", true),
  ).toEqual({ exitCode: 3, output: "", receipt: null });
});

it.each([
  [6, [3, "deadline", "connecting", "none"]],
  [3, [1, "error", "connecting", "none"]],
  [3, [2, "error", "connecting", "none", "other", 22]],
  [3, [3, "error", "connecting", "none"]],
  [3, [3, "early_close", "connecting", 1006]],
  [3, [3, "deadline", "PRIVATE", "none"]],
  [3, [3, "deadline", "connecting", 1006]],
  [3, [3, "deadline", "connecting", "none", "PRIVATE"]],
  [3, [3, "deadline", "connecting", "none", 0, "not_observed"]],
  [6, [4, "deadline", "message_received", "none", 1, "false"]],
  [3, ["4", "deadline", "message_received", "none", 1, "false"]],
  [3, [4, "error", "message_received", "none", 1, "false"]],
  [3, [4, "deadline", "PRIVATE", "none", 1, "false"]],
  [3, [4, "deadline", "message_received", 1006, 1, "false"]],
  [3, [4, "deadline", "message_received", "none", 1]],
  [3, [4, "deadline", "message_received", "none", 1, "false", "PRIVATE"]],
  [3, [4, "deadline", "message_received", "none", 17, "false"]],
  [3, [4, "deadline", "message_received", "none", -1, "false"]],
  [3, [4, "deadline", "message_received", "none", 1.5, "false"]],
  [3, [4, "deadline", "message_received", "none", "1", "false"]],
  [3, [4, "deadline", "message_received", "none", null, "false"]],
  [3, [4, "deadline", "message_received", "none", 1, false]],
  [3, [4, "deadline", "message_received", "none", 1, "TRUE"]],
  [3, [4, "deadline", "message_received", "none", 1, "PRIVATE"]],
  // Only combinations the helper can emit: messages imply message_received.
  [3, [4, "deadline", "message_received", "none", 0, "not_observed"]],
  [3, [4, "deadline", "connecting", "none", 1, "not_observed"]],
  [3, [4, "deadline", "awaiting_frame", "none", 0, "false"]],
  [3, [4, "deadline", "awaiting_frame", "none", 2, "true"]],
  [3, [4, "deadline", "message_received", "none", 1, "true", "true"]],
  // v5 adds exactly one closed screencasting claim paired with connected.
  [6, [5, "deadline", "message_received", "none", 1, "true", "true"]],
  [2, [5, "deadline", "message_received", "none", 1, "true", "true"]],
  [3, ["5", "deadline", "message_received", "none", 1, "true", "true"]],
  [3, [5, "deadline", "message_received", "none", 1, "true"]],
  [3, [5, "deadline", "message_received", "none", 1, "true", "true", "true"]],
  [3, [5, "error", "message_received", "none", 1, "true", "true"]],
  [3, [5, "deadline", "PRIVATE", "none", 1, "true", "true"]],
  [3, [5, "deadline", "message_received", 1006, 1, "true", "true"]],
  [3, [5, "deadline", "message_received", "none", 17, "true", "true"]],
  [3, [5, "deadline", "message_received", "none", 1.5, "true", "true"]],
  [3, [5, "deadline", "message_received", "none", 1, "PRIVATE", "true"]],
  [3, [5, "deadline", "message_received", "none", 1, "true", "PRIVATE"]],
  [3, [5, "deadline", "message_received", "none", 1, "true", true]],
  [3, [5, "deadline", "message_received", "none", 1, "true", "TRUE"]],
  [3, [5, "deadline", "message_received", "none", 1, "true", null]],
  [3, [5, "deadline", "message_received", "none", 1, "true", "not_observed"]],
  [3, [5, "deadline", "message_received", "none", 1, "not_observed", "false"]],
  [
    3,
    [
      5,
      "deadline",
      "message_received",
      "none",
      0,
      "not_observed",
      "not_observed",
    ],
  ],
  [3, [5, "deadline", "connecting", "none", 1, "not_observed", "not_observed"]],
  [3, [5, "deadline", "awaiting_frame", "none", 0, "not_observed", "true"]],
  [3, [5, "deadline", "awaiting_frame", "none", 0, "false", "false"]],
])(
  "keeps watchdog metadata tied to its exact exit and finite packet (%#)",
  (exitCode, tuple) => {
    expect(
      browserBridgeFailureContext({
        exitCode,
        stdout: JSON.stringify({ bridge_failure: tuple }),
      }),
    ).toEqual({});
  },
);
