#!/usr/bin/env node

/**
 * HackerAI Local Sandbox Client
 *
 * Connects to HackerAI backend via Convex and executes commands
 * on the local machine (either in Docker or directly on the host OS).
 *
 * Usage:
 *   npx hackerai-local --token TOKEN --name "My Laptop"
 *   npx hackerai-local --token TOKEN --name "Kali" --image kalilinux/kali-rolling
 *   npx hackerai-local --token TOKEN --name "Work PC" --dangerous
 */

import { config as dotenvConfig } from "dotenv";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";

// Load environment variables from .env.local
dotenvConfig({ path: path.resolve(process.cwd(), ".env.local") });
dotenvConfig({ path: path.resolve(process.cwd(), ".env") });

const execAsync = promisify(exec);

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

// API types (matching Convex functions)
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
      // Check Docker
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

      // Create container
      this.containerId = await this.createContainer();
      console.log(chalk.green(`✓ Container: ${this.containerId.slice(0, 12)}`));
    } else {
      console.log(
        chalk.yellow(
          "⚠️  DANGEROUS MODE - Commands will run directly on your OS!",
        ),
      );
    }

    // Connect to Convex
    await this.connect();
  }

  private async createContainer(): Promise<string> {
    console.log(chalk.blue("Creating Docker container..."));

    const { stdout } = await execAsync(
      `docker run -d --network host ${this.config.image} tail -f /dev/null`,
    );

    const containerId = stdout.trim();

    // Install common tools (suppress errors for images that already have them)
    console.log(chalk.blue("Installing tools..."));
    try {
    } catch {
      // Ignore errors - some images may not have package managers
    }

    return containerId;
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
    console.log(chalk.blue("Connecting to Convex..."));

    try {
      const result = (await this.convex.mutation(api.localSandbox.connect, {
        token: this.config.token,
        connectionName: this.config.name,
        containerId: this.containerId,
        clientVersion: "1.0.0",
        mode: this.config.dangerous ? ("dangerous" as const) : ("docker" as const),
        osInfo: this.config.dangerous ? this.getOsInfo() : undefined,
      })) as ConnectResult;

      if (!result.success) {
        throw new Error(result.error || "Authentication failed");
      }

      this.userId = result.userId;
      this.connectionId = result.connectionId;

      console.log(chalk.green("✓ Authenticated"));
      console.log(chalk.bold(chalk.green("🎉 Local sandbox is ready!")));
      console.log(chalk.gray(`User ID: ${this.userId}`));
      console.log(chalk.gray(`Connection ID: ${this.connectionId}`));
      console.log(
        chalk.gray(`Mode: ${this.config.dangerous ? "DANGEROUS" : "Docker"}`),
      );

      // Start heartbeat
      this.startHeartbeat();

      // Start polling for commands
      this.startPolling();
    } catch (error: any) {
      const errorMessage = error?.data?.message || error?.message || JSON.stringify(error);
      console.error(chalk.red("❌ Connection failed:"), errorMessage);
      if (errorMessage.includes("Invalid token") || errorMessage.includes("token")) {
        console.error(chalk.yellow("Please regenerate your token in Settings"));
      } else {
        console.error(chalk.yellow("Error details:"), error);
      }
      await this.cleanup();
      process.exit(1);
    }
  }

  private startPolling(): void {
    // Poll for commands every 500ms
    this.pollInterval = setInterval(async () => {
      if (this.isShuttingDown || !this.connectionId) return;

      try {
        const data = (await this.convex.query(
          api.localSandbox.getPendingCommands,
          {
            connectionId: this.connectionId,
          },
        )) as PendingCommandsResult;

        if (data?.commands && data.commands.length > 0) {
          // Execute all pending commands
          for (const cmd of data.commands) {
            await this.executeCommand(cmd);
          }
        }
      } catch (error) {
        // Ignore polling errors (connection might be temporarily unavailable)
      }
    }, 500);
  }

  private async executeCommand(cmd: Command): Promise<void> {
    const { command_id, command, env, cwd, timeout } = cmd;
    const startTime = Date.now();

    console.log(chalk.cyan(`▶ Executing: ${command}`));

    try {
      // Mark as executing

      await this.convex.mutation(api.localSandbox.markCommandExecuting, {
        commandId: command_id,
      });

      // Build command with env vars and cwd
      let fullCommand = command;

      if (cwd) {
        fullCommand = `cd ${cwd} && ${fullCommand}`;
      }

      if (env) {
        const envString = Object.entries(env)
          .map(([k, v]) => `export ${k}="${v}"`)
          .join("; ");
        fullCommand = `${envString}; ${fullCommand}`;
      }

      let result: { stdout: string; stderr: string; code?: number };

      if (this.config.dangerous) {
        // Execute directly on host
        result = await execAsync(fullCommand, {
          timeout: timeout ?? 30000,
          shell: "/bin/bash",
        }).catch((error) => ({
          stdout: error.stdout || "",
          stderr: error.stderr || error.message,
          code: error.code || 1,
        }));
      } else {
        // Execute in Docker container
        const escapedCommand = fullCommand.replace(/"/g, '\\"');
        result = await execAsync(
          `docker exec ${this.containerId} bash -c "${escapedCommand}"`,
          { timeout: timeout ?? 30000 },
        ).catch((error) => ({
          stdout: error.stdout || "",
          stderr: error.stderr || error.message,
          code: error.code || 1,
        }));
      }

      const duration = Date.now() - startTime;

      // Submit result

      await this.convex.mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        userId: this.userId!,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.code || 0,
        duration,
      });

      console.log(chalk.green(`✓ Command completed in ${duration}ms`));
    } catch (error: any) {
      const duration = Date.now() - startTime;

      await this.convex.mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        userId: this.userId!,
        stdout: "",
        stderr: error.message,
        exitCode: 1,
        duration,
      });

      console.log(chalk.red(`✗ Command failed: ${error.message}`));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      if (this.connectionId) {
        try {
          const result = (await this.convex.mutation(
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
        } catch (error) {
          // Ignore heartbeat errors
        }
      }
    }, 10000); // Every 10 seconds
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
        await this.convex.mutation(api.localSandbox.disconnect, {
          connectionId: this.connectionId,
        });
        console.log(chalk.green("✓ Disconnected from Convex"));
      } catch (error) {
        // Ignore disconnect errors
      }
    }

    if (this.containerId) {
      try {
        await execAsync(`docker rm -f ${this.containerId}`);
        console.log(chalk.green("✓ Container removed"));
      } catch (error) {
        console.error(chalk.red("Error removing container:"), error);
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
  npx hackerai-local --token TOKEN [options]

${chalk.yellow("Options:")}
  --token TOKEN       Authentication token from Settings (required)
  --name NAME         Connection name (default: hostname)
  --image IMAGE       Docker image to use (default: ubuntu:latest)
  --dangerous         Run commands directly on host OS (no Docker)
  --convex-url URL    Convex backend URL
  --help, -h          Show this help message

${chalk.yellow("Examples:")}
  # Basic usage (Docker mode)
  npx hackerai-local --token hsb_abc123 --name "My Laptop"

  # Custom Docker image
  npx hackerai-local --token hsb_abc123 --name "Kali" --image kalilinux/kali-rolling

  # Dangerous mode (no Docker isolation)
  npx hackerai-local --token hsb_abc123 --name "Work PC" --dangerous

${chalk.red("⚠️  Security Warning:")}
  In Docker mode, commands run in an isolated container with --network host.
  In DANGEROUS mode, commands run directly on your OS without isolation.
`);
  process.exit(0);
}

const config: Config = {
  convexUrl:
    getArg("--convex-url") ||
    process.env.NEXT_PUBLIC_CONVEX_URL ||
    "",
  token: getArg("--token") || process.env.HACKERAI_TOKEN || "",
  name: getArg("--name") || os.hostname(),
  image: getArg("--image") || process.env.DOCKER_IMAGE || "ubuntu:latest",
  dangerous: hasFlag("--dangerous"),
};

if (!config.convexUrl) {
  console.error(chalk.red("❌ No Convex URL found"));
  console.error(chalk.yellow("Set NEXT_PUBLIC_CONVEX_URL in .env.local or use --convex-url"));
  process.exit(1);
}

if (!config.token) {
  console.error(chalk.red("❌ No authentication token provided"));
  console.error(chalk.yellow("Usage: npx hackerai-local --token YOUR_TOKEN"));
  console.error(chalk.yellow("Or set HACKERAI_TOKEN environment variable"));
  process.exit(1);
}

const client = new LocalSandboxClient(config);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log(chalk.yellow("\n🛑 Shutting down..."));
  await client.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await client.cleanup();
  process.exit(0);
});

// Start the client
client.start().catch((error) => {
  console.error(chalk.red("Fatal error:"), error);
  process.exit(1);
});
