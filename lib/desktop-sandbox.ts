/**
 * Desktop Sandbox Service
 *
 * Runs inside the Tauri WebView to bridge local command execution
 * with the Convex backend. This eliminates the need for users to
 * separately install and run `@hackerai/local` when using the desktop app.
 *
 * Flow:
 * 1. Detects Tauri environment
 * 2. Connects to Convex using the user's auth token
 * 3. Subscribes for pending commands
 * 4. Executes commands via Tauri invoke (native shell)
 * 5. Reports results back to Convex
 */

import { ConvexClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

// Types matching the Rust Tauri commands
interface CommandOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  pid: number | null;
  duration_ms: number;
}

interface OsInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
}

interface PendingCommand {
  command_id: string;
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  background?: boolean;
  display_name?: string;
}

interface SignedSession {
  userId: string;
  expiresAt: number;
  signature: string;
}

interface PendingCommandsResult {
  commands: PendingCommand[];
  authError?: boolean;
}

type StatusCallback = (status: DesktopSandboxStatus) => void;

export type DesktopSandboxStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface DesktopSandboxInfo {
  status: DesktopSandboxStatus;
  connectionId: string | null;
  osInfo: OsInfo | null;
  error: string | null;
}

// Convex API references (matching @hackerai/local)
const convexApi = {
  localSandbox: {
    connect: "localSandbox:connect" as any,
    heartbeat: "localSandbox:heartbeat" as any,
    disconnect: "localSandbox:disconnect" as any,
    getPendingCommands: "localSandbox:getPendingCommands" as any,
    markCommandExecuting: "localSandbox:markCommandExecuting" as any,
    submitResult: "localSandbox:submitResult" as any,
  },
};

const MAX_OUTPUT_SIZE = 12288; // Match @hackerai/local
const HEARTBEAT_INTERVAL = 60000; // 60s
const HEARTBEAT_JITTER = 10000; // ±10s

/**
 * Truncate output using 25% head + 75% tail strategy
 */
function truncateOutput(content: string, maxSize: number = MAX_OUTPUT_SIZE): string {
  if (content.length <= maxSize) return content;
  const headSize = Math.floor(maxSize / 4);
  const tailSize = maxSize - headSize;
  const head = content.slice(0, headSize);
  const tail = content.slice(-tailSize);
  return `${head}\n\n--- OUTPUT TRUNCATED ---\n\n${tail}`;
}

/**
 * Check if we're running inside Tauri
 */
function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as any).__TAURI_INTERNALS__ !== undefined
  );
}

/**
 * Invoke a Tauri command (dynamic import to avoid errors in non-Tauri contexts)
 */
async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/**
 * Desktop Sandbox Client
 *
 * Manages the lifecycle of a local sandbox connection through the desktop app.
 * Similar to @hackerai/local but executes commands via Tauri native shell
 * instead of requiring a separate CLI process.
 */
export class DesktopSandboxClient {
  private convex: ConvexClient | null = null;
  private connectionId: string | null = null;
  private userId: string | null = null;
  private session: SignedSession | null = null;
  private token: string | null = null;
  private osInfo: OsInfo | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private commandSubscription: (() => void) | null = null;
  private isShuttingDown = false;
  private statusCallbacks: Set<StatusCallback> = new Set();
  private _status: DesktopSandboxStatus = "disconnected";
  private isExecuting = false;
  private commandQueue: PendingCommand[] = [];

  constructor(private convexUrl: string) {}

  get status(): DesktopSandboxStatus {
    return this._status;
  }

  get info(): DesktopSandboxInfo {
    return {
      status: this._status,
      connectionId: this.connectionId,
      osInfo: this.osInfo,
      error: null,
    };
  }

  onStatusChange(callback: StatusCallback): () => void {
    this.statusCallbacks.add(callback);
    return () => this.statusCallbacks.delete(callback);
  }

