import { EventEmitter } from "events";
import { getPlatformDisplayName, escapeShellValue } from "./platform-utils";

/** Matches the Rust ExecResponse (serde default = snake_case) */
interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

interface TauriSandboxConfig {
  port: number;
  token: string;
}

/** Shape of a single NDJSON streaming chunk from the Tauri command server */
interface StreamChunk {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exit_code?: number;
  message?: string;
}

/**
 * Allowed base directories for file operations.
 * All file paths must resolve under one of these prefixes.
 */
const ALLOWED_FILE_ROOTS = ["/tmp/hackerai-upload", "/tmp/hackerai"];

/**
 * Validate that a resolved file path is within allowed directories.
 * Prevents path traversal attacks (e.g. ../../etc/passwd).
 */
export function validateFilePath(filePath: string): void {
  // Normalize: resolve .. and . segments
  const segments = filePath.split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      resolved.pop();
    } else if (seg !== "." && seg !== "") {
      resolved.push(seg);
    }
  }
  const normalizedPath = "/" + resolved.join("/");

  const isAllowed = ALLOWED_FILE_ROOTS.some(
    (root) => normalizedPath === root || normalizedPath.startsWith(root + "/"),
  );

  if (!isAllowed) {
    throw new Error(
      `File path not allowed: "${filePath}". Must be under one of: ${ALLOWED_FILE_ROOTS.join(", ")}`,
    );
  }
}

/**
 * Validate that a URL is safe for download (block SSRF to internal networks).
 */
export function validateDownloadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: "${url}"`);
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Download URL must use http or https protocol, got: ${parsed.protocol}`,
    );
  }

  // Block common internal/metadata IPs
  const hostname = parsed.hostname;
  const blockedPatterns = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^localhost$/i,
    /^\[::1?\]$/,
    /^metadata\.google\.internal$/i,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(hostname)) {
      throw new Error(
        `Download URL blocked: "${hostname}" resolves to an internal address`,
      );
    }
  }
}

/**
 * Process a single NDJSON streaming chunk, returning accumulated output.
 */
