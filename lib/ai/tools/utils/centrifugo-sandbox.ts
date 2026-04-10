import { EventEmitter } from "events";
import { Centrifuge, type Subscription } from "centrifuge";

import { generateCentrifugoToken } from "@/lib/centrifugo/jwt";
import {
  sandboxChannel,
  type SandboxMessage,
  type CommandMessage,
} from "@/lib/centrifugo/types";
import { getPlatformDisplayName, escapeShellValue } from "./platform-utils";
import type { ConnectionInfo } from "./sandbox-types";
import { validateDownloadUrl } from "./path-validation";

const VALID_MESSAGE_TYPES = new Set([
  "command",
  "stdout",
  "stderr",
  "exit",
  "error",
]);

function parseSandboxMessage(data: unknown): SandboxMessage | null {
  if (typeof data !== "object" || data === null) {
    console.warn("Invalid sandbox message: not an object", data);
    return null;
  }

  const msg = data as Record<string, unknown>;

  if (typeof msg.type !== "string" || !VALID_MESSAGE_TYPES.has(msg.type)) {
    console.warn("Invalid sandbox message: unknown type", msg.type);
    return null;
  }

  if (typeof msg.commandId !== "string") {
    console.warn("Invalid sandbox message: commandId is not a string", msg);
    return null;
  }

  switch (msg.type) {
    case "exit":
      if (typeof msg.exitCode !== "number") {
        console.warn("Invalid exit message: missing exitCode", msg);
        return null;
      }
      break;
    case "stdout":
    case "stderr":
      if (typeof msg.data !== "string") {
        console.warn(`Invalid ${msg.type} message: missing data`, msg);
        return null;
      }
      break;
    case "error":
      if (typeof msg.message !== "string") {
        console.warn("Invalid error message: missing message field", msg);
        return null;
      }
      break;
    case "command":
      if (typeof msg.command !== "string") {
        console.warn("Invalid command message: missing command", msg);
        return null;
      }
      break;
  }

  return data as SandboxMessage;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid?: number;
}

export interface CentrifugoConfig {
  wsUrl: string;
  tokenSecret: string;
}

/**
 * Centrifugo-based sandbox that implements E2B-compatible interface.
 * Uses Centrifugo pub/sub for real-time command streaming.
 */
export class CentrifugoSandbox extends EventEmitter {
  readonly sandboxKind = "centrifugo" as const;
  private activeClients: Centrifuge[] = [];

  constructor(
    private userId: string,
    private connectionInfo: ConnectionInfo,
    private config: CentrifugoConfig,
  ) {
    super();
  }

  getConnectionId(): string {
    return this.connectionInfo.connectionId;
  }

  getConnectionName(): string {
    return this.connectionInfo.name;
  }

