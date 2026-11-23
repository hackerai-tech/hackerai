/** @jest-environment node */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BROWSER_BRIDGE_PROGRAM,
  browserBridgeFailureContext,
} from "../bridge-program";

// Runs the generated helper as a real child with a real stdout pipe against a
// synthetic local daemon. Frame contents are synthetic ASCII only.
const MAX_FRAME = "A".repeat(900_000);
const TIMESTAMP = 1_700_000_000_000;

const children = new Set<ChildProcessWithoutNullStreams>();
const servers = new Set<WebSocketServer>();

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
    child.stdout.destroy();
  }
  children.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

async function daemon(onConnection: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.add(server);
  await once(server, "listening");
  const received: string[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => received.push(String(data)));
    onConnection(socket);
  });
  return { port: (server.address() as AddressInfo).port, received };
}

function bridge(port: number, mode: "frame" | "input") {
  const started = Date.now();
  const child = spawn(
    process.execPath,
    ["-e", BROWSER_BRIDGE_PROGRAM, String(port), mode],
    { env: {}, stdio: "pipe" },
  );
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(child, "exit").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    elapsed: Date.now() - started,
  }));
  // "exit" can precede the last stderr bytes; "close" follows stdio closure.
  // Await it only where stdout is not left full and unread.
  const closed = once(child, "close").then(() => undefined);
  closed.catch(() => {});
  return { child, exited, closed, stderr: () => stderr };
}

/** Leave stdout unread for `delayMs` so the child's writes hit pipe backpressure. */
async function readAll(stream: Readable, delayMs = 0) {
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const frame = (data: string) =>
  JSON.stringify({
    type: "frame",
    data,
    metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp: TIMESTAMP },
  });

/** Compare without diffing a 900 KB string on failure. */
function receipt(output: string, data: string) {
  const expected = JSON.stringify({
    data,
    width: 1280,
    height: 720,
    capturedAt: TIMESTAMP,
  });
  let complete = false;
  try {
    const parsed = JSON.parse(output);
    complete =
      parsed.data === data &&
      parsed.width === 1280 &&
      parsed.height === 720 &&
      parsed.capturedAt === TIMESTAMP;
  } catch {}
  return { bytes: output.length, expectedBytes: expected.length, complete };
}

it("delivers the largest accepted frame to a slow stdout reader before exiting 0, ignoring late daemon events", async () => {
  const { port } = await daemon((socket) => {
    socket.send(frame(MAX_FRAME), () => {
      // Late events arrive while the first frame's output is still draining.
      socket.send(frame("PRIVATE_LATE"));
      socket.terminate();
    });
  });
  const run = bridge(port, "frame");
  const [output, exit] = await Promise.all([
    readAll(run.child.stdout, 250),
    run.exited,
  ]);
  expect(exit).toMatchObject({ code: 0, signal: null });
  const result = receipt(output, MAX_FRAME);
  expect(result).toEqual({
    bytes: result.expectedBytes,
    expectedBytes: result.expectedBytes,
    complete: true,
  });
  expect(output).not.toContain("PRIVATE_LATE");
  expect(run.stderr()).toBe("");
});

it("returns a small frame and keeps it over a later disconnected claim and close", async () => {
  const { port } = await daemon((socket) => {
    socket.send(frame("/9j/AAAA"), () => {
      socket.send(JSON.stringify({ type: "status", connected: false }));
      socket.close(1011);
    });
  });
  const run = bridge(port, "frame");
  const [output, exit] = await Promise.all([
    readAll(run.child.stdout),
    run.exited,
  ]);
  expect(exit).toMatchObject({ code: 0, signal: null });
  expect(JSON.parse(output)).toEqual({
    data: "/9j/AAAA",
    width: 1280,
    height: 720,
    capturedAt: TIMESTAMP,
  });
  expect(run.stderr()).toBe("");
});

it("ends a frame whose output never drains with the existing deadline exit inside the caller budget", async () => {
  const { port } = await daemon((socket) => socket.send(frame(MAX_FRAME)));
  const run = bridge(port, "frame");
  // stdout is never read: the pipe stays full and the write cannot complete.
  const exit = await run.exited;
  expect(exit).toMatchObject({ code: 3, signal: null });
  expect(exit.elapsed).toBeGreaterThanOrEqual(6_500);
  // The server-side command budget is 8s.
  expect(exit.elapsed).toBeLessThan(8_000);
  expect(run.stderr()).toBe("");
}, 15_000);

it("reports a false-then-true screencasting claim on the frame deadline without exporting status contents", async () => {
  const status = (screencasting: boolean) =>
    JSON.stringify({
      type: "status",
      connected: true,
      screencasting,
      url: "https://PRIVATE_URL.test/",
      session: "PRIVATE_SESSION",
    });
  const { port } = await daemon((socket) => {
    // Status and other non-frame messages only; the socket stays open.
    socket.send(status(false));
    socket.send(JSON.stringify({ type: "PRIVATE_TYPE", data: "PRIVATE" }));
    socket.send(status(true));
  });
  const run = bridge(port, "frame");
  const [output, exit] = await Promise.all([
    readAll(run.child.stdout),
    run.exited,
  ]);
  expect(exit).toMatchObject({ code: 3, signal: null });
  expect(exit.elapsed).toBeGreaterThanOrEqual(6_500);
  // The server-side command budget is 8s.
  expect(exit.elapsed).toBeLessThan(8_000);
  const tuple = JSON.parse(output).bridge_failure;
  expect(tuple.slice(0, 9)).toEqual([
    6,
    "deadline",
    "message_received",
    "none",
    3,
    "true",
    "true",
    "false",
    2,
  ]);
  // Sent on connection; local delivery latency decides the exact bucket.
  expect(["lt1s", "lt3s", "lt5s", "ge5s"]).toContain(tuple[9]);
  expect(
    browserBridgeFailureContext({ exitCode: exit.code, stdout: output }),
  ).toMatchObject({
    capture_bridge_diagnostic_version: 6,
    capture_bridge_status_message_screencasting: "true",
    capture_bridge_status_message_first_screencasting: "false",
    capture_bridge_status_message_count: 2,
    capture_bridge_status_message_latest_since_open: tuple[9],
  });
  expect(output.length).toBeLessThanOrEqual(128);
  expect(output).not.toMatch(/PRIVATE|url|session/);
  expect(run.stderr()).toBe("");
}, 15_000);

it("exits nonzero without a crash report when stdout cannot accept the frame", async () => {
  const { port } = await daemon((socket) => socket.send(frame(MAX_FRAME)));
  const run = bridge(port, "frame");
  // Close the read end so the child's write fails with EPIPE.
  run.child.stdout.destroy();
  const exit = await run.exited;
  expect(exit).toMatchObject({ code: 1, signal: null });
  expect(exit.elapsed).toBeLessThan(6_500);
  await run.closed;
  expect(run.stderr()).toBe("");
});

it("forwards an input batch and reports success through the real pipe", async () => {
  const events = [
    { type: "input_keyboard", key: "a" },
    { type: "input_mouse", x: 1, y: 2 },
  ];
  const { port, received } = await daemon(() => {});
  const run = bridge(port, "input");
  run.child.stdin.end(JSON.stringify(events));
  const [output, exit] = await Promise.all([
    readAll(run.child.stdout),
    run.exited,
  ]);
  expect(exit).toMatchObject({ code: 0, signal: null });
  expect(output).toBe(JSON.stringify({ ok: true }));
  expect(received).toEqual(events.map((event) => JSON.stringify(event)));
  expect(run.stderr()).toBe("");
});
