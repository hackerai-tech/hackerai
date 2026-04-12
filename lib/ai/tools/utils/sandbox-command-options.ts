import type { AnySandbox } from "@/types";
import { isE2BSandbox } from "./sandbox-types";

export const MAX_COMMAND_EXECUTION_TIME = 10 * 60 * 1000; // 10 minutes

/**
 * Common directories where user-installed CLI tools live (Go, Rust, Homebrew, etc.).
 * Shell-expanded at runtime via `$HOME`.
 */
const LOCAL_EXTRA_PATH_DIRS = [
  "$HOME/go/bin",
  "$HOME/.local/bin",
  "$HOME/.cargo/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/local/go/bin",
].join(":");

/**
 * Prepend common tool directories to PATH for local (non-E2B) sandboxes.
 * E2B sandboxes have their own pre-configured PATH and are left untouched.
 */
export function augmentCommandPath(
  command: string,
  sandbox: AnySandbox,
): string {
  if (isE2BSandbox(sandbox)) return command;
  return `export PATH="${LOCAL_EXTRA_PATH_DIRS}:$PATH" && ${command}`;
}

/**
 * Build command options for sandbox execution.
 *
 * E2B sandbox requires user: "root" and cwd: "/home/user" for network tools
 * (ping, nmap, etc.) to work without sudo. CentrifugoSandbox (Docker) uses
 * --cap-add flags instead (NET_RAW, NET_ADMIN, SYS_PTRACE).
 *
 * @param sandbox - The sandbox instance
 * @param handlers - Optional stdout/stderr handlers for foreground commands
 * @returns Command options object
 */
export function buildSandboxCommandOptions(
  sandbox: AnySandbox,
  handlers?: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
  extraEnvVars?: Record<string, string>,
): {
  timeoutMs: number;
  user?: "root";
  cwd?: string;
  envVars?: Record<string, string>;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
} {
  return {
    timeoutMs: MAX_COMMAND_EXECUTION_TIME,
    // E2B specific: run as root with /home/user as working directory
    // This allows network tools (ping, nmap, etc.) to work without sudo
    ...(isE2BSandbox(sandbox) && {
      user: "root" as const,
      cwd: "/home/user",
    }),
    ...(extraEnvVars && { envVars: extraEnvVars }),
    ...(handlers && {
      onStdout: handlers.onStdout,
      onStderr: handlers.onStderr,
    }),
  };
}
