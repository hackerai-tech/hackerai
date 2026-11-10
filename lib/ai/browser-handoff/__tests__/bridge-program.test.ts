import { runInNewContext } from "node:vm";
import {
  BROWSER_BRIDGE_PROGRAM,
  browserBridgeFailureContext,
} from "../bridge-program";

/** Exercise the actual helper while withholding private transport event contents. */
function transportFailure(
  event: "error" | "close",
  phase: "connecting" | "awaiting_frame" | "message_received",
  code: unknown = 1006,
  mode = "frame",
  failOutput = false,
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
  listeners.get(event)!({ code, reason: "PRIVATE reason", error: "PRIVATE" });
  // Both events can arrive for one failure; only the first may produce a receipt.
  listeners.get(event === "error" ? "close" : "error")!({ code: 1000 });
  for (const callback of timers.values()) callback();
  return { exitCode, output, receipt: output ? JSON.parse(output) : null };
}

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
        1,
        event === "error" ? "error" : "early_close",
        phase,
        expected,
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
