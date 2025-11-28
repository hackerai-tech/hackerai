import { EventEmitter } from "events";
import { ConvexHttpClient, ConvexClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid?: number;
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
  mode: "docker" | "dangerous" | "custom";
  imageName?: string;
  osInfo?: OsInfo;
  containerId?: string;
}

/**
 * Convex-based sandbox that implements E2B-compatible interface
 * Uses Convex real-time subscriptions for command execution
 */
export class ConvexSandbox extends EventEmitter {
  private convex: ConvexHttpClient;
  private realtimeClient: ConvexClient;
  private connectionInfo: ConnectionInfo;

  constructor(
    private userId: string,
    convexUrl: string,
    connectionInfo: ConnectionInfo,
    private serviceKey: string,
  ) {
    super();
    this.convex = new ConvexHttpClient(convexUrl);
    this.realtimeClient = new ConvexClient(convexUrl);
    this.connectionInfo = connectionInfo;
  }

  /**
   * Get sandbox context for AI based on mode
   */
  getSandboxContext(): string | null {
    const { mode, osInfo, imageName } = this.connectionInfo;

    if (mode === "dangerous" && osInfo) {
      const { platform, arch, release, hostname } = osInfo;
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

    if (mode === "custom" && imageName) {
      return `You are executing commands in a custom Docker container using image "${imageName}".
This is a user-provided image - available tools and environment may vary.
Commands run inside the Docker container with network access.`;
    }

    if (mode === "docker") {
      return `You are executing commands in the HackerAI sandbox Docker container.
This container includes common pentesting tools like nmap, sqlmap, ffuf, gobuster, nuclei, hydra, nikto, wpscan, subfinder, httpx, and more.
Commands run inside the Docker container with network access.`;
    }

    return null;
  }

  /**
   * Get OS context for AI when in dangerous mode (alias for backwards compatibility)
   */
  getOsContext(): string | null {
    return this.getSandboxContext();
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
    ): Promise<{ stdout: string; stderr: string; exitCode: number; pid?: number }> => {
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
        background: opts?.background,
      });

      // Wait for result with timeout
      const result = await this.waitForResult(commandId, timeout);

      // Stream output if handlers provided (not applicable for background)
      if (!opts?.background) {
        if (opts?.onStdout && result.stdout) {
          opts.onStdout(result.stdout);
        }
        if (opts?.onStderr && result.stderr) {
          opts.onStderr(result.stderr);
        }
      }

