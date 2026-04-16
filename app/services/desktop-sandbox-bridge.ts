import { Centrifuge, type Subscription } from "centrifuge";
import {
  sandboxChannel,
  type SandboxMessage,
  type CommandMessage,
  type PtyCreateMessage,
  type PtyInputMessage,
  type PtyResizeMessage,
  type PtyKillMessage,
} from "@/lib/centrifugo/types";

interface StreamChunk {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exitCode?: number;
  message?: string;
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
          console.error(
            "[DesktopSandboxBridge] Failed to refresh Centrifugo token:",
            error,
          );
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
      channel.onmessage = (chunk: string) => {
        // The Tauri PTY backend sends raw output strings and a final JSON
        // exit message: {"type":"exit","exitCode":N,"sessionId":"..."}
        try {
          const parsed = JSON.parse(chunk) as {
            type?: string;
            exitCode?: number;
          };
          if (parsed.type === "exit") {
            this.publishResult({
              type: "pty_exit",
              sessionId,
              exitCode: parsed.exitCode ?? -1,
            }).catch((err) => {
              console.error(
                "[DesktopSandboxBridge] Failed to publish pty_exit:",
                err,
              );
            });
            return;
          }
        } catch {
          // Not JSON — regular PTY output
        }

        this.publishResult({
          type: "pty_data",
          sessionId,
          data: chunk,
        }).catch((err) => {
          console.error(
            "[DesktopSandboxBridge] Failed to publish pty_data:",
            err,
          );
        });
      };

      const result = (await invoke("execute_pty_create", {
        sessionId,
        command,
        cols: cols ?? 120,
        rows: rows ?? 30,
        cwd,
        env,
        onData: channel,
      })) as { pid: number; session_id: string };

      await this.publishResult({
        type: "pty_ready",
        sessionId,
        pid: result.pid,
      });
    } catch (err) {
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
      await this.publishResult({
        type: "pty_error",
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handlePtyResize(msg: PtyResizeMessage): Promise<void> {
    const { sessionId, cols, rows } = msg;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("execute_pty_resize", { sessionId, cols, rows }).catch(
      () => {},
    );
  }

  private async handlePtyKill(msg: PtyKillMessage): Promise<void> {
    const { sessionId } = msg;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("execute_pty_kill", { sessionId }).catch(() => {});
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
