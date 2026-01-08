import type { AnySandbox } from "@/types";
import { isE2BSandbox } from "./sandbox-types";

export const MAX_COMMAND_EXECUTION_TIME = 10 * 60 * 1000; // 10 minutes

/**
 * Build command options for sandbox execution.
 *
 * E2B sandbox requires user: "root" and cwd: "/home/user" for network tools
 * (ping, nmap, etc.) to work without sudo. ConvexSandbox (Docker) uses
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
): {
  timeoutMs: number;
  user?: "root";
  cwd?: string;
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
    ...(handlers && {
      onStdout: handlers.onStdout,
      onStderr: handlers.onStderr,
    }),
  };
}
