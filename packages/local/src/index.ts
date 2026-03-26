#!/usr/bin/env node

/**
 * HackerAI Local Sandbox Client
 *
 * Connects to HackerAI backend via Convex for connection lifecycle
 * and uses Centrifugo for real-time command relay and streaming output.
 *
 * Runs commands directly on the host OS (no Docker isolation).
 *
 * Usage:
 *   npx @hackerai/local --token TOKEN --name "My Machine"
 */

import { ConvexHttpClient } from "convex/browser";
import { Centrifuge, Subscription, PublicationContext } from "centrifuge";
import WebSocket from "ws";
import { spawn, ChildProcess } from "child_process";
import os from "os";
import { truncateOutput, MAX_OUTPUT_SIZE, getDefaultShell } from "./utils";

const DEFAULT_SHELL = getDefaultShell(os.platform());

// Idle timeout: auto-terminate after 1 hour without commands
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// Idle check interval: check every 5 minutes
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a shell command using spawn for better output control.
 * Collects stdout/stderr and handles timeouts gracefully.
 */
function runShellCommand(
  command: string,
  options: {
    timeout?: number;
    shell?: string;
    shellFlag?: string;
    maxOutputSize?: number;
  } = {},
): Promise<ShellCommandResult> {
  const {
    timeout = 30000,
    shell = DEFAULT_SHELL.shell,
    shellFlag = DEFAULT_SHELL.shellFlag,
    maxOutputSize = MAX_OUTPUT_SIZE,
  } = options;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const proc: ChildProcess = spawn(shell, [shellFlag, command], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Set up timeout
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        killed = true;
        proc.kill("SIGTERM");
        // Force kill after 2 seconds if still running
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 2000);
      }, timeout);
    }

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      // Prevent memory issues by capping collection (we'll truncate at the end)
      if (stdout.length > maxOutputSize * 2) {
        stdout = truncateOutput(stdout, maxOutputSize * 2);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > maxOutputSize * 2) {
        stderr = truncateOutput(stderr, maxOutputSize * 2);
      }
    });

    proc.on("close", (code) => {
      if (timeoutId) clearTimeout(timeoutId);

      // Final truncation
      const truncatedStdout = truncateOutput(stdout, maxOutputSize);
      const truncatedStderr = truncateOutput(stderr, maxOutputSize);

      if (killed) {
        resolve({
          stdout: truncatedStdout,
          stderr: truncatedStderr + "\n[Command timed out and was terminated]",
          exitCode: 124, // Standard timeout exit code
        });
      } else {
        resolve({
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          exitCode: code ?? 1,
        });
      }
    });

    proc.on("error", (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        stdout: truncateOutput(stdout, maxOutputSize),
        stderr: truncateOutput(stderr + "\n" + error.message, maxOutputSize),
        exitCode: 1,
      });
    });
  });
}

// Production Convex URL - hardcoded for the published package
const PRODUCTION_CONVEX_URL = "https://convex.haiusercontent.com";

