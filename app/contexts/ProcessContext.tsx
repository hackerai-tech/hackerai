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
  registerProcess: (pid: number, command: string) => void;
  clearAllProcesses: () => void;
  setCurrentChatId: (chatId: string | null) => void;
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
const STORAGE_KEY_PREFIX = "process-context-";

// Helper functions for localStorage
function saveProcessesToStorage(chatId: string, processes: Map<number, TrackedProcess>) {
  try {
    const processArray = Array.from(processes.entries());
    localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${chatId}`,
      JSON.stringify(processArray)
    );
  } catch (error) {
    console.warn("[Process Context] Failed to save to localStorage:", error);
  }
}

function loadProcessesFromStorage(chatId: string): Map<number, TrackedProcess> {
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${chatId}`);
    if (!stored) return new Map();

    const processArray: [number, TrackedProcess][] = JSON.parse(stored);
    return new Map(processArray);
  } catch (error) {
    console.warn("[Process Context] Failed to load from localStorage:", error);
    return new Map();
  }
}

export function ProcessProvider({ children }: { children: React.ReactNode }) {
  const [processes, setProcesses] = useState<Map<number, TrackedProcess>>(
    new Map(),
  );
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const currentChatIdRef = useRef<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => {
    currentChatIdRef.current = currentChatId;
  }, [currentChatId]);

  const refreshProcesses = useCallback(async () => {
    // Prevent concurrent polling
    if (isPollingRef.current) {
      return;
    }

    isPollingRef.current = true;

    try {
      // Get current processes from state at time of execution
      // Only poll processes that are still running
      const currentProcesses = Array.from(processes.values()).filter(
        (p) => p.running,
      );

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

              // Log completion but don't auto-delete
              if (!result.running && existing.running) {
                console.log(`[Process Context] Process ${result.pid} completed (will stay in memory until chat cleared)`);
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
    (pid: number, command: string) => {
      // Validate inputs
      if (!pid || typeof pid !== "number" || pid <= 0) {
        console.warn("[Process Context] Invalid PID:", pid);
        return;
      }

      if (!command || typeof command !== "string" || !command.trim()) {
        console.warn("[Process Context] Invalid command:", command);
        return;
      }

      setProcesses((prev) => {
        // Check if process already registered
        const existing = prev.get(pid);
        if (existing) {
          // Already tracking this process
          return prev;
        }

        const updated = new Map(prev);
        const now = Date.now();
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
    [],
  );

  const removeProcess = useCallback((pid: number) => {
    setProcesses((prev) => {
      const updated = new Map(prev);
      updated.delete(pid);
      return updated;
    });
  }, []);

  const clearAllProcesses = useCallback(() => {
    console.log("[Process Context] Clearing all processes (chat change/reset)");
    setProcesses((prev) => {
      // Save current state before clearing
      const chatId = currentChatIdRef.current;
      if (chatId) {
        saveProcessesToStorage(chatId, prev);
      }
      return new Map();
    });
  }, []);

  const handleSetCurrentChatId = useCallback((chatId: string | null) => {
    setProcesses((prev) => {
      // Save current chat's state before switching
      const prevChatId = currentChatIdRef.current;
      if (prevChatId && prev.size > 0) {
        console.log(`[Process Context] Saving ${prev.size} processes for chat ${prevChatId}`);
        saveProcessesToStorage(prevChatId, prev);
      }

      // Load new chat's state
      if (chatId) {
        const loadedProcesses = loadProcessesFromStorage(chatId);
        console.log(`[Process Context] Loaded ${loadedProcesses.size} processes for chat ${chatId}`);
        return loadedProcesses;
      } else {
        return new Map();
      }
    });

    setCurrentChatId(chatId);
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

  // Save to localStorage whenever processes change
  useEffect(() => {
    const chatId = currentChatIdRef.current;
    if (chatId && processes.size > 0) {
      saveProcessesToStorage(chatId, processes);
    }
  }, [processes]);

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
    clearAllProcesses,
    setCurrentChatId: handleSetCurrentChatId,
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