function processStreamChunk(
  chunk: StreamChunk,
  opts?: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
): { stdout: string; stderr: string; exitCode?: number } {
  switch (chunk.type) {
    case "stdout":
      if (chunk.data) {
        opts?.onStdout?.(chunk.data);
        return { stdout: chunk.data, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    case "stderr":
      if (chunk.data) {
        opts?.onStderr?.(chunk.data);
        return { stdout: "", stderr: chunk.data };
      }
      return { stdout: "", stderr: "" };
    case "exit":
      return { stdout: "", stderr: "", exitCode: chunk.exit_code ?? -1 };
    case "error": {
      const msg = chunk.message || "Unknown error";
      opts?.onStderr?.(msg);
      return { stdout: "", stderr: msg };
    }
    default:
      return { stdout: "", stderr: "" };
  }
}

/**
 * Tauri-based sandbox that executes commands directly on the local machine
 * via the Tauri desktop app's built-in HTTP command server.
 *
 * Replaces ConvexSandbox for desktop app users — commands go directly
 * to localhost instead of round-tripping through Convex cloud.
 */
export class TauriSandbox extends EventEmitter {
  private baseUrl: string;
  private token: string;

  constructor(config: TauriSandboxConfig) {
    super();
    this.baseUrl = `http://127.0.0.1:${config.port}`;
    this.token = config.token;
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Tauri command server error (${response.status}): ${text}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get sandbox context for AI — describes this as a local Tauri desktop environment
   */
  getSandboxContext(): string {
    const platform =
      typeof process !== "undefined" ? process.platform : "unknown";
    const platformName = getPlatformDisplayName(platform);

    const shellInfo =
      platform === "win32"
        ? `Commands are invoked via cmd.exe /C (NOT PowerShell). Use cmd.exe syntax — do not use PowerShell cmdlets or syntax like Invoke-WebRequest, $env:, or backtick escapes.`
        : `Commands are invoked via /bin/sh -c.`;
    return `You are executing commands on the user's local machine via the HackerAI Desktop app (${platformName}).
${shellInfo}
Commands run directly on the host OS without Docker isolation. Be careful with:
- File system operations (no sandbox protection)
- Network operations (direct access to host network)
- Process management (can affect host system)`;
  }

  getOsContext(): string {
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
    }> => {
      // Use streaming endpoint when callbacks are provided
      if (opts?.onStdout || opts?.onStderr) {
        return this.executeStreaming(command, opts);
      }

      const result = await this.request<CommandResult>("/execute", {
        command,
        cwd: opts?.cwd,
        env: opts?.envVars,
        timeout_ms: opts?.timeoutMs ?? 30000,
      });

      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.exit_code ?? -1,
      };
    },
  };

  private async executeStreaming(
    command: string,
    opts?: {
      envVars?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const response = await fetch(`${this.baseUrl}/execute/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        command,
        cwd: opts?.cwd,
        env: opts?.envVars,
        timeout_ms: opts?.timeoutMs ?? 30000,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Tauri command server error (${response.status}): ${text}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body for streaming execute");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let stdout = "";
    let stderr = "";
    let exitCode = -1;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const chunk = JSON.parse(trimmed) as StreamChunk;
          const result = processStreamChunk(chunk, opts);
          stdout += result.stdout;
          stderr += result.stderr;
          if (result.exitCode !== undefined) exitCode = result.exitCode;
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Flush any remaining buffered data after EOF
    const remaining = buffer.trim();
    if (remaining) {
      try {
        const chunk = JSON.parse(remaining) as StreamChunk;
        const result = processStreamChunk(chunk, opts);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== undefined) exitCode = result.exitCode;
      } catch {
        // Skip malformed data
      }
    }

    return { stdout, stderr, exitCode };
  }

  /**
   * Escape a value for safe inline use in a shell command string.
   * Delegates to the shared cross-platform utility.
   */
  private static escapeShell(value: string): string {
    return escapeShellValue(value);
  }

  files = {
    write: async (
      path: string,
      content: string | Buffer | ArrayBuffer,
    ): Promise<void> => {
      validateFilePath(path);
      let contentStr: string;
      let isBase64 = false;

      if (typeof content === "string") {
        contentStr = content;
      } else if (content instanceof ArrayBuffer) {
        contentStr = Buffer.from(content).toString("base64");
        isBase64 = true;
      } else {
        contentStr = content.toString("base64");
        isBase64 = true;
      }

      await this.request("/files/write", {
        path,
        content: contentStr,
        is_base64: isBase64,
      });
    },

    read: async (path: string): Promise<string> => {
      validateFilePath(path);
      const result = await this.request<{ content: string }>("/files/read", {
        path,
      });
      return result.content;
    },

    remove: async (path: string): Promise<void> => {
      validateFilePath(path);
      await this.request("/files/remove", { path });
    },

    list: async (
      path: string = "/tmp/hackerai-upload",
    ): Promise<{ name: string }[]> => {
      validateFilePath(path);
      return this.request<{ name: string }[]>("/files/list", { path });
    },

    downloadFromUrl: async (url: string, path: string): Promise<void> => {
      validateFilePath(path);
      validateDownloadUrl(url);

      // Ensure parent directory exists (e.g. /tmp/hackerai-upload)
      // Handle both `/` and `\` separators for Windows paths
      const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      const dir = lastSep > 0 ? path.substring(0, lastSep) : "";
      if (dir) {
        const escapedDir = TauriSandbox.escapeShell(dir);
        // cmd.exe's mkdir creates parent dirs by default; POSIX needs -p
        const mkdirCmd =
          process.platform === "win32"
            ? `mkdir ${escapedDir} 2>nul || echo.`
            : `mkdir -p ${escapedDir}`;
        await this.commands.run(mkdirCmd, { displayName: "" });
      }

      // Use the command execution to download via curl/wget
      const escapedPath = TauriSandbox.escapeShell(path);
      const escapedUrl = TauriSandbox.escapeShell(url);
      const result = await this.commands.run(
        `curl -fsSL -o ${escapedPath} ${escapedUrl} || wget -q -O ${escapedPath} ${escapedUrl}`,
        { displayName: `Downloading: ${path.split("/").pop() || "file"}` },
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
      validateFilePath(path);
      const escapedPath = TauriSandbox.escapeShell(path);
      const escapedUrl = TauriSandbox.escapeShell(uploadUrl);
      const escapedContentType = TauriSandbox.escapeShell(
        `Content-Type: ${contentType}`,
      );
      const result = await this.commands.run(
        `curl -fsSL -X PUT -H ${escapedContentType} --data-binary @${escapedPath} ${escapedUrl}`,
        {
          timeoutMs: 120000,
          displayName: `Uploading: ${path.split("/").pop() || "file"}`,
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to upload file: ${result.stderr}`);
      }
    },
  };

  /**
   * Check if the command server is reachable
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.request<{ status: string }>("/health", {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the host address for a given port.
   * For Tauri desktop, services run on the user's local machine.
   */
  getHost(port: number): string {
    return `localhost:${port}`;
  }

  async close(): Promise<void> {
    this.emit("close");
  }
}