  /**
   * Get sandbox context for AI based on mode
   */
  getSandboxContext(): string | null {
    const { osInfo } = this.connectionInfo;

    if (osInfo) {
      const { platform, arch, release, hostname } = osInfo;
      const platformName = getPlatformDisplayName(platform);

      const shellInfo =
        platform === "win32"
          ? `Commands are invoked via cmd.exe /C (NOT PowerShell). Use cmd.exe syntax — do not use PowerShell cmdlets or syntax like Invoke-WebRequest, $env:, or backtick escapes.`
          : `Commands are invoked via /bin/bash -c.`;
      return `You are executing commands on ${platformName} ${release} (${arch}) in DANGEROUS MODE.
${shellInfo}
Commands run directly on the host OS "${hostname}" without Docker isolation. Be careful with:
- File system operations (no sandbox protection)
- Network operations (direct access to host network)
- Process management (can affect host system)`;
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

        // Timing diagnostics — track which phase we reached before timeout
        const t0 = Date.now();
        let tConnected = 0;
        let tSubscribed = 0;
        let tPublished = 0;
        let tFirstMessage = 0;

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
            const phases = [
              `connected: ${tConnected ? `${tConnected - t0}ms` : "no"}`,
              `subscribed: ${tSubscribed ? `${tSubscribed - t0}ms` : "no"}`,
              `published: ${tPublished ? `${tPublished - t0}ms` : "no"}`,
              `firstMsg: ${tFirstMessage ? `${tFirstMessage - t0}ms` : "no"}`,
            ].join(", ");
            reject(
              new Error(
                `Command timeout after ${maxWaitTime}ms [${phases}]` +
                  ` connectionId=${this.connectionInfo.connectionId}`,
              ),
            );
          }
        }, maxWaitTime);

        // Subscribe to the sandbox channel
        subscription = client.newSubscription(channel);

        subscription.on("publication", (ctx) => {
          if (settled) return;
          if (!tFirstMessage) tFirstMessage = Date.now();

          const message = parseSandboxMessage(ctx.data);
          if (!message) return;
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
          tSubscribed = Date.now();
          const commandMessage: CommandMessage = {
            type: "command",
            commandId,
            command,
            env: opts?.envVars,
            cwd: opts?.cwd,
            timeout,
            background: opts?.background,
            displayName: opts?.displayName,
            targetConnectionId: this.connectionInfo.connectionId,
          };

          subscription!
            .publish(commandMessage)
            .then(() => {
              tPublished = Date.now();
            })
            .catch((err: unknown) => {
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

        client.on("connected", () => {
          tConnected = Date.now();
        });

        client.on("error", (ctx) => {
          if (!settled) {
            settled = true;
            cleanup();
            const msg = ctx.error?.message ?? "unknown";
            const isConnectionLimit =
              msg.includes("connection limit") || ctx.error?.code === 4503;
            reject(
              new Error(
                isConnectionLimit
                  ? "Centrifugo connection limit reached. The server has too many active connections. Please try again later."
                  : `Centrifugo client error: ${msg}`,
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

  /** Extract parent directory from a path, handling both `/` and `\` separators. */
  private static parentDir(path: string): string {
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return lastSep > 0 ? path.substring(0, lastSep) : "";
  }

  /**
   * Whether the target machine is Windows in dangerous mode.
   * Docker containers are always Linux regardless of host OS.
   */
  isWindows(): boolean {
    return this.connectionInfo.osInfo?.platform === "win32";
  }

  /**
   * Convert Unix-style paths (e.g. /tmp/hackerai-upload/file.png) to
   * Windows-native paths when running on a Windows sandbox.
   * Paths are generated before the sandbox platform is known, so they
   * always arrive in Unix form and need translating here.
   */
  private toNativePath(path: string): string {
    if (!this.isWindows()) return path;
    if (path.startsWith("/tmp/")) {
      return "C:\\temp" + path.slice(4).replace(/\//g, "\\");
    }
    // Translate any remaining absolute Unix paths to Windows-style
    return path.replace(/\//g, "\\");
  }

  /**
   * Escape a value for the target platform's shell.
   * Uses double quotes on Windows (cmd.exe), single quotes on POSIX.
   */
  private escapeForTarget(value: string): string {
    return escapeShellValue(value, this.connectionInfo.osInfo?.platform);
  }

  /**
   * Convert a Windows path (`C:\temp\foo`) to its MSYS/git-bash form
   * (`/c/temp/foo`). Leaves POSIX paths untouched. Used when the remote
   * shell is git-bash on Windows — since PR #346, that's the default, so
   * cmd.exe syntax like `if not exist` and backslash paths break.
   */
  private static toBashPath(path: string): string {
    const drive = path.match(/^([A-Za-z]):[\\/](.*)$/);
    if (drive) {
      return `/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
    }
    return path.replace(/\\/g, "/");
  }

  // Cache for detected remote shell (git-bash vs cmd.exe on Windows)
  private shellKind: "bash" | "cmd" | null = null;

  /**
   * Detect whether the remote shell is bash (git-bash on Windows, or any
   * POSIX host) or cmd.exe. Cached per sandbox instance.
   *
   * Probe: `echo $BASH_VERSION` — bash substitutes the version string,
   * cmd.exe echoes the literal `$BASH_VERSION`.
   */
  private async detectShell(): Promise<"bash" | "cmd"> {
    if (this.shellKind) return this.shellKind;
    if (!this.isWindows()) {
      this.shellKind = "bash";
      return "bash";
    }
    const probe = await this.commands.run("echo $BASH_VERSION", {
      displayName: "",
    });
    this.shellKind = /^\d/.test(probe.stdout.trim()) ? "bash" : "cmd";
    return this.shellKind;
  }

  /**
   * Shell-aware context bundle for file operations: resolves the remote
   * shell kind, converts a raw path to the form that shell expects, and
   * returns escaping helpers for paths and arbitrary shell values.
   *
   * Centralizes the branching that used to be duplicated across every
   * `files.*` method and `ensureDirectory`.
   */
  private async shellContext(rawPath: string): Promise<{
    useBash: boolean;
    path: string;
    escapePath: (value: string) => string;
    escapeValue: (value: string) => string;
  }> {
    const shell = await this.detectShell();
    const useBash = shell === "bash";
    const nativePath = this.toNativePath(rawPath);
    const path = useBash
      ? CentrifugoSandbox.toBashPath(nativePath)
      : nativePath;
    const escapePath = useBash
      ? (v: string) => CentrifugoSandbox.escapePath(v)
      : (v: string) => this.escapeForTarget(v);
    const escapeValue = useBash
      ? (v: string) => `'${v.replace(/'/g, "'\\''")}'`
      : (v: string) => this.escapeForTarget(v);
    return { useBash, path, escapePath, escapeValue };
  }

  /**
   * Ensure a directory exists on the target, using the correct command for the shell.
   */
  private async ensureDirectory(dir: string): Promise<void> {
    if (!dir) return;
    const {
      useBash,
      path: shellDir,
      escapePath,
    } = await this.shellContext(dir);
    const escaped = escapePath(shellDir);
    // cmd.exe mkdir creates parent dirs by default; use `if not exist` to
    // skip gracefully when it already exists without swallowing real errors.
    const command = useBash
      ? `mkdir -p ${escaped}`
      : `if not exist ${escaped} mkdir ${escaped}`;
    const result = await this.commands.run(command, { displayName: "" });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create directory ${dir}: ${result.stderr}`);
    }
  }

  // Cache for detected HTTP client (curl or wget)
  private httpClient: "curl" | "wget" | null = null;

  /**
   * Detect available HTTP client (curl or wget).
   * Alpine Linux uses wget by default, most other distros have curl.
   * On Windows (cmd.exe), curl resolves to the real curl.exe bundled with Win10+.
   */
  private async detectHttpClient(): Promise<"curl" | "wget"> {
    if (this.httpClient) return this.httpClient;

    // On Windows, curl.exe is bundled since Win10 build 17063 and there's no
    // wget to fall back to. Skip detection since `command -v` is POSIX-only.
    // If curl is missing on an older Windows Server, the download command
    // itself will fail with a clear "curl is not recognized" error.
    if (this.isWindows()) {
      this.httpClient = "curl";
      return "curl";
    }

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
      rawPath: string,
      content: string | Buffer | ArrayBuffer,
    ): Promise<void> => {
      const { useBash, path, escapePath } = await this.shellContext(rawPath);
      const fileName = path.split(/[/\\]/).pop() || "file";

      // Ensure parent directory exists. Pass the native (unconverted) dir
      // so ensureDirectory re-applies its own shell-aware path handling.
      const dir = CentrifugoSandbox.parentDir(this.toNativePath(rawPath));
      if (dir) {
        await this.ensureDirectory(dir);
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

      if (!useBash) {
        // Windows cmd.exe: use certutil to decode base64
        const escapedPath = escapePath(path);
        const b64 = isBinary
          ? contentStr
          : Buffer.from(contentStr).toString("base64");

        // Chunk if needed
        const chunks: string[] = [];
        if (b64.length > CentrifugoSandbox.MAX_CHUNK_SIZE) {
          for (
            let i = 0;
            i < b64.length;
            i += CentrifugoSandbox.MAX_CHUNK_SIZE
          ) {
            chunks.push(b64.slice(i, i + CentrifugoSandbox.MAX_CHUNK_SIZE));
          }
        } else {
          chunks.push(b64);
        }

        // Write base64 to temp file, then certutil -decode to target
        // certutil adds header/footer lines, so we write raw base64 via echo
        const tempFile = this.escapeForTarget(`${path}.b64tmp.${Date.now()}`);
        for (let i = 0; i < chunks.length; i++) {
          const operator = i === 0 ? ">" : ">>";
          const result = await this.commands.run(
            `echo ${chunks[i]} ${operator} ${tempFile}`,
            { displayName: i === 0 ? `Writing: ${fileName}` : "" },
          );
          if (result.exitCode !== 0) {
            throw new Error(`Failed to write file: ${result.stderr}`);
          }
        }
        // Decode and clean up temp file
        const decodeResult = await this.commands.run(
          `certutil -decode ${tempFile} ${escapedPath} >nul & del /q /f ${tempFile}`,
          { displayName: "" },
        );
        if (decodeResult.exitCode !== 0) {
          // Clean up temp file on failure
          await this.commands.run(`del /q /f ${tempFile}`, {
            displayName: "",
          });
          throw new Error(`Failed to write file: ${decodeResult.stderr}`);
        }
      } else if (
        isBinary &&
        contentStr.length > CentrifugoSandbox.MAX_CHUNK_SIZE
      ) {
        // POSIX: Chunk large binary files to stay under size limits
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

        const escapedPath = escapePath(path);
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
        const escapedPath = escapePath(path);
        // Docker containers and Unix dangerous-mode hosts use cat heredoc
        // (more efficient — no ~33% base64 inflation or arg length limits).
        let command: string;
        if (isBinary) {
          command = `printf '%s' "${contentStr}" | base64 -d > ${escapedPath}`;
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

    read: async (rawPath: string): Promise<string> => {
      const { useBash, path, escapePath } = await this.shellContext(rawPath);
      const fileName = path.split(/[/\\]/).pop() || "file";
      const escaped = escapePath(path);
      // cmd.exe uses `type`, bash uses `cat`
      const command = useBash ? `cat ${escaped}` : `type ${escaped}`;
      const result = await this.commands.run(command, {
        displayName: `Reading: ${fileName}`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr}`);
      }
      return result.stdout;
    },

    remove: async (rawPath: string): Promise<void> => {
      const { useBash, path, escapePath } = await this.shellContext(rawPath);
      const fileName = path.split(/[/\\]/).pop() || "file";
      const escaped = escapePath(path);
      // cmd.exe: try both del (files) and rmdir (dirs) to handle either case
      const command = useBash
        ? `rm -rf ${escaped}`
        : `del /q /f ${escaped} 2>nul & rmdir /s /q ${escaped} 2>nul`;
      const result = await this.commands.run(command, {
        displayName: `Removing: ${fileName}`,
      });
      // Under cmd.exe, if both del and rmdir fail the path didn't exist — that's OK for rm -rf semantics
      if (useBash && result.exitCode !== 0) {
        throw new Error(`Failed to remove file: ${result.stderr}`);
      }
    },

    list: async (rawPath: string = "/"): Promise<{ name: string }[]> => {
      const { useBash, path, escapePath } = await this.shellContext(rawPath);
      const dirName = path.split(/[/\\]/).pop() || path;
      const escaped = escapePath(path);
      // cmd.exe: `dir /b /a-d` lists files only (no dirs), one per line
      const command = useBash
        ? `find ${escaped} -maxdepth 1 -type f 2>/dev/null || true`
        : `dir /b /a-d ${escaped} 2>nul`;
      const result = await this.commands.run(command, {
        displayName: `Listing: ${dirName}`,
      });
      if (result.exitCode !== 0) return [];

      return result.stdout
        .split("\n")
        .filter(Boolean)
        .map((name) => {
          // cmd.exe `dir /b` returns relative names; prepend the directory path.
          // bash `find` already returns full paths, so only rewrite under cmd.
          if (!useBash && !name.startsWith(path)) {
            const sep = path.endsWith("/") || path.endsWith("\\") ? "" : "/";
            return { name: `${path}${sep}${name.trim()}` };
          }
          return { name: name.trim() };
        });
    },

    downloadFromUrl: async (url: string, rawPath: string): Promise<void> => {
      validateDownloadUrl(url);
      // When the shell is git-bash (default on Windows since PR #346),
      // emit POSIX syntax with MSYS-form paths. cmd.exe syntax like
      // `if not exist` breaks under bash and leaves the target dir missing,
      // causing curl to fail with the Windows "invalid filename syntax" error.
      const { useBash, path, escapePath, escapeValue } =
        await this.shellContext(rawPath);
      const httpClient = await this.detectHttpClient();
      const dir = CentrifugoSandbox.parentDir(path);
      const fileName = path.split(/[/\\]/).pop() || "file";

      const escapedPath = escapePath(path);
      const escapedUrl = escapeValue(url);
      const escapedDir = dir ? escapePath(dir) : "";

      // Combine mkdir + download into a single command to avoid separate
      // round-trips through the sandbox bridge (e.g. Tauri desktop app),
      // ensuring the directory exists in the same shell session as the download.
      // Skip mkdir entirely for root-level destinations (parentDir returns "")
      // to avoid `mkdir -p ''` / `mkdir "C:"` on valid drive-root paths.
      const mkdirPart = !dir
        ? ""
        : useBash
          ? `mkdir -p ${escapedDir} &&`
          : `if not exist ${escapedDir} mkdir ${escapedDir} &&`;
      const downloadPart =
        httpClient === "curl"
          ? `curl -fsSL -o ${escapedPath} ${escapedUrl}`
          : `wget -q -O ${escapedPath} ${escapedUrl}`;
      const command = `${mkdirPart} ${downloadPart}`;

      const result = await this.commands.run(command, {
        displayName: `Downloading: ${fileName}`,
      });
      if (result.exitCode !== 0) {
        // Gather diagnostic info to help debug write failures (e.g. curl exit 23).
        // Fall back to the target's own directory context when the destination
        // is a drive root and `dir` is empty.
        const diagDir = escapedDir || (useBash ? "/" : '"."');
        const diagCmd = useBash
          ? `ls -la ${diagDir} 2>&1; df -h /tmp 2>&1`
          : `dir ${diagDir} 2>&1`;
        const diag = await this.commands.run(diagCmd, { displayName: "" });
        throw new Error(
          `Failed to download file: ${result.stderr}\n` +
            `  url: ${url.substring(0, 120)}${url.length > 120 ? "..." : ""}\n` +
            `  path: ${path}\n` +
            `  command: ${httpClient}\n` +
            `  exitCode: ${result.exitCode}\n` +
            `  diagnostics: ${diag.stdout}`,
        );
      }
    },

    uploadToUrl: async (
      rawPath: string,
      uploadUrl: string,
      contentType: string,
    ): Promise<void> => {
      const { path, escapePath, escapeValue } =
        await this.shellContext(rawPath);
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

      const fileName = path.split(/[/\\]/).pop() || "file";
      const escapedPath = escapePath(path);
      const escapedUrl = escapeValue(uploadUrl);
      const escapedContentType = escapeValue(`Content-Type: ${contentType}`);

      const command =
        httpClient === "curl"
          ? `curl -fsSL -X PUT -H ${escapedContentType} --data-binary @${escapedPath} ${escapedUrl}`
          : `wget -q --method=PUT --header=${escapedContentType} --body-file=${escapedPath} -O - ${escapedUrl}`;

      const result = await this.commands.run(command, {
        timeoutMs: 120000,
        displayName: `Uploading: ${fileName}`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to upload file: ${result.stderr}`);
      }
    },
  };

  getHost(_port: number): string {
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
