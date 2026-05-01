import { Centrifuge, type Subscription } from "centrifuge";
import posthog from "posthog-js";
import {
  sandboxChannel,
  type SandboxMessage,
  type CommandMessage,
  type PtyCreateMessage,
  type PtyInputMessage,
  type PtyResizeMessage,
  type PtyKillMessage,
} from "@/lib/centrifugo/types";
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
} from "@/lib/ai/tools/utils/pty-session-manager";

interface ConnectionTerminatedDetails {
  code?: string;
  message?: string;
  connectionId?: string;
  clientVersion?: string;
  status?: string;
  disconnectReason?: string | null;
  msSinceDisconnected?: number | null;
  msSinceLastHeartbeat?: number;
  msSinceCreated?: number;
}

function readErrorData(error: unknown): ConnectionTerminatedDetails {
  if (!error || typeof error !== "object") return {};
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return {};
  return data as ConnectionTerminatedDetails;
}

interface StreamChunk {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exitCode?: number;
  message?: string;
}

// A getToken refresh fails with one of these when the Convex row has been
// authoritatively flipped to disconnected (token regenerated, multi-tab
// connectDesktop kick, manual disconnectByBackend, or row purged after long
// disconnect). Centrifuge would otherwise retry getToken on its backoff
// schedule forever and flood Convex logs with identical errors.
function isConnectionTerminatedByServer(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  const code = (data as { code?: string }).code;
  const message = (data as { message?: string }).message;
  if (code === "BAD_REQUEST" && message === "Connection is not active")
    return true;
  if (code === "NOT_FOUND") return true;
  if (code === "UNAUTHORIZED") return true;
  return false;
}

interface DesktopBridgeConfig {
  connectDesktop: (args: {
    connectionName: string;
    osInfo?: {
      platform: string;
      arch: string;
      release: string;
      hostname: string;
    };
  }) => Promise<{
    connectionId: string;
    centrifugoToken: string;
    centrifugoWsUrl: string;
  }>;
  refreshCentrifugoTokenDesktop: (args: {
    connectionId: string;
  }) => Promise<{ centrifugoToken: string }>;
  disconnectDesktop: (args: {
    connectionId: string;
  }) => Promise<{ success: boolean }>;
}

export class DesktopSandboxBridge {
  private client: Centrifuge | null = null;
  private subscription: Subscription | null = null;
  private connectionId: string | null = null;
  private config: DesktopBridgeConfig;

  constructor(config: DesktopBridgeConfig) {
    this.config = config;
  }

  getConnectionId(): string | null {
    return this.connectionId;
  }

