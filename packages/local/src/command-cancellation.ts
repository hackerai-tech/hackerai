import type { ChildProcess } from "child_process";

export const LOCAL_CANCEL_CONFIRMATION_TIMEOUT_MS = 4000;

type TerminationObservable = Pick<
  ChildProcess,
  "exitCode" | "signalCode" | "once" | "off"
>;

/**
 * A signal request is not a termination acknowledgement. Wait for Node to
 * observe the child reaching a terminal state before reporting success.
 */
export function confirmProcessTermination(
  proc: TerminationObservable,
  requestTermination: () => void,
  timeoutMs = LOCAL_CANCEL_CONFIRMATION_TIMEOUT_MS,
): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      proc.off("close", handleTerminal);
      proc.off("error", handleTerminal);
      resolve(confirmed);
    };
    const handleTerminal = () => finish(true);
    const timeoutId = setTimeout(() => finish(false), timeoutMs);
    timeoutId.unref?.();

    proc.once("close", handleTerminal);
    proc.once("error", handleTerminal);
    try {
      requestTermination();
    } catch {
      finish(false);
    }
  });
}
