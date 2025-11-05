"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";

export interface TrackedProcess {
  pid: number;
  command: string;
  startTime: number;
  running: boolean;
  actualCommand?: string;
  commandMatches?: boolean;
  lastChecked?: number;
  isKilling?: boolean;
}

interface ProcessContextType {
  processes: Map<number, TrackedProcess>;
  // Core process management
  registerProcess: (pid: number, command: string, maxAgeMs?: number) => void;
  // Process state queries
  isProcessRunning: (pid: number) => boolean;
  isProcessKilling: (pid: number) => boolean;
  // Process actions
  killProcess: (pid: number) => Promise<boolean>;
  // Internal (exposed for edge cases)
  removeProcess: (pid: number) => void;
  getProcess: (pid: number) => TrackedProcess | undefined;
  refreshProcesses: () => Promise<void>;
}

const ProcessContext = createContext<ProcessContextType | undefined>(undefined);

const POLL_INTERVAL = 5000; // 5 seconds
const POLL_TIMEOUT = 5000; // 5 seconds timeout

export function ProcessProvider({ children }: { children: React.ReactNode }) {
  const [processes, setProcesses] = useState<Map<number, TrackedProcess>>(
    new Map(),
  );
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);

  const refreshProcesses = useCallback(async () => {
    // Prevent concurrent polling
    if (isPollingRef.current) {
      return;
    }

    isPollingRef.current = true;

    try {
      // Get current processes from state at time of execution
      const currentProcesses = Array.from(processes.values());

      if (currentProcesses.length === 0) {
        isPollingRef.current = false;
        return;
      }

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), POLL_TIMEOUT);

      const response = await fetch("/api/check-processes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          processes: currentProcesses.map((p) => ({
            pid: p.pid,
            command: p.command,
          })),
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();

        setProcesses((prev) => {
          const updated = new Map(prev);
          const now = Date.now();

          for (const result of data.results) {
            const existing = updated.get(result.pid);
            if (existing) {
              // Don't update if process was just added (within 2 seconds)
              // This prevents overwriting the optimistic "running: true" state
              const processAge = now - existing.startTime;
              if (processAge < 2000 && !result.running) {
                // Process is very new and API says not running - might be timing issue
                // Keep the optimistic state for a bit longer
                continue;
              }

              updated.set(result.pid, {
                ...existing,
                running: result.running,
                actualCommand: result.actualCommand,
                commandMatches: result.commandMatches,
                lastChecked: now,
              });

              // Remove processes that are no longer running
              if (!result.running) {
                // Keep them for a brief period for UI feedback
                setTimeout(() => {
                  setProcesses((current) => {
                    const newMap = new Map(current);
                    newMap.delete(result.pid);
                    return newMap;
                  });
                }, 2000);
              }
            }
          }

          return updated;
        });
      }
    } catch (error) {
      // Ignore abort errors (timeout is expected behavior)
      if (error instanceof Error && error.name === "AbortError") {
        console.warn("[Process Context] Process check timed out after 5s");
      } else {
        console.error("[Process Context] Error checking processes:", error);
      }
    } finally {
      isPollingRef.current = false;
    }
  }, [processes]);

  const registerProcess = useCallback(
    (pid: number, command: string, maxAgeMs: number = 20 * 60 * 1000) => {
      // Validate inputs
      if (!pid || typeof pid !== "number" || pid <= 0) {
        console.warn("[Process Context] Invalid PID:", pid);
        return;
      }

      if (!command || typeof command !== "string" || !command.trim()) {
        console.warn("[Process Context] Invalid command:", command);
        return;
      }

      // Check if process already registered
      const existing = processes.get(pid);
      if (existing) {
        // Already tracking this process
        return;
      }

      // Don't track very old processes (likely timed out on E2B)
      const now = Date.now();

      setProcesses((prev) => {
        const updated = new Map(prev);
        updated.set(pid, {
          pid,
          command: command.trim(),
          startTime: now,
          running: true,
        });
        return updated;
      });

      console.log(`[Process Context] Registered process ${pid}: ${command.slice(0, 50)}...`);
    },
    [processes],
  );

  const removeProcess = useCallback((pid: number) => {
    setProcesses((prev) => {
      const updated = new Map(prev);
      updated.delete(pid);
      return updated;
    });
  }, []);

  const getProcess = useCallback(
    (pid: number) => {
      return processes.get(pid);
    },
    [processes],
  );

  const isProcessRunning = useCallback(
    (pid: number) => {
      return processes.get(pid)?.running ?? false;
    },
    [processes],
  );

  const isProcessKilling = useCallback(
    (pid: number) => {
      return processes.get(pid)?.isKilling ?? false;
    },
    [processes],
  );

  const killProcess = useCallback(
    async (pid: number): Promise<boolean> => {
      // Set killing state
      setProcesses((prev) => {
        const updated = new Map(prev);
        const process = updated.get(pid);
        if (process) {
          updated.set(pid, { ...process, isKilling: true });
        }
        return updated;
      });

      try {
        const response = await fetch("/api/kill-process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pid }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            // Immediately refresh process status
            await refreshProcesses();
            return true;
          }
        }
        return false;
      } catch (error) {
        console.error("Error killing process:", error);
        return false;
      } finally {
        // Clear killing state
        setProcesses((prev) => {
          const updated = new Map(prev);
          const process = updated.get(pid);
          if (process) {
            updated.set(pid, { ...process, isKilling: false });
          }
          return updated;
        });
      }
    },
    [refreshProcesses],
  );

  // Set up polling
  useEffect(() => {
    if (processes.size === 0) {
      // Clear interval if no processes to track
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    // Set up interval if not already running
    if (!pollIntervalRef.current) {
      // Initial check immediately
      refreshProcesses();
      // Then poll regularly
      pollIntervalRef.current = setInterval(refreshProcesses, POLL_INTERVAL);
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
    // Only re-run when processes.size changes (process added/removed), not on every process update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processes.size]);

  const value: ProcessContextType = {
    processes,
    registerProcess,
    removeProcess,
    getProcess,
    isProcessRunning,
    isProcessKilling,
    killProcess,
    refreshProcesses,
  };

  return (
    <ProcessContext.Provider value={value}>{children}</ProcessContext.Provider>
  );
}

export function useProcessContext() {
  const context = useContext(ProcessContext);
  if (context === undefined) {
    throw new Error("useProcessContext must be used within a ProcessProvider");
  }
  return context;
}
