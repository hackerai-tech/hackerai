import { useEffect, useCallback } from "react";
import { useProcessContext } from "./ProcessContext";

export interface TerminalProcessData {
  isBackground?: boolean;
  pid?: number | null;
  command?: string;
}

export interface UseTerminalProcessResult {
  isRunning: boolean;
  isKilling: boolean;
  handleKill: () => Promise<void>;
  statusBadge: "running" | null;
}

/**
 * Consolidated hook for managing terminal process state across components.
 * Handles registration, status checking, and killing processes.
 *
 * @param data - Terminal process data containing pid, command, and background flag
 * @returns Process state and handlers
 */
export function useTerminalProcess(
  data: TerminalProcessData | null
): UseTerminalProcessResult {
  const { registerProcess, isProcessRunning, isProcessKilling, killProcess } =
    useProcessContext();

  // Extract PID only for background processes
  const pid =
    data?.isBackground && data?.pid && typeof data.pid === "number"
      ? data.pid
      : null;

  // Register background process on mount (only once per PID)
  useEffect(() => {
    if (pid && data?.command) {
      registerProcess(pid, data.command);
    }
    // Only depend on PID to prevent re-registration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // Get current process state
  const isRunning = pid ? isProcessRunning(pid) : false;
  const isKilling = pid ? isProcessKilling(pid) : false;

  // Kill handler
  const handleKill = useCallback(async () => {
    if (!pid) return;
    await killProcess(pid);
  }, [pid, killProcess]);

  // Determine status badge
  const statusBadge = pid && isRunning ? ("running" as const) : null;

  return {
    isRunning,
    isKilling,
    handleKill,
    statusBadge,
  };
}

/**
 * Get display text for terminal process status
 */
export function getProcessStatusText(
  isRunning: boolean | null,
  pid: number | null
): string {
  if (pid === null) return "";
  if (isRunning === true) return `Running in background (PID: ${pid})`;
  if (isRunning === false) return `Completed (was PID: ${pid})`;
  return `Ran in background (PID: ${pid})`; // null = haven't checked yet
}
