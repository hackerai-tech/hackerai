import {
  SESSION_MANAGER_SCRIPT,
  SESSION_MANAGER_PATH,
} from "./session-manager-script";
import { truncateContent, TOOL_DEFAULT_MAX_TOKENS } from "@/lib/token-utils";

/**
 * Sandbox interface for session manager operations.
 */
export type SandboxForSessionManager = {
  commands: {
    run: (
      cmd: string,
      opts?: { timeoutMs?: number },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  files: {
    write: (path: string, content: string) => Promise<unknown>;
  };
};

/**
 * Result type from the session manager script.
 * Simplified to 4 fields for cleaner API.
 */
export type SessionResult = {
  content: string;
  status: "completed" | "running" | "error";
  exitCode: number | null;
  workingDir: string;
};

// Track which sandboxes have the session manager installed
const installedSandboxes = new WeakMap<object, boolean>();

/**
 * Ensure the session manager script is installed in the sandbox.
 * Uses a WeakMap to track installation per sandbox instance.
 * Checks actual file content once per execution, updates if different.
 */
export const ensureSessionManager = async (
  sandbox: SandboxForSessionManager,
): Promise<boolean> => {
  // Already verified for this sandbox instance this execution
  if (installedSandboxes.get(sandbox)) {
    return true;
  }

  try {
    // Check if script exists and matches current content
    const checkResult = await sandbox.commands.run(
      `cat ${SESSION_MANAGER_PATH} 2>/dev/null || echo ""`,
      { timeoutMs: 5000 },
    );

    const existingContent = checkResult.stdout;

    // Only write if content differs
    if (existingContent.trim() !== SESSION_MANAGER_SCRIPT.trim()) {
      await sandbox.files.write(SESSION_MANAGER_PATH, SESSION_MANAGER_SCRIPT);
      await sandbox.commands.run(`chmod +x ${SESSION_MANAGER_PATH}`, {
        timeoutMs: 5000,
      });
    }

    installedSandboxes.set(sandbox, true);
    return true;
  } catch (error) {
    console.error("[Shell Session] Failed to install session manager:", error);
    return false;
  }
};

/**
 * Escape a string for use as a shell argument.
 * Uses single quotes and escapes any embedded single quotes.
 */
export const escapeShellArg = (arg: string): string => {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
};

/**
 * Parse the JSON result from the session manager script.
 * Truncates content using the same token-based strategy as other tools.
 */
export const parseSessionResult = (
  stdout: string,
  stderr: string,
): SessionResult => {
  try {
    // Find the last line that contains our result JSON
    // The session manager outputs JSON on the last non-empty line
    const lines = stdout.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("{") && line.endsWith("}")) {
        try {
          const parsed = JSON.parse(line);
          if ("status" in parsed && "working_dir" in parsed) {
            // Truncate content using token-based strategy from lib/token-utils.ts
            const content = parsed.content ?? "";
            return {
              content: truncateContent(content, undefined, TOOL_DEFAULT_MAX_TOKENS),
              status: parsed.status ?? "error",
              exitCode: parsed.exit_code ?? null,
              workingDir: parsed.working_dir ?? "/home/user",
            };
          }
        } catch {
          // Not valid JSON, continue searching
        }
      }
    }

    // Fallback: try greedy regex for backwards compatibility
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const content = parsed.content ?? "";
        return {
          content: truncateContent(content, undefined, TOOL_DEFAULT_MAX_TOKENS),
          status: parsed.status ?? "error",
          exitCode: parsed.exit_code ?? null,
          workingDir: parsed.working_dir ?? "/home/user",
        };
      } catch {
        // JSON parse failed
      }
    }

    return {
      content: stderr || "No JSON response from session manager",
      status: "error",
      exitCode: null,
      workingDir: "/home/user",
    };
  } catch {
    return {
      content: `Failed to parse response: ${stderr || stdout}`,
      status: "error",
      exitCode: null,
      workingDir: "/home/user",
    };
  }
};
