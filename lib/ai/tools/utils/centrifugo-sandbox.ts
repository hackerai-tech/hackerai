import { EventEmitter } from "events";
import { Centrifuge, type Subscription } from "centrifuge";
import { publishCommand } from "@/lib/centrifugo/client";
import { generateCentrifugoToken } from "@/lib/centrifugo/jwt";
import {
  sandboxChannel,
  type SandboxMessage,
  type CommandMessage,
} from "@/lib/centrifugo/types";
import { getPlatformDisplayName } from "./platform-utils";

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
  mode: "docker" | "dangerous";
  osInfo?: OsInfo;
  containerId?: string;
}

export interface CentrifugoConfig {
  apiUrl: string;
  apiKey: string;
  wsUrl: string;
  tokenSecret: string;
}

/**
 * Centrifugo-based sandbox that implements E2B-compatible interface.
 * Uses Centrifugo pub/sub for real-time command streaming,
 * replacing the Convex-based relay.
 */
export class CentrifugoSandbox extends EventEmitter {
  private activeClients: Centrifuge[] = [];

  constructor(
    private userId: string,
    private connectionInfo: ConnectionInfo,
    private config: CentrifugoConfig,
  ) {
    super();
  }

  /**
   * Get sandbox context for AI based on mode
   */
  getSandboxContext(): string | null {
    const { mode, osInfo } = this.connectionInfo;

    if (mode === "dangerous" && osInfo) {
      const { platform, arch, release, hostname } = osInfo;
      const platformName = getPlatformDisplayName(platform);

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
      const channel = sandboxChannel(this.userId);

      // Generate short-lived JWT for this subscription (30s + command timeout)
      const tokenExpSeconds = Math.ceil(timeout / 1000) + 30;
      const token = await generateCentrifugoToken(this.userId, tokenExpSeconds);

      // Create a centrifuge client for this command
      const client = new Centrifuge(this.config.wsUrl, {
        token,
      });
      this.activeClients.push(client);

      const result = await new Promise<CommandResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timeoutId: NodeJS.Timeout | undefined;
        let subscription: Subscription | undefined;

        const maxWaitTime = timeout + 5000; // Add 5s buffer for network

        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          if (subscription) {
            try {
              subscription.unsubscribe();
              subscription.removeAllListeners();
            } catch {
              // Ignore errors during cleanup
            }
          }
          try {
            client.disconnect();
          } catch {
            // Ignore errors during disconnect
          }
          const idx = this.activeClients.indexOf(client);
          if (idx !== -1) {
            this.activeClients.splice(idx, 1);
          }
        };

        // Set up timeout
        timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error(`Command timeout after ${maxWaitTime}ms`));
          }
        }, maxWaitTime);

        // Subscribe to the sandbox channel
        subscription = client.newSubscription(channel);

        subscription.on("publication", (ctx) => {
          if (settled) return;

          const message = ctx.data as SandboxMessage;
          if (message.commandId !== commandId) return;

          switch (message.type) {
            case "stdout":
              stdout += message.data;
              opts?.onStdout?.(message.data);
              break;
            case "stderr":
              stderr += message.data;
              opts?.onStderr?.(message.data);
              break;
            case "exit":
              settled = true;
              cleanup();
              resolve({
                stdout,
                stderr,
                exitCode: message.exitCode,
                pid: message.pid,
              });
              break;
            case "error":
              settled = true;
              cleanup();
              resolve({
                stdout,
                stderr: stderr + message.message,
                exitCode: -1,
              });
              break;
          }
        });

        subscription.on("error", (ctx) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `Centrifugo subscription error: ${ctx.error?.message ?? "unknown"}`,
              ),
            );
          }
        });

        // Wait for subscription to be fully established before publishing command.
        // "subscribed" fires after the server confirms the subscription,
        // ensuring we receive messages published to the channel.
        subscription.on("subscribed", () => {
          const commandMessage: CommandMessage = {
            type: "command",
            commandId,
            command,
            env: opts?.envVars,
            cwd: opts?.cwd,
            timeout,
            background: opts?.background,
            displayName: opts?.displayName,
          };

          publishCommand(channel, commandMessage).catch((err: unknown) => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(
                new Error(
                  `Failed to publish command: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
            }
          });
        });

        subscription.subscribe();
        client.connect();

        client.on("error", (ctx) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `Centrifugo client error: ${ctx.error?.message ?? "unknown"}`,
              ),
            );
          }
        });
      });

      return result;
    },
  };

  // Escape paths for shell using single quotes (prevents $(), backticks, etc.)
  private static escapePath(path: string): string {
    return `'${path.replace(/'/g, "'\\''")}'`;
  }

  // Max chunk size ~500KB base64 to stay under size limits
  private static readonly MAX_CHUNK_SIZE = 500 * 1024;

  // Cache for detected HTTP client (curl or wget)
  private httpClient: "curl" | "wget" | null = null;

  /**
   * Detect available HTTP client (curl or wget).
   * Alpine Linux uses wget by default, most other distros have curl.
   */
  private async detectHttpClient(): Promise<"curl" | "wget"> {
    if (this.httpClient) return this.httpClient;

    const curlCheck = await this.commands.run("command -v curl || true", {
      displayName: "",
    });
    if (curlCheck.stdout.includes("curl")) {
      this.httpClient = "curl";
      return "curl";
    }

    const wgetCheck = await this.commands.run("command -v wget || true", {
      displayName: "",
    });
    if (wgetCheck.stdout.includes("wget")) {
      this.httpClient = "wget";
      return "wget";
    }

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
        await this.commands.run(
          `mkdir -p ${CentrifugoSandbox.escapePath(dir)}`,
          { displayName: "" },
        );
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

      if (isBinary && contentStr.length > CentrifugoSandbox.MAX_CHUNK_SIZE) {
        const chunks: string[] = [];
        for (
          let i = 0;
          i < contentStr.length;
          i += CentrifugoSandbox.MAX_CHUNK_SIZE
        ) {
          chunks.push(
            contentStr.slice(i, i + CentrifugoSandbox.MAX_CHUNK_SIZE),
          );
        }

        const escapedPath = CentrifugoSandbox.escapePath(path);
        for (let i = 0; i < chunks.length; i++) {
          const operator = i === 0 ? ">" : ">>";
          const result = await this.commands.run(
            `printf '%s' "${chunks[i]}" | base64 -d ${operator} ${escapedPath}`,
            { displayName: i === 0 ? `Writing: ${fileName}` : "" },
          );
          if (result.exitCode !== 0) {
            throw new Error(`Failed to write file: ${result.stderr}`);
          }
        }
      } else {
        const escapedPath = CentrifugoSandbox.escapePath(path);
        const isWindows =
          this.connectionInfo.mode === "dangerous" &&
          this.connectionInfo.osInfo?.platform === "win32";

        let command: string;
        if (isBinary || isWindows) {
          const b64 = isBinary
            ? contentStr
            : Buffer.from(contentStr).toString("base64");
          command = `printf '%s' "${b64}" | base64 -d > ${escapedPath}`;
        } else {
          const delimiter = `HACKERAI_EOF_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
          command = `cat > ${escapedPath} <<'${delimiter}'\n${contentStr}\n${delimiter}`;
        }

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
        `cat ${CentrifugoSandbox.escapePath(path)}`,
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
        `rm -rf ${CentrifugoSandbox.escapePath(path)}`,
        { displayName: `Removing: ${fileName}` },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to remove file: ${result.stderr}`);
      }
    },

    list: async (path: string = "/"): Promise<{ name: string }[]> => {
      const dirName = path.split("/").pop() || path;
      const result = await this.commands.run(
        `find ${CentrifugoSandbox.escapePath(path)} -maxdepth 1 -type f 2>/dev/null || true`,
        { displayName: `Listing: ${dirName}` },
      );
      if (result.exitCode !== 0) return [];

      return result.stdout
        .split("\n")
        .filter(Boolean)
        .map((name) => ({ name }));
    },

    downloadFromUrl: async (url: string, path: string): Promise<void> => {
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        await this.commands.run(
          `mkdir -p ${CentrifugoSandbox.escapePath(dir)}`,
          { displayName: "" },
        );
      }

      const httpClient = await this.detectHttpClient();
      const escapedUrl = url.replace(/'/g, "'\\''");
      const fileName = path.split("/").pop() || "file";
      const escapedPath = CentrifugoSandbox.escapePath(path);

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
      const escapedPath = CentrifugoSandbox.escapePath(path);
      const fileName = path.split("/").pop() || "file";

      const command =
        httpClient === "curl"
          ? `curl -fsSL -X PUT -H 'Content-Type: ${escapedContentType}' --data-binary @${escapedPath} '${escapedUrl}'`
          : `wget -q --method=PUT --header='Content-Type: ${escapedContentType}' --body-file=${escapedPath} -O - '${escapedUrl}'`;

      const result = await this.commands.run(command, {
        timeoutMs: 120000,
        displayName: `Uploading: ${fileName}`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to upload file: ${result.stderr}`);
      }
    },
  };

  getHost(): string {
    return "";
  }

  async close(): Promise<void> {
    for (const client of this.activeClients) {
      try {
        client.disconnect();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.activeClients = [];
    this.emit("close");
  }
}
