import { EventEmitter } from "events";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OsInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
}

interface ConnectionInfo {
  connectionId: string;
  name: string;
  mode: "docker" | "dangerous";
  osInfo?: OsInfo;
  containerId?: string;
}

/**
 * Convex-based sandbox that implements E2B-compatible interface
 * Uses Convex real-time subscriptions for command execution
 */
export class ConvexSandbox extends EventEmitter {
  private convex: ConvexHttpClient;
  private connectionInfo: ConnectionInfo;

  constructor(
    private userId: string,
    convexUrl: string,
    connectionInfo: ConnectionInfo,
    private serviceKey: string,
  ) {
    super();
    this.convex = new ConvexHttpClient(convexUrl);
    this.connectionInfo = connectionInfo;
  }

  /**
   * Get OS context for AI when in dangerous mode
   */
  getOsContext(): string | null {
    if (this.connectionInfo.mode !== "dangerous" || !this.connectionInfo.osInfo) {
      return null;
    }

    const { platform, arch, release, hostname } = this.connectionInfo.osInfo;
    const platformName =
      platform === "darwin"
        ? "macOS"
        : platform === "win32"
          ? "Windows"
          : platform === "linux"
            ? "Linux"
            : platform;

    return `You are executing commands on ${platformName} ${release} (${arch}) in DANGEROUS MODE.
Commands run directly on the host OS "${hostname}" without Docker isolation. Be careful with:
- File system operations (no sandbox protection)
- Network operations (direct access to host network)
- Process management (can affect host system)`;
  }

  /**
   * Get connection info
   */
  getConnectionInfo(): ConnectionInfo {
    return this.connectionInfo;
  }

  // E2B-compatible interface: commands.run()
  commands = {
    run: async (
      command: string,
      opts?: {
        envVars?: Record<string, string>;
        cwd?: string;
        timeoutMs?: number;
        background?: boolean;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
      },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (opts?.background) {
        throw new Error("Background commands not supported in local sandbox");
      }

      const commandId = crypto.randomUUID();
      const timeout = opts?.timeoutMs ?? 30000;

      // Enqueue command in Convex
      
      await this.convex.mutation(api.localSandbox.enqueueCommand, {
        serviceKey: this.serviceKey,
        userId: this.userId,
        connectionId: this.connectionInfo.connectionId,
        commandId,
        command,
        env: opts?.envVars,
        cwd: opts?.cwd,
        timeout,
      });

      // Wait for result with timeout
      const result = await this.waitForResult(commandId, timeout);

      // Stream output if handlers provided
      if (opts?.onStdout && result.stdout) {
        opts.onStdout(result.stdout);
      }
      if (opts?.onStderr && result.stderr) {
        opts.onStderr(result.stderr);
      }

      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };

  private async waitForResult(
    commandId: string,
    timeout: number,
  ): Promise<CommandResult> {
    const startTime = Date.now();
    const pollInterval = 200; // Poll every 200ms
    const maxWaitTime = timeout + 5000; // Add 5s buffer for network

    while (Date.now() - startTime < maxWaitTime) {
      
      const result = await this.convex.query(api.localSandbox.getResult, {
        serviceKey: this.serviceKey,
        commandId,
      });

      if (result?.found) {
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? 0,
        };
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Command timeout after ${timeout}ms`);
  }

  // E2B-compatible interface: files operations
  files = {
    write: async (path: string, content: string | Buffer): Promise<void> => {
      const contentStr =
        typeof content === "string" ? content : content.toString("base64");

      const command =
        typeof content === "string"
          ? `cat > ${path} <<'HACKERAI_EOF'\n${contentStr}\nHACKERAI_EOF`
          : `echo "${contentStr}" | base64 -d > ${path}`;

      await this.commands.run(command);
    },

    read: async (path: string): Promise<string> => {
      const result = await this.commands.run(`cat ${path}`);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr}`);
      }
      return result.stdout;
    },

    remove: async (path: string): Promise<void> => {
      await this.commands.run(`rm -rf ${path}`);
    },

    list: async (path: string = "/"): Promise<{ name: string }[]> => {
      const result = await this.commands.run(
        `find ${path} -maxdepth 1 -type f 2>/dev/null || true`,
      );
      if (result.exitCode !== 0) return [];

      return result.stdout
        .split("\n")
        .filter(Boolean)
        .map((name) => ({ name }));
    },
  };

  // E2B-compatible interface: getHost()
  getHost(port: number): string {
    return `localhost:${port}`;
  }

  // E2B-compatible interface: close()
  async close(): Promise<void> {
    this.emit("close");
  }

  /**
   * Check if sandbox is still connected
   */
  async isConnected(): Promise<boolean> {
    
    const status = await this.convex.query(api.localSandbox.isConnected, {
      connectionId: this.connectionInfo.connectionId,
    });
    return status.connected;
  }
}
