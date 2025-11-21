#!/usr/bin/env node

/**
 * Local Sandbox Client - Direct Mode (No Docker)
 *
 * ⚠️ WARNING: This mode runs commands DIRECTLY on your machine without isolation!
 * Only use this if you fully trust the AI and understand the security implications.
 *
 * This script runs on the user's machine and:
 * 1. Polls the backend for commands to execute
 * 2. Executes commands directly in the shell (NO DOCKER)
 * 3. Sends results back to the backend
 *
 * Usage:
 *   npm run local-sandbox -- --auth-token YOUR_TOKEN --no-docker
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as path from "path";

const execAsync = promisify(exec);

interface Config {
  backendUrl: string;
  authToken: string;
  pollInterval: number;
  workingDir: string;
}

class DirectSandboxClient {
  private running: boolean = false;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async start(): Promise<void> {
    console.log("🚀 Starting local sandbox client (DIRECT MODE - NO DOCKER)...");
    console.log("");
    console.log("⚠️  WARNING: Commands will execute DIRECTLY on your machine!");
    console.log("   - No isolation or sandboxing");
    console.log("   - Full access to your filesystem");
    console.log("   - Can modify/delete any files");
    console.log("   - Only use if you fully trust the AI");
    console.log("");

    // Register with backend
    await this.register();

    // Start polling loop
    this.running = true;
    await this.pollLoop();
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
          data: { containerId: "direct-mode" },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      console.log("✓ Connected to backend");
      console.log("✓ Working directory:", this.config.workingDir);
      console.log("🎉 Direct mode is ready!");
      console.log("\nYou can now use local mode in the UI.");
      console.log("Press Ctrl+C to stop.\n");
    } catch (error) {
      console.error("✗ Failed to register with backend:", error);
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
    console.log(`\n→ Executing: ${cmd.command}`);

    try {
      const { stdout, stderr } = await execAsync(cmd.command, {
        cwd: this.config.workingDir,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: cmd.options?.timeoutMs || 15 * 60 * 1000,
      });

      console.log(`← Exit code: 0`);
      if (stdout) {
        console.log(`   Output: ${stdout.substring(0, 200)}${stdout.length > 200 ? "..." : ""}`);
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
              exitCode: 0,
              stdout,
              stderr,
            },
          },
        }),
      });
    } catch (error: any) {
      const exitCode = error.code || 1;
      console.error(`← Error (exit code ${exitCode}): ${error.message}`);

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
              exitCode,
              stdout: error.stdout || "",
              stderr: error.stderr || error.message,
              error: error.message,
            },
          },
        }),
      });
    }
  }

  private async cleanup(): Promise<void> {
    console.log("\n🛑 Shutting down...");

    this.running = false;

    try {
      await fetch(`${this.config.backendUrl}/api/local-sandbox`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({ type: "disconnect" }),
      });
      console.log("✓ Disconnected from backend");
    } catch {
      // Ignore errors during disconnect
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  stop(): void {
    this.running = false;
  }
}

// Parse command line arguments
function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    backendUrl: process.env.BACKEND_URL || "http://localhost:3000",
    authToken: "",
    pollInterval: 1000, // 1 second
    workingDir: process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--auth-token":
        config.authToken = args[++i];
        break;
      case "--backend-url":
        config.backendUrl = args[++i];
        break;
      case "--working-dir":
        config.workingDir = args[++i];
        break;
      case "--help":
        console.log(`
Local Sandbox Client - Direct Mode (No Docker)

⚠️  WARNING: This mode runs commands DIRECTLY on your machine without isolation!

Usage:
  npm run local-sandbox:direct -- --auth-token YOUR_TOKEN

Options:
  --auth-token TOKEN       Authentication token (required)
  --backend-url URL        Backend URL (default: http://localhost:3000)
  --working-dir DIR        Working directory (default: current directory)
  --help                   Show this help message

Environment Variables:
  BACKEND_URL             Same as --backend-url
  AUTH_TOKEN              Same as --auth-token

Security Notes:
  - Commands run directly on your machine with YOUR user permissions
  - No filesystem isolation - can access/modify ANY file you can
  - No network isolation - full access to your network
  - Only use if you fully trust the AI
  - Consider using Docker mode instead for better security
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

  return config;
}

// Main
if (require.main === module) {
  const config = parseArgs();
  const client = new DirectSandboxClient(config);

  // Handle graceful shutdown
  const shutdown = async () => {
    await client.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  client.start().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { DirectSandboxClient };
