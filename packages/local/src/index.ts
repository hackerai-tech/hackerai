#!/usr/bin/env node

/**
 * HackerAI Local Sandbox Client
 *
 * Connects to HackerAI backend via Convex for connection lifecycle
 * and uses either Centrifugo or AWS's authenticated endpoint for real-time
 * command transport and streaming output.
 *
 * Runs commands directly on the host OS (no Docker isolation).
 *
 * Usage:
 *   npx @hackerai/local --token TOKEN
 */

import { ConvexHttpClient } from "convex/browser";
import { Centrifuge, Subscription, PublicationContext } from "centrifuge";
import WebSocket, { WebSocketServer } from "ws";
import { spawn, ChildProcess } from "child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import os from "os";
import {
  truncateOutput,
  MAX_OUTPUT_SIZE,
  getDefaultShell,
  buildShellSpawn,
} from "./utils";
import {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
  isPtyAvailable,
} from "./process-runner";
import {
  confirmProcessTermination,
  isProcessTreeTerminationConfirmed,
} from "./command-cancellation";
import { CentrifugoPublishQueue } from "./centrifugo-transport";
import {
  CloudImagePrimeError,
  primeCloudImageWorkingSet,
} from "./cloud-image-prime";
import { InProcessRelayLifecycle } from "./cloud-relay-lifecycle";
import {
  CloudDirectTransport,
  type DirectTransportDisconnect,
} from "./cloud-direct-transport";

const DEFAULT_SHELL = getDefaultShell(os.platform());

// Idle timeout: auto-terminate after 1 hour without commands
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// Idle check interval: check every 5 minutes
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Production Convex URL - hardcoded for the published package
const PRODUCTION_CONVEX_URL = "https://convex.haiusercontent.com";

// Convex function references (string paths work at runtime)
const api = {
  localSandbox: {
    connect: "localSandbox:connect" as const,
    disconnect: "localSandbox:disconnect" as const,
    refreshCentrifugoToken: "localSandbox:refreshCentrifugoToken" as const,
    connectCloud: "localSandbox:connectCloud" as const,
    markCloudRelayReady: "localSandbox:markCloudRelayReady" as const,
    refreshCloudCentrifugoToken:
      "localSandbox:refreshCloudCentrifugoToken" as const,
    disconnectCloud: "localSandbox:disconnectCloud" as const,
    reportCloudLifecycleState:
      "localSandbox:reportCloudLifecycleState" as const,
  },
};

// ANSI color codes for terminal output
const chalk = {
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export interface Config {
  convexUrl: string;
  token: string;
  name: string;
  authMode: "local" | "cloud" | "direct-cloud";
  cloudSessionId?: string;
  microvmId?: string;
  lifecycleCallback?: CloudLifecycleCallback;
}

interface OsInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
}

interface ClientCapabilities {
  commands: boolean;
  pty: boolean;
}

interface CentrifugoCommandMessage {
  type: "command";
  commandId: string;
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  background?: boolean;
  displayName?: string;
  targetConnectionId: string;
}

interface CentrifugoCommandCancelMessage {
  type: "command_cancel";
  commandId: string;
  targetConnectionId: string;
}

interface CentrifugoStdoutMessage {
  type: "stdout";
  commandId: string;
  data: string;
}

interface CentrifugoStderrMessage {
  type: "stderr";
  commandId: string;
  data: string;
}

interface CentrifugoExitMessage {
  type: "exit";
  commandId: string;
  exitCode: number;
  pid?: number;
}

interface CentrifugoErrorMessage {
  type: "error";
  commandId: string;
  message: string;
}

interface CentrifugoCommandCancelResultMessage {
  type: "command_cancel_result";
  commandId: string;
  canceled: boolean;
}

// --- PTY incoming message types ---

interface PtyCreateMessage {
  type: "pty_create";
  sessionId: string;
  command: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  targetConnectionId: string;
}

interface PtyInputMessage {
  type: "pty_input";
  sessionId: string;
  data: string;
  targetConnectionId: string;
}

interface PtyResizeMessage {
  type: "pty_resize";
  sessionId: string;
  cols: number;
  rows: number;
  targetConnectionId: string;
}

interface PtyKillMessage {
  type: "pty_kill";
  sessionId: string;
  signal?: string;
  targetConnectionId: string;
}

type CentrifugoPtyIncomingMessage =
  PtyCreateMessage | PtyInputMessage | PtyResizeMessage | PtyKillMessage;

type TargetedIncomingMessage =
  | CentrifugoCommandMessage
  | CentrifugoCommandCancelMessage
  | CentrifugoPtyIncomingMessage;

function isTargetedIncomingMessage(
  message: unknown,
): message is TargetedIncomingMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const { type, targetConnectionId } = message as {
    type?: unknown;
    targetConnectionId?: unknown;
  };
  return (
    typeof targetConnectionId === "string" &&
    (type === "command" ||
      type === "command_cancel" ||
      type === "pty_create" ||
      type === "pty_input" ||
      type === "pty_resize" ||
      type === "pty_kill")
  );
}

// --- PTY outgoing message types ---

interface CentrifugoPtyReadyMessage {
  type: "pty_ready";
  sessionId: string;
  pid: number;
}

interface CentrifugoPtyDataMessage {
  type: "pty_data";
  sessionId: string;
  data: string;
}

interface CentrifugoPtyExitMessage {
  type: "pty_exit";
  sessionId: string;
  exitCode: number;
}

interface CentrifugoPtyErrorMessage {
  type: "pty_error";
  sessionId: string;
  message: string;
}

type CentrifugoOutgoingMessage =
  | CentrifugoStdoutMessage
  | CentrifugoStderrMessage
  | CentrifugoExitMessage
  | CentrifugoErrorMessage
  | CentrifugoCommandCancelResultMessage
  | CentrifugoPtyReadyMessage
  | CentrifugoPtyDataMessage
  | CentrifugoPtyExitMessage
  | CentrifugoPtyErrorMessage;