  private setStatus(status: DesktopSandboxStatus) {
    this._status = status;
    for (const cb of this.statusCallbacks) {
      try {
        cb(status);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Start the desktop sandbox connection
   * @param token - Auth token from HackerAI settings
   */
  async start(token: string): Promise<void> {
    if (!isTauri()) {
      throw new Error("Desktop sandbox can only run in Tauri environment");
    }

    this.token = token;
    this.setStatus("connecting");

    try {
      // Get OS info from Tauri
      this.osInfo = await tauriInvoke<OsInfo>("get_os_info");

      // Connect to Convex
      this.convex = new ConvexClient(this.convexUrl);

      // Authenticate with the backend
      await this.connect();

      this.setStatus("connected");
      console.log("[DesktopSandbox] Connected successfully");
    } catch (error) {
      this.setStatus("error");
      console.error("[DesktopSandbox] Failed to start:", error);
      throw error;
    }
  }

  private async connect(): Promise<void> {
    if (!this.convex || !this.token || !this.osInfo) {
      throw new Error("Client not initialized");
    }

    const result = await this.convex.mutation(convexApi.localSandbox.connect, {
      token: this.token,
      connectionName: `Desktop (${this.osInfo.hostname})`,
      containerId: undefined, // No Docker container for desktop
      clientVersion: "desktop-1.0.0",
      mode: "dangerous" as const,
      osInfo: {
        platform: this.osInfo.platform,
        arch: this.osInfo.arch,
        release: this.osInfo.release,
        hostname: this.osInfo.hostname,
      },
    });

    if (!result || !result.connectionId) {
      throw new Error("Failed to connect: invalid response");
    }

    this.userId = result.userId;
    this.connectionId = result.connectionId;
    this.session = result.session;

    // Start heartbeat and command subscription
    this.startHeartbeat();
    this.startCommandSubscription();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    const jitter = Math.floor(Math.random() * HEARTBEAT_JITTER * 2) - HEARTBEAT_JITTER;
    const interval = HEARTBEAT_INTERVAL + jitter;

    this.heartbeatTimer = setTimeout(async () => {
      if (this.isShuttingDown) return;

      try {
        const result = await this.convex!.mutation(
          convexApi.localSandbox.heartbeat,
          {
            token: this.token,
            connectionId: this.connectionId,
          },
        );

        if (result?.session) {
          this.session = result.session;
          // Restart command subscription with fresh session
          this.startCommandSubscription();
        }
      } catch (error) {
        console.error("[DesktopSandbox] Heartbeat failed:", error);
        this.setStatus("error");
      }

      // Schedule next heartbeat
      if (!this.isShuttingDown) {
        this.startHeartbeat();
      }
    }, interval);
  }

  private startCommandSubscription(): void {
    // Unsubscribe from previous subscription
    if (this.commandSubscription) {
      this.commandSubscription();
      this.commandSubscription = null;
    }

    if (!this.convex || !this.connectionId || !this.session) return;

    this.commandSubscription = this.convex.onUpdate(
      convexApi.localSandbox.getPendingCommands,
      {
        connectionId: this.connectionId,
        session: {
          userId: this.session.userId,
          expiresAt: this.session.expiresAt,
          signature: this.session.signature,
        },
      },
      async (data: PendingCommandsResult) => {
        if (this.isShuttingDown) return;

        if (data?.authError) {
          console.warn("[DesktopSandbox] Auth error in subscription, will retry on heartbeat");
          return;
        }

        if (data?.commands && data.commands.length > 0) {
          for (const cmd of data.commands) {
            // Queue commands and process sequentially
            this.commandQueue.push(cmd);
          }
          this.processCommandQueue();
        }
      },
    );
  }

  private async processCommandQueue(): Promise<void> {
    if (this.isExecuting || this.commandQueue.length === 0) return;

    this.isExecuting = true;

    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift()!;
      try {
        await this.executeCommand(cmd);
      } catch (error) {
        console.error(
          `[DesktopSandbox] Failed to execute command ${cmd.command_id}:`,
          error,
        );
      }
    }

    this.isExecuting = false;
  }

  private async executeCommand(cmd: PendingCommand): Promise<void> {
    // Mark command as executing
    try {
      await this.convex!.mutation(convexApi.localSandbox.markCommandExecuting, {
        token: this.token,
        commandId: cmd.command_id,
      });
    } catch {
      // Non-fatal, continue with execution
    }

    let result: CommandOutput;

    try {
      if (cmd.background) {
        result = await tauriInvoke<CommandOutput>("execute_command_background", {
          command: cmd.command,
          env: cmd.env || null,
          cwd: cmd.cwd || null,
        });
      } else {
        result = await tauriInvoke<CommandOutput>("execute_command", {
          command: cmd.command,
          env: cmd.env || null,
          cwd: cmd.cwd || null,
          timeoutMs: cmd.timeout || 30000,
        });
      }
    } catch (error) {
      result = {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exit_code: 1,
        pid: null,
        duration_ms: 0,
      };
    }

    // Submit result back to Convex
    try {
      await this.convex!.mutation(convexApi.localSandbox.submitResult, {
        token: this.token,
        commandId: cmd.command_id,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr),
        exitCode: result.exit_code,
        pid: result.pid ?? undefined,
        duration: result.duration_ms,
      });
    } catch (error) {
      console.error("[DesktopSandbox] Failed to submit result:", error);
    }
  }

  /**
   * Stop the desktop sandbox and clean up
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.commandSubscription) {
      this.commandSubscription();
      this.commandSubscription = null;
    }

    // Notify backend of disconnect
    if (this.convex && this.token && this.connectionId) {
      try {
        await this.convex.mutation(convexApi.localSandbox.disconnect, {
          token: this.token,
          connectionId: this.connectionId,
        });
      } catch {
        // Best-effort disconnect
      }
    }

    if (this.convex) {
      await this.convex.close();
      this.convex = null;
    }

    this.connectionId = null;
    this.userId = null;
    this.session = null;
    this.token = null;
    this.commandQueue = [];
    this.isExecuting = false;
    this.isShuttingDown = false;
    this.setStatus("disconnected");

    console.log("[DesktopSandbox] Disconnected");
  }

  /**
   * Check if the client is connected and healthy
   */
  isConnected(): boolean {
    return this._status === "connected" && this.connectionId !== null;
  }

  /**
   * Get the connection ID for use in the sandbox selector
   */
  getConnectionId(): string | null {
    return this.connectionId;
  }
}

// Singleton instance for the app
let instance: DesktopSandboxClient | null = null;

/**
 * Get or create the desktop sandbox client singleton
 */
export function getDesktopSandboxClient(
  convexUrl: string,
): DesktopSandboxClient {
  if (!instance) {
    instance = new DesktopSandboxClient(convexUrl);
  }
  return instance;
}

/**
 * Check if the desktop sandbox feature is available (running in Tauri)
 */
export function isDesktopSandboxAvailable(): boolean {
  return isTauri();
}
