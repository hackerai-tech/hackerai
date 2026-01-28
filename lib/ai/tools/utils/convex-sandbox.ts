import { EventEmitter } from "events";
import { ConvexHttpClient, ConvexClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid?: number;
}

interface SignedSession {
  userId: string;
  connectionId: string;
  expiresAt: number;
  signature: string;
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
  private realtimeClient: ConvexClient;
  private connectionInfo: ConnectionInfo;
  // Track active subscriptions for cleanup on close
  private activeSubscriptions: Set<() => void> = new Set();

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
    const { mode, osInfo } = this.connectionInfo;

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
        // Display name for CLI output (empty string = hide, undefined = show command)
        displayName?: string;
      },
    ): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      pid?: number;
    }> => {
      const commandId = crypto.randomUUID();
      const timeout = opts?.timeoutMs ?? 30000;

      // Enqueue command in Convex and get signed session for result subscription
      const enqueueResult = await this.convex.mutation(
        api.localSandbox.enqueueCommand,
        {
          serviceKey: this.serviceKey,
          userId: this.userId,
          connectionId: this.connectionInfo.connectionId,
          commandId,
          command,
          env: opts?.envVars,
          cwd: opts?.cwd,
          timeout,
          background: opts?.background,
          displayName: opts?.displayName,
        },
      );

      if (!enqueueResult.session) {
        throw new Error("Failed to get session for command subscription");
      }

      // Wait for result with timeout, using signed session for secure subscription
      const result = await this.waitForResult(
        commandId,
        timeout,
        enqueueResult.session,
      );

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
    session: SignedSession,
  ): Promise<CommandResult> {
    const maxWaitTime = timeout + 5000; // Add 5s buffer for network

    let timeoutId: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    let settled = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (unsubscribe) {
        this.activeSubscriptions.delete(unsubscribe);
        try {
          unsubscribe();
        } catch {
          // Ignore errors during unsubscribe (client may already be closed)
        }
        unsubscribe = undefined;
      }
    };

    try {
      return await new Promise<CommandResult>((resolve, reject) => {
        // Set up timeout
        timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error(`Command timeout after ${maxWaitTime}ms`));
          }
        }, maxWaitTime);

        // Subscribe to result using real-time client with signed session
        unsubscribe = this.realtimeClient.onUpdate(
          api.localSandbox.subscribeToResult,
          { commandId, session },
          (result) => {
            if (settled) return; // Ignore updates after settlement

            // Handle session auth errors
            if (result?.authError) {
              settled = true;
              cleanup();
              reject(
                new Error(
                  "Session expired or invalid - command result unavailable",
                ),
              );
              return;
            }

            if (result?.found) {
              settled = true;
              cleanup();

              // Delete result after read to reduce storage (fire and forget)
              this.convex
                .mutation(api.localSandbox.deleteResult, {
                  serviceKey: this.serviceKey,
                  userId: this.userId,
                  commandId,
                })
                .catch((error) => {
                  console.warn(
                    `Failed to delete command result ${commandId}: ${error instanceof Error ? error.message : String(error)}`,
                  );
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

        // Track subscription for cleanup on close()
        this.activeSubscriptions.add(unsubscribe);
      });
    } finally {
      // Ensure cleanup even if promise is externally rejected or cancelled
      cleanup();
    }
  }

  // E2B-compatible interface: files operations
  // Max chunk size ~500KB base64 to stay under Convex's 1MB limit
  private static readonly MAX_CHUNK_SIZE = 500 * 1024;

  // Escape paths for shell using single quotes (prevents $(), backticks, etc.)
  private static escapePath(path: string): string {
    return `'${path.replace(/'/g, "'\\''")}'`;
  }

  // Cache for detected HTTP client (curl or wget)
  private httpClient: "curl" | "wget" | null = null;

  /**
   * Detect available HTTP client (curl or wget).
   * Alpine Linux uses wget by default, most other distros have curl.
   * Note: We check stdout instead of exitCode for reliability through Convex relay.
   */
  private async detectHttpClient(): Promise<"curl" | "wget"> {
    if (this.httpClient) return this.httpClient;

    // Check for curl first (more common)
    // Use stdout check - exitCode may not propagate correctly through Convex relay
    const curlCheck = await this.commands.run("command -v curl || true", {
      displayName: "",
    });
    if (curlCheck.stdout.includes("curl")) {
      this.httpClient = "curl";
      return "curl";
    }

    // Fall back to wget
    const wgetCheck = await this.commands.run("command -v wget || true", {
      displayName: "",
    });
    if (wgetCheck.stdout.includes("wget")) {
      this.httpClient = "wget";
      return "wget";
    }

    // Default to curl and let it fail with a clear error
    this.httpClient = "curl";
    return "curl";
  }

  files = {
    write: async (
      path: string,
      content: string | Buffer | ArrayBuffer,
    ): Promise<void> => {
      const fileName = path.split("/").pop() || "file";

      // Ensure parent directory exists
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        await this.commands.run(`mkdir -p ${ConvexSandbox.escapePath(dir)}`, {
          displayName: "", // Hide internal mkdir
        });
      }

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
          const result = await this.commands.run(
            `printf '%s' "${chunks[i]}" | base64 -d ${operator} ${escapedPath}`,
            // Show progress for first chunk only
            { displayName: i === 0 ? `Writing: ${fileName}` : "" },
          );
          if (result.exitCode !== 0) {
            throw new Error(`Failed to write file: ${result.stderr}`);
          }
        }
      } else {
        // Generate a unique delimiter to avoid content collision
        const delimiter = `HACKERAI_EOF_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const escapedPath = ConvexSandbox.escapePath(path);
        const command = isBinary
          ? `printf '%s' "${contentStr}" | base64 -d > ${escapedPath}`
          : `cat > ${escapedPath} <<'${delimiter}'\n${contentStr}\n${delimiter}`;

        const result = await this.commands.run(command, {
          displayName: `Writing: ${fileName}`,
        });
        if (result.exitCode !== 0) {
          throw new Error(`Failed to write file: ${result.stderr}`);
        }
      }
    },

    read: async (path: string): Promise<string> => {
      const fileName = path.split("/").pop() || "file";
      const result = await this.commands.run(
        `cat ${ConvexSandbox.escapePath(path)}`,
        { displayName: `Reading: ${fileName}` },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr}`);
      }
      return result.stdout;
    },

    remove: async (path: string): Promise<void> => {
      const fileName = path.split("/").pop() || "file";
      const result = await this.commands.run(
        `rm -rf ${ConvexSandbox.escapePath(path)}`,
        { displayName: `Removing: ${fileName}` },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to remove file: ${result.stderr}`);
      }
    },

    list: async (path: string = "/"): Promise<{ name: string }[]> => {
      const dirName = path.split("/").pop() || path;
      const result = await this.commands.run(
        `find ${ConvexSandbox.escapePath(path)} -maxdepth 1 -type f 2>/dev/null || true`,
        { displayName: `Listing: ${dirName}` },
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
        await this.commands.run(`mkdir -p ${ConvexSandbox.escapePath(dir)}`, {
          displayName: "", // Hide internal mkdir
        });
      }

      const httpClient = await this.detectHttpClient();
      const escapedUrl = url.replace(/'/g, "'\\''");
      const fileName = path.split("/").pop() || "file";
      const escapedPath = ConvexSandbox.escapePath(path);

      // Use curl or wget depending on what's available
      const command =
        httpClient === "curl"
          ? `curl -fsSL -o ${escapedPath} '${escapedUrl}'`
          : `wget -q -O ${escapedPath} '${escapedUrl}'`;

      const result = await this.commands.run(command, {
        displayName: `Downloading: ${fileName}`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to download file: ${result.stderr}`);
      }
    },

    uploadToUrl: async (
      path: string,
      uploadUrl: string,
      contentType: string,
    ): Promise<void> => {
      const httpClient = await this.detectHttpClient();

      // BusyBox wget (common on Alpine) doesn't support --method=PUT or --body-file
      // Check for this and provide a clear error message to the AI
      // Note: BusyBox wget doesn't support --version, but outputs "BusyBox" in usage text
      if (httpClient === "wget") {
        const versionCheck = await this.commands.run("wget 2>&1 | head -1", {
          displayName: "",
        });
        if (versionCheck.stdout.toLowerCase().includes("busybox")) {
          throw new Error(
            "File upload failed: curl is not available and BusyBox wget does not support PUT requests. " +
              "Install curl to enable file uploads (e.g., 'apk add curl' on Alpine or 'apt install curl' on Debian).",
          );
        }
      }

      const escapedUrl = uploadUrl.replace(/'/g, "'\\''");
      const escapedContentType = contentType.replace(/'/g, "'\\''");
      const escapedPath = ConvexSandbox.escapePath(path);
      const fileName = path.split("/").pop() || "file";

      // Use curl or wget depending on what's available
      const command =
        httpClient === "curl"
          ? `curl -fsSL -X PUT -H 'Content-Type: ${escapedContentType}' --data-binary @${escapedPath} '${escapedUrl}'`
          : `wget -q --method=PUT --header='Content-Type: ${escapedContentType}' --body-file=${escapedPath} -O - '${escapedUrl}'`;

      const result = await this.commands.run(command, {
        timeoutMs: 120000, // 2 minutes for large files
        displayName: `Uploading: ${fileName}`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to upload file: ${result.stderr}`);
      }
    },
  };

  // E2B-compatible interface: close()
  async close(): Promise<void> {
    // Clean up any active subscriptions first
    for (const unsubscribe of this.activeSubscriptions) {
      try {
        unsubscribe();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.activeSubscriptions.clear();

    await this.realtimeClient.close();
    this.emit("close");
  }
}
