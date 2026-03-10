import { EventEmitter } from "events";
import { getPlatformDisplayName, escapeShellValue } from "./platform-utils";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TauriSandboxConfig {
  port: number;
  token: string;
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

    return `You are executing commands on the user's local machine via the HackerAI Desktop app (${platformName}).
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
        exitCode: result.exitCode ?? -1,
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
          const chunk = JSON.parse(trimmed) as {
            type: "stdout" | "stderr" | "exit" | "error";
            data?: string;
            exit_code?: number;
            message?: string;
          };

          switch (chunk.type) {
            case "stdout":
              if (chunk.data) {
                stdout += chunk.data;
                opts?.onStdout?.(chunk.data);
              }
              break;
            case "stderr":
              if (chunk.data) {
                stderr += chunk.data;
                opts?.onStderr?.(chunk.data);
              }
              break;
            case "exit":
              exitCode = chunk.exit_code ?? -1;
              break;
            case "error":
              stderr += chunk.message || "Unknown error";
              opts?.onStderr?.(chunk.message || "Unknown error");
              break;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Flush any remaining buffered data after EOF
    const remaining = buffer.trim();
    if (remaining) {
      try {
        const chunk = JSON.parse(remaining) as {
          type: "stdout" | "stderr" | "exit" | "error";
          data?: string;
          exit_code?: number;
          message?: string;
        };
        switch (chunk.type) {
          case "stdout":
            if (chunk.data) {
              stdout += chunk.data;
              opts?.onStdout?.(chunk.data);
            }
            break;
          case "stderr":
            if (chunk.data) {
              stderr += chunk.data;
              opts?.onStderr?.(chunk.data);
            }
            break;
          case "exit":
            exitCode = chunk.exit_code ?? -1;
            break;
          case "error":
            stderr += chunk.message || "Unknown error";
            opts?.onStderr?.(chunk.message || "Unknown error");
            break;
        }
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
      const result = await this.request<{ content: string }>("/files/read", {
        path,
      });
      return result.content;
    },

    remove: async (path: string): Promise<void> => {
      await this.request("/files/remove", { path });
    },

    list: async (path: string = "/"): Promise<{ name: string }[]> => {
      return this.request<{ name: string }[]>("/files/list", { path });
    },

    downloadFromUrl: async (url: string, path: string): Promise<void> => {
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
