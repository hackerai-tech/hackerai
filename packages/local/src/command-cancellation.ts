import type { ChildProcess } from "child_process";
import os from "os";

export const LOCAL_CANCEL_CONFIRMATION_TIMEOUT_MS = 4000;
const LOCAL_CANCEL_CONFIRMATION_POLL_MS = 50;

type TerminationObservable = Pick<
  ChildProcess,
  "exitCode" | "signalCode" | "once" | "off"
>;

type ProcessTreeObservable = TerminationObservable & Pick<ChildProcess, "pid">;

const isRootProcessTerminated = (proc: TerminationObservable): boolean =>
  proc.exitCode !== null || proc.signalCode !== null;

/**
 * On Unix, streamed commands run in their own process group. A shell exiting
 * does not prove its descendants exited, so probe the group before confirming
 * cancellation. Windows taskkill /T completion is observed through the root
 * process because Windows does not expose the same process-group probe.
 */
export function isProcessTreeTerminationConfirmed(
  proc: ProcessTreeObservable,
  platform: NodeJS.Platform = os.platform(),
  signalProcessGroup: (pid: number, signal: 0) => unknown = (pid, signal) =>
    process.kill(pid, signal),
): boolean {
  if (platform === "win32" || !proc.pid) {
    return isRootProcessTerminated(proc);
  }

  try {
    signalProcessGroup(-proc.pid, 0);
    return false;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

/**
 * A signal request is not a termination acknowledgement. Wait for Node to
 * observe the requested termination scope reaching a terminal state before
 * reporting success.
 */
export function confirmProcessTermination(
  proc: TerminationObservable,
  requestTermination: () => void,
  timeoutMs = LOCAL_CANCEL_CONFIRMATION_TIMEOUT_MS,
  isTerminationComplete: () => boolean = () => isRootProcessTerminated(proc),
): Promise<boolean> {
  try {
    if (isTerminationComplete()) {
      return Promise.resolve(true);
    }
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let pollId: NodeJS.Timeout | undefined;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (pollId) clearInterval(pollId);
      proc.off("close", handleClose);
      proc.off("error", handleError);
      resolve(confirmed);
    };
    const checkCompletion = () => {
      try {
        if (isTerminationComplete()) {
          finish(true);
        }
      } catch {
        finish(false);
      }
    };
    const handleClose = () => checkCompletion();
    const handleError = () => finish(false);
    timeoutId = setTimeout(() => finish(false), timeoutMs);
    timeoutId.unref?.();
    pollId = setInterval(checkCompletion, LOCAL_CANCEL_CONFIRMATION_POLL_MS);
    pollId.unref?.();

    proc.once("close", handleClose);
    proc.once("error", handleError);
    try {
      requestTermination();
      checkCompletion();
    } catch {
      finish(false);
    }
  });
}