interface ConnectResult {
  success: boolean;
  userId?: string;
  connectionId?: string;
  centrifugoToken?: string;
  centrifugoWsUrl?: string;
  error?: string;
}

type RefreshTokenResult =
  | { ok: true; centrifugoToken: string }
  | {
      ok: false;
      terminated: true;
      reason:
        "connection_not_found" | "ownership_mismatch" | "connection_inactive";
      connectionId: string;
      clientVersion: string | null;
      status: string | null;
      disconnectReason:
        | "client_disconnect"
        | "desktop_disconnect"
        | "desktop_kicked_by_new_session"
        | "token_regenerated"
        | "presence_sweep"
        | "command_unresponsive"
        | null;
      msSinceDisconnected: number | null;
      msSinceLastHeartbeat: number | null;
      msSinceCreated: number | null;
    };

// "Invalid token" UNAUTHORIZED still throws server-side (the caller's token
// is bad, not a connection lifecycle event), so the catch path needs to
// recognize it as another terminate-the-loop signal.
function isInvalidTokenError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  return (data as { code?: string }).code === "UNAUTHORIZED";
}

type LocalSandboxClientOptions = {
  onExitRequested?: (code: number, error: Error) => void;
  directTransport?: CloudDirectTransport;
};

export class LocalSandboxClient {
  private convexHttp: ConvexHttpClient;
  private centrifuge?: Centrifuge;
  private subscription?: Subscription;
  private userId?: string;
  private connectionId?: string;
  private isShuttingDown = false;
  private lastActivityTime: number;
  private idleCheckInterval?: NodeJS.Timeout;
  private processRunner: ProcessRunner;
  private activeStreamCommands: Map<string, ChildProcess> = new Map();
  private publishQueue?: CentrifugoPublishQueue;
  private cleanupPromise?: Promise<void>;
  private exitRequested = false;

  constructor(
    private config: Config,
    private readonly options: LocalSandboxClientOptions = {},
  ) {
    this.convexHttp = new ConvexHttpClient(config.convexUrl);
    this.lastActivityTime = Date.now();
    this.processRunner = new ProcessRunner();
    this.setupProcessRunnerListeners();
  }

  async primeStartupWorkingSet(): Promise<void> {
    const command = {
      type: "command",
      commandId: "image-validation",
      command: "printf hackerai-image-prime",
      targetConnectionId: "image-validation",
    };
    const parsed = JSON.parse(JSON.stringify(command)) as unknown;
    if (!isTargetedIncomingMessage(parsed)) {
      throw new Error("Command protocol priming failed");
    }
    const queue = new CentrifugoPublishQueue(async (fragment) => {
      JSON.parse(JSON.stringify(fragment));
    });
    await queue.publish({
      type: "exit",
      commandId: "image-validation",
      exitCode: 0,
    });
    this.getOsInfo();
    this.getCapabilities();
  }

  disposePrimedResources(): void {
    this.isShuttingDown = true;
    this.processRunner.dispose();
  }