// Convex function references (string paths work at runtime)
const api = {
  localSandbox: {
    connect: "localSandbox:connect" as const,
    disconnect: "localSandbox:disconnect" as const,
    refreshCentrifugoToken: "localSandbox:refreshCentrifugoToken" as const,
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

interface Config {
  convexUrl: string;
  token: string;
  name: string;
}

interface OsInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
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
  targetConnectionId?: string;
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

type CentrifugoOutgoingMessage =
  | CentrifugoStdoutMessage
  | CentrifugoStderrMessage
  | CentrifugoExitMessage
  | CentrifugoErrorMessage;

interface ConnectResult {
  success: boolean;
  userId?: string;
  connectionId?: string;
  centrifugoToken?: string;
  centrifugoWsUrl?: string;
  error?: string;
}

interface RefreshTokenResult {
  centrifugoToken: string;
}

class LocalSandboxClient {
  private convexHttp: ConvexHttpClient;
  private centrifuge?: Centrifuge;
  private subscription?: Subscription;
  private userId?: string;
  private connectionId?: string;
  private isShuttingDown = false;
  private lastActivityTime: number;
  private idleCheckInterval?: NodeJS.Timeout;

  constructor(private config: Config) {
    this.convexHttp = new ConvexHttpClient(config.convexUrl);
    this.lastActivityTime = Date.now();
  }

  async start(): Promise<void> {
    console.log(chalk.blue("🚀 Starting HackerAI local sandbox..."));
    console.log(
      chalk.yellow(
        "⚠️  Commands run directly on your OS without any isolation.",
      ),
    );
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

  private async connect(): Promise<void> {
    console.log(chalk.blue("Connecting to HackerAI..."));

    try {
      const result = (await this.convexHttp.mutation(
        api.localSandbox.connect as never,
        {
          token: this.config.token,
          connectionName: this.config.name,
          clientVersion: "1.0.0",
          osInfo: this.getOsInfo(),
        } as never,
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

      console.log(chalk.green("✓ Authenticated"));
      console.log(chalk.bold(chalk.green("🎉 Local sandbox is ready!")));
      console.log(chalk.gray(`Connection: ${this.connectionId}`));

      this.setupCentrifugo(result.centrifugoWsUrl, result.centrifugoToken);
      this.startIdleCheck();
    } catch (error: unknown) {
      const err = error as { data?: { message?: string }; message?: string };
      const errorMessage =
        err?.data?.message || err?.message || JSON.stringify(error);
      console.error(chalk.red("❌ Connection failed:"), errorMessage);
      if (
        errorMessage.includes("Invalid token") ||
        errorMessage.includes("token")
      ) {
        console.error(chalk.yellow("Please regenerate your token in Settings"));
      }
      await this.cleanup();
      process.exit(1);
    }
  }

  private setupCentrifugo(wsUrl: string, initialToken: string): void {
    this.centrifuge = new Centrifuge(wsUrl, {
      websocket: WebSocket as unknown as typeof globalThis.WebSocket,
      token: initialToken,
      getToken: async (): Promise<string> => {
        if (!this.connectionId) {
          throw new Error("Cannot refresh token: connectionId is null");
        }
        try {
          const result = (await this.convexHttp.mutation(
            api.localSandbox.refreshCentrifugoToken as never,
            {
              token: this.config.token,
              connectionId: this.connectionId,
            } as never,
          )) as RefreshTokenResult;
          return result.centrifugoToken;
        } catch (error) {
          console.error(
            chalk.red("Failed to refresh Centrifugo token:"),
            error,
          );
          throw error;
        }
      },
    });

    const channel = `sandbox:user#${this.userId}`;
    this.subscription = this.centrifuge.newSubscription(channel);

    this.subscription.on("publication", (ctx: PublicationContext) => {
      if (this.isShuttingDown) return;

      const message = ctx.data as CentrifugoCommandMessage;
      if (message.type === "command") {
        if (
          message.targetConnectionId &&
          message.targetConnectionId !== this.connectionId
        ) {
          return;
        }
        this.lastActivityTime = Date.now();
        this.handleCommand(message).catch((error: unknown) => {
          const errorMsg =
            error instanceof Error ? error.message : JSON.stringify(error);
          console.error(chalk.red(`Error handling command: ${errorMsg}`));
        });
      }
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
          this.cleanup().then(() => process.exit(1));
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

    this.subscription.subscribe();
    this.centrifuge.connect();
  }

  private async publishToChannel(
    data: CentrifugoOutgoingMessage,
  ): Promise<void> {
    if (!this.subscription) {
      console.error(chalk.red("Cannot publish: no active subscription"));
      return;
    }
    try {
      await this.subscription.publish(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      console.error(chalk.red(`Publish failed: ${msg}`));
      throw err;
    }
  }

  private async handleCommand(msg: CentrifugoCommandMessage): Promise<void> {
    const { commandId, command, env, cwd, timeout, background, displayName } =
      msg;

    // Determine what to show in console:
    // - displayName === "" (empty string): hide command entirely
    // - displayName === "something": show that instead of command
    // - displayName === undefined: show actual command
    const shouldShow = displayName !== "";
    const displayText = displayName || command;
    if (shouldShow) {
      console.log(chalk.cyan(`▶ ${background ? "[BG] " : ""}${displayText}`));
    }

    try {
      let fullCommand = command;

      if (cwd && cwd.trim() !== "") {
        fullCommand = `cd "${cwd}" 2>/dev/null && ${fullCommand}`;
      }

      if (env) {
        const envString = Object.entries(env)
          .map(([k, v]) => {
            const escaped = v
              .replace(/\\/g, "\\\\")
              .replace(/"/g, '\\"')
              .replace(/\$/g, "\\$")
              .replace(/`/g, "\\`");
            return `export ${k}="${escaped}"`;
          })
          .join("; ");
        fullCommand = `${envString}; ${fullCommand}`;
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
      console.log(chalk.red(`✗ ${displayText}: ${message}`));
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

      const proc = spawn(
        DEFAULT_SHELL.shell,
        [DEFAULT_SHELL.shellFlag, fullCommand],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      if (commandTimeout > 0) {
        timeoutId = setTimeout(() => {
          killed = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill("SIGKILL");
            }
          }, 2000);
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

      proc.on("close", (code) => {
        if (timeoutId) clearTimeout(timeoutId);

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

        this.publishToChannel({
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

      proc.on("error", (error) => {
        if (timeoutId) clearTimeout(timeoutId);
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
        this.publishToChannel({
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
    const child = spawn(
      DEFAULT_SHELL.shell,
      [DEFAULT_SHELL.shellFlag, fullCommand],
      {
        detached: os.platform() !== "win32",
        stdio: "ignore",
      },
    );
    child.unref();
    return child.pid ?? -1;
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
        this.cleanup().then(() => process.exit(0));
      }
    }, IDLE_CHECK_INTERVAL_MS);
  }

  private stopIdleCheck(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = undefined;
    }
  }

  async cleanup(): Promise<void> {
    console.log(chalk.blue("\n🧹 Cleaning up..."));

    this.isShuttingDown = true;
    this.stopIdleCheck();

    // Disconnect Centrifugo
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = undefined;
    }
    if (this.centrifuge) {
      this.centrifuge.disconnect();
      this.centrifuge = undefined;
    }

    // Set up force-exit timeout (5 seconds)
    const forceExitTimeout = setTimeout(() => {
      console.log(chalk.yellow("⚠️  Force exiting after 5 second timeout..."));
      process.exit(1);
    }, 5000);

    try {
      if (this.connectionId) {
        try {
          await this.convexHttp.mutation(
            api.localSandbox.disconnect as never,
            {
              token: this.config.token,
              connectionId: this.connectionId,
            } as never,
          );
          console.log(chalk.green("✓ Disconnected"));
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(chalk.yellow(`⚠️  Failed to disconnect: ${message}`));
        }
      }
    } finally {
      clearTimeout(forceExitTimeout);
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

// Show help
if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`
${chalk.bold("HackerAI Local Sandbox Client")}

${chalk.yellow("Usage:")}
  npx @hackerai/local --token TOKEN [options]

${chalk.yellow("Options:")}
  --token TOKEN       Authentication token from Settings (required)
  --name NAME         Connection name (default: hostname)
  --convex-url URL    Override Convex backend URL (for development)
  --help, -h          Show this help message

${chalk.yellow("Examples:")}
  npx @hackerai/local --token hsb_abc123 --name "My Laptop"
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

const config: Config = {
  convexUrl: getArg("--convex-url") || PRODUCTION_CONVEX_URL,
  token: getArg("--token") || "",
  name: getArg("--name") || os.hostname(),
};

if (!config.token) {
  console.error(chalk.red("❌ No authentication token provided"));
  console.error(chalk.yellow("Usage: npx @hackerai/local --token YOUR_TOKEN"));
  console.error(chalk.yellow("Get your token from HackerAI Settings > Agents"));
  process.exit(1);
}

const client = new LocalSandboxClient(config);

process.on("SIGINT", async () => {
  console.log(chalk.yellow("\n🛑 Shutting down..."));
  await client.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await client.cleanup();
  process.exit(0);
});

client.start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red("Fatal error:"), message);
  process.exit(1);
});
