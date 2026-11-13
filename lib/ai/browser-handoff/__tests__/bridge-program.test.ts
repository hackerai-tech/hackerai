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
        write: (value: string) => {
          output += value;
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
  ["connecting", 0, "not_observed"],
  ["awaiting_frame", 0, "not_observed"],
  ["message_received", 1, "not_observed"],
] as const)(
  "attributes the existing frame watchdog at %s without changing exit3 or allowing a late event to replace it",
  (phase, count, status) => {
    const result = transportFailure("deadline", phase);
    expect(result.exitCode).toBe(3);
    expect(result.receipt).toEqual({
      bridge_failure: [4, "deadline", phase, "none", count, status],
    });
    expect(
      browserBridgeFailureContext({ exitCode: 3, stdout: result.output }),
    ).toEqual({
      capture_bridge_diagnostic_version: 4,
      capture_bridge_failure: "deadline",
      capture_bridge_phase: phase,
      capture_bridge_close_code: "none",
      capture_bridge_nonframe_message_count: count,
      capture_bridge_status_message_connected: status,
    });
    expect(result.output.length).toBeLessThanOrEqual(128);
    expect(result.output).not.toContain("PRIVATE");
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
        write: (value: string) => {
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
  listeners.get("open")!();
  for (const data of messages) listeners.get("message")!({ data });
  if (deadline) timers.get(1)!();
  // Late daemon events cannot replace the first receipt.
  listeners.get("message")!({
    data: JSON.stringify({ type: "status", connected: true }),
  });
  listeners.get("message")!({
    data: JSON.stringify({ type: "frame", data: "PRIVATE_LATE" }),
  });
  listeners.get("close")!({ code: 1000 });
  for (const callback of timers.values()) callback();
  return { exitCode, output, receipt: output ? JSON.parse(output) : null };
}

const status = (connected?: unknown) =>
  JSON.stringify({ type: "status", connected, url: "PRIVATE_URL" });
const other = JSON.stringify({ type: "PRIVATE_TYPE", data: "PRIVATE" });

it.each([
  ["reported disconnected", [status(false)], 1, "false"],
  ["reported connected", [status(true)], 1, "true"],
  ["omitted connected", [status()], 1, "other"],
  ["sent a non-boolean", [status("false")], 1, "other"],
  ["sent a numeric flag", [status(1)], 1, "other"],
  [
    "sent only other messages",
    [other, '"PRIVATE"', "[]", "7"],
    4,
    "not_observed",
  ],
  [
    "sent connected on a non-status message",
    [JSON.stringify({ type: "PRIVATE_TYPE", connected: false })],
    1,
    "not_observed",
  ],
  ["exceeded the count cap", Array(20).fill(other), 16, "not_observed"],
] as const)(
  "summarizes a deadline after the daemon %s without exporting message contents",
  (_case, messages, count, connected) => {
    const result = frameMessages([...messages]);
    expect(result.exitCode).toBe(3);
    expect(result.receipt).toEqual({
      bridge_failure: [
        4,
        "deadline",
        "message_received",
        "none",
        count,
        connected,
      ],
    });
    expect(
      browserBridgeFailureContext({ exitCode: 3, stdout: result.output }),
    ).toMatchObject({
      capture_bridge_diagnostic_version: 4,
      capture_bridge_nonframe_message_count: count,
      capture_bridge_status_message_connected: connected,
    });
    expect(result.output.length).toBeLessThanOrEqual(128);
    expect(result.output).not.toMatch(/PRIVATE|url|connected/);
  },
);

it("keeps the latest status after the count reaches its cap", () => {
  const result = frameMessages([
    status(true),
    ...Array(18).fill(other),
    status(false),
  ]);
  expect(result.exitCode).toBe(3);
  expect(result.receipt.bridge_failure.slice(4)).toEqual([16, "false"]);
});

it("returns a later frame with its producer age instead of a status summary", () => {
  const timestamp = Date.now() - 60_000;
  const result = frameMessages(
    [
      status(false),
      other,
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
    receipt: { data: "image", width: 800, height: 600, capturedAt: timestamp },
  });
});

it.each(["PRIVATE not json", "null"])(
  "keeps exit5 for an unreadable daemon message after a status: %p",
  (data) => {
    expect(frameMessages([status(false), data], false)).toEqual({
      exitCode: 5,
      output: "",
      receipt: null,
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