  private requestExit(code: number, error: Error): void {
    if (this.exitRequested || this.isShuttingDown) return;
    this.exitRequested = true;
    void this.cleanup().then(
      () => {
        if (this.options.onExitRequested) {
          this.options.onExitRequested(code, error);
        } else {
          process.exit(code);
        }
      },
      (cleanupError) => {
        const fatal =
          cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError));
        if (this.options.onExitRequested) {
          this.options.onExitRequested(code, fatal);
        } else {
          process.exit(code);
        }
      },
    );
  }

  private setupProcessRunnerListeners(): void {
    this.processRunner.on("data", (sessionId: string, data: string) => {
      this.publishToChannel({
        type: "pty_data",
        sessionId,
        data,
      }).catch((err: unknown) => {
        console.error(
          chalk.red(
            `[PTY] Failed to publish data for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      });
    });

    this.processRunner.on("exit", (sessionId: string, exitCode: number) => {
      console.log(
        chalk.gray(`[PTY] Session ${sessionId} exited (code ${exitCode})`),
      );
      this.publishToChannel({
        type: "pty_exit",
        sessionId,
        exitCode,
      }).catch((err: unknown) => {
        console.error(
          chalk.red(
            `[PTY] Failed to publish exit for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      });
    });

    this.processRunner.on("error", (sessionId: string, error: Error) => {
      console.error(
        chalk.red(`[PTY] Session ${sessionId} error: ${error.message}`),
      );
      this.publishToChannel({
        type: "pty_error",
        sessionId,
        message: error.message,
      }).catch((err: unknown) => {
        console.error(
          chalk.red(
            `[PTY] Failed to publish error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      });
    });
  }

  async start(): Promise<void> {
    if (this.config.authMode !== "local") {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          event: "cloud_sandbox_guest_starting",
          service: "hackerai-cloud-sandbox-agent",
          environment: "aws-lambda-microvm",
          request_id: this.config.cloudSessionId ?? null,
          microvm_id: this.config.microvmId ?? null,
        }),
      );
    } else {
      console.log(chalk.blue("🚀 Starting HackerAI local sandbox..."));
      console.log(
        chalk.yellow(
          "⚠️  Commands run directly on your OS without any isolation.",
        ),
      );
    }
    await this.connect();
  }

  private getOsInfo(): OsInfo {
    return {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
    };
  }

  private getCapabilities(): ClientCapabilities {
    return {
      commands: true,
      pty: isPtyAvailable(),
    };
  }

  private async connect(): Promise<void> {
    if (this.config.authMode === "direct-cloud") {
      if (!this.options.directTransport || !this.config.microvmId) {
        throw new Error("Direct cloud transport is not configured");
      }
      this.connectionId = this.config.microvmId;
      this.options.directTransport.start({
        onMessage: (message) => this.handleIncomingMessage(message),
        onDisconnect: (pending) => this.handleDirectDisconnect(pending),
      });
      return;
    }

    if (this.config.authMode === "local") {
      console.log(chalk.blue("Connecting to HackerAI..."));
    }

    try {
      const result = (await this.convexHttp.mutation(
        (this.config.authMode === "cloud"
          ? api.localSandbox.connectCloud
          : api.localSandbox.connect) as never,
        (this.config.authMode === "cloud"
          ? {
              sessionId: this.config.cloudSessionId,
              bootstrapToken: this.config.token,
              microvmId: this.config.microvmId,
              clientVersion: "aws-lambda-microvm-relay-ready-v1",
              osInfo: this.getOsInfo(),
              capabilities: this.getCapabilities(),
            }
          : {
              token: this.config.token,
              connectionName: this.config.name,
              clientVersion: "1.0.0",
              osInfo: this.getOsInfo(),
              capabilities: this.getCapabilities(),
            }) as never,
      )) as ConnectResult;

      if (
        !result.success ||
        !result.centrifugoToken ||
        !result.centrifugoWsUrl
      ) {
        throw new Error(result.error || "Authentication failed");
      }

      this.userId = result.userId;
      this.connectionId = result.connectionId;

      if (this.config.authMode === "local") {
        console.log(chalk.green("✓ Authenticated"));
        console.log(chalk.bold(chalk.green("🎉 Local sandbox is ready!")));
        console.log(chalk.gray(`Connection: ${this.connectionId}`));
      }

      await this.setupCentrifugo(
        result.centrifugoWsUrl,
        result.centrifugoToken,
      );
      if (this.config.authMode === "cloud") {
        const ready = (await this.convexHttp.mutation(
          api.localSandbox.markCloudRelayReady as never,
          {
            sessionId: this.config.cloudSessionId,
            bootstrapToken: this.config.token,
            microvmId: this.config.microvmId,
            connectionId: this.connectionId,
          } as never,
        )) as boolean;
        if (!ready) {
          throw new Error("Cloud relay could not be marked ready");
        }
      }
      if (this.config.authMode === "local") {
        this.startIdleCheck();
      }
    } catch (error: unknown) {
      const err = error as { data?: { message?: string }; message?: string };
      const errorMessage =
        err?.data?.message || err?.message || JSON.stringify(error);
      console.error(chalk.red("❌ Connection failed:"), errorMessage);
      if (
        this.config.authMode === "local" &&
        (errorMessage.includes("Invalid token") ||
          errorMessage.includes("token"))
      ) {
        console.error(chalk.yellow("Please regenerate your token in Settings"));
      }
      await this.cleanup().catch((cleanupError: unknown) => {
        const detail =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        console.warn(chalk.yellow(`⚠️  Cleanup incomplete: ${detail}`));
      });
      throw error;
    }
  }

  private async setupCentrifugo(
    wsUrl: string,
    initialToken: string,
  ): Promise<void> {
    this.centrifuge = new Centrifuge(wsUrl, {
      websocket: WebSocket as unknown as typeof globalThis.WebSocket,
      token: initialToken,
      getToken: async (): Promise<string> => {
        if (!this.connectionId) {
          throw new Error("Cannot refresh token: connectionId is null");
        }
        let result: RefreshTokenResult;
        try {
          result = (await this.convexHttp.mutation(
            (this.config.authMode === "cloud"
              ? api.localSandbox.refreshCloudCentrifugoToken
              : api.localSandbox.refreshCentrifugoToken) as never,
            (this.config.authMode === "cloud"
              ? {
                  sessionId: this.config.cloudSessionId,
                  bootstrapToken: this.config.token,
                  connectionId: this.connectionId,
                }
              : {
                  token: this.config.token,
                  connectionId: this.connectionId,
                }) as never,
          )) as RefreshTokenResult;
        } catch (error) {
          if (isInvalidTokenError(error)) {
            console.error(chalk.red("\n❌ Token rejected by server."));
            if (this.config.authMode === "local") {
              console.error(
                chalk.yellow("Please regenerate your token in Settings."),
              );
            }
            // cleanup() synchronously calls centrifuge.disconnect() before any
            // awaits, so by the time we re-throw below Centrifuge is in a
            // terminal state and won't invoke getToken again.
            this.requestExit(1, new Error("Centrifugo token was rejected"));
          } else {
            console.error(
              chalk.red("Failed to refresh Centrifugo token:"),
              error,
            );
          }
          throw error;
        }
        if (result.ok) return result.centrifugoToken;

        console.error(
          chalk.red(`\n❌ Connection terminated by server (${result.reason})`),
        );
        const reasonHint =
          result.disconnectReason === "token_regenerated"
            ? "Your token was regenerated; rerun with the new token."
            : result.disconnectReason === "presence_sweep"
              ? "Server presence sweep marked this connection stale."
              : result.disconnectReason === "command_unresponsive"
                ? "Server stopped this connection after repeated commands received no response. Restart HackerAI Local and try again."
                : result.disconnectReason === "desktop_kicked_by_new_session"
                  ? "A new desktop session took over."
                  : result.disconnectReason === "client_disconnect" ||
                      result.disconnectReason === "desktop_disconnect"
                    ? "This connection was explicitly disconnected."
                    : "Likely causes: token regenerated, or disconnected from another session.";
        console.error(chalk.yellow(reasonHint));
        console.error(
          chalk.gray(
            JSON.stringify({
              connectionId: result.connectionId,
              disconnectReason: result.disconnectReason,
              msSinceDisconnected: result.msSinceDisconnected,
              msSinceLastHeartbeat: result.msSinceLastHeartbeat,
              msSinceCreated: result.msSinceCreated,
            }),
          ),
        );
        // Stop the Centrifuge retry loop and exit. cleanup() synchronously
        // calls centrifuge.disconnect() before any awaits, so by the time we
        // throw below Centrifuge is in a terminal state and won't invoke
        // getToken again.
        this.requestExit(
          1,
          new Error(`Centrifugo refresh aborted: ${result.reason}`),
        );
        throw new Error(`Centrifugo refresh aborted: ${result.reason}`);
      },
    });

    const channel = `sandbox:connection:${this.connectionId}#${this.userId}`;
    this.subscription = this.centrifuge.newSubscription(channel);
    this.publishQueue = new CentrifugoPublishQueue(async (message) => {
      if (!this.subscription) {
        throw new Error("Cannot publish: no active subscription");
      }
      await this.subscription.publish(message);
    });

    this.subscription.on("publication", (ctx: PublicationContext) => {
      this.handleIncomingMessage(ctx.data);
    });

    this.centrifuge.on("disconnected", (ctx) => {
      if (!this.isShuttingDown) {
        const isConnectionLimit =
          ctx.reason?.includes("connection limit") || ctx.code === 4503;
        if (isConnectionLimit) {
          console.error(
            chalk.red(
              "❌ Connection limit reached. The server has too many active connections.",
            ),
          );
          console.error(
            chalk.yellow("Please try again later or contact support."),
          );
          this.requestExit(1, new Error("Centrifugo connection limit reached"));
        } else {
          console.log(
            chalk.yellow(`⚠️  Disconnected from Centrifugo: ${ctx.reason}`),
          );
        }
      }
    });

    this.centrifuge.on("connected", () => {
      console.log(chalk.green("✓ Connected to command relay"));
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out connecting to the command relay"));
      }, 20_000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      this.subscription?.once("subscribed", () => finish());
      this.subscription?.on("error", (ctx) => {
        // Centrifuge retries recoverable subscription errors. Keep waiting for
        // `subscribed` until the bounded startup timeout expires.
        console.warn(
          chalk.yellow(
            `Command relay subscription error; retrying: ${ctx.error?.message ?? "unknown"}`,
          ),
        );
      });
    });

    this.subscription.subscribe();
    this.centrifuge.connect();
    await ready;
  }

  private async publishToChannel(
    data: CentrifugoOutgoingMessage,
  ): Promise<void> {
    if (this.config.authMode === "direct-cloud") {
      if (!this.options.directTransport) {
        throw new Error("Direct cloud transport is not configured");
      }
      await this.options.directTransport.publish(
        data as unknown as Record<string, unknown>,
      );
      return;
    }

    if (!this.publishQueue) {
      console.error(chalk.red("Cannot publish: no active subscription"));
      return;
    }
    try {
      await this.publishQueue.publish(
        data as unknown as Record<string, unknown>,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      console.error(chalk.red(`Publish failed: ${msg}`));
      throw err;
    }
  }

  private handleIncomingMessage(message: unknown): void {
    if (this.isShuttingDown || !isTargetedIncomingMessage(message)) return;
    if (message.targetConnectionId !== this.connectionId) return;

    this.lastActivityTime = Date.now();
    switch (message.type) {
      case "command":
        this.handleCommand(message).catch((error: unknown) => {
          const errorMsg =
            error instanceof Error ? error.message : JSON.stringify(error);
          console.error(
            chalk.red(
              this.config.authMode === "direct-cloud"
                ? "Error handling direct command"
                : `Error handling command: ${errorMsg}`,
            ),
          );
        });
        break;
      case "command_cancel":
        this.handleCommandCancel(message).catch((error: unknown) => {
          console.error(
            chalk.red(
              `[CMD] Failed to handle cancellation: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        });
        break;
      case "pty_create":
        this.handlePtyCreate(message).catch((error: unknown) => {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`[PTY] Error creating session: ${errorMsg}`));
        });
        break;
      case "pty_input":
        this.handlePtyInput(message);
        break;
      case "pty_resize":
        this.handlePtyResize(message);
        break;
      case "pty_kill":
        this.handlePtyKill(message);
        break;
    }
  }

  private handleDirectDisconnect(pending: DirectTransportDisconnect): void {
    for (const commandId of pending.commandIds) {
      void this.handleCommandCancel({
        type: "command_cancel",
        commandId,
        targetConnectionId: this.connectionId ?? "",
      }).catch(() => undefined);
    }
    for (const sessionId of pending.sessionIds) {
      this.handlePtyKill({
        type: "pty_kill",
        sessionId,
        targetConnectionId: this.connectionId ?? "",
      });
    }
  }

  private async handleCommand(msg: CentrifugoCommandMessage): Promise<void> {
    const { commandId, command, env, cwd, timeout, background, displayName } =
      msg;

    // Determine what to show in console:
    // - displayName === "" (empty string): hide command entirely
    // - displayName === "something": show that instead of command
    // - displayName === undefined: show actual command
    // CloudWatch guest logs must never contain user commands, arguments,
    // targets, working directories, environment values, or command output.
    const shouldShow =
      this.config.authMode !== "direct-cloud" && displayName !== "";
    const displayText =
      this.config.authMode === "direct-cloud"
        ? "direct command"
        : displayName || command;
    if (shouldShow) {
      console.log(chalk.cyan(`▶ ${background ? "[BG] " : ""}${displayText}`));
    }

    try {
      let fullCommand = command;

      // Detect whether the default shell is cmd.exe so we emit the
      // correct syntax for cd and environment variable injection.
      const shellBase =
        DEFAULT_SHELL.shell
          .toLowerCase()
          .replace(/\\/g, "/")
          .split("/")
          .pop() ?? "";
      const useCmd = shellBase === "cmd" || shellBase === "cmd.exe";

      if (cwd && cwd.trim() !== "") {
        fullCommand = useCmd
          ? `cd /d "${cwd}" && ${fullCommand}`
          : `cd "${cwd}" 2>/dev/null && ${fullCommand}`;
      }

      if (env) {
        const envString = Object.entries(env)
          .map(([k, v]) => {
            if (useCmd) {
              // cmd.exe: use `set` with no trailing space inside quotes
              const escaped = v.replace(/%/g, "%%").replace(/"/g, '""');
              return `set "${k}=${escaped}"`;
            }
            const escaped = v
              .replace(/\\/g, "\\\\")
              .replace(/"/g, '\\"')
              .replace(/\$/g, "\\$")
              .replace(/`/g, "\\`");
            return `export ${k}="${escaped}"`;
          })
          .join(useCmd ? " && " : "; ");
        fullCommand = useCmd
          ? `${envString} && ${fullCommand}`
          : `${envString}; ${fullCommand}`;
      }

      if (background) {
        const pid = await this.spawnBackground(fullCommand);
        await this.publishToChannel({
          type: "exit",
          commandId,
          exitCode: 0,
          pid,
        });
        console.log(
          chalk.green(`✓ Background process started with PID: ${pid}`),
        );
        return;
      }

      await this.streamCommand(
        commandId,
        fullCommand,
        timeout,
        shouldShow,
        displayText,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.publishToChannel({
        type: "error",
        commandId,
        message: truncateOutput(message),
      });
      console.log(
        chalk.red(
          this.config.authMode === "direct-cloud"
            ? "✗ Direct command failed"
            : `✗ ${displayText}: ${message}`,
        ),
      );
    }
  }

  private async handleCommandCancel(
    msg: CentrifugoCommandCancelMessage,
  ): Promise<void> {
    const proc = this.activeStreamCommands.get(msg.commandId);
    const canceled = proc
      ? await confirmProcessTermination(
          proc,
          () => this.terminateProcessTree(proc),
          undefined,
          () => isProcessTreeTerminationConfirmed(proc),
        )
      : false;
    await this.publishToChannel({
      type: "command_cancel_result",
      commandId: msg.commandId,
      canceled,
    });
  }

  private terminateProcessTree(proc: ChildProcess): void {
    const pid = proc.pid;
    if (!pid) {
      proc.kill("SIGKILL");
      return;
    }

    if (os.platform() === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      proc.kill("SIGTERM");
    }

    setTimeout(() => {
      if (isProcessTreeTerminationConfirmed(proc)) {
        return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, 1000).unref();
  }

  private async terminateActiveStreamCommands(): Promise<void> {
    const commands = [...this.activeStreamCommands.entries()];
    const results = await Promise.all(
      commands.map(async ([commandId, proc]) => {
        console.log(
          chalk.yellow(`[CMD] Terminating active command ${commandId}`),
        );
        const confirmed = await confirmProcessTermination(
          proc,
          () => this.terminateProcessTree(proc),
          undefined,
          () => isProcessTreeTerminationConfirmed(proc),
        );
        if (confirmed) this.activeStreamCommands.delete(commandId);
        return confirmed;
      }),
    );
    const unconfirmed = results.filter((confirmed) => !confirmed).length;
    if (unconfirmed > 0) {
      throw new Error(
        `Could not confirm termination of ${unconfirmed} command process tree(s)`,
      );
    }
  }

  private async streamCommand(
    commandId: string,
    fullCommand: string,
    timeout: number | undefined,
    shouldShow: boolean,
    displayText: string,
  ): Promise<void> {
    const startTime = Date.now();
    const commandTimeout = timeout ?? 30000;

    return new Promise<void>((resolve) => {
      let killed = false;
      let timeoutId: NodeJS.Timeout | undefined;

      const spawnSpec = buildShellSpawn(
        DEFAULT_SHELL.shell,
        DEFAULT_SHELL.shellFlag,
        fullCommand,
      );
      const proc = spawn(DEFAULT_SHELL.shell, spawnSpec.args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: os.platform() !== "win32",
        ...spawnSpec.options,
      });
      this.activeStreamCommands.set(commandId, proc);

      if (commandTimeout > 0) {
        timeoutId = setTimeout(() => {
          killed = true;
          this.terminateProcessTree(proc);
        }, commandTimeout);
      }

      let accumulatedStderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        this.publishToChannel({
          type: "stdout",
          commandId,
          data: chunk,
        }).catch((err: unknown) => {
          console.error(
            chalk.red(
              `[ERROR] Failed to publish stdout: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        });
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        accumulatedStderr += chunk;
        this.publishToChannel({
          type: "stderr",
          commandId,
          data: chunk,
        }).catch((err: unknown) => {
          console.error(
            chalk.red(
              `[ERROR] Failed to publish stderr: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        });
      });

      proc.on("close", async (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        this.activeStreamCommands.delete(commandId);

        const duration = Date.now() - startTime;
        const exitCode = killed ? 124 : (code ?? 1);

        if (killed) {
          this.publishToChannel({
            type: "stderr",
            commandId,
            data: "\n[Command timed out and was terminated]",
          }).catch((err: unknown) => {
            console.error(
              chalk.red(
                `[ERROR] Failed to publish timeout stderr: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          });
        }

        await this.publishToChannel({
          type: "exit",
          commandId,
          exitCode,
        }).catch((err: unknown) => {
          console.error(
            chalk.red(
              `[CRITICAL] Failed to publish EXIT message: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        });

        if (shouldShow) {
          if (exitCode === 0) {
            console.log(
              chalk.green(`✓ ${displayText} ${chalk.gray(`(${duration}ms)`)}`),
            );
          } else {
            console.log(
              chalk.red(
                `✗ ${displayText} ${chalk.gray(`(exit ${exitCode}, ${duration}ms)`)}`,
              ),
            );
            if (accumulatedStderr.trim()) {
              const indented = accumulatedStderr
                .trim()
                .split("\n")
                .map((l) => `  ${l}`)
                .join("\n");
              console.log(chalk.red(indented));
            }
          }
        }

        resolve();
      });

      proc.on("error", async (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        this.activeStreamCommands.delete(commandId);
        this.publishToChannel({
          type: "error",
          commandId,
          message: error.message,
        }).catch((err: unknown) => {
          console.error(
            chalk.red(
              `[ERROR] Failed to publish error message: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        });
        await this.publishToChannel({
          type: "exit",
          commandId,
          exitCode: 1,
        }).catch((err: unknown) => {
          console.error(
            chalk.red(
              `[CRITICAL] Failed to publish EXIT after process error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        });
        resolve();
      });
    });
  }

  private async spawnBackground(fullCommand: string): Promise<number> {
    const spawnSpec = buildShellSpawn(
      DEFAULT_SHELL.shell,
      DEFAULT_SHELL.shellFlag,
      fullCommand,
    );
    const child = spawn(DEFAULT_SHELL.shell, spawnSpec.args, {
      detached: os.platform() !== "win32",
      stdio: "ignore",
      ...spawnSpec.options,
    });
    child.unref();
    return child.pid ?? -1;
  }

  private async handlePtyCreate(msg: PtyCreateMessage): Promise<void> {
    const { sessionId, command, cols, rows, cwd, env } = msg;

    console.log(
      chalk.cyan(
        this.config.authMode === "direct-cloud"
          ? `[PTY] Creating session ${sessionId}`
          : `[PTY] Creating session ${sessionId}: ${command}`,
      ),
    );

    try {
      const opts: ProcessRunOptions = {};
      if (cols !== undefined) opts.cols = cols;
      if (rows !== undefined) opts.rows = rows;
      if (cwd !== undefined) opts.cwd = cwd;
      if (env !== undefined) opts.env = env;

      const result: ProcessRunResult = this.processRunner.run(
        sessionId,
        command,
        opts,
      );

      await this.publishToChannel({
        type: "pty_ready",
        sessionId,
        pid: result.pid,
      });

      console.log(
        chalk.green(`[PTY] Session ${sessionId} ready (pid ${result.pid})`),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        chalk.red(
          this.config.authMode === "direct-cloud"
            ? `[PTY] Failed to create session ${sessionId}`
            : `[PTY] Failed to create session ${sessionId}: ${message}`,
        ),
      );
      await this.publishToChannel({
        type: "pty_error",
        sessionId,
        message,
      });
    }
  }

  private handlePtyInput(msg: PtyInputMessage): void {
    const { sessionId, data } = msg;
    const ok = this.processRunner.write(sessionId, data);
    if (!ok) {
      console.warn(chalk.yellow(`[PTY] Write to unknown session ${sessionId}`));
    }
  }

  private handlePtyResize(msg: PtyResizeMessage): void {
    const { sessionId, cols, rows } = msg;
    const ok = this.processRunner.resize(sessionId, cols, rows);
    if (!ok) {
      console.warn(
        chalk.yellow(`[PTY] Resize for unknown session ${sessionId}`),
      );
    }
  }

  private handlePtyKill(msg: PtyKillMessage): void {
    const { sessionId, signal } = msg;
    console.log(
      chalk.yellow(
        `[PTY] Killing session ${sessionId}${signal ? ` (signal: ${signal})` : ""}`,
      ),
    );
    const ok = this.processRunner.stop(sessionId, signal);
    if (!ok) {
      console.warn(chalk.yellow(`[PTY] Kill for unknown session ${sessionId}`));
    }
  }

  private startIdleCheck(): void {
    this.idleCheckInterval = setInterval(() => {
      const idleTime = Date.now() - this.lastActivityTime;
      if (idleTime >= IDLE_TIMEOUT_MS) {
        const idleMinutes = Math.floor(idleTime / 60000);
        console.log(
          chalk.yellow(
            `\n⏰ Idle timeout: No commands received for ${idleMinutes} minutes`,
          ),
        );
        console.log(chalk.yellow("Auto-terminating to save resources..."));
        this.requestExit(0, new Error("Local sandbox idle timeout"));
      }
    }, IDLE_CHECK_INTERVAL_MS);
  }

  private stopIdleCheck(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = undefined;
    }
  }

  async cleanup(options: { terminated?: boolean } = {}): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.performCleanup(options).catch((error) => {
      this.cleanupPromise = undefined;
      throw error;
    });
    return this.cleanupPromise;
  }

  private async performCleanup(options: {
    terminated?: boolean;
  }): Promise<void> {
    console.log(chalk.blue("\n🧹 Cleaning up..."));

    this.isShuttingDown = true;
    this.stopIdleCheck();

    // Confirm both PTY and streamed-command process trees are gone before AWS
    // snapshots a suspended VM or completes termination.
    const processShutdown = Promise.all([
      this.processRunner.shutdown(),
      this.terminateActiveStreamCommands(),
    ]);

    const directTransportShutdown =
      this.config.authMode === "direct-cloud"
        ? this.options.directTransport?.stop()
        : undefined;

    // Disconnect Centrifugo
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = undefined;
    }
    this.publishQueue = undefined;
    if (this.centrifuge) {
      this.centrifuge.disconnect();
      this.centrifuge = undefined;
    }

    await Promise.all([processShutdown, directTransportShutdown]);

    if (this.connectionId && this.config.authMode !== "direct-cloud") {
      let disconnectTimeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.convexHttp.mutation(
            (this.config.authMode === "cloud"
              ? api.localSandbox.disconnectCloud
              : api.localSandbox.disconnect) as never,
            (this.config.authMode === "cloud"
              ? {
                  sessionId: this.config.cloudSessionId,
                  bootstrapToken: this.config.token,
                  connectionId: this.connectionId,
                  terminated: options.terminated === true,
                }
              : {
                  token: this.config.token,
                  connectionId: this.connectionId,
                }) as never,
          ),
          new Promise<never>(
            (_, reject) =>
              (disconnectTimeout = setTimeout(
                () => reject(new Error("Disconnect timed out after 5 seconds")),
                5_000,
              )),
          ),
        ]);
        console.log(chalk.green("✓ Disconnected"));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(chalk.yellow(`⚠️  Failed to disconnect: ${message}`));
      } finally {
        if (disconnectTimeout) clearTimeout(disconnectTimeout);
      }
    }
  }
}

// Parse command-line arguments
const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const hasFlag = (flag: string): boolean => {
  return args.includes(flag);
};

interface CloudLifecycleCallback {
  convexUrl: string;
  bootstrapToken: string;
}

interface CloudLifecyclePayload {
  sessionId: string;
  connectionName?: string;
  lifecycleCallback?: CloudLifecycleCallback;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 32 * 1024) {
      throw new Error("Lifecycle payload exceeds 32 KiB");
    }
  }
  return body ? JSON.parse(body) : {};
}

function writeLifecycleResponse(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function parseCloudLifecyclePayload(value: unknown): {
  microvmId: string;
  config: CloudLifecyclePayload | null;
  smokeTest: boolean;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid lifecycle request");
  }
  const record = value as Record<string, unknown>;
  const microvmId = record.microvmId;
  const rawPayload = record.runHookPayload;
  if (typeof microvmId !== "string" || typeof rawPayload !== "string") {
    throw new Error("Lifecycle request is missing MicroVM bootstrap data");
  }
  const payload = JSON.parse(rawPayload) as Partial<CloudLifecyclePayload>;
  if (
    payload &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).smokeTest === true
  ) {
    return {
      microvmId,
      config: { sessionId: "image-smoke-test" },
      smokeTest: true,
    };
  }
  if (typeof payload.sessionId !== "string") {
    throw new Error("Invalid cloud bootstrap payload");
  }
  let lifecycleCallback: CloudLifecycleCallback | undefined;
  if (payload.lifecycleCallback !== undefined) {
    const callback = payload.lifecycleCallback;
    if (
      !callback ||
      typeof callback !== "object" ||
      typeof callback.convexUrl !== "string" ||
      typeof callback.bootstrapToken !== "string" ||
      callback.bootstrapToken.length === 0
    ) {
      throw new Error("Invalid cloud lifecycle callback");
    }
    const callbackUrl = new URL(callback.convexUrl);
    if (callbackUrl.protocol !== "https:") {
      throw new Error("Cloud lifecycle callback must use HTTPS");
    }
    lifecycleCallback = {
      convexUrl: callbackUrl.toString().replace(/\/$/, ""),
      bootstrapToken: callback.bootstrapToken,
    };
  }
  return {
    microvmId,
    smokeTest: false,
    config: {
      sessionId: payload.sessionId,
      connectionName: payload.connectionName,
      lifecycleCallback,
    },
  };
}

async function startCloudLifecycleServer(): Promise<void> {
  let lifecycleConfig: Config | null = null;
  const directTransport = new CloudDirectTransport();
  const relay = new InProcessRelayLifecycle<Config>(
    (config, onFatal) =>
      new LocalSandboxClient(config, {
        onExitRequested: (_code, error) => onFatal(error),
        directTransport,
      }),
    (error) => {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "cloud_sandbox_guest_failed",
          service: "hackerai-cloud-sandbox-agent",
          environment: "aws-lambda-microvm",
          request_id: lifecycleConfig?.cloudSessionId ?? null,
          error: error.message,
        }),
      );
    },
    (error) => {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "cloud_sandbox_guest_restart_failed",
          service: "hackerai-cloud-sandbox-agent",
          environment: "aws-lambda-microvm",
          request_id: lifecycleConfig?.cloudSessionId ?? null,
          error: error.message,
        }),
      );
    },
  );

  const reportLifecycleState = async (
    config: Config | null,
    state: "RUNNING" | "SUSPENDING" | "SUSPENDED" | "TERMINATING",
  ): Promise<void> => {
    if (
      !config?.lifecycleCallback ||
      !config.cloudSessionId ||
      !config.microvmId
    ) {
      return;
    }
    const startedAt = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = new ConvexHttpClient(config.lifecycleCallback.convexUrl);
      const reported = await Promise.race([
        client.mutation(
          api.localSandbox.reportCloudLifecycleState as never,
          {
            sessionId: config.cloudSessionId,
            bootstrapToken: config.lifecycleCallback.bootstrapToken,
            microvmId: config.microvmId,
            state,
          } as never,
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Lifecycle callback timed out")),
            2_000,
          );
        }),
      ]);
      if (!reported) throw new Error("Lifecycle callback was rejected");
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          event: "cloud_sandbox_lifecycle_state_reported",
          service: "hackerai-cloud-sandbox-agent",
          environment: "aws-lambda-microvm",
          request_id: config.cloudSessionId,
          microvm_id: config.microvmId,
          microvm_state: state,
          duration_ms: Math.round(performance.now() - startedAt),
        }),
      );
    } catch (error) {
      // AWS lifecycle progress must not depend on Convex availability. The
      // scheduled control-plane reconciliation repairs missed callbacks.
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          event: "cloud_sandbox_lifecycle_state_report_failed",
          service: "hackerai-cloud-sandbox-agent",
          environment: "aws-lambda-microvm",
          request_id: config.cloudSessionId,
          microvm_id: config.microvmId,
          microvm_state: state,
          duration_ms: Math.round(performance.now() - startedAt),
          error_name: error instanceof Error ? error.name : typeof error,
          error_message:
            error instanceof Error
              ? error.message.slice(0, 500)
              : String(error).slice(0, 500),
        }),
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const primeImage = async (hook: string): Promise<void> => {
    const result = await primeCloudImageWorkingSet({
      primeRelay: async () => {
        const client = new LocalSandboxClient({
          convexUrl: "http://127.0.0.1",
          token: "image-validation",
          name: "image-validation",
          authMode: "cloud",
          cloudSessionId: "image-validation",
          microvmId: "image-validation",
        });
        try {
          await client.primeStartupWorkingSet();
        } finally {
          client.disposePrimedResources();
        }
      },
    });
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "cloud_sandbox_image_primed",
        service: "hackerai-cloud-sandbox-agent",
        environment: "aws-lambda-microvm",
        request_id: "image-build",
        hook,
        duration_ms: result.duration_ms,
        step_count: result.steps.length,
        steps: result.steps,
      }),
    );
  };

  const server = createServer(async (request, response) => {
    const path = request.url?.split("?", 1)[0] ?? "/";
    const requestId = lifecycleConfig?.cloudSessionId ?? "image-build";
    try {
      if (request.method === "GET" && path === "/health") {
        writeLifecycleResponse(response, 200, {
          ok: true,
          connected: relay.running,
        });
        return;
      }

      if (
        request.method === "POST" &&
        (path === "/aws/lambda-microvms/runtime/v1/ready" ||
          path === "/aws/lambda-microvms/runtime/v1/validate")
      ) {
        await primeImage(path.endsWith("/ready") ? "ready" : "validate");
        writeLifecycleResponse(response, 200, { ok: true, primed: true });
        return;
      }

      if (
        request.method === "POST" &&
        path === "/aws/lambda-microvms/runtime/v1/run"
      ) {
        const { microvmId, config, smokeTest } = parseCloudLifecyclePayload(
          await readJsonBody(request),
        );
        if (!config) throw new Error("Cloud sandbox bootstrap is missing");
        lifecycleConfig = {
          convexUrl: "http://127.0.0.1",
          token: "",
          name: config.connectionName ?? "AWS Lambda MicroVM",
          authMode: "direct-cloud",
          cloudSessionId: config.sessionId,
          microvmId,
          lifecycleCallback: config.lifecycleCallback,
        };
        await relay.run(lifecycleConfig);
        writeLifecycleResponse(response, 200, { ok: true, smokeTest });
        return;
      }

      if (
        request.method === "POST" &&
        path === "/aws/lambda-microvms/runtime/v1/suspend"
      ) {
        await relay.suspend();
        await reportLifecycleState(lifecycleConfig, "SUSPENDING");
        writeLifecycleResponse(response, 200, { ok: true });
        return;
      }

      if (
        request.method === "POST" &&
        path === "/aws/lambda-microvms/runtime/v1/resume"
      ) {
        await relay.resume();
        await reportLifecycleState(lifecycleConfig, "RUNNING");
        writeLifecycleResponse(response, 200, { ok: true });
        return;
      }

      if (
        request.method === "POST" &&
        path === "/aws/lambda-microvms/runtime/v1/terminate"
      ) {
        await relay.terminate();
        await reportLifecycleState(lifecycleConfig, "TERMINATING");
        lifecycleConfig = null;
        writeLifecycleResponse(response, 200, { ok: true });
        return;
      }

      writeLifecycleResponse(response, 404, { error: "not_found" });
    } catch (error) {
      const primeError =
        error instanceof CloudImagePrimeError ? error : undefined;
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "cloud_sandbox_lifecycle_hook_failed",
          service: "hackerai-cloud-sandbox-agent",
          environment: "aws-lambda-microvm",
          request_id: requestId,
          hook: path,
          failure_step: primeError?.step ?? null,
          completed_steps: primeError?.completedSteps ?? null,
          cause_error:
            primeError?.cause instanceof Error
              ? primeError.cause.message.slice(0, 500)
              : null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      writeLifecycleResponse(response, 500, { error: "lifecycle_hook_failed" });
    }
  });

  const directServer = createServer((_request, response) => {
    writeLifecycleResponse(response, 426, { error: "websocket_required" });
  });
  const directWebSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    perMessageDeflate: false,
  });
  directServer.on("upgrade", (request, socket, head) => {
    const path = request.url?.split("?", 1)[0] ?? "/";
    if (path !== "/sandbox") {
      socket.destroy();
      return;
    }
    directWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
      directTransport.accept(webSocket);
    });
  });

  const shutdown = async (): Promise<void> => {
    try {
      await relay.terminate();
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "cloud_sandbox_shutdown_cleanup_failed",
          service: "hackerai-cloud-sandbox-agent",
          environment: "aws-lambda-microvm",
          request_id: lifecycleConfig?.cloudSessionId ?? "signal",
          failure_code: "guest_termination_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    directWebSockets.close();
    directServer.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  server.listen(8080, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "cloud_sandbox_lifecycle_server_ready",
        service: "hackerai-cloud-sandbox-agent",
        environment: "aws-lambda-microvm",
        request_id: "image-build",
        port: 8080,
      }),
    );
  });
  directServer.listen(9000, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "cloud_sandbox_direct_server_ready",
        service: "hackerai-cloud-sandbox-agent",
        environment: "aws-lambda-microvm",
        request_id: "image-build",
        port: 9000,
      }),
    );
  });
}