      // Output is already truncated by the local sandbox before submission
      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.exitCode ?? -1, // -1 indicates unknown exit status
        pid: result.pid,
      };
    },
  };

  private async waitForResult(
    commandId: string,
    timeout: number,
  ): Promise<CommandResult> {
    const maxWaitTime = timeout + 5000; // Add 5s buffer for network

    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      let unsubscribe: (() => void) | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubscribe) unsubscribe();
      };

      // Set up timeout
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Command timeout after ${maxWaitTime}ms`));
      }, maxWaitTime);

      // Subscribe to result using real-time client
      unsubscribe = this.realtimeClient.onUpdate(
        api.localSandbox.subscribeToResult,
        { userId: this.userId, commandId },
        async (result) => {
          if (result?.found) {
            cleanup();

            // Delete result after read to reduce storage
            this.convex
              .mutation(api.localSandbox.deleteResult, {
                serviceKey: this.serviceKey,
                userId: this.userId,
                commandId,
              })
              .catch(() => {
                // Ignore cleanup errors
              });

            resolve({
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? "",
              exitCode: result.exitCode ?? -1,
              pid: result.pid,
            });
          }
        },
      );
    });
  }

  // E2B-compatible interface: files operations
  // Max chunk size ~500KB base64 to stay under Convex's 1MB limit
  private static readonly MAX_CHUNK_SIZE = 500 * 1024;

  // Escape paths for shell using single quotes (prevents $(), backticks, etc.)
  private static escapePath(path: string): string {
    return `'${path.replace(/'/g, "'\\''")}'`;
  }

  files = {
    write: async (
      path: string,
      content: string | Buffer | ArrayBuffer,
    ): Promise<void> => {
      let contentStr: string;
      let isBinary = false;

      if (typeof content === "string") {
        contentStr = content;
      } else if (content instanceof ArrayBuffer) {
        contentStr = Buffer.from(content).toString("base64");
        isBinary = true;
      } else {
        contentStr = content.toString("base64");
        isBinary = true;
      }

      if (isBinary && contentStr.length > ConvexSandbox.MAX_CHUNK_SIZE) {
        // Chunk large binary files to stay under Convex size limits
        const chunks: string[] = [];
        for (
          let i = 0;
          i < contentStr.length;
          i += ConvexSandbox.MAX_CHUNK_SIZE
        ) {
          chunks.push(contentStr.slice(i, i + ConvexSandbox.MAX_CHUNK_SIZE));
        }

        // First chunk creates the file, subsequent chunks append
        const escapedPath = ConvexSandbox.escapePath(path);
        for (let i = 0; i < chunks.length; i++) {
          const operator = i === 0 ? ">" : ">>";
          // Use printf to avoid echo interpretation issues
          await this.commands.run(
            `printf '%s' "${chunks[i]}" | base64 -d ${operator} ${escapedPath}`,
          );
        }
      } else {
        // Generate a unique delimiter to avoid content collision
        const delimiter = `HACKERAI_EOF_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const escapedPath = ConvexSandbox.escapePath(path);
        const command = isBinary
          ? `printf '%s' "${contentStr}" | base64 -d > ${escapedPath}`
          : `cat > ${escapedPath} <<'${delimiter}'\n${contentStr}\n${delimiter}`;

        await this.commands.run(command);
      }
    },

    read: async (path: string): Promise<string> => {
      const result = await this.commands.run(
        `cat ${ConvexSandbox.escapePath(path)}`,
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr}`);
      }
      return result.stdout;
    },

    remove: async (path: string): Promise<void> => {
      await this.commands.run(`rm -rf ${ConvexSandbox.escapePath(path)}`);
    },

    list: async (path: string = "/"): Promise<{ name: string }[]> => {
      const result = await this.commands.run(
        `find ${ConvexSandbox.escapePath(path)} -maxdepth 1 -type f 2>/dev/null || true`,
      );
      if (result.exitCode !== 0) return [];

      return result.stdout
        .split("\n")
        .filter(Boolean)
        .map((name) => ({ name }));
    },

    downloadFromUrl: async (url: string, path: string): Promise<void> => {
      // Ensure parent directory exists
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        await this.commands.run(`mkdir -p ${ConvexSandbox.escapePath(dir)}`);
      }
      // Download file directly from URL using curl
      // Use single quotes for URL and escape embedded single quotes to prevent shell injection
      const escapedUrl = url.replace(/'/g, "'\\''");
      const result = await this.commands.run(
        `curl -fsSL -o ${ConvexSandbox.escapePath(path)} '${escapedUrl}'`,
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to download file: ${result.stderr}`);
      }
    },

    uploadToUrl: async (
      path: string,
      uploadUrl: string,
      contentType: string,
    ): Promise<void> => {
      // Upload file directly to presigned URL using curl
      // Use --data-binary to preserve binary data exactly
      // Use single quotes for URL/contentType and escape embedded single quotes
      const escapedUrl = uploadUrl.replace(/'/g, "'\\''");
      const escapedContentType = contentType.replace(/'/g, "'\\''");
      const result = await this.commands.run(
        `curl -fsSL -X PUT -H 'Content-Type: ${escapedContentType}' --data-binary @${ConvexSandbox.escapePath(path)} '${escapedUrl}'`,
        { timeoutMs: 120000 }, // 2 minutes for large files
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to upload file: ${result.stderr}`);
      }
    },
  };

  // E2B-compatible interface: close()
  async close(): Promise<void> {
    await this.realtimeClient.close();
    this.emit("close");
  }
}
