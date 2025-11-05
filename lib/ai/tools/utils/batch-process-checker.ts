import type { Sandbox } from "@e2b/code-interpreter";

export interface ProcessInfo {
  pid: number;
  command: string;
}

export interface ProcessCheckRequest {
  pid: number;
  expectedCommand: string;
}

export interface ProcessCheckResult {
  pid: number;
  running: boolean;
  actualCommand?: string;
  commandMatches?: boolean;
}

/**
 * Fetches all running processes once and returns them as a map for efficient lookups.
 * This is much more efficient than calling ps multiple times.
 */
export async function getAllProcesses(
  sandbox: Sandbox,
): Promise<Map<number, string>> {
  try {
    // ps -eo pid,cmd shows all processes with PID and full command line
    // Using -eo instead of aux to avoid truncation
    const result = await sandbox.commands.run("ps -eo pid,cmd", {
      user: "root" as const,
      cwd: "/home/user",
    });

    const processMap = new Map<number, string>();

    if (!result.stdout?.trim()) {
      return processMap;
    }

    const lines = result.stdout.trim().split("\n");

    // Skip header line (first line is "PID CMD")
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Split on first whitespace to separate PID from command
      const firstSpaceIndex = line.indexOf(" ");
      if (firstSpaceIndex === -1) continue;

      const pidStr = line.slice(0, firstSpaceIndex).trim();
      const command = line.slice(firstSpaceIndex + 1).trim();

      const pid = parseInt(pidStr);
      if (!isNaN(pid)) {
        processMap.set(pid, command);
      }
    }

    return processMap;
  } catch (error) {
    console.error("[Batch Process Checker] Failed to fetch processes:", error);
    return new Map();
  }
}

/**
 * Checks if a command matches the expected command.
 * Uses flexible matching to handle arguments and paths.
 */
function commandMatches(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;

  const normalizedActual = actual.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();

  // Exact match
  if (normalizedActual === normalizedExpected) {
    return true;
  }

  // Check if actual contains expected (for commands with additional wrappers)
  if (normalizedActual.includes(normalizedExpected)) {
    return true;
  }

  // Check if expected contains actual (for partial matches)
  if (normalizedExpected.includes(normalizedActual)) {
    return true;
  }

  // Extract first word (command name) and compare
  const actualCmd = normalizedActual.split(/\s+/)[0];
  const expectedCmd = normalizedExpected.split(/\s+/)[0];

  // If command names match, check if key parts of the arguments match
  if (actualCmd === expectedCmd) {
    // Extract meaningful tokens (skip common shell words)
    const skipWords = new Set(["cd", "&&", "||", ";", "|"]);
    const actualTokens = normalizedActual
      .split(/\s+/)
      .filter((t) => t.length > 2 && !skipWords.has(t));
    const expectedTokens = normalizedExpected
      .split(/\s+/)
      .filter((t) => t.length > 2 && !skipWords.has(t));

    // If we have at least 2 matching tokens, consider it a match
    const matchingTokens = expectedTokens.filter((token) =>
      actualTokens.some((actualToken) => actualToken.includes(token)),
    );

    return matchingTokens.length >= Math.min(2, expectedTokens.length);
  }

  return false;
}

/**
 * Checks multiple processes at once using a single ps call.
 * Much more efficient than checking processes one by one.
 */
export async function checkProcessesBatch(
  sandbox: Sandbox,
  requests: ProcessCheckRequest[],
): Promise<ProcessCheckResult[]> {
  let processMap: Map<number, string>;

  try {
    // Get all processes once
    processMap = await getAllProcesses(sandbox);
  } catch (error) {
    // If sandbox is unavailable, mark all processes as not running
    console.warn(
      "[Batch Process Checker] Failed to fetch processes:",
      error instanceof Error ? error.message : error,
    );
    return requests.map((request) => ({
      pid: request.pid,
      running: false,
    }));
  }

  // Check each requested process against the map
  return requests.map((request) => {
    const actualCommand = processMap.get(request.pid);

    if (!actualCommand) {
      return {
        pid: request.pid,
        running: false,
      };
    }

    const matches = commandMatches(actualCommand, request.expectedCommand);

    return {
      pid: request.pid,
      running: true,
      actualCommand,
      commandMatches: matches,
    };
  });
}
