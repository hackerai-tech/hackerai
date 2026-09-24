import type { PtyHandle } from "./e2b-pty-adapter";
import { createResolvableExited } from "./pty-exited-promise";

/**
 * A lightweight handle that lets one-shot command execution participate in
 * the same per-chat session lifecycle as PTYs after a foreground timeout.
 *
 * The underlying command transport still owns execution and streaming. This
 * adapter only provides an opaque session handle, bounded output fan-out, and
 * cleanup hooks; it deliberately does not make a non-interactive command
 * input-capable.
 */
export interface CommandSessionHandle extends PtyHandle {
  emitText(text: string): void;
  setPid(pid: number): void;
  resolveExit(exitCode: number | null): void;
}

export function createCommandSessionHandle(opts: {
  kill: () => Promise<boolean>;
}): CommandSessionHandle {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const encoder = new TextEncoder();
  const { exited, resolveOnce } = createResolvableExited();
  let pid = 0;
  let hasExited = false;

  const resolveExit = (exitCode: number | null) => {
    if (hasExited) return;
    hasExited = true;
    resolveOnce({ exitCode });
  };

  return {
    get pid() {
      return pid;
    },
    async sendInput(): Promise<void> {
      throw new Error(
        "This is a non-interactive command session and does not accept input.",
      );
    },
    async resize(): Promise<void> {
      // Non-interactive commands have no terminal geometry.
    },
    async kill(): Promise<void> {
      if (hasExited) return;
      const terminated = await opts.kill();
      if (!terminated) {
        throw new Error("Failed to terminate non-interactive command session.");
      }
      resolveExit(null);
    },
    onData(cb): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    get exited() {
      return exited;
    },
    emitText(text: string): void {
      if (!text) return;
      const bytes = encoder.encode(text);
      for (const listener of Array.from(listeners)) {
        listener(bytes);
      }
    },
    setPid(nextPid: number): void {
      if (Number.isInteger(nextPid) && nextPid > 0) pid = nextPid;
    },
    resolveExit,
  };
}
