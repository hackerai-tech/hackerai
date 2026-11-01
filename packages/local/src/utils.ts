/**
 * Utility functions for the local sandbox client.
 * Extracted for testability.
 */

import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { win32 } from "path";

// Align with LLM context limits (~4096 tokens ≈ 12288 chars)
export const MAX_OUTPUT_SIZE = 12288;

// Truncation marker for 25% head + 75% tail strategy
export const TRUNCATION_MARKER =
  "\n\n[... OUTPUT TRUNCATED - middle content removed to fit context limits ...]\n\n";

/**
 * Truncates output using 25% head + 75% tail strategy.
 * This preserves both the command start (context) and the end (final results/errors).
 */
export function truncateOutput(
  content: string,
  maxSize: number = MAX_OUTPUT_SIZE,
): string {
  if (content.length <= maxSize) return content;

  const markerLength = TRUNCATION_MARKER.length;
  const budgetForContent = maxSize - markerLength;

  // 25% head + 75% tail strategy
  const headBudget = Math.floor(budgetForContent * 0.25);
  const tailBudget = budgetForContent - headBudget;

  const head = content.slice(0, headBudget);
  const tail = content.slice(-tailBudget);

  return head + TRUNCATION_MARKER + tail;
}

export interface ShellConfig {
  shell: string;
  shellFlag: string;
}

export const windowsSystemExecutable = (name: string): string => {
  const systemRoot = process.env.SystemRoot;
  const root =
    systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
  return win32.join(root, "System32", name);
};

/**
 * Get the default shell for a given platform.
 * On Windows, uses cmd.exe (not PowerShell, which aliases curl to Invoke-WebRequest
 * and breaks POSIX-style flags like -fsSL). On Unix-like systems, uses bash.
 */
export function getDefaultShell(platform: string): ShellConfig {
  if (platform === "win32") {
    // Prefer git-bash when available: it gives POSIX semantics (&&, pipes,
    // quoting) and sidesteps cmd.exe's quoting quirks entirely. Falls back
    // to cmd.exe when git-bash isn't installed. Override with HACKERAI_BASH_PATH.
    const bash = findGitBash();
    if (bash) {
      return { shell: bash, shellFlag: "-c" };
    }
    return { shell: windowsSystemExecutable("cmd.exe"), shellFlag: "/C" };
  }
  // Unix-like systems (Linux, macOS, etc.)
  return { shell: "/bin/bash", shellFlag: "-c" };
}

/**
 * Locate `bash.exe` from Git for Windows. Tries, in order:
 *   1. `HACKERAI_BASH_PATH` environment override
 *   2. Common install locations
 *   3. System `where.exe` searches PATH → resolve `<gitDir>/../../bin/bash.exe`
 * Returns null if not found.
 */
export function findGitBash(): string | null {
  const override = process.env.HACKERAI_BASH_PATH;
  if (override && existsSync(override)) return override;

  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  try {
    const out = execFileSync(
      windowsSystemExecutable("where.exe"),
      ["$PATH:git.exe"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const gitExe = out
      .split(/\r?\n/)
      .find(
        (l) =>
          win32.isAbsolute(l.trim()) &&
          l.trim().toLowerCase().endsWith("git.exe"),
      );
    if (gitExe) {
      // <gitDir>/cmd/git.exe → <gitDir>/bin/bash.exe
      const bash = win32.join(
        win32.dirname(win32.dirname(gitExe.trim())),
        "bin",
        "bash.exe",
      );
      if (existsSync(bash)) return bash;
    }
  } catch {
    // System where.exe unavailable or no Git on PATH — fall through
  }

  return null;
}

/**
 * Build the args array and spawn options for invoking a shell command,
 * working around Node's MSVCRT-style `\"` escaping which cmd.exe doesn't
 * understand. On cmd.exe we use `windowsVerbatimArguments: true` and wrap
 * the command in the outer quotes that `cmd /C` expects, so embedded
 * quoted Windows paths (e.g. `"C:\temp\foo\bar.png"`) survive intact.
 */
export function buildShellSpawn(
  shell: string,
  shellFlag: string,
  command: string,
): { args: string[]; options: { windowsVerbatimArguments?: boolean } } {
  // Match the cmd.exe basename exactly — substring check would false-positive
  // on paths like `C:\tools\cmdrunner\bash.exe`.
  const base = shell.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? "";
  const isCmd = base === "cmd" || base === "cmd.exe";
  if (isCmd) {
    return {
      args: [shellFlag, `"${command}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  if (base === "bash.exe") {
    // Git for Windows is often launched from PowerShell with only Git/cmd on
    // PATH. Non-login Bash then has builtins but cannot find base64/mkdir/cat.
    // Initialize its bundled tools without sourcing profiles or changing cwd.
    return {
      args: [shellFlag, `export PATH="/usr/bin:/bin:$PATH"\n${command}`],
      options: {},
    };
  }
  return { args: [shellFlag, command], options: {} };
}
