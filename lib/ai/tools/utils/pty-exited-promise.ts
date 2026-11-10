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
