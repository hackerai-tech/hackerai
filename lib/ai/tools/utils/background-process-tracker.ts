import type { AnySandbox } from "@/types";

export interface BackgroundProcess {
  session: string;
  pid: number;
  command: string;
  outputFiles: string[];
  startTime: number;
}

export class BackgroundProcessTracker {
  private processes = new Map<string, BackgroundProcess>();

  /** Track the owned handle's lifetime, never infer ownership from a PID. */
  addProcess(
    session: string,
    pid: number,
    command: string,
    outputFiles: string[],
    exited: Promise<{ exitCode: number | null }>,
  ): void {
    const process = {
      session,
      pid,
      command,
      outputFiles,
      startTime: Date.now(),
    };
    this.processes.set(session, process);
    void exited
      .then(() => {
        if (this.processes.get(session) === process)
          this.processes.delete(session);
      })
      .catch(() => {
        // A monitoring failure is not proof of exit; retain the file guard.
      });
  }

  /** Guard unfinished artifacts using owned sessions, without probing reusable OS PIDs. */
  async hasActiveProcessesForFiles(
    _sandbox: AnySandbox,
    filePaths: string[],
  ): Promise<{ active: boolean; processes: BackgroundProcess[] }> {
    const activeProcesses = Array.from(this.processes.values()).filter(
      (process) =>
        process.outputFiles.some((outputFile) =>
          filePaths.some((requestedFile) => {
            const normalizedOutput = this.normalizePath(outputFile);
            const normalizedRequested = this.normalizePath(requestedFile);
            return (
              normalizedOutput === normalizedRequested ||
              normalizedOutput.endsWith("/" + normalizedRequested) ||
              normalizedRequested.endsWith("/" + normalizedOutput) ||
              normalizedOutput.endsWith(normalizedRequested) ||
              normalizedRequested.endsWith(normalizedOutput)
            );
          }),
        ),
    );

    return {
      active: activeProcesses.length > 0,
      processes: activeProcesses,
    };
  }

  /**
   * Normalize file path for comparison
   */
  private normalizePath(path: string): string {
    // Remove leading/trailing spaces and normalize slashes
    let normalized = path.trim().replace(/\/+/g, "/");

    // Remove leading ./ if present
    if (normalized.startsWith("./")) {
      normalized = normalized.slice(2);
    }

    return normalized;
  }

  /**
   * Extract output file paths from a command string
   */
  static extractOutputFiles(command: string): string[] {
    const outputFiles: string[] = [];

    // Pattern 1: nmap -oN file, -oX file, -oG file
    const nmapPatterns = [
      /-oN\s+([^\s]+)/g,
      /-oX\s+([^\s]+)/g,
      /-oG\s+([^\s]+)/g,
    ];

    for (const pattern of nmapPatterns) {
      let match;
      while ((match = pattern.exec(command)) !== null) {
        const filename = match[1].replace(/^['"]|['"]$/g, "");
        outputFiles.push(filename);
      }
    }

    // Pattern 2: nmap -oA prefix (creates prefix.nmap, prefix.xml, prefix.gnmap)
    const nmapAllPattern = /-oA\s+([^\s]+)/g;
    let match;
    while ((match = nmapAllPattern.exec(command)) !== null) {
      const prefix = match[1];
      outputFiles.push(`${prefix}.nmap`, `${prefix}.xml`, `${prefix}.gnmap`);
    }

    // Pattern 3: Shell redirection > file or >> file
    const redirectPattern = /(?:^|[|;&])\s*[^|;&]*?\s+>>?\s+([^\s|;&]+)/g;
    while ((match = redirectPattern.exec(command)) !== null) {
      const filename = match[1].replace(/^['"]|['"]$/g, "");
      outputFiles.push(filename);
    }

    // Pattern 4: tee file
    const teePattern = /\|\s*tee\s+([^\s|;&]+)/g;
    while ((match = teePattern.exec(command)) !== null) {
      const filename = match[1].replace(/^['"]|['"]$/g, "");
      outputFiles.push(filename);
    }

    // Pattern 5: Generic --output file or -o file
    const genericPatterns = [/--output\s+([^\s]+)/g, /(?:^|\s)-o\s+([^\s]+)/g];

    for (const pattern of genericPatterns) {
      while ((match = pattern.exec(command)) !== null) {
        const filename = match[1].replace(/^['"]|['"]$/g, "");
        outputFiles.push(filename);
      }
    }

    return [...new Set(outputFiles)];
  }

  /**
   * Get all tracked processes (for debugging)
   */
  getTrackedProcesses(): BackgroundProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Clear all tracked processes
   */
  clear(): void {
    this.processes.clear();
  }
}