  async start(): Promise<string> {
    const osInfo = await this.getOsInfo();

    const { connectionId, centrifugoToken, centrifugoWsUrl } =
      await this.config.connectDesktop({
        connectionName: osInfo?.hostname || "Desktop",
        osInfo,
      });

    this.connectionId = connectionId;

    this.client = new Centrifuge(centrifugoWsUrl, {
      token: centrifugoToken,
      getToken: async () => {
        if (!this.connectionId) {
          throw new Error(
            "[DesktopSandboxBridge] Cannot refresh token: connectionId is null",
          );
        }
        try {
          const result = await this.config.refreshCentrifugoTokenDesktop({
            connectionId: this.connectionId,
          });
          return result.centrifugoToken;
        } catch (error) {
          if (isConnectionTerminatedByServer(error)) {
            const data = readErrorData(error);
            const eventProps = {
              connectionId: this.connectionId,
              clientSurface: "desktop_bridge",
              code: data.code ?? null,
              message: data.message ?? null,
              serverConnectionId: data.connectionId ?? null,
              serverClientVersion: data.clientVersion ?? null,
              serverStatus: data.status ?? null,
              disconnectReason: data.disconnectReason ?? null,
              msSinceDisconnected: data.msSinceDisconnected ?? null,
              msSinceLastHeartbeat: data.msSinceLastHeartbeat ?? null,
              msSinceCreated: data.msSinceCreated ?? null,
            };
            console.warn(
              "[DesktopSandboxBridge] Centrifugo refresh aborted — server reports connection terminated; stopping client to break retry loop",
              eventProps,
            );
            try {
              posthog.capture("sandbox_connection_terminated", eventProps);
            } catch {
              // posthog not initialized for this user
            }
            const client = this.client;
            this.client = null;
            this.connectionId = null;
            try {
              client?.disconnect();
            } catch {
              // already in a terminal state
            }
          } else {
            console.error(
              "[DesktopSandboxBridge] Failed to refresh Centrifugo token:",
              error,
            );
          }
          throw error;
        }
      },
    });

    const userId = this.extractUserIdFromToken(centrifugoToken);
    const channel = sandboxChannel(userId);
    this.subscription = this.client.newSubscription(channel);

    this.subscription.on("publication", (ctx) => {
      const message = ctx.data as SandboxMessage;

      // Gate on targetConnectionId for all message types that carry it
      const targetId = (message as { targetConnectionId?: string })
        .targetConnectionId;
      if (targetId && targetId !== this.connectionId) {
        return;
      }

      switch (message.type) {
        case "command":
          this.handleCommand(message as CommandMessage).catch((err) => {
            console.error(
              "[DesktopSandboxBridge] Command handling failed:",
              err,
            );
          });
          break;

        case "pty_create":
          this.handlePtyCreate(message as PtyCreateMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] PTY create failed:", err);
          });
          break;

        case "pty_input":
          this.handlePtyInput(message as PtyInputMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] PTY input failed:", err);
          });
          break;

        case "pty_resize":
          this.handlePtyResize(message as PtyResizeMessage).catch(() => {});
          break;

        case "pty_kill":
          this.handlePtyKill(message as PtyKillMessage).catch(() => {});
          break;

