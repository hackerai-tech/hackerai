import type { PtySession } from "./pty-session-manager";

/**
 * Strip CSI + OSC ANSI escape sequences from model-facing output. Keeping a
 * small inline helper avoids pulling in `strip-ansi` which isn't currently a
 * dep. UI-side consumers still get the raw bytes via `data-terminal` events.
 */
export const ANSI_REGEX =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_REGEX, "");

export interface WaitPolicy {
  pattern?: string;
  idle_ms: number;
  timeout_ms: number;
}

/**
 * Thrown by `waitForOutput` when `policy.pattern` cannot be compiled to a
 * RegExp. Callers translate this into a structured tool error rather than
 * letting the JS SyntaxError bubble out of `execute()`.
 */
export class InvalidWaitPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWaitPatternError";
  }
}

/** Upper bound on `wait_for.pattern` length to blunt ReDoS via pathological input. */
export const MAX_WAIT_PATTERN_LENGTH = 256;

/**
 * Compile `policy.pattern` into a RegExp, returning `null` when no pattern is
 * configured. Throws `InvalidWaitPatternError` synchronously when the pattern
 * is too long or cannot be compiled - callers should invoke this BEFORE any
 * side-effects (PTY spawn, timers, listeners) so nothing leaks on the error
 * path.
 */
export function compileWaitPattern(policy: WaitPolicy): RegExp | null {
  if (!policy.pattern) return null;
  if (policy.pattern.length > MAX_WAIT_PATTERN_LENGTH) {
    throw new InvalidWaitPatternError(
      `pattern exceeds ${MAX_WAIT_PATTERN_LENGTH} characters`,
    );
  }
  try {
    return new RegExp(policy.pattern);
  } catch (err) {
    throw new InvalidWaitPatternError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Resolve once any of:
 *   - `policy.pattern` matches the ANSI-stripped accumulated delta (if set)
 *   - `policy.idle_ms` of no new onData chunks (if pattern unset)
 *   - `policy.timeout_ms` absolute cap
 *   - `signal` aborts
 *
 * Streams every raw chunk through `onChunk` for the UI writer before
 * consuming the session delta and returning.
 *
 * Throws `InvalidWaitPatternError` synchronously if `policy.pattern` is set
 * but cannot be compiled. We throw BEFORE any timers / listeners are armed
 * so nothing needs to be cleaned up on the error path.
 */
export async function waitForOutput(
  session: PtySession,
  policy: WaitPolicy,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => void,
  consume: (s: PtySession) => Uint8Array,
): Promise<Uint8Array> {
  // Compile the regex FIRST so invalid patterns surface as a synchronous
  // throw before any timers or listeners are armed - nothing to clean up.
  const regex = compileWaitPattern(policy);

  return new Promise<Uint8Array>((resolve) => {
    let settled = false;
    let accumulated = "";
    const decoder = new TextDecoder();

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
      if (regex) {
        accumulated += stripAnsi(decoder.decode(preBuffered, { stream: true }));
      }
    }

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const hardTimer = setTimeout(() => finish(), policy.timeout_ms);

    const armIdle = () => {
      if (regex) return; // pattern mode doesn't use idle timer
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), policy.idle_ms);
    };

    // Pattern may already match from pre-buffered bytes
    if (regex && regex.test(accumulated)) {
      settled = true;
      clearTimeout(hardTimer);
      const finalDelta = consume(session);
      const combined = new Uint8Array(
        preBuffered.byteLength + finalDelta.byteLength,
      );
      combined.set(preBuffered, 0);
      combined.set(finalDelta, preBuffered.byteLength);
      resolve(combined);
      return;
    }

    // If we already have pre-buffered data and no pattern, reset idle to
    // give subsequent chunks time to arrive.
    armIdle();

    const unsubscribe = session.handle.onData((bytes) => {
      if (settled) return;
      try {
        onChunk(bytes);
      } catch (err) {
        console.error("[pty-wait-utils] onChunk failed:", err);
      }
      if (regex) {
        accumulated += stripAnsi(decoder.decode(bytes, { stream: true }));
        if (regex.test(accumulated)) {
          finish();
          return;
        }
      } else {
        armIdle();
      }
    });

    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish() {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
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
