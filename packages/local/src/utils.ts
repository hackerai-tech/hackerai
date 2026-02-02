/**
 * Utility functions for the local sandbox client.
 * Extracted for testability.
 */

// Align with LLM context limits (~4096 tokens ≈ 12288 chars)
export const MAX_OUTPUT_SIZE = 12288;

// Truncation marker for 25% head + 75% tail strategy
export const TRUNCATION_MARKER =
  "\n\n[... OUTPUT TRUNCATED - middle content removed to fit context limits ...]\n\n";

/**
 * Required Docker capabilities for penetration testing tools.
 * - NET_RAW: ping, nmap, masscan, hping3, arp-scan, tcpdump, raw sockets
 * - NET_ADMIN: network interface manipulation, arp-scan, netdiscover
 * - SYS_PTRACE: gdb, strace, ltrace (debugging tools)
 */
export const DOCKER_CAPABILITIES = [
  "NET_RAW",
  "NET_ADMIN",
  "SYS_PTRACE",
] as const;

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

/**
 * Build Docker capability flags for the docker run command.
 */
export function buildDockerCapabilityFlags(): string {
  return DOCKER_CAPABILITIES.map((cap) => `--cap-add=${cap}`).join(" ");
}

/**
 * Build the full docker run command for creating a container.
 */
export function buildDockerRunCommand(options: {
  image: string;
  containerName?: string;
  capabilities?: boolean;
}): string {
  const { image, containerName, capabilities = true } = options;

  const nameFlag = containerName ? `--name ${containerName} ` : "";
  const capFlags = capabilities ? `${buildDockerCapabilityFlags()} ` : "";

  return `docker run -d ${nameFlag}${capFlags}--network host ${image} tail -f /dev/null`;
}

/**
 * Determine the sandbox mode based on configuration.
 */
export function getSandboxMode(config: {
  dangerous?: boolean;
}): "docker" | "dangerous" {
  if (config.dangerous) {
    return "dangerous";
  }
  return "docker";
}

/**
 * Parse shell detection output to find available shell.
 * Returns the first valid shell path found.
 */
export function parseShellDetectionOutput(output: string): string {
  if (!output || !output.trim()) {
    return "/bin/sh";
  }
  // Take first line (first result from 'command -v bash || command -v sh')
  const shell = output.trim().split("\n")[0];
  return shell || "/bin/sh";
}

export interface ShellConfig {
  shell: string;
  shellFlag: string;
}

/**
 * Get the default shell for a given platform.
 * On Windows, uses PowerShell; on Unix-like systems, uses bash.
 */
export function getDefaultShell(platform: string): ShellConfig {
  if (platform === "win32") {
    return { shell: "powershell.exe", shellFlag: "-Command" };
  }
  // Unix-like systems (Linux, macOS, etc.)
  return { shell: "/bin/bash", shellFlag: "-c" };
}
