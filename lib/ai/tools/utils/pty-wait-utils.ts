import type { PtySession } from "./pty-session-manager";

/**
 * Strip CSI + OSC ANSI escape sequences from model-facing output. Keeping a
 * small inline helper avoids pulling in `strip-ansi` which isn't currently a
 * dep. UI-side consumers still get the raw bytes via `data-terminal` events.
 */
export const ANSI_REGEX =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_REGEX, "");

/**
 * Collect output for up to `timeoutMs`, then resolve. Aborts early on `signal`.
 *
 * Streams every raw chunk through `onChunk` for the UI writer before
 * consuming the session delta and returning.
 *
 * If `quietMs` is set, also resolves once `quietMs` of silence elapses *after*
 * the first chunk arrives — useful for "wait until the shell prompt redraws"
 * semantics where the full `timeoutMs` is only a hard ceiling. The quiet timer
 * is intentionally NOT armed pre-first-chunk so a slow shell startup (cold
 * `.zshrc`) doesn't return an empty result.
 */
export async function waitForOutput(
  session: PtySession,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => void,
  consume: (s: PtySession) => Uint8Array,
  options?: { quietMs?: number },
): Promise<Uint8Array> {
  const quietMs = options?.quietMs;
  return new Promise<Uint8Array>((resolve) => {
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    const armQuietTimer = () => {
      if (!quietMs) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), quietMs);
    };

    // Capture any bytes already buffered before subscription (e.g. data that
    // arrived during await sendInput's network RTT on E2B). Without this,
    // pre-subscription bytes reach only the buffer listener and are never
    // streamed to the UI.
    const preBuffered = consume(session);
    if (preBuffered.byteLength > 0) {
      try {
        onChunk(preBuffered);
      } catch (err) {
        console.error("[pty-wait-utils] onChunk failed:", err);
      }
      armQuietTimer();
    }

    const hardTimer = setTimeout(() => finish(), timeoutMs);

    const unsubscribe = session.handle.onData((bytes) => {
      if (settled) return;
      try {
        onChunk(bytes);
      } catch (err) {
        console.error("[pty-wait-utils] onChunk failed:", err);
      }
      armQuietTimer();
    });

    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (quietTimer) clearTimeout(quietTimer);
      try {
        unsubscribe();
      } catch (err) {
        console.error("[pty-wait-utils] unsubscribe failed:", err);
      }
      signal?.removeEventListener("abort", onAbort);
      const finalDelta = consume(session);
      const combined = new Uint8Array(
        preBuffered.byteLength + finalDelta.byteLength,
      );
      combined.set(preBuffered, 0);
      combined.set(finalDelta, preBuffered.byteLength);
      resolve(combined);
    }
  });
}

/**
 * Truncate model-visible output with a head/tail marker.
 * @param text - The text to potentially truncate
 * @param maxBytes - Maximum allowed bytes (default: 8192)
 */
export function capOutput(text: string, maxBytes: number = 8 * 1024): string {
  if (text.length <= maxBytes) return text;
  const head = Math.floor(maxBytes * 0.7);
  const tail = maxBytes - head - 64;
  return (
    text.slice(0, head) +
    `\n...[truncated ${text.length - head - tail} bytes]...\n` +
    text.slice(-tail)
  );
}

/**
 * Peek at `session.handle.exited` without blocking. Returns the resolved
 * value if already settled, otherwise `null`.
 */
export async function peekExited(
  session: PtySession,
): Promise<{ exitCode: number | null } | null> {
  const sentinel: { exitCode: number | null } = { exitCode: -0xdeadbeef };
  const result = await Promise.race([
    session.handle.exited,
    new Promise<typeof sentinel>((r) => {
      // Queue a microtask - if `exited` is already settled it'll win the race.
      Promise.resolve().then(() => r(sentinel));
    }),
  ]);
  if (result === sentinel) return null;
  return result;
}
