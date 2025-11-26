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

import { ConvexHttpClient } from "convex/browser";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import os from "os";

const execAsync = promisify(exec);

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
  private convex: ConvexHttpClient;
  private containerId?: string;
  private userId?: string;
  private connectionId?: string;
  private heartbeatInterval?: NodeJS.Timeout;
  private pollInterval?: NodeJS.Timeout;
  private isShuttingDown = false;

  constructor(private config: Config) {
    this.convex = new ConvexHttpClient(config.convexUrl);
  }

  async start(): Promise<void> {
    console.log(chalk.blue("🚀 Starting HackerAI local sandbox..."));

    if (!this.config.dangerous) {
      try {
        await execAsync("docker --version");
        console.log(chalk.green("✓ Docker is available"));
      } catch {
        console.error(
          chalk.red(
            "❌ Docker not found. Please install Docker or use --dangerous mode.",
          ),
        );
        process.exit(1);
      }

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
    const { stdout } = await execAsync(
      `docker run -d --network host ${this.config.image} tail -f /dev/null`,
    );

    return stdout.trim();
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (this.convex as any).mutation(
        api.localSandbox.connect,
        {
          token: this.config.token,
          connectionName: this.config.name,
          containerId: this.containerId,
          clientVersion: "1.0.0",
          mode: this.config.dangerous ? "dangerous" : "docker",
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
      console.log(
        chalk.gray(`Mode: ${this.config.dangerous ? "DANGEROUS" : "Docker"}`),
      );

      this.startHeartbeat();
      this.startPolling();
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

  private startPolling(): void {
    this.pollInterval = setInterval(async () => {
      if (this.isShuttingDown || !this.connectionId) return;

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await (this.convex as any).query(
          api.localSandbox.getPendingCommands,
          {
            connectionId: this.connectionId,
          },
        )) as PendingCommandsResult;

        if (data?.commands && data.commands.length > 0) {
          for (const cmd of data.commands) {
            await this.executeCommand(cmd);
          }
        }
      } catch {
        // Ignore polling errors
      }
    }, 500);
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
          commandId: command_id,
        },
      );

      let fullCommand = command;

      if (cwd && cwd.trim() !== "") {
        fullCommand = `cd "${cwd}" 2>/dev/null && ${fullCommand}`;
      }

      if (env) {
        const envString = Object.entries(env)
          .map(([k, v]) => `export ${k}="${v}"`)
          .join("; ");
        fullCommand = `${envString}; ${fullCommand}`;
      }

      let result: { stdout: string; stderr: string; code?: number };

      if (this.config.dangerous) {
        result = await execAsync(fullCommand, {
          timeout: timeout ?? 30000,
          shell: "/bin/bash",
        }).catch(
          (error: {
            stdout?: string;
            stderr?: string;
            message?: string;
            code?: number;
          }) => ({
            stdout: error.stdout || "",
            stderr: error.stderr || error.message || "",
            code: error.code || 1,
          }),
        );
      } else {
        const escapedCommand = fullCommand.replace(/"/g, '\\"');
        result = await execAsync(
          `docker exec ${this.containerId} bash -c "${escapedCommand}"`,
          { timeout: timeout ?? 30000 },
        ).catch(
          (error: {
            stdout?: string;
            stderr?: string;
            message?: string;
            code?: number;
          }) => ({
            stdout: error.stdout || "",
            stderr: error.stderr || error.message || "",
            code: error.code || 1,
          }),
        );
      }

      const duration = Date.now() - startTime;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.convex as any).mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        userId: this.userId!,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.code || 0,
        duration,
      });

      console.log(chalk.green(`✓ Command completed in ${duration}ms`));
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.convex as any).mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        userId: this.userId!,
        stdout: "",
        stderr: message,
        exitCode: 1,
        duration,
      });

      console.log(chalk.red(`✗ Command failed: ${message}`));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      if (this.connectionId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (await (this.convex as any).mutation(
            api.localSandbox.heartbeat,
            {
              connectionId: this.connectionId,
            },
          )) as HeartbeatResult;

          if (!result.success) {
            console.log(
              chalk.yellow("⚠️  Heartbeat failed, connection may be stale"),
            );
          }
        } catch {
          // Ignore heartbeat errors
        }
      }
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  async cleanup(): Promise<void> {
    console.log(chalk.blue("\n🧹 Cleaning up..."));

    this.isShuttingDown = true;
    this.stopHeartbeat();
    this.stopPolling();

    if (this.connectionId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.convex as any).mutation(api.localSandbox.disconnect, {
          connectionId: this.connectionId,
        });
        console.log(chalk.green("✓ Disconnected"));
      } catch {
        // Ignore disconnect errors
      }
    }

    if (this.containerId) {
      try {
        await execAsync(`docker rm -f ${this.containerId}`);
        console.log(chalk.green("✓ Container removed"));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red("Error removing container:"), message);
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
  In Docker mode, commands run in an isolated container with --network host.
  In DANGEROUS mode, commands run directly on your OS without isolation.
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
  console.error(
    chalk.yellow("Get your token from HackerAI Settings > Local Sandbox"),
  );
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
