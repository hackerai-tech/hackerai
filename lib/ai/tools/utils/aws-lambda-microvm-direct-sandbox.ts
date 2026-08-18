import WebSocket from "ws";

import type {
  CommandCancelResultMessage,
  CommandResponseMessage,
  PtyCreateMessage,
  PtyDataMessage,
  PtyErrorMessage,
  PtyExitMessage,
  PtyInputMessage,
  PtyKillMessage,
  PtyReadyMessage,
  PtyResizeMessage,
} from "@/lib/centrifugo/types";
import { CentrifugoSandbox } from "./centrifugo-sandbox";
import type { CreatePtyOptions, PtyHandle } from "./e2b-pty-adapter";
import { createResolvableExited } from "./pty-exited-promise";

const DIRECT_PORT = 9000;
const DIRECT_PATH = "/sandbox";
const CONNECT_TIMEOUT_MS = 45_000;
const COMMAND_CANCEL_ACK_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_STALE_MS = 90_000;
const WS_OPEN = 1;
const WS_CLOSED = 3;

type DirectLog = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => void;

type CommandOptions = {
  envVars?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  displayName?: string;
  signal?: AbortSignal;
  onCancelReady?: (cancel: () => Promise<boolean>) => void;
};

type DirectMessage = Record<string, unknown>;

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(
    endpoint.includes("://") ? endpoint : `https://${endpoint}`,
  );
  url.protocol = "wss:";
  url.pathname = DIRECT_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseMessage(data: WebSocket.RawData): DirectMessage | null {
  try {
    const parsed = JSON.parse(data.toString()) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as DirectMessage)
      : null;
  } catch {
    return null;
  }
}

export interface AwsLambdaMicrovmDirectSandboxOptions {
  userId: string;
  sessionId: string;
  microvmId: string;
  endpoint: string;
  issueAuthToken: () => Promise<string>;
  log: DirectLog;
  createWebSocket?: (
    endpoint: string,
    protocols: string[],
    options: WebSocket.ClientOptions,
  ) => WebSocket;
}

/** E2B-compatible sandbox facade over the authenticated AWS MicroVM endpoint. */
export class AwsLambdaMicrovmDirectSandbox extends CentrifugoSandbox {
  private directSocket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private closed = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private readonly commandHandlers = new Map<
    string,
    (message: CommandResponseMessage | Error) => void
  >();
  private readonly ptyHandlers = new Map<
    string,
    (
      message:
        | PtyReadyMessage
        | PtyDataMessage
        | PtyExitMessage
        | PtyErrorMessage
        | Error,
    ) => void
  >();

  constructor(private readonly direct: AwsLambdaMicrovmDirectSandboxOptions) {
    super(
      direct.userId,
      {
        connectionId: direct.microvmId,
        name: "AWS Lambda MicroVM",
        cloudProvider: "aws-lambda-microvm",
        osInfo: {
          platform: "linux",
          arch: "arm64",
          release: "Kali Linux",
          hostname: direct.microvmId,
        },
        capabilities: { commands: true, pty: true },
      },
      { wsUrl: "", tokenSecret: "" },
      "/home/user",
    );
  }

  async ready(): Promise<void> {
    await this.ensureConnected();
  }

