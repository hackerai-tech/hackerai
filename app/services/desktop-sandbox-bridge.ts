import { Centrifuge, type Subscription } from "centrifuge";
import {
  sandboxChannel,
  type SandboxMessage,
  type CommandMessage,
} from "@/lib/centrifugo/types";

interface CmdServerInfo {
  port: number;
  token: string;
}

interface StreamChunk {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exit_code?: number;
  message?: string;
}

interface DesktopBridgeConfig {
  cmdServerInfo: CmdServerInfo;
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
    const { connectionId, centrifugoToken, centrifugoWsUrl } =
      await this.config.connectDesktop({
        connectionName: "Local",
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
      if (message.type === "command") {
        const cmd = message as CommandMessage;
        if (
          cmd.targetConnectionId &&
          cmd.targetConnectionId !== this.connectionId
        ) {
          return;
        }
        this.handleCommand(cmd).catch((err) => {
          console.error("[DesktopSandboxBridge] Command handling failed:", err);
        });
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

  private async handleCommand(command: CommandMessage): Promise<void> {
    const { commandId } = command;

    try {
      const response = await fetch(
        `http://127.0.0.1:${this.config.cmdServerInfo.port}/execute/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.cmdServerInfo.token}`,
          },
          body: JSON.stringify({
            command: command.command,
            cwd: command.cwd,
            env: command.env,
            timeout_ms: command.timeout ?? 30000,
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        await this.publishResult({
          type: "error",
          commandId,
          message: `Command server error (${response.status}): ${text}`,
        });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        await this.publishResult({
          type: "error",
          commandId,
          message: "No response body for streaming execute",
        });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const chunk = JSON.parse(trimmed) as StreamChunk;
            await this.forwardChunk(commandId, chunk);
          } catch (parseError) {
            console.warn(
              "[DesktopSandboxBridge] Malformed NDJSON line:",
              trimmed,
            );
          }
        }
      }

      const remaining = buffer.trim();
      if (remaining) {
        try {
          const chunk = JSON.parse(remaining) as StreamChunk;
          await this.forwardChunk(commandId, chunk);
        } catch (parseError) {
          console.warn(
            "[DesktopSandboxBridge] Malformed NDJSON line:",
            remaining,
          );
        }
      }
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
        await this.publishResult({
          type: "exit",
          commandId,
          exitCode: chunk.exit_code ?? -1,
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
