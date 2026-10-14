import type { ToolContext } from "@/types";

// A context belongs to one Ask/Agent execution, including its model fallbacks.
// Track before approval/setup awaits so delivery cannot overtake a writer.
const pendingByContext = new WeakMap<ToolContext, Set<Promise<void>>>();

export async function trackForegroundCommand<T>(
  context: ToolContext,
  execute: () => Promise<T>,
): Promise<T> {
  let pending = pendingByContext.get(context);
  if (!pending) {
    pending = new Set();
    pendingByContext.set(context, pending);
  }
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  pending.add(completion);
  try {
    return await execute();
  } finally {
    pending.delete(completion);
    // The command's own caller retains its error. Delivery must still check
    // the requested paths after a failed or denied command has settled.
    finish();
  }
}

export async function waitForForegroundCommands(
  context: ToolContext,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const pending = [...(pendingByContext.get(context) ?? [])];
  if (pending.length === 0) return 0;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([Promise.all(pending), aborted]);
    signal?.throwIfAborted();
    return pending.length;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