  commands = {
    run: async (
      command: string,
      opts: CommandOptions = {},
    ): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      pid?: number;
    }> => {
      const commandId = crypto.randomUUID();
      const timeoutMs = opts.timeoutMs ?? 30_000;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let cancelRequested = false;
      let cancelPromise: Promise<boolean> | null = null;
      let resolveCancel: ((value: boolean) => void) | null = null;
      let cancelTimer: NodeJS.Timeout | null = null;
      let commandSendPromise: Promise<void> | null = null;

      return new Promise((resolve, reject) => {
        const finish = (result: {
          stdout: string;
          stderr: string;
          exitCode: number;
          pid?: number;
        }) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          clearTimeout(timeout);
          if (cancelTimer) clearTimeout(cancelTimer);
          resolveCancel?.(false);
          resolveCancel = null;
          cancelPromise = null;
          opts.signal?.removeEventListener("abort", handleAbort);
          this.commandHandlers.delete(commandId);
        };
        const cancel = (): Promise<boolean> => {
          if (settled) return Promise.resolve(true);
          if (cancelPromise) return cancelPromise;
          cancelRequested = true;
          cancelPromise = new Promise<boolean>((resolveValue) => {
            resolveCancel = resolveValue;
          });
          void (async () => {
            await commandSendPromise;
            if (settled) return;
            cancelTimer = setTimeout(() => {
              cancelRequested = false;
              resolveCancel?.(false);
              resolveCancel = null;
              cancelPromise = null;
              if (opts.signal?.aborted) {
                fail(
                  new Error("Direct command cancellation was not acknowledged"),
                );
              }
            }, COMMAND_CANCEL_ACK_TIMEOUT_MS);
            await this.send({
              type: "command_cancel",
              commandId,
              targetConnectionId: this.direct.microvmId,
            });
          })().catch((error) => fail(error));
          return cancelPromise;
        };
        const handleAbort = () => void cancel();
        const timeout = setTimeout(() => {
          fail(new Error(`Command timeout after ${timeoutMs + 5_000}ms`));
        }, timeoutMs + 5_000);

        this.commandHandlers.set(commandId, (message) => {
          if (message instanceof Error) {
            fail(message);
            return;
          }
          switch (message.type) {
            case "stdout":
              stdout += message.data;
              opts.onStdout?.(message.data);
              break;
            case "stderr":
              stderr += message.data;
              opts.onStderr?.(message.data);
              break;
            case "exit":
              finish({
                stdout,
                stderr,
                exitCode: cancelRequested ? 130 : message.exitCode,
                pid: message.pid,
              });
              break;
            case "command_cancel_result": {
              const result = message as CommandCancelResultMessage;
              if (!cancelRequested) break;
              if (cancelTimer) clearTimeout(cancelTimer);
              resolveCancel?.(result.canceled);
              resolveCancel = null;
              cancelPromise = null;
              if (result.canceled) finish({ stdout, stderr, exitCode: 130 });
              else {
                cancelRequested = false;
                if (opts.signal?.aborted) {
                  fail(
                    new Error("Direct command cancellation was not confirmed"),
                  );
                }
              }
              break;
            }
            case "error":
              finish({
                stdout,
                stderr: stderr
                  ? `${stderr}\n${message.message}`
                  : message.message,
                exitCode: -1,
              });
              break;
          }
        });

        if (opts.signal?.aborted) {
          finish({ stdout, stderr, exitCode: 130 });
          return;
        }
        opts.signal?.addEventListener("abort", handleAbort, { once: true });
        commandSendPromise = this.send({
          type: "command",
          commandId,
          command,
          env: opts.envVars,
          cwd: opts.cwd ?? this.getWorkingDirectory(),
          timeout: timeoutMs,
          background: opts.background,
          displayName: opts.displayName,
          targetConnectionId: this.direct.microvmId,
        });
        opts.onCancelReady?.(cancel);
        void commandSendPromise.catch((error) => fail(error));
      });
    },
  };

  async createPtyHandle(
    opts: CreatePtyOptions & { command: string },
  ): Promise<PtyHandle> {
    const sessionId = crypto.randomUUID();
    const listeners = new Set<(bytes: Uint8Array) => void>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const { exited, resolveOnce } = createResolvableExited();
    let pid = 0;
    let ready = false;

    const handle: PtyHandle = {
      get pid() {
        return pid;
      },
      sendInput: (bytes) =>
        this.send({
          type: "pty_input",
          sessionId,
          data: decoder.decode(bytes),
          targetConnectionId: this.direct.microvmId,
        } satisfies PtyInputMessage),
      resize: (cols, rows) =>
        this.send({
          type: "pty_resize",
          sessionId,
          cols,
          rows,
          targetConnectionId: this.direct.microvmId,
        } satisfies PtyResizeMessage),
      kill: async () => {
        await this.send({
          type: "pty_kill",
          sessionId,
          targetConnectionId: this.direct.microvmId,
        } satisfies PtyKillMessage).catch(() => undefined);
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
        ]);
        resolveOnce({ exitCode: null });
        this.ptyHandlers.delete(sessionId);
      },
      onData: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      exited,
    };

    return new Promise<PtyHandle>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ptyHandlers.delete(sessionId);
        reject(new Error("Direct PTY creation timed out after 15000ms"));
      }, 15_000);
      this.ptyHandlers.set(sessionId, (message) => {
        if (message instanceof Error) {
          clearTimeout(timeout);
          resolveOnce({ exitCode: null });
          this.ptyHandlers.delete(sessionId);
          if (!ready) reject(message);
          return;
        }
        switch (message.type) {
          case "pty_ready":
            pid = message.pid;
            if (!ready) {
              ready = true;
              clearTimeout(timeout);
              resolve(handle);
            }
            break;
          case "pty_data":
            for (const listener of [...listeners]) {
              listener(encoder.encode(message.data));
            }
            break;
          case "pty_exit":
            clearTimeout(timeout);
            resolveOnce({ exitCode: message.exitCode });
            this.ptyHandlers.delete(sessionId);
            break;
          case "pty_error":
            clearTimeout(timeout);
            resolveOnce({ exitCode: null });
            this.ptyHandlers.delete(sessionId);
            if (!ready) reject(new Error(message.message));
            break;
        }
      });
      void this.send({
        type: "pty_create",
        sessionId,
        command: opts.command,
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.envs,
        targetConnectionId: this.direct.microvmId,
      } satisfies PtyCreateMessage).catch((error) => {
        clearTimeout(timeout);
        this.ptyHandlers.delete(sessionId);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.failPending(new Error("Direct sandbox connection closed"));
    const socket = this.directSocket;
    this.directSocket = null;
    if (socket && socket.readyState !== WS_CLOSED) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1_000);
        socket.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.close(1000, "trigger_run_finished");
      });
    }
    await super.close();
  }

  private async send(message: DirectMessage): Promise<void> {
    await this.ensureConnected();
    const socket = this.directSocket;
    if (!socket || socket.readyState !== WS_OPEN) {
      throw new Error("Direct sandbox WebSocket is not connected");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private ensureConnected(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Sandbox is closed"));
    if (this.directSocket && this.directSocket.readyState === WS_OPEN) {
      return Promise.resolve();
    }
    if (!this.connectPromise) {
      this.connectPromise = this.connectWithRetry().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private async connectWithRetry(): Promise<void> {
    const startedAt = performance.now();
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let attempt = 0;
    let lastError: unknown;
    while (!this.closed && Date.now() < deadline) {
      attempt++;
      try {
        await this.openSocket();
        this.direct.log("info", "cloud_sandbox_direct_connected", {
          user_id: this.direct.userId,
          session_id: this.direct.sessionId,
          microvm_id: this.direct.microvmId,
          transport: "aws_websocket",
          connection_attempts: attempt,
          duration_ms: Math.round(performance.now() - startedAt),
        });
        return;
      } catch (error) {
        lastError = error;
        const delayMs = Math.min(250 * 2 ** Math.min(attempt - 1, 3), 2_000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new Error(
      `AWS MicroVM direct WebSocket did not become ready: ${errorMessage(lastError)}`,
    );
  }

  private async openSocket(): Promise<void> {
    const token = await this.direct.issueAuthToken();
    const endpoint = normalizeEndpoint(this.direct.endpoint);
    const protocols = [
      "lambda-microvms",
      `lambda-microvms.authentication.${token}`,
      `lambda-microvms.port.${DIRECT_PORT}`,
    ];
    const options: WebSocket.ClientOptions = {
      handshakeTimeout: 10_000,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    };
    const socket = this.direct.createWebSocket
      ? this.direct.createWebSocket(endpoint, protocols, options)
      : new WebSocket(endpoint, protocols, options);

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("AWS MicroVM WebSocket readiness timed out"));
      }, 12_000);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        socket.terminate();
        reject(error);
      };
      socket.once("error", fail);
      socket.on("message", (data) => {
        const message = parseMessage(data);
        if (!message) return;
        if (message.type === "transport_ready" && !opened) {
          opened = true;
          clearTimeout(timeout);
          socket.off("error", fail);
          this.installSocket(socket);
          resolve();
        }
      });
    });
  }

  private installSocket(socket: WebSocket): void {
    const previous = this.directSocket;
    this.directSocket = socket;
    this.lastPongAt = Date.now();
    if (previous && previous !== socket) previous.terminate();

    socket.on("message", (data) => {
      const message = parseMessage(data);
      if (!message || message.type === "transport_ready") return;
      if (message.type === "transport_pong") {
        this.lastPongAt = Date.now();
        return;
      }
      const commandId = message.commandId;
      if (typeof commandId === "string") {
        this.commandHandlers.get(commandId)?.(
          message as unknown as CommandResponseMessage,
        );
        return;
      }
      const sessionId = message.sessionId;
      if (typeof sessionId === "string") {
        this.ptyHandlers.get(sessionId)?.(
          message as unknown as
            PtyReadyMessage | PtyDataMessage | PtyExitMessage | PtyErrorMessage,
        );
      }
    });
    socket.once("close", (code) => this.handleSocketClosed(socket, code));
    socket.once("error", () => this.handleSocketClosed(socket, 1006));
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      const socket = this.directSocket;
      if (!socket || socket.readyState !== WS_OPEN) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_STALE_MS) {
        socket.terminate();
        return;
      }
      socket.send(
        JSON.stringify({
          type: "transport_ping",
          nonce: crypto.randomUUID(),
        }),
      );
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  private handleSocketClosed(socket: WebSocket, code: number): void {
    if (this.directSocket !== socket) return;
    this.directSocket = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const pendingCommands = this.commandHandlers.size;
    const pendingPtys = this.ptyHandlers.size;
    const error = new Error(`AWS MicroVM WebSocket closed (code ${code})`);
    this.failPending(error);
    if (!this.closed) {
      this.direct.log("warn", "cloud_sandbox_direct_disconnected", {
        user_id: this.direct.userId,
        session_id: this.direct.sessionId,
        microvm_id: this.direct.microvmId,
        transport: "aws_websocket",
        close_code: code,
        pending_command_count: pendingCommands,
        pending_pty_count: pendingPtys,
      });
    }
  }

  private failPending(error: Error): void {
    for (const handler of this.commandHandlers.values()) handler(error);
    for (const handler of this.ptyHandlers.values()) handler(error);
    this.commandHandlers.clear();
    this.ptyHandlers.clear();
  }
}
