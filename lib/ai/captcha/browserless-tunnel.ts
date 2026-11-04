import { createServer } from "node:http";
import { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { AnySandbox } from "@/types";
import { buildSandboxCommandOptions } from "../tools/utils/sandbox-command-options";
import type { BrowserlessSession } from "./browserless-session";
import { isE2BSandbox } from "../tools/utils/sandbox-types";

// Only loopback browser traffic crosses protected E2B stdin/stdout. There is no
// public listener, provider endpoint, account key, or credential file here.
export const BROWSERLESS_TUNNEL_PROGRAM = String.raw`
import base64, json, os, pathlib, select, socket, sys, threading, time
root = pathlib.Path(sys.argv[1])
deadline = float(sys.argv[2]) / 1000
if root.parent != pathlib.Path('/dev/shm') or not root.name.startswith('hackerai-browser-'):
    sys.exit(2)
server = socket.socket()
server.bind(('127.0.0.1', 0))
server.listen(1)
server.settimeout(1)
print(json.dumps({'port': server.getsockname()[1]}), flush=True)
connection = None
def stop():
    os._exit(0)
def expire():
    while time.time() < deadline and root.is_dir():
        time.sleep(0.25)
    stop()
threading.Thread(target=expire, daemon=True).start()
try:
    first = None
    while connection is None:
        try:
            candidate, _ = server.accept()
            candidate.settimeout(2)
            try: first = candidate.recv(32768)
            except socket.timeout: first = None
            if not first:
                candidate.close()
                continue  # agent-browser probes TCP readiness before its WS.
            connection = candidate
        except socket.timeout: continue
    server.close()
    connection.settimeout(10)
    def receive():
        try:
            total = len(first)
            print(json.dumps({'data': base64.b64encode(first).decode()}), flush=True)
            while True:
                if not select.select([connection], [], [], 1)[0]: continue
                data = connection.recv(32768)
                if not data: break
                total += len(data)
                if total > 64 * 1024 * 1024: break
                print(json.dumps({'data': base64.b64encode(data).decode()}), flush=True)
        finally: stop()
    threading.Thread(target=receive, daemon=True).start()
    total = 0
    while True:
        line = sys.stdin.buffer.readline(65537)
        if not line or len(line) > 65536: break
        data = base64.b64decode(json.loads(line)['data'], validate=True)
        total += len(data)
        if len(data) > 32768 or total > 64 * 1024 * 1024: break
        connection.sendall(data)
finally: stop()
`;

/** Node's HTTP and ws implementations handle framing; the sandbox just relays bytes. */
export function bridgeBrowserlessSocket(
  upstream: WebSocket,
  send: (bytes: Buffer) => Promise<void>,
  stopped: () => void,
) {
  let peer: WebSocket | undefined;
  let ended = false;
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  const transport = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (chunk.length > 8 * 1024 * 1024) {
        callback(new Error("Browser buffer exceeded."));
        return;
      }
      send(chunk).then(
        () => callback(),
        () => callback(new Error("Browser connection ended.")),
      );
    },
  });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const stop = () => {
    if (ended) return;
    ended = true;
    upstream.off("message", receive);
    upstream.off("close", stop);
    upstream.off("error", stop);
    peer?.terminate();
    transport.destroy();
    sockets.close();
    server.close();
    pending.length = 0;
    stopped();
  };
  const receive = (data: WebSocket.RawData) => {
    const bytes = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as ArrayBuffer);
    if (peer?.readyState === WebSocket.OPEN) {
      if (peer.bufferedAmount > 8 * 1024 * 1024) {
        stop();
        return;
      }
      peer.send(bytes, { binary: false });
    } else {
      pendingBytes += bytes.length;
      if (pendingBytes > 8 * 1024 * 1024) {
        stop();
        return;
      }
      pending.push(bytes);
    }
  };
  server.on("upgrade", (request, socket, head) => {
    if (ended || peer || request.url !== "/") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      peer = client;
      client.on("error", stop);
      client.on("close", stop);
      client.on("message", (data) => {
        try {
          const command = JSON.parse(data.toString());
          // The sandbox controls its browser, not the provider's account APIs.
          if (
            typeof command.method !== "string" ||
            command.method.startsWith("Browserless.") ||
            command.method === "Browser.getBrowserCommandLine" ||
            // Legacy nested CDP can otherwise wrap a denied provider command.
            // agent-browser uses flattened sessions, so it does not need this.
            command.method === "Target.sendMessageToTarget"
          ) {
            client.send(
              JSON.stringify({
                id: command.id,
                error: { code: -32601, message: "Command unavailable." },
              }),
            );
            return;
          }
          if (
            upstream.readyState !== WebSocket.OPEN ||
            upstream.bufferedAmount > 8 * 1024 * 1024
          ) {
            stop();
            return;
          }
          upstream.send(data, { binary: false });
        } catch {
          stop();
        }
      });
      for (const bytes of pending) client.send(bytes, { binary: false });
      pending.length = 0;
      pendingBytes = 0;
    });
  });
  transport.on("error", stop);
  upstream.on("message", receive);
  upstream.on("close", stop);
  upstream.on("error", stop);
  server.emit("connection", transport);
  return {
    receive: (bytes: Buffer) => {
      if (!ended) transport.push(bytes);
    },
    close: stop,
  };
}

