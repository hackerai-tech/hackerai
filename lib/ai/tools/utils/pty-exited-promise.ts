/**
 * Resolvable `exited` promise with at-most-once semantics.
 *
 * Both PTY adapters need to expose `exited: Promise<{exitCode: number|null}>`
 * that resolves exactly once even when multiple code paths race to provide
 * the exit (e.g. pty_exit message AND kill() fallback). Centralizing the
 * resolve-once guard prevents subtle drift between adapters.
 */

export interface ResolvableExited {
  exited: Promise<{ exitCode: number | null }>;
  resolveOnce: (value: { exitCode: number | null }) => void;
}

export function createResolvableExited(): ResolvableExited {
  let resolved = false;
  let resolveFn!: (value: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveFn = resolve;
  });
  const resolveOnce = (value: { exitCode: number | null }): void => {
    if (resolved) return;
    resolved = true;
    resolveFn(value);
  };
  return { exited, resolveOnce };
}