        default:
          break;
      }
    });

    this.subscription.subscribe();
    this.client.connect();

    return connectionId;
  }

  private extractUserIdFromToken(token: string): string {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const payload = JSON.parse(atob(b64));
    if (!payload.sub || typeof payload.sub !== "string") {
      throw new Error("JWT missing 'sub' claim");
    }
    return payload.sub;
  }

  private async getOsInfo(): Promise<
    | { platform: string; arch: string; release: string; hostname: string }
    | undefined
  > {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        stdout: string;
        stderr: string;
        exit_code: number;
      }>("execute_command", {
        command: "uname -srm && hostname",
        timeoutMs: 5000,
      });
      if (result.exit_code === 0) {
        const lines = result.stdout.trim().split("\n");
        const [uname, hostname] = [lines[0] || "", lines[1] || "Desktop"];
        const parts = uname.split(" ");
        return {
          platform:
            parts[0]?.toLowerCase() === "darwin"
              ? "darwin"
              : parts[0]?.toLowerCase() || "unknown",
          release: parts[1] || "unknown",
          arch: parts[2] || "unknown",
          hostname: hostname.trim(),
        };
      }

      // uname failed — try Windows-specific detection
      const winResult = await invoke<{
        stdout: string;
        stderr: string;
        exit_code: number;
      }>("execute_command", {
        command: "ver && hostname",
        timeoutMs: 5000,
      });
      if (winResult.exit_code === 0) {
        const lines = winResult.stdout.trim().split("\n").filter(Boolean);
        // `ver` outputs e.g. "Microsoft Windows [Version 10.0.22631.4890]"
        const verLine = lines[0] || "";
        const hostname = lines[1]?.trim() || "Desktop";
        const versionMatch = verLine.match(/\[Version\s+([\d.]+)\]/i);
        const archResult = await invoke<{
          stdout: string;
          stderr: string;
          exit_code: number;
        }>("execute_command", {
          command: "echo %PROCESSOR_ARCHITECTURE%",
          timeoutMs: 5000,
        });
        const arch =
          archResult.exit_code === 0
            ? archResult.stdout.trim().toLowerCase()
            : "unknown";
        return {
          platform: "win32",
          release: versionMatch?.[1] || "unknown",
          arch: arch === "amd64" ? "x64" : arch,
          hostname,
        };
      }
    } catch (error) {
      console.warn("[DesktopSandboxBridge] Failed to get OS info:", error);
    }
    return undefined;
  }

  private async handleCommand(command: CommandMessage): Promise<void> {
    const { commandId } = command;

    try {
      const { invoke, Channel } = await import("@tauri-apps/api/core");

      const channel = new Channel<StreamChunk>();
      channel.onmessage = async (chunk) => {
        await this.forwardChunk(commandId, chunk);
      };

      await invoke("execute_stream_command", {
        command: command.command,
        cwd: command.cwd,
        env: command.env,
        timeoutMs: command.timeout ?? 30000,
        onEvent: channel,
      });
    } catch (error) {
      await this.publishResult({
        type: "error",
        commandId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async forwardChunk(
    commandId: string,
    chunk: StreamChunk,
  ): Promise<void> {
    switch (chunk.type) {
      case "stdout":
        if (chunk.data) {
          await this.publishResult({
            type: "stdout",
            commandId,
            data: chunk.data,
          });
        }
        break;
      case "stderr":
        if (chunk.data) {
          await this.publishResult({
            type: "stderr",
            commandId,
            data: chunk.data,
          });
        }
        break;
      case "exit":
        if (chunk.exitCode === undefined) {
          console.warn(
            `[desktop-bridge] exit chunk missing exitCode for command ${commandId}, defaulting to -1`,
          );
        }
        await this.publishResult({
          type: "exit",
          commandId,
          exitCode: chunk.exitCode ?? -1,
        });
        break;
      case "error":
        await this.publishResult({
          type: "error",
          commandId,
          message: chunk.message || "Unknown error",
        });
        break;
    }
  }

  private async publishResult(message: SandboxMessage): Promise<void> {
    if (!this.subscription) {
      throw new Error(
        "[DesktopSandboxBridge] Cannot publish result: subscription is null",
      );
    }
    try {
      await this.subscription.publish(message);
    } catch (error) {
      console.error("[DesktopSandboxBridge] Failed to publish result:", error);
      throw error;
    }
  }

  private async handlePtyCreate(msg: PtyCreateMessage): Promise<void> {
    const { sessionId, command, cols, rows, cwd, env } = msg;

    try {
      const { invoke, Channel } = await import("@tauri-apps/api/core");

      const channel = new Channel<string>();
      // Serialize publishes: Rust now flushes per-read (could be per-char on
      // interactive echo). Firing 12 unawaited publishes at the Centrifuge
      // client caused reordered arrival at the server, producing garbled
      // terminal rendering. Chain through this promise to preserve order.
      let publishQueue: Promise<void> = Promise.resolve();
      const enqueuePublish = (msg: SandboxMessage) => {
        publishQueue = publishQueue.then(() =>
          this.publishResult(msg).catch((err) => {
            console.error(
              "[DesktopSandboxBridge] Failed to publish",
              msg.type,
              err,
            );
          }),
        );
      };

      // Debounce buffer for PTY output - accumulate chunks before publishing
      // to reduce RPC overhead from node-pty's per-character callbacks.
      const PTY_DEBOUNCE_MS = 8;
      let ptyBuffer = "";
      let ptyDebounceTimer: ReturnType<typeof setTimeout> | null = null;

      const flushPtyBuffer = () => {
        if (ptyBuffer) {
          enqueuePublish({
            type: "pty_data",
            sessionId,
            data: ptyBuffer,
          });
          ptyBuffer = "";
        }
        ptyDebounceTimer = null;
      };

      channel.onmessage = (chunk: string) => {
        // The Tauri PTY backend sends raw output strings and a final JSON
        // exit sentinel: {"type":"exit","exitCode":N,"sessionId":"..."}.
        // We require ALL three sentinel fields before treating a chunk as an
        // exit — otherwise a program that legitimately prints
        // `{"type":"exit",...}` would be swallowed and never reach pty_data.
        try {
          const parsed = JSON.parse(chunk) as {
            type?: unknown;
            exitCode?: unknown;
            sessionId?: unknown;
          };
          if (
            parsed.type === "exit" &&
            parsed.sessionId === sessionId &&
            typeof parsed.exitCode === "number"
          ) {
            // Flush any buffered data before exit
            if (ptyDebounceTimer) {
              clearTimeout(ptyDebounceTimer);
              flushPtyBuffer();
            }
            enqueuePublish({
              type: "pty_exit",
              sessionId,
              exitCode: parsed.exitCode,
            });
            return;
          }
        } catch {
          // Not JSON — regular PTY output
        }

        // Accumulate chunks and debounce publish
        ptyBuffer += chunk;
        if (!ptyDebounceTimer) {
          ptyDebounceTimer = setTimeout(flushPtyBuffer, PTY_DEBOUNCE_MS);
        }
      };

      const result = (await invoke("execute_pty_create", {
        sessionId,
        command,
        cols: cols ?? DEFAULT_PTY_COLS,
        rows: rows ?? DEFAULT_PTY_ROWS,
        cwd,
        env,
        onData: channel,
      })) as { pid: number | null; session_id: string };

      // Rust's PtyCreateResult.pid is Option<u32> — serializes to `null` when
      // the child didn't expose a pid. Reject that case explicitly so the
      // server doesn't get a pty_ready with a bogus pid cast.
      if (typeof result.pid !== "number") {
        throw new Error(
          `execute_pty_create returned no pid for sessionId=${sessionId}`,
        );
      }

      // Route pty_ready through the same publishQueue that pty_data/pty_exit
      // use. Direct publishResult can arrive AFTER already-queued pty_data
      // chunks on fast-starting commands — the server-side adapter would then
      // see pty_data with no matching pty_ready and drop the output.
      enqueuePublish({
        type: "pty_ready",
        sessionId,
        pid: result.pid,
      });
    } catch (err) {
      // The failure path never reaches the channel.onmessage listener, so
      // no pty_data was queued for this session — publishResult direct is
      // safe here. (enqueuePublish is also out of scope in this catch.)
      await this.publishResult({
        type: "pty_error",
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handlePtyInput(msg: PtyInputMessage): Promise<void> {
    const { sessionId, data } = msg;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("execute_pty_input", { sessionId, data });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err) || "unknown pty_input error";
      console.error("[desktop-bridge] execute_pty_input failed:", err);
      await this.publishResult({
        type: "pty_error",
        sessionId,
        message,
      });
    }
  }

  private async handlePtyResize(msg: PtyResizeMessage): Promise<void> {
    const { sessionId, cols, rows } = msg;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("execute_pty_resize", { sessionId, cols, rows });
    } catch (err) {
      console.warn(
        `[DesktopSandboxBridge] pty_resize failed sessionId=${sessionId}:`,
        err,
      );
    }
  }

  private async handlePtyKill(msg: PtyKillMessage): Promise<void> {
    const { sessionId } = msg;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("execute_pty_kill", { sessionId });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err) || "unknown pty_kill error";
      console.error("[desktop-bridge] execute_pty_kill failed:", err);
      // Surface the failure to the server so the adapter's failTransport()
      // path can resolve `exited` — otherwise awaiters of handle.exited
      // would only escape via the 1500ms kill-timeout fallback.
      await this.publishResult({
        type: "pty_error",
        sessionId,
        message,
      });
    }
  }

  async stop(): Promise<void> {
    if (this.connectionId) {
      try {
        await this.config.disconnectDesktop({
          connectionId: this.connectionId,
        });
      } catch (error) {
        console.warn("[DesktopSandboxBridge] Failed to disconnect:", error);
      }
    }

    if (this.subscription) {
      try {
        this.subscription.unsubscribe();
        this.subscription.removeAllListeners();
      } catch (error) {
        console.warn("[DesktopSandboxBridge] Failed to unsubscribe:", error);
      }
      this.subscription = null;
    }

    if (this.client) {
      try {
        this.client.disconnect();
      } catch (error) {
        console.warn(
          "[DesktopSandboxBridge] Failed to disconnect client:",
          error,
        );
      }
      this.client = null;
    }

    this.connectionId = null;
  }
}