export async function createBrowserlessTunnel(
  sandbox: AnySandbox,
  directory: string,
  remote: BrowserlessSession,
  signal: AbortSignal,
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  signal.throwIfAborted();
  if (!isE2BSandbox(sandbox)) throw new Error("Cloud browser required.");
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  let handle: Awaited<ReturnType<typeof sandbox.commands.run>> | undefined;
  let bridge: ReturnType<typeof bridgeBrowserlessSocket> | undefined;
  let buffer = "";
  let closed = false;
  let resolvePort!: (port: number) => void;
  let rejectPort!: (error: Error) => void;
  const portReady = new Promise<number>((resolve, reject) => {
    resolvePort = resolve;
    rejectPort = reject;
  });
  // Attach rejection handling immediately, including failures before setup awaits it.
  void portReady.catch(() => {});
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    rejectPort(new Error("Browser tunnel ended."));
    bridge?.close();
    await Promise.allSettled([
      remote.close(),
      handle && "kill" in handle ? handle.kill() : Promise.resolve(),
    ]);
  };
  const abort = () => {
    void close();
  };
  const readinessTimeout = setTimeout(() => {
    void close();
  }, 10_000);
  signal.addEventListener("abort", abort, { once: true });
  try {
    handle = await sandbox.commands.run(
      `python3 -u -c ${quote(BROWSERLESS_TUNNEL_PROGRAM)} ${quote(directory)} ${remote.expiresAt}`,
      {
        ...buildSandboxCommandOptions(sandbox),
        background: true,
        stdin: true,
        timeoutMs: Math.max(1, remote.expiresAt - Date.now()),
        onStdout: (chunk) => {
          try {
            buffer += chunk;
            if (buffer.length > 2 * 1024 * 1024) throw new Error();
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const message = JSON.parse(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
              if (
                Number.isInteger(message.port) &&
                message.port > 0 &&
                message.port <= 65535
              )
                resolvePort(message.port);
              else if (
                typeof message.data === "string" &&
                message.data.length <= 45000 &&
                bridge
              )
                bridge.receive(Buffer.from(message.data, "base64"));
              else throw new Error();
            }
          } catch {
            void close();
          }
        },
      },
    );
    if (closed || signal.aborted) {
      if ("kill" in handle) await handle.kill();
      throw new Error();
    }
    const activeHandle = handle;
    if (!("sendStdin" in activeHandle)) throw new Error();
    bridge = bridgeBrowserlessSocket(
      remote.socket,
      async (bytes) => {
        for (let start = 0; start < bytes.length; start += 32768)
          await activeHandle.sendStdin(
            JSON.stringify({
              data: bytes.subarray(start, start + 32768).toString("base64"),
            }) + "\n",
          );
      },
      () => {
        void close();
      },
    );
    void activeHandle.wait().then(close, close);
    const port = await portReady;
    signal.throwIfAborted();
    if (closed) throw new Error();
    return { endpoint: `ws://127.0.0.1:${port}/`, close };
  } catch {
    await close();
    signal.throwIfAborted();
    throw new Error("Browser tunnel unavailable.");
  } finally {
    clearTimeout(readinessTimeout);
  }
}
