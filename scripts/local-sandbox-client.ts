#!/usr/bin/env node

/**
 * Local Sandbox Client
 *
 * This script runs on the user's machine and:
 * 1. Spins up a Docker container as a sandbox
 * 2. Polls the backend for commands to execute
 * 3. Executes commands in the container
 * 4. Sends results back to the backend
 *
 * Usage:
 *   npm run local-sandbox -- --auth-token YOUR_TOKEN
 *   or
 *   node scripts/local-sandbox-client.js --auth-token YOUR_TOKEN
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface Config {
  backendUrl: string;
  authToken: string;
  image: string;
  pollInterval: number;
}

class LocalSandboxClient {
  private containerId: string | null = null;
  private running: boolean = false;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async start(): Promise<void> {
    console.log("🚀 Starting local sandbox client (Docker mode)...");
    console.log("");

    // Check Docker is available
    await this.checkDocker();

    // Create container
    await this.createContainer();

    // Register with backend
    await this.register();

    // Start polling loop
    this.running = true;
    await this.pollLoop();
  }

  private async checkDocker(): Promise<void> {
    try {
      await execAsync("docker --version");
      console.log("✓ Docker is available");
    } catch (error) {
      console.error("✗ Docker is not available. Please install Docker first.");
      process.exit(1);
    }
  }

  private async createContainer(): Promise<void> {
    console.log(`Creating Docker container from ${this.config.image}...`);

    try {
      // Create container with host network access
      const { stdout } = await execAsync(
        `docker run -d --network host --name hackerai-sandbox-${Date.now()} ${this.config.image} tail -f /dev/null`,
      );

      this.containerId = stdout.trim();
      console.log(`✓ Container created: ${this.containerId.substring(0, 12)}`);

      // Install common tools
      await this.execInContainer(
        "apt-get update && apt-get install -y curl wget nmap git python3 python3-pip",
      );
      console.log("✓ Common tools installed");
    } catch (error) {
      console.error("✗ Failed to create container:", error);
      process.exit(1);
    }
  }

  private async register(): Promise<void> {
    try {
      const response = await fetch(`${this.config.backendUrl}/api/local-sandbox`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({
          type: "connect",
          data: {
            containerId: this.containerId,
            mode: "docker",
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const result = await response.json();

      console.log("✓ Connected to backend");

      if (result.disconnectedOld) {
        console.log("");
        console.log("⚠️  Previous connection was disconnected");
        console.log("   Only one sandbox can be connected at a time");
        console.log("");
      }

      console.log("🎉 Local sandbox is ready!");
      console.log("\nYou can now use local mode in the UI.");
    } catch (error) {
      console.error("✗ Failed to register with backend:", error);
      await this.cleanup();
      process.exit(1);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const response = await fetch(`${this.config.backendUrl}/api/local-sandbox`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.authToken}`,
          },
          body: JSON.stringify({ type: "poll" }),
        });

        if (response.ok) {
          const { commands } = await response.json();

          for (const cmd of commands) {
            await this.executeCommand(cmd);
          }
        }
      } catch (error) {
        console.error("Poll error:", error);
      }

      await this.sleep(this.config.pollInterval);
    }
  }

  private async executeCommand(cmd: {
    id: string;
    command: string;
    options: any;
  }): Promise<void> {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`\n[${timestamp}] → Executing command:`);
    console.log(`  ${cmd.command}`);

    try {
      const startTime = Date.now();
      const result = await this.execInContainer(cmd.command);
      const duration = Date.now() - startTime;

      console.log(`[${new Date().toLocaleTimeString()}] ← Exit code: ${result.exitCode} (${duration}ms)`);

      if (result.stdout) {
        console.log(`  STDOUT (${result.stdout.length} bytes):`);
        const lines = result.stdout.split('\n').slice(0, 10);
        lines.forEach(line => console.log(`    ${line}`));
        if (result.stdout.split('\n').length > 10) {
          console.log(`    ... (${result.stdout.split('\n').length - 10} more lines)`);
        }
      }

      if (result.stderr) {
        console.log(`  STDERR (${result.stderr.length} bytes):`);
        const lines = result.stderr.split('\n').slice(0, 10);
        lines.forEach(line => console.log(`    ${line}`));
        if (result.stderr.split('\n').length > 10) {
          console.log(`    ... (${result.stderr.split('\n').length - 10} more lines)`);
        }
      }

      // Send result back
      await fetch(`${this.config.backendUrl}/api/local-sandbox`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({
          type: "result",
          data: {
            requestId: cmd.id,
            result: {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            },
          },
        }),
      });
    } catch (error: any) {
      console.error(`[${new Date().toLocaleTimeString()}] ← Error: ${error.message}`);

      await fetch(`${this.config.backendUrl}/api/local-sandbox`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({
          type: "result",
          data: {
            requestId: cmd.id,
            result: {
              exitCode: 1,
              stdout: "",
              stderr: error.message,
              error: error.message,
            },
          },
        }),
      });
    }
  }

  private async execInContainer(command: string): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    try {
      // Execute in Docker container
      const { stdout, stderr } = await execAsync(
        `docker exec ${this.containerId} bash -c ${JSON.stringify(command)}`,
      );

      return {
        exitCode: 0,
        stdout,
        stderr,
      };
    } catch (error: any) {
      return {
        exitCode: error.code || 1,
        stdout: error.stdout || "",
        stderr: error.stderr || error.message,
      };
    }
  }

  private async cleanup(): Promise<void> {
    console.log("\n🛑 Shutting down...");

    this.running = false;

    if (this.containerId) {
      try {
        await execAsync(`docker rm -f ${this.containerId}`);
        console.log("✓ Container removed");
      } catch (error) {
        console.error("✗ Failed to remove container:", error);
      }
    }

    try {
      await fetch(`${this.config.backendUrl}/api/local-sandbox`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({ type: "disconnect" }),
      });
    } catch {
      // Ignore errors during disconnect
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.cleanup();
  }
}

// Parse command line arguments
function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    backendUrl: process.env.BACKEND_URL || "http://localhost:3000",
    authToken: "",
    image: "ubuntu:latest",
    pollInterval: 1000, // 1 second
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--auth-token":
        config.authToken = args[++i];
        break;
      case "--backend-url":
        config.backendUrl = args[++i];
        break;
      case "--image":
        config.image = args[++i];
        break;
      case "--help":
        console.log(`
Local Sandbox Client

Usage:
  npm run local-sandbox -- --auth-token YOUR_TOKEN

Options:
  --auth-token TOKEN    Authentication token (required)
  --backend-url URL     Backend URL (default: http://localhost:3000)
  --image NAME          Docker image (default: ubuntu:latest)
  --help                Show this help message

Example:
  npm run local-sandbox -- --auth-token YOUR_TOKEN

Environment Variables:
  BACKEND_URL          Same as --backend-url
  AUTH_TOKEN           Same as --auth-token
        `);
        process.exit(0);
    }
  }

  if (!config.authToken && process.env.AUTH_TOKEN) {
    config.authToken = process.env.AUTH_TOKEN;
  }

  if (!config.authToken) {
    console.error("Error: --auth-token is required\n");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  // Debug output
  console.log("=== Configuration ===");
  console.log(`Backend URL: ${config.backendUrl}`);
  console.log(`Docker Image: ${config.image}`);
  console.log("====================\n");

  return config;
}

// Main
if (require.main === module) {
  const config = parseArgs();
  const client = new LocalSandboxClient(config);

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n"); // New line after ^C
    await client.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await client.stop();
    process.exit(0);
  });

  client.start().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { LocalSandboxClient };
