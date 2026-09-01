export const BACKGROUND_WORK_DRAIN_TIMEOUT_MS = 10_000;

export type BackgroundWorkDrainResult = {
  status: "completed" | "timed_out" | "aborted";
  pendingCount: number;
  durationMs: number;
};

/**
 * Waits for registered best-effort work without allowing it to hold request or
 * task finalization indefinitely. Work may register more work while draining;
 * the original deadline applies to the complete drain.
 */
export const drainBackgroundWork = async (
  backgroundWork: ReadonlySet<Promise<void>>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): Promise<BackgroundWorkDrainResult> => {
  const timeoutMs = Math.max(
    0,
    options.timeoutMs ?? BACKGROUND_WORK_DRAIN_TIMEOUT_MS,
  );
  const now = options.now ?? Date.now;
  const startedAt = now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const interruption = new Promise<"timed_out" | "aborted">((resolve) => {
    timeout = setTimeout(() => resolve("timed_out"), timeoutMs);
    if (!options.signal) return;
    onAbort = () => resolve("aborted");
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    while (backgroundWork.size > 0) {
      const result = await Promise.race([
        Promise.allSettled([...backgroundWork]).then(() => "settled" as const),
        interruption,
      ]);
      if (result !== "settled") {
        return {
          status: result,
          pendingCount: backgroundWork.size,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
        };
      }
    }

    return {
      status: "completed",
      pendingCount: 0,
      durationMs: Math.max(0, Math.round(now() - startedAt)),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
};
