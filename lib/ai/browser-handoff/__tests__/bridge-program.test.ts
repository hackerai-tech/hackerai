import { runInNewContext } from "node:vm";
import { BROWSER_BRIDGE_PROGRAM } from "../bridge-program";

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
