/**
 * Utility functions for the local sandbox client.
 * Extracted for testability.
 */

// Large limit to prevent sandbox from breaking structured output (like JSON).
// Actual token-based truncation is handled by the tools themselves.
// This is just a safety limit to prevent memory issues with massive output.
export const MAX_OUTPUT_SIZE = 100000;

// Minimal marker - tools handle their own truncation messages
export const TRUNCATION_MARKER = "\n...\n";

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
  image: string;
  defaultImage: string;
}): "docker" | "dangerous" | "custom" {
  if (config.dangerous) {
    return "dangerous";
  }
  if (config.image !== config.defaultImage) {
    return "custom";
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
