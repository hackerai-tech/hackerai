#!/usr/bin/env node

/**
 * HackerAI Local Sandbox Client
 *
 * Connects to HackerAI backend via Convex and executes commands
 * on the local machine (either in Docker or directly on the host OS).
 *
 * Usage:
 *   npx @hackerai/local --token TOKEN --name "My Laptop"
 *   npx @hackerai/local --token TOKEN --name "Work PC" --dangerous
 */

import { ConvexClient } from "convex/browser";
import { spawn, ChildProcess } from "child_process";
import os from "os";
import {
  truncateOutput,
  MAX_OUTPUT_SIZE,
  getSandboxMode,
  buildDockerRunCommand,
  parseShellDetectionOutput,
  getDefaultShell,
} from "./utils";

const DEFAULT_SHELL = getDefaultShell(os.platform());

// Idle timeout: auto-terminate after 1 hour without commands
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

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

      // Final truncation to fit Convex limits
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

function runWithOutput(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

// Production Convex URL - hardcoded for the published package
const PRODUCTION_CONVEX_URL = "https://convex.haiusercontent.com";

// Default pre-built image with all pentesting tools
const DEFAULT_IMAGE = "hackerai/sandbox";

// Convex function references (string paths work at runtime)
const api = {
  localSandbox: {
    connect: "localSandbox:connect" as const,
    heartbeat: "localSandbox:heartbeat" as const,
    disconnect: "localSandbox:disconnect" as const,
    getPendingCommands: "localSandbox:getPendingCommands" as const,
    markCommandExecuting: "localSandbox:markCommandExecuting" as const,
    submitResult: "localSandbox:submitResult" as const,
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
  dangerous: boolean;
  build: boolean;
  persist: boolean;
}

interface OsInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
}

interface Command {
  command_id: string;
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  background?: boolean;
  // Display name for CLI output (empty string = hide, undefined = show command)
  display_name?: string;
}

interface SignedSession {
  expiresAt: number;
  signature: string;
}

interface ConnectResult {
  success: boolean;
  userId?: string;
  connectionId?: string;
  session?: SignedSession;
  error?: string;
}

interface HeartbeatResult {
  success: boolean;
  session?: SignedSession;
  error?: string;
}

interface PendingCommandsResult {
  commands: Command[];
  authError?: boolean;
}

class LocalSandboxClient {
  private convex: ConvexClient;
  private containerId?: string;
  private containerShell: string = "/bin/bash"; // Detected shell, defaults to bash
  private userId?: string;
  private connectionId?: string;
  private session?: SignedSession;
  private heartbeatInterval?: NodeJS.Timeout;
  private commandSubscription?: () => void;
  private isShuttingDown = false;
  private lastActivityTime: number;

  constructor(private config: Config) {
    this.convex = new ConvexClient(config.convexUrl);
    this.lastActivityTime = Date.now();
  }

  async start(): Promise<void> {
    console.log(chalk.blue("🚀 Starting HackerAI local sandbox..."));

    if (!this.config.dangerous) {
      const dockerCheck = await runShellCommand("docker --version", {
        timeout: 5000,
      });
      if (dockerCheck.exitCode !== 0) {
        console.error(
          chalk.red(
            "❌ Docker not found. Please install Docker or use --dangerous mode.",
          ),
        );
        process.exit(1);
      }
      console.log(chalk.green("✓ Docker is available"));

      this.containerId = await this.createContainer();
      console.log(chalk.green(`✓ Container: ${this.containerId.slice(0, 12)}`));

      // Detect available shell (bash or sh fallback for Alpine/minimal images)
      await this.detectContainerShell();
    } else {
      console.log(
        chalk.yellow(
          "⚠️  DANGEROUS MODE - Commands will run directly on your OS!",
        ),
      );
    }

    await this.connect();
  }

  private getContainerName(): string {
    // Generate a predictable container name for --persist mode
    // Sanitize the connection name to be docker-compatible
    const sanitized = this.config.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return `hackerai-sandbox-${sanitized || "default"}`;
  }

  private async findExistingContainer(
    containerName: string,
  ): Promise<{ id: string; running: boolean } | null> {
    // Check if container with this name exists
    const result = await runShellCommand(
      `docker ps -a --filter "name=^${containerName}$" --format "{{.ID}}|{{.State}}"`,
      { timeout: 5000 },
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }

    const [id, state] = result.stdout.trim().split("|");
    return { id, running: state === "running" };
  }

  private async createContainer(): Promise<string> {
    // In persist mode, try to reuse existing container
    if (this.config.persist) {
      const containerName = this.getContainerName();
      const existing = await this.findExistingContainer(containerName);

      if (existing) {
        if (existing.running) {
          console.log(
            chalk.green(`✓ Reusing existing container: ${containerName}`),
          );
          return existing.id;
        } else {
          // Container exists but stopped - start it
          console.log(
            chalk.blue(`Starting existing container: ${containerName}`),
          );
          const startResult = await runShellCommand(
            `docker start ${existing.id}`,
            { timeout: 30000 },
          );
          if (startResult.exitCode === 0) {
            console.log(chalk.green(`✓ Container started: ${containerName}`));
            return existing.id;
          }
          // If start failed, remove and create fresh
          console.log(
            chalk.yellow(`⚠️  Failed to start, creating new container...`),
          );
          await runShellCommand(`docker rm -f ${existing.id}`, {
            timeout: 5000,
          });
        }
      }
    }

    if (this.config.build) {
      console.log(
        chalk.red("❌ --build flag is not supported in the npx package."),
      );
      process.exit(1);
    }

    console.log(chalk.blue(`Pulling pre-built image: ${DEFAULT_IMAGE}`));
    console.log(
      chalk.gray("(First run may take a few minutes to download the image)"),
    );
    console.log("");
    try {
      await runWithOutput("docker", ["pull", DEFAULT_IMAGE]);
      console.log(chalk.green("✓ Image ready"));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red("❌ Failed to pull image:"), message);
      process.exit(1);
    }

    console.log(chalk.blue("Creating Docker container..."));

    // Build docker run command with capabilities for penetration testing tools
    const dockerCommand = buildDockerRunCommand({
      image: DEFAULT_IMAGE,
      containerName: this.config.persist ? this.getContainerName() : undefined,
    });

    const result = await runShellCommand(dockerCommand, { timeout: 60000 });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to create container: ${result.stderr}`);
    }

    return result.stdout.trim();
  }

  private getOsInfo(): OsInfo {
    return {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
    };
  }

  private getMode(): "docker" | "dangerous" {
    return getSandboxMode({
      dangerous: this.config.dangerous,
    });
  }

  private getModeDisplay(): string {
    const mode = this.getMode();
    if (mode === "dangerous") {
      return "DANGEROUS";
    }
    return "Docker";
  }

  /**
   * Detects which shell is available in the container.
   * Tries bash first, falls back to sh if bash is not available.
   * This handles Alpine/BusyBox images that don't have bash installed.
   */
  private async detectContainerShell(): Promise<void> {
    if (!this.containerId) return;

    // Try to detect available shell using 'command -v' (POSIX compliant)
    // We use 'sh' to run the detection since it's guaranteed to exist
    const result = await runShellCommand(
      `docker exec ${this.containerId} sh -c 'command -v bash || command -v sh || echo /bin/sh'`,
      { timeout: 5000 },
    );

    if (result.exitCode === 0) {
      this.containerShell = parseShellDetectionOutput(result.stdout);
      console.log(chalk.green(`✓ Shell: ${this.containerShell}`));
    } else {
      // Fallback to /bin/sh if detection failed
      this.containerShell = "/bin/sh";
      console.log(
        chalk.yellow(
          `⚠️  Shell detection failed, using ${this.containerShell}`,
        ),
      );
    }
  }

  private async connect(): Promise<void> {
    console.log(chalk.blue("Connecting to HackerAI..."));

    try {
      const result = (await (this.convex as any).mutation(
        api.localSandbox.connect,
        {
          token: this.config.token,
          connectionName: this.config.name,
          containerId: this.containerId,
          clientVersion: "1.0.0",
          mode: this.getMode(),
          osInfo: this.config.dangerous ? this.getOsInfo() : undefined,
        },
      )) as ConnectResult;

      if (!result.success || !result.session) {
        throw new Error(result.error || "Authentication failed");
      }

      this.userId = result.userId;
      this.connectionId = result.connectionId;
      this.session = result.session;

      console.log(chalk.green("✓ Authenticated"));
      console.log(chalk.bold(chalk.green("🎉 Local sandbox is ready!")));
      console.log(chalk.gray(`Connection: ${this.connectionId}`));
      console.log(
        chalk.gray(
          `Mode: ${this.getModeDisplay()}${this.config.persist ? " (persistent)" : ""}`,
        ),
      );

      this.startHeartbeat();
      this.startCommandSubscription();
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

  private startCommandSubscription(): void {
    if (!this.connectionId || !this.userId || !this.session) return;

    // Use Convex subscription for real-time command updates

    this.commandSubscription = (this.convex as any).onUpdate(
      api.localSandbox.getPendingCommands,
      {
        connectionId: this.connectionId,
        // Pass signed session for secure verification without DB lookups
        session: {
          userId: this.userId,
          expiresAt: this.session.expiresAt,
          signature: this.session.signature,
        },
      },
      async (data: PendingCommandsResult) => {
        if (this.isShuttingDown) return;

        // Handle session auth errors - client needs to re-authenticate
        if (data?.authError) {
          console.debug(
            "Session expired or invalid, will refresh on next heartbeat",
          );
          return;
        }

        if (!data?.commands) return;

        for (const cmd of data.commands) {
          await this.executeCommand(cmd);
        }
      },
    );
  }

  private async executeCommand(cmd: Command): Promise<void> {
    const { command_id, command, env, cwd, timeout, background, display_name } =
      cmd;
    const startTime = Date.now();

    // Update activity time to prevent idle timeout
    this.lastActivityTime = Date.now();

    // Determine what to show in console:
    // - display_name === "" (empty string): hide command entirely
    // - display_name === "something": show that instead of command
    // - display_name === undefined: show actual command
    const shouldShow = display_name !== "";
    const displayText = display_name || command;
    if (shouldShow) {
      console.log(chalk.cyan(`▶ ${background ? "[BG] " : ""}${displayText}`));
    }

    try {
      await (this.convex as any).mutation(
        api.localSandbox.markCommandExecuting,
        {
          token: this.config.token,
          commandId: command_id,
        },
      );

      let fullCommand = command;

      if (cwd && cwd.trim() !== "") {
        fullCommand = `cd "${cwd}" 2>/dev/null && ${fullCommand}`;
      }

      if (env) {
        const envString = Object.entries(env)
          .map(([k, v]) => {
            // Escape quotes, backticks, and $ to prevent shell injection
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

      // Handle background mode - spawn and return immediately with PID
      if (background) {
        const pid = await this.spawnBackground(fullCommand);
        const duration = Date.now() - startTime;

        await (this.convex as any).mutation(api.localSandbox.submitResult, {
          commandId: command_id,
          token: this.config.token,
          stdout: "",
          stderr: "",
          exitCode: 0,
          pid,
          duration,
        });

        console.log(
          chalk.green(`✓ Background process started with PID: ${pid}`),
        );
        return;
      }

      let result: ShellCommandResult;

      if (this.config.dangerous) {
        result = await runShellCommand(fullCommand, {
          timeout: timeout ?? 30000,
          // Use platform-appropriate shell (powershell on Windows, bash on Unix)
        });
      } else {
        // Use single quotes to prevent host shell from interpreting $(), backticks, etc.
        // This ensures ALL command execution happens inside the Docker container
        const escapedCommand = fullCommand.replace(/'/g, "'\\''");
        // Extract shell name (e.g., "bash" from "/bin/bash" or "/usr/bin/bash")
        const shellName = this.containerShell.split("/").pop() || "sh";
        result = await runShellCommand(
          `docker exec ${this.containerId} ${shellName} -c '${escapedCommand}'`,
          { timeout: timeout ?? 30000 },
        );
      }

      const duration = Date.now() - startTime;

      await (this.convex as any).mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        token: this.config.token,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration,
      });

      if (shouldShow) {
        if (result.exitCode === 0) {
          console.log(
            chalk.green(`✓ ${displayText} ${chalk.gray(`(${duration}ms)`)}`),
          );
        } else {
          console.log(
            chalk.red(
              `✗ ${displayText} ${chalk.gray(`(exit ${result.exitCode}, ${duration}ms)`)}`,
            ),
          );
          if (result.stderr.trim()) {
            // Indent each line of stderr for readability
            const indented = result.stderr
              .trim()
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n");
            console.log(chalk.red(indented));
          }
        }
      }
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      await (this.convex as any).mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        token: this.config.token,
        stdout: "",
        stderr: truncateOutput(message),
        exitCode: 1,
        duration,
      });

      console.log(
        chalk.red(
          `✗ ${displayText} ${chalk.gray(`(${duration}ms)`)}: ${message}`,
        ),
      );
    }
  }

  private async spawnBackground(fullCommand: string): Promise<number> {
    if (this.config.dangerous) {
      // Spawn directly on host in dangerous mode using platform-appropriate shell
      const child = spawn(
        DEFAULT_SHELL.shell,
        [DEFAULT_SHELL.shellFlag, fullCommand],
        {
          detached: os.platform() !== "win32", // detached doesn't work the same on Windows
          stdio: "ignore",
        },
      );
      child.unref();
      return child.pid ?? -1;
    } else {
      // For Docker, start the process in background inside container and get its PID
      // Using 'nohup command & echo $!' to get the container process PID
      const escapedCommand = fullCommand.replace(/'/g, "'\\''");
      // Extract shell name (e.g., "bash" from "/bin/bash" or "/usr/bin/bash")
      const shellName = this.containerShell.split("/").pop() || "sh";
      const result = await runShellCommand(
        `docker exec ${this.containerId} ${shellName} -c 'nohup ${escapedCommand} > /dev/null 2>&1 & echo $!'`,
        { timeout: 5000 },
      );

      if (result.exitCode === 0 && result.stdout.trim()) {
        const pid = parseInt(result.stdout.trim(), 10);
        return isNaN(pid) ? -1 : pid;
      }
      return -1;
    }
  }

  private scheduleNextHeartbeat(): void {
    // Add jitter (±10s) to prevent thundering herd when multiple clients connect
    const baseInterval = 60000; // 1 minute
    const jitter = Math.floor(Math.random() * 20000) - 10000; // -10000 to +10000
    const interval = baseInterval + jitter;

    this.heartbeatInterval = setTimeout(async () => {
      if (this.connectionId && !this.isShuttingDown) {
        // Check for idle timeout
        const idleTime = Date.now() - this.lastActivityTime;
        if (idleTime >= IDLE_TIMEOUT_MS) {
          const idleMinutes = Math.floor(idleTime / 60000);
          console.log(
            chalk.yellow(
              `\n⏰ Idle timeout: No commands received for ${idleMinutes} minutes`,
            ),
          );
          console.log(chalk.yellow("Auto-terminating to save resources..."));
          await this.cleanup();
          process.exit(0);
        }

        try {
          const result = (await (this.convex as any).mutation(
            api.localSandbox.heartbeat,
            {
              token: this.config.token,
              connectionId: this.connectionId,
            },
          )) as HeartbeatResult;

          if (!result.success) {
            console.log(
              chalk.red(
                "\n❌ Connection invalidated (token may have been regenerated)",
              ),
            );
            console.log(chalk.yellow("Shutting down..."));
            await this.cleanup();
            process.exit(1);
          }

          // Refresh session and restart subscription with new session
          if (result.session) {
            this.session = result.session;
            this.restartCommandSubscription();
          }
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.debug(`Heartbeat error (will retry): ${message}`);
        }
      }
      // Schedule next heartbeat with fresh jitter
      if (!this.isShuttingDown) {
        this.scheduleNextHeartbeat();
      }
    }, interval);
  }

  private startHeartbeat(): void {
    this.scheduleNextHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearTimeout(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private stopCommandSubscription(): void {
    if (this.commandSubscription) {
      this.commandSubscription();
      this.commandSubscription = undefined;
    }
  }

  private restartCommandSubscription(): void {
    this.stopCommandSubscription();
    this.startCommandSubscription();
  }

  async cleanup(): Promise<void> {
    console.log(chalk.blue("\n🧹 Cleaning up..."));

    this.isShuttingDown = true;
    this.stopHeartbeat();
    this.stopCommandSubscription();

    // Set up force-exit timeout (5 seconds)
    const forceExitTimeout = setTimeout(() => {
      console.log(chalk.yellow("⚠️  Force exiting after 5 second timeout..."));
      process.exit(1);
    }, 5000);

    try {
      if (this.connectionId) {
        try {
          await (this.convex as any).mutation(api.localSandbox.disconnect, {
            token: this.config.token,
            connectionId: this.connectionId,
          });
          console.log(chalk.green("✓ Disconnected"));
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(chalk.yellow(`⚠️  Failed to disconnect: ${message}`));
        }
      }

      if (this.containerId) {
        if (this.config.persist) {
          console.log(
            chalk.green(`✓ Container preserved: ${this.getContainerName()}`),
          );
          console.log(
            chalk.gray(
              "  (Use --persist again to reuse it, or docker rm to remove)",
            ),
          );
        } else {
          const result = await runShellCommand(
            `docker rm -f ${this.containerId}`,
            {
              timeout: 3000,
            },
          );
          if (result.exitCode === 0) {
            console.log(chalk.green("✓ Container removed"));
          } else {
            console.error(
              chalk.red("Error removing container:"),
              result.stderr,
            );
          }
        }
      }

      // Close the Convex client to clean up WebSocket connection
      await this.convex.close();
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
  --dangerous         Run commands directly on host OS (no Docker)
  --persist           Keep container running on exit and reuse if exists
  --convex-url URL    Override Convex backend URL (for development)
  --help, -h          Show this help message

${chalk.yellow("Examples:")}
  # Basic usage - pulls pre-built image with 30+ pentesting tools
  npx @hackerai/local --token hsb_abc123 --name "My Laptop"

  # Persistent container (faster restarts, preserves installed packages)
  npx @hackerai/local --token hsb_abc123 --name "Dev" --persist

  # Dangerous mode (no Docker isolation) - use with caution!
  npx @hackerai/local --token hsb_abc123 --name "Work PC" --dangerous

${chalk.cyan("Pre-built Image:")}
  The default image includes: nmap, sqlmap, ffuf, gobuster, nuclei, hydra,
  nikto, wpscan, subfinder, httpx, and 20+ more pentesting tools.

${chalk.red("⚠️  Security Warning:")}
  Docker mode provides process isolation but uses --network host for direct
  network access (required for pentesting tools to scan network services).
  In DANGEROUS mode, commands run directly on your OS without any isolation.

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
  dangerous: hasFlag("--dangerous"),
  build: hasFlag("--build"),
  persist: hasFlag("--persist"),
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