export function main(): void {
  // Show help
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`
${chalk.bold("HackerAI Local Sandbox Client")}

${chalk.yellow("Usage:")}
  npx @hackerai/local --token TOKEN [options]

${chalk.yellow("Options:")}
  --token TOKEN       Authentication token from Settings (required)
  --name NAME         Optional connection name fallback (default: hostname)
  --convex-url URL    Override Convex backend URL (for development)
  --help, -h          Show this help message

${chalk.yellow("Examples:")}
  npx @hackerai/local --token hsb_abc123
  npx @hackerai/local --token hsb_abc123 --name "Work PC"

${chalk.red("⚠️  Security Warning:")}
  Commands run directly on your OS without any isolation.
  Only connect machines you trust and control.

${chalk.cyan("Auto-termination:")}
  The client automatically terminates after 1 hour of inactivity (no commands
  executed) to save system resources.
`);
    process.exit(0);
  }

  if (hasFlag("--cloud-lifecycle")) {
    void startCloudLifecycleServer().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "cloud_sandbox_lifecycle_server_failed",
          service: "hackerai-cloud-sandbox-agent",
          environment: "aws-lambda-microvm",
          request_id: "startup",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(1);
    });
  } else {
    const config: Config = {
      convexUrl: getArg("--convex-url") || PRODUCTION_CONVEX_URL,
      token: getArg("--token") || "",
      name: getArg("--name") || os.hostname(),
      authMode: "local",
    };

    if (!config.token) {
      console.error(chalk.red("❌ No authentication token provided"));
      console.error(
        chalk.yellow("Usage: npx @hackerai/local --token YOUR_TOKEN"),
      );
      console.error(
        chalk.yellow("Get your token from HackerAI Settings > Agents"),
      );
      process.exit(1);
    }

    const client = new LocalSandboxClient(config);

    process.on("SIGINT", async () => {
      console.log(chalk.yellow("\n🛑 Shutting down..."));
      try {
        await client.cleanup();
        process.exit(0);
      } catch (error) {
        console.error(
          chalk.red(
            `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    });

    process.on("SIGTERM", async () => {
      try {
        await client.cleanup();
        process.exit(0);
      } catch (error) {
        console.error(
          chalk.red(
            `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    });

    client.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red("Fatal error:"), message);
      process.exit(1);
    });
  }
}

if (require.main === module) {
  main();
}
