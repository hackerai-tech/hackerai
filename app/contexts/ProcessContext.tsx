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
}

interface ProcessContextType {
  processes: Map<number, TrackedProcess>;
  addProcess: (pid: number, command: string) => void;
  removeProcess: (pid: number) => void;
  getProcess: (pid: number) => TrackedProcess | undefined;
  isProcessRunning: (pid: number) => boolean;
  refreshProcesses: () => Promise<void>;
}

const ProcessContext = createContext<ProcessContextType | undefined>(undefined);

const POLL_INTERVAL = 5000; // 5 seconds

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

      const response = await fetch("/api/check-processes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          processes: currentProcesses.map((p) => ({
            pid: p.pid,
            command: p.command,
          })),
        }),
      });

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
      console.error("[Process Context] Error checking processes:", error);
    } finally {
      isPollingRef.current = false;
    }
  }, [processes]);

  const addProcess = useCallback((pid: number, command: string) => {
    setProcesses((prev) => {
      const updated = new Map(prev);
      updated.set(pid, {
        pid,
        command,
        startTime: Date.now(),
        running: true,
      });
      return updated;
    });
  }, []);

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
    addProcess,
    removeProcess,
    getProcess,
    isProcessRunning,
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
