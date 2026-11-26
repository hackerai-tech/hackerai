/**
 * Resolvable `exited` promise with at-most-once semantics.
 *
 * Both PTY adapters need to expose `exited: Promise<{exitCode: number|null}>`
 * that resolves exactly once even when multiple code paths race to provide
 * the exit (e.g. pty_exit message AND kill() fallback). Centralizing the
 * resolve-once guard prevents subtle drift between adapters.
 */

export interface PtyExitResult {
  exitCode: number | null;
  /** Transport failure or a kill acknowledgement without an observed exit. */
  observationFailed?: true;
  /**
   * The run continues past this terminal although it may still be running:
   * its outcome is unknown, its output may be incomplete, and it refuses
   * input. Tools must say so instead of reporting an exit. Set only by
   * transports whose runs continue past such a terminal.
   */
  outcomeUnknown?: true;
  /**
   * The process exited, but this exit arrived while the host was unverified,
   * so unsequenced output sent before it may be missing. Set only by
   * transports whose runs continue past such a terminal.
   */
  outputIncomplete?: true;
}

/** Input was not sent: the terminal's outcome is unknown. */
export class TerminalInputRefusedError extends Error {
  constructor() {
    super("Terminal input was not sent: this terminal's outcome is unknown");
    this.name = "TerminalInputRefusedError";
  }
}

export interface ResolvableExited {
  exited: Promise<PtyExitResult>;
  resolveOnce: (value: PtyExitResult) => void;
}

export function createResolvableExited(): ResolvableExited {
  let resolved = false;
  let resolveFn!: (value: PtyExitResult) => void;
  const exited = new Promise<PtyExitResult>((resolve) => {
    resolveFn = resolve;
  });
  const resolveOnce = (value: PtyExitResult): void => {
    if (resolved) return;
    resolved = true;
    resolveFn(value);
  };
  return { exited, resolveOnce };
}
