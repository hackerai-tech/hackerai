#!/usr/bin/env node

/**
 * HackerAI Local Sandbox Client
 *
 * Connects to HackerAI backend via Convex and executes commands
 * on the local machine (either in Docker or directly on the host OS).
 *
 * Usage:
 *   npx @hackerai/local --token TOKEN --name "My Laptop"
 *   npx @hackerai/local --token TOKEN --name "Kali" --image kalilinux/kali-rolling
 *   npx @hackerai/local --token TOKEN --name "Work PC" --dangerous
 */

import { ConvexClient } from "convex/browser";
import { spawn, ChildProcess } from "child_process";
import os from "os";

// Align with LLM context limits: ~2048 tokens ≈ 6000 chars
const MAX_OUTPUT_SIZE = 6000;

// Truncation marker for 25% head + 75% tail strategy
const TRUNCATION_MARKER =
  "\n\n[... OUTPUT TRUNCATED - middle content removed to fit context limits ...]\n\n";

/**
 * Truncates output using 25% head + 75% tail strategy.
 * This preserves both the command start (context) and the end (final results/errors).
 */
function truncateOutput(content: string, maxSize: number = MAX_OUTPUT_SIZE): string {
  if (content.length <= maxSize) return content;

  const markerLength = TRUNCATION_MARKER.length;
  const budgetForContent = maxSize - markerLength;

  // 25% head + 75% tail strategy
  const headBudget = Math.floor(budgetForContent * 0.25);
  const tailBudget = budgetForContent - headBudget;

  const head = content.slice(0, headBudget);
  const tail = content.slice(-tailBudget);

  return head + TRUNCATION_MARKER + tail;
}

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
    maxOutputSize?: number;
  } = {},
): Promise<ShellCommandResult> {
  const { timeout = 30000, shell = "/bin/bash", maxOutputSize = MAX_OUTPUT_SIZE } = options;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const proc: ChildProcess = spawn(shell, ["-c", command], {
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
const DEFAULT_IMAGE = "hackeraidev/sandbox";

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
  image: string;
  dangerous: boolean;
  build: boolean;
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
}

interface ConnectResult {
  success: boolean;
  userId?: string;
  connectionId?: string;
  error?: string;
}

interface HeartbeatResult {
  success: boolean;
  error?: string;
}

interface PendingCommandsResult {
  commands: Command[];
}

class LocalSandboxClient {
  private convex: ConvexClient;
  private containerId?: string;
  private userId?: string;
  private connectionId?: string;
  private heartbeatInterval?: NodeJS.Timeout;
  private commandSubscription?: () => void;
  private isShuttingDown = false;

  constructor(private config: Config) {
    this.convex = new ConvexClient(config.convexUrl);
  }

  async start(): Promise<void> {
    console.log(chalk.blue("🚀 Starting HackerAI local sandbox..."));

    if (!this.config.dangerous) {
      const dockerCheck = await runShellCommand("docker --version", { timeout: 5000 });
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
    } else {
      console.log(
        chalk.yellow(
          "⚠️  DANGEROUS MODE - Commands will run directly on your OS!",
        ),
      );
    }

    await this.connect();
  }

  private async createContainer(): Promise<string> {
    const image = this.config.image;
    const isDefaultImage = image === DEFAULT_IMAGE;

    if (this.config.build) {
      console.log(
        chalk.red("❌ --build flag is not supported in the npx package."),
      );
      console.log(
        chalk.yellow("Use the pre-built image or specify a custom --image."),
      );
      process.exit(1);
    } else if (isDefaultImage) {
      console.log(chalk.blue(`Pulling pre-built image: ${image}`));
      console.log(
        chalk.gray("(First run may take a few minutes to download the image)"),
      );
      console.log("");
      try {
        await runWithOutput("docker", ["pull", image]);
        console.log(chalk.green("✓ Image ready"));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red("❌ Failed to pull image:"), message);
        process.exit(1);
      }
    }

    console.log(chalk.blue("Creating Docker container..."));
    const result = await runShellCommand(
      `docker run -d --network host ${this.config.image} tail -f /dev/null`,
      { timeout: 60000 },
    );

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

  private getMode(): "docker" | "dangerous" | "custom" {
    if (this.config.dangerous) {
      return "dangerous";
    }
    if (this.config.image !== DEFAULT_IMAGE) {
      return "custom";
    }
    return "docker";
  }

  private getModeDisplay(): string {
    const mode = this.getMode();
    if (mode === "dangerous") {
      return "DANGEROUS";
    }
    if (mode === "custom") {
      return `Custom (${this.config.image})`;
    }
    return "Docker";
  }

  private async connect(): Promise<void> {
    console.log(chalk.blue("Connecting to HackerAI..."));

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (this.convex as any).mutation(
        api.localSandbox.connect,
        {
          token: this.config.token,
          connectionName: this.config.name,
          containerId: this.containerId,
          clientVersion: "1.0.0",
          mode: this.getMode(),
          imageName: this.config.dangerous ? undefined : this.config.image,
          osInfo: this.config.dangerous ? this.getOsInfo() : undefined,
        },
      )) as ConnectResult;

      if (!result.success) {
        throw new Error(result.error || "Authentication failed");
      }

      this.userId = result.userId;
      this.connectionId = result.connectionId;

      console.log(chalk.green("✓ Authenticated"));
      console.log(chalk.bold(chalk.green("🎉 Local sandbox is ready!")));
      console.log(chalk.gray(`Connection: ${this.connectionId}`));
      console.log(chalk.gray(`Mode: ${this.getModeDisplay()}`));

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
    if (!this.connectionId) return;

    // Use Convex subscription for real-time command updates
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.commandSubscription = (this.convex as any).onUpdate(
      api.localSandbox.getPendingCommands,
      {
        connectionId: this.connectionId,
      },
      async (data: PendingCommandsResult) => {
        if (this.isShuttingDown || !data?.commands) return;

        for (const cmd of data.commands) {
          await this.executeCommand(cmd);
        }
      },
    );
  }

  private async executeCommand(cmd: Command): Promise<void> {
    const { command_id, command, env, cwd, timeout } = cmd;
    const startTime = Date.now();

    console.log(chalk.cyan(`▶ Executing: ${command}`));

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      let result: ShellCommandResult;

      if (this.config.dangerous) {
        result = await runShellCommand(fullCommand, {
          timeout: timeout ?? 30000,
          shell: "/bin/bash",
        });
      } else {
        // Use single quotes to prevent host shell from interpreting $(), backticks, etc.
        // This ensures ALL command execution happens inside the Docker container
        const escapedCommand = fullCommand.replace(/'/g, "'\\''");
        result = await runShellCommand(
          `docker exec ${this.containerId} bash -c '${escapedCommand}'`,
          { timeout: timeout ?? 30000 },
        );
      }

      const duration = Date.now() - startTime;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.convex as any).mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        token: this.config.token,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration,
      });

      console.log(chalk.green(`✓ Command completed in ${duration}ms`));
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.convex as any).mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        token: this.config.token,
        stdout: "",
        stderr: truncateOutput(message),
        exitCode: 1,
        duration,
      });

      console.log(chalk.red(`✗ Command failed: ${message}`));
    }
  }

  private scheduleNextHeartbeat(): void {
    // Add jitter (±5s) to prevent thundering herd when multiple clients connect
    const baseInterval = 30000;
    const jitter = Math.floor(Math.random() * 10000) - 5000; // -5000 to +5000
    const interval = baseInterval + jitter;

    this.heartbeatInterval = setTimeout(async () => {
      if (this.connectionId && !this.isShuttingDown) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        } catch {
          // Ignore transient heartbeat errors
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (this.convex as any).mutation(api.localSandbox.disconnect, {
            token: this.config.token,
            connectionId: this.connectionId,
          });
          console.log(chalk.green("✓ Disconnected"));
        } catch {
          // Ignore disconnect errors
        }
      }

      if (this.containerId) {
        const result = await runShellCommand(`docker rm -f ${this.containerId}`, {
          timeout: 3000,
        });
        if (result.exitCode === 0) {
          console.log(chalk.green("✓ Container removed"));
        } else {
          console.error(chalk.red("Error removing container:"), result.stderr);
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
  --image IMAGE       Docker image to use (default: pre-built HackerAI sandbox)
  --dangerous         Run commands directly on host OS (no Docker)
  --convex-url URL    Override Convex backend URL (for development)
  --help, -h          Show this help message

${chalk.yellow("Examples:")}
  # Basic usage - pulls pre-built image with 30+ pentesting tools
  npx @hackerai/local --token hsb_abc123 --name "My Laptop"

  # Use a custom Docker image (e.g., Kali Linux)
  npx @hackerai/local --token hsb_abc123 --name "Kali" --image kalilinux/kali-rolling

  # Dangerous mode (no Docker isolation) - use with caution!
  npx @hackerai/local --token hsb_abc123 --name "Work PC" --dangerous

${chalk.cyan("Pre-built Image:")}
  The default image includes: nmap, sqlmap, ffuf, gobuster, nuclei, hydra,
  nikto, wpscan, subfinder, httpx, and 20+ more pentesting tools.

${chalk.red("⚠️  Security Warning:")}
  Docker mode provides process isolation but uses --network host for direct
  network access (required for pentesting tools to scan network services).
  In DANGEROUS mode, commands run directly on your OS without any isolation.
`);
  process.exit(0);
}

const config: Config = {
  convexUrl: getArg("--convex-url") || PRODUCTION_CONVEX_URL,
  token: getArg("--token") || "",
  name: getArg("--name") || os.hostname(),
  image: getArg("--image") || DEFAULT_IMAGE,
  dangerous: hasFlag("--dangerous"),
  build: hasFlag("--build"),
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
