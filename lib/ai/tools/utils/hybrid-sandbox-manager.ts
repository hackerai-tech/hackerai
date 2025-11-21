import type { Sandbox } from "@e2b/code-interpreter";
import type { SandboxManager } from "@/types";
import { ensureSandboxConnection } from "./sandbox";
import { LocalDockerSandbox } from "./local-docker-sandbox";
import { queueCommand, getCommandResult } from "@/app/api/local-sandbox/route";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

/**
 * Hybrid sandbox manager that switches between E2B and local Docker
 * based on user preference
 */
export class HybridSandboxManager implements SandboxManager {
  private e2bSandbox: Sandbox | null = null;
  private localSandbox: LocalDockerSandbox | null = null;
  private useLocal: boolean = false;

  constructor(
    private userID: string,
    private setSandboxCallback: (sandbox: Sandbox) => void,
    initialSandbox?: Sandbox | null,
  ) {
    this.e2bSandbox = initialSandbox || null;

    // Check if user has local sandbox connected
    this.checkLocalConnection();
  }

  /**
   * Check if local sandbox is connected and update mode
   */
  private async checkLocalConnection(): Promise<void> {
    try {
      console.log(`[HybridSandbox] Checking local connection for user ${this.userID}`);
      const status = await fetchMutation(api.localSandbox.getConnectionStatus, {
        userId: this.userID
      });

      console.log(`[HybridSandbox] Connection status result:`, status);

      this.useLocal = status?.connected === true;

      if (this.useLocal) {
        console.log(`[HybridSandbox] ✓ Local sandbox detected for user ${this.userID}, mode: ${status.mode}`);
      } else {
        console.log(`[HybridSandbox] ✗ No local sandbox connected for user ${this.userID}`);
      }
    } catch (error) {
      console.error('[HybridSandbox] Failed to check local connection:', error);
      this.useLocal = false;
    }
  }

  async getSandbox(): Promise<{ sandbox: Sandbox }> {
    // Refresh local connection status
    await this.checkLocalConnection();

    if (this.useLocal) {
      console.log('[HybridSandbox] Using local sandbox');
      return this.getLocalSandbox();
    } else {
      console.log('[HybridSandbox] Using E2B sandbox');
      return this.getE2BSandbox();
    }
  }

  /**
   * Get E2B sandbox
   */
  private async getE2BSandbox(): Promise<{ sandbox: Sandbox }> {
    if (!this.e2bSandbox) {
      const result = await ensureSandboxConnection(
        {
          userID: this.userID,
          setSandbox: this.setSandboxCallback,
        },
        {
          initialSandbox: this.e2bSandbox,
        },
      );
      this.e2bSandbox = result.sandbox;
    }

    if (!this.e2bSandbox) {
      throw new Error("Failed to initialize E2B sandbox");
    }

    return { sandbox: this.e2bSandbox };
  }

  /**
   * Get local Docker sandbox (wrapped to match E2B interface)
   */
  private async getLocalSandbox(): Promise<{ sandbox: Sandbox }> {
    if (!this.localSandbox) {
      this.localSandbox = new LocalDockerSandbox();
    }

    // Wrap local sandbox to match E2B interface
    const wrappedSandbox = this.wrapLocalSandbox(this.localSandbox);
    console.log(`[HybridSandbox] Returning wrapped local sandbox`);
    return { sandbox: wrappedSandbox as Sandbox };
  }

  /**
   * Wrap local sandbox to provide E2B-compatible interface
   */
  private wrapLocalSandbox(localSandbox: LocalDockerSandbox): Partial<Sandbox> {
    const userID = this.userID;

    const runCommand = async (command: string, options: any = {}) => {
      const requestId = Math.random().toString(36).substring(7);
      const timestamp = new Date().toISOString();

      console.log(`[${timestamp}] [LocalSandbox] Queueing command for user ${userID}:`);
      console.log(`  Request ID: ${requestId}`);
      console.log(`  Command: ${command.substring(0, 200)}${command.length > 200 ? '...' : ''}`);

      // Queue command for local client to pick up
      queueCommand(userID, {
        id: requestId,
        command,
        options,
      });

      // Poll for result
      return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const timeout = setTimeout(() => {
          const duration = Date.now() - startTime;
          console.error(`[${new Date().toISOString()}] [LocalSandbox] Command timeout after ${duration}ms (Request ID: ${requestId})`);
          reject(new Error("Command timeout"));
        }, options.timeoutMs || 15 * 60 * 1000);

        const pollInterval = setInterval(() => {
          const result = getCommandResult(requestId);
          if (result) {
            clearInterval(pollInterval);
            clearTimeout(timeout);

            const duration = Date.now() - startTime;
            console.log(`[${new Date().toISOString()}] [LocalSandbox] Command completed in ${duration}ms (Request ID: ${requestId})`);
            console.log(`  Exit code: ${result.exitCode}`);
            if (result.stdout) {
              console.log(`  STDOUT: ${result.stdout.length} bytes`);
            }
            if (result.stderr) {
              console.log(`  STDERR: ${result.stderr.length} bytes`);
            }

            if (result.error) {
              reject(new Error(result.error));
            } else {
              resolve({
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
              } as any);
            }
          }
        }, 500); // Poll every 500ms
      });
    };

    return {
      commands: {
        run: runCommand,
      },
      getHost: (port: number) => {
        return localSandbox.getHost(port);
      },
      files: {
        read: async (path: string, options?: any) => {
          console.log(`[${new Date().toISOString()}] [LocalSandbox] Reading file: ${path}`);
          // Use cat command to read file
          const result = await runCommand(`cat "${path}"`, options) as { stdout: string; stderr: string; exitCode: number };
          return result.stdout;
        },
        write: async (path: string, content: string, options?: any) => {
          console.log(`[${new Date().toISOString()}] [LocalSandbox] Writing file: ${path} (${content.length} bytes)`);
          // Use cat with heredoc to write file
          await runCommand(`cat > "${path}" << 'EOF'\n${content}\nEOF`, options);
        },
      } as any,
      // Add missing E2B methods
      isRunning: async () => {
        console.log(`[${new Date().toISOString()}] [LocalSandbox] isRunning check`);
        return true; // Local sandbox is always "running" when connected
      },
      setTimeout: (timeout: number) => {
        console.log(`[${new Date().toISOString()}] [LocalSandbox] setTimeout called with ${timeout}ms`);
        // No-op for local sandbox
      },
      close: async () => {
        console.log(`[${new Date().toISOString()}] [LocalSandbox] close called`);
        // No-op for local sandbox - client manages container lifecycle
      },
    } as any as Sandbox;
  }

  setSandbox(sandbox: Sandbox): void {
    this.e2bSandbox = sandbox;
    this.setSandboxCallback(sandbox);
  }

  /**
   * Force switch to local mode
   */
  enableLocalMode(): void {
    this.useLocal = true;
  }

  /**
   * Force switch to E2B mode
   */
  disableLocalMode(): void {
    this.useLocal = false;
  }

  /**
   * Check current mode
   */
  isUsingLocal(): boolean {
    return this.useLocal;
  }
}
