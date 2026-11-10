/** @jest-environment-options {"customExportConditions": ["node", "node-addons"]} */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import type { WebSocketServer as Server } from "ws";
import { WebSocketServer } from "ws";
function fetch(
  url: string,
  options: {
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    signal?: AbortSignal;
  } = {},
) {
  return new Promise<{ status: number; body: IncomingMessage }>(
    (resolve, reject) => {
      const req = request(
        url,
        { method: options.method, headers: options.headers },
        (res) => resolve({ status: res.statusCode!, body: res }),
      );
      req.on("error", reject);
      options.signal?.addEventListener("abort", () => req.destroy());
      req.end(options.body);
    },
  );
}
import {
  browserRelayProgram,
  RELAY_START_PROGRAM,
  RELAY_STOP_PROGRAM,
  RELAY_RENEW_PROGRAM,
} from "../relay-program";

let root: string;
let directory: string;
let child: ChildProcess;
let upstream: Server;
let url: string;
let received: Record<string, unknown>[];
const origin = "https://preview.example";
const headers = { Origin: origin, Authorization: "Bearer test-grant-only" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "handoff-relay-test-"));
  directory = join(root, "relay-test");
  await mkdir(directory);
  await writeFile(join(root, "paused"), "");
  await writeFile(join(root, "active-session"), "default");
  upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  received = [];
  upstream.on("connection", (socket) => {
    socket.on("message", (data) => received.push(JSON.parse(String(data))));
    socket.send(
      JSON.stringify({
        type: "frame",
        data: Buffer.from([255, 216, 255, 217]).toString("base64"),
        metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 123 },
      }),
    );
  });
  const address = upstream.address();
  await writeFile(
    join(directory, "config"),
    JSON.stringify({
      root,
      port: typeof address === "object" ? address.port : 0,
      origin,
      grant: "test-grant-only",
      browserSessionName: "default",
      expiresAt: Date.now() + 60_000,
    }),
  );
  await writeFile(join(directory, "lease"), String(Date.now() + 30_000));
  child = spawn(
    process.execPath,
    ["--experimental-websocket", "-e", browserRelayProgram(), directory],
    {
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 100; i++) {
    try {
      // The file can be visible before the child finishes writing its port.
      const port = Number(await readFile(join(directory, "port"), "utf8"));
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        url = `http://127.0.0.1:${port}`;
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Relay failed to start");
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  for (const socket of upstream?.clients ?? []) socket.terminate();
  if (upstream)
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const input = (body: unknown, extraHeaders = headers) =>
  fetch(`${url}/input`, {
    method: "POST",
    headers: { ...extraHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function renewLease(lease: number, path = directory) {
  const renewal = spawn(
    process.execPath,
    ["-e", RELAY_RENEW_PROGRAM, path, String(lease)],
    { stdio: "ignore" },
  );
  const [code] = await once(renewal, "exit");
  return code;
}

it("does not shorten the relay lease when a delayed renewal arrives after a newer one", async () => {
  const newer = Date.now() + 40_000;
  expect(await renewLease(newer)).toBe(0);
  expect(await renewLease(newer - 10_000)).toBe(0);
  expect(Number(await readFile(join(directory, "lease"), "utf8"))).toBe(newer);
});

it("rejects a missing relay instead of reporting a successful renewal", async () => {
  expect(await renewLease(Date.now() + 25_000, join(root, "missing"))).not.toBe(
    0,
  );
});

it.each(["revoked", "closed", "expired"])(
  "does not revive a %s relay",
  async (state) => {
    if (state === "expired")
      await writeFile(join(directory, "lease"), String(Date.now() - 1));
    else await writeFile(join(directory, state), "1");
    const previous = await readFile(join(directory, "lease"), "utf8");
    expect(await renewLease(Date.now() + 25_000)).not.toBe(0);
    expect(await readFile(join(directory, "lease"), "utf8")).toBe(previous);
  },
);

it("serializes concurrent renewals without losing the later deadline", async () => {
  const deadline = Date.now() + 40_000;
  expect(
    await Promise.all([renewLease(deadline), renewLease(deadline - 5_000)]),
  ).toEqual([0, 0]);
  expect(Number(await readFile(join(directory, "lease"), "utf8"))).toBe(
    deadline,
  );
  expect(
    (
      await input({
        sequence: 1,
        inputs: [{ kind: "text", text: "still controlled" }],
      })
    ).status,
  ).toBe(200);
});

it("requires origin and bearer authorization before exposing frames or input", async () => {
  expect(
    (await fetch(`${url}/frames`, { headers: { Origin: origin } })).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/frames`, {
        headers: { ...headers, Origin: "https://other.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await input(
        { sequence: 1, inputs: [{ kind: "text", text: "X" }] },
        { ...headers, Authorization: "Bearer wrong" },
      )
    ).status,
  ).toBe(403);
  expect(received).toEqual([]);
  const controller = new AbortController();
  const response = await fetch(`${url}/frames`, {
    headers,
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  let content = "";
  for await (const chunk of response.body) {
    content += chunk;
    if (content.includes('"frame"')) break;
  }
  expect(content).toContain('"capturedAt":123');
  expect(content).not.toContain("test-grant-only");
  controller.abort();
});

it("preserves input order, rejects arbitrary commands, and deduplicates response retries", async () => {
  expect(
    (
      await input({
        sequence: 1,
        inputs: [{ kind: "cdp", method: "Network.getAllCookies" }],
      })
    ).status,
  ).toBe(400);
  const first = {
    sequence: 1,
    inputs: [{ kind: "text", text: "A.b@C-d!日本語😀" }],
  };
  expect((await input(first)).status).toBe(200);
  expect((await input(first)).status).toBe(200);
  expect(
    (await input({ ...first, inputs: [{ kind: "text", text: "changed" }] }))
      .status,
  ).toBe(409);
  expect(
    (await input({ sequence: 3, inputs: [{ kind: "text", text: "skip" }] }))
      .status,
  ).toBe(409);
  expect(
    (
      await input({
        sequence: 2,
        inputs: [{ kind: "key", key: "Backspace", code: "Backspace" }],
      })
    ).status,
  ).toBe(200);
  // Revocation closes the ordered upstream connection only after accepted input.
  await writeFile(join(directory, "revoked"), "1");
  await once(child, "exit");
  expect(await readFile(join(directory, "closed"), "utf8")).toBe("1");
  expect(
    received
      .filter((event) => event.eventType === "keyDown")
      .map((event) => event.text)
      .join(""),
  ).toBe("A.b@C-d!日本語😀");
  expect(received.at(-1)).toMatchObject({
    key: "Backspace",
    eventType: "keyUp",
  });
});

it("forwards held movement across requests and releases a drag before relay shutdown", async () => {
  expect(
    (await input({ sequence: 1, inputs: [{ kind: "down", x: 10, y: 20 }] }))
      .status,
  ).toBe(200);
  expect(
    (
      await input({
        sequence: 2,
        inputs: [{ kind: "move", x: 40, y: 50, buttons: 1 }],
      })
    ).status,
  ).toBe(200);
  await writeFile(join(directory, "revoked"), "1");
  await once(child, "exit");
  expect(received).toEqual([
    {
      type: "input_mouse",
      eventType: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    },
    {
      type: "input_mouse",
      eventType: "mouseMoved",
      x: 40,
      y: 50,
      button: "left",
    },
    {
      type: "input_mouse",
      eventType: "mouseReleased",
      x: 40,
      y: 50,
      button: "left",
    },
  ]);
});

it.each(["expiry", "browser replacement", "Agent resume", "run cleanup"])(
  "closes frames and rejects further input after %s",
  async (reason) => {
    const response = await fetch(`${url}/frames`, { headers });
    if (reason === "expiry") await writeFile(join(directory, "lease"), "1");
    else if (reason === "browser replacement")
      await writeFile(join(root, "active-session"), "other");
    else if (reason === "Agent resume") await rm(join(root, "paused"));
    else await rm(root, { recursive: true, force: true });
    for await (const chunk of response.body) {
      expect(chunk.length).toBeGreaterThan(0);
    }
    await expect(
      input({ sequence: 1, inputs: [{ kind: "text", text: "late" }] }),
    ).rejects.toThrow();
    expect(received).toEqual([]);
  },
);

it.each([false, true])(
  "starts the detached relay from protected stdin despite an initial empty port read: %s",
  async (emptyPortRead) => {
    const second = join(root, "second-relay");
    const config = JSON.parse(
      await readFile(join(directory, "config"), "utf8"),
    );
    // Model the create/write window without depending on filesystem scheduling.
    const initialRead = emptyPortRead
      ? `
    (() => {
      const fs = require('node:fs');
      const read = fs.readFileSync;
      let first = true;
      fs.readFileSync = function(path, ...args) {
        if (first && typeof path === 'string' && path.endsWith('/port')) {
          first = false;
          return '';
        }
        return read.call(this, path, ...args);
      };
    })();
  `
      : "";
    const launcher = spawn(
      process.execPath,
      ["-e", initialRead + RELAY_START_PROGRAM],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    launcher.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    launcher.stdin.end(
      JSON.stringify({
        directory: second,
        config,
        program: browserRelayProgram(),
        lease: Date.now() + 3000,
      }),
    );
    try {
      const [code] = await once(launcher, "close");
      expect(code).toBe(0);
      expect(stdout).toMatch(/^\d+$/);
      expect(Number(stdout)).toBeGreaterThan(0);
      expect(Number(stdout)).toBeLessThanOrEqual(65535);
    } finally {
      expect(await stopRelay(second)).toBe(0);
    }
  },
);

async function stopRelay(target = directory) {
  const stopper = spawn(
    process.execPath,
    ["-e", RELAY_STOP_PROGRAM, root, target],
    { stdio: "ignore" },
  );
  return (await once(stopper, "exit"))[0];
}

it("recovers from a dead relay without a close marker", async () => {
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await expect(readFile(join(directory, "closed"))).rejects.toThrow();
  expect(await stopRelay()).toBe(0);
  expect(await readFile(join(directory, "revoked"), "utf8")).toBe("1");
  expect(await readFile(join(directory, "closed"), "utf8")).toBe("1");
});

it("waits for a live relay to close before allowing resume", async () => {
  await input({ sequence: 1, inputs: [{ kind: "text", text: "LAST" }] });
  expect(await stopRelay()).toBe(0);
  expect(
    received
      .filter(
        (event) =>
          event.type === "input_keyboard" && event.eventType === "keyDown",
      )
      .map((event) => event.text)
      .join(""),
  ).toBe("LAST");
  expect(await readFile(join(directory, "closed"), "utf8")).toBe("1");
});

it("recovers a relay that crashed before opening its public port", async () => {
  const second = join(root, "failed-relay");
  const config = JSON.parse(await readFile(join(directory, "config"), "utf8"));
  const launcher = spawn(process.execPath, ["-e", RELAY_START_PROGRAM], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  launcher.stdin.end(
    JSON.stringify({
      directory: second,
      config,
      program: "throw new Error('Startup failure')",
      lease: Date.now() + 3000,
    }),
  );
  expect((await once(launcher, "exit"))[0]).toBe(1);
  expect(await stopRelay(second)).toBe(0);
  expect(await readFile(join(second, "closed"), "utf8")).toBe("1");
});
