export type ActiveRuntimeBudget = {
  getElapsedTimeMs: () => number;
  pause: () => void;
  resume: () => void;
  dispose: () => void;
};

export function createActiveRuntimeBudget({
  maxDurationMs,
  initialElapsedMs = 0,
  onExceeded,
}: {
  maxDurationMs: number;
  initialElapsedMs?: number;
  onExceeded: () => void;
}): ActiveRuntimeBudget {
  let elapsedBeforeSegmentMs = Math.max(0, initialElapsedMs);
  let segmentStartedAt = Date.now();
  let paused = false;
  let disposed = false;
  let exceeded = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const getElapsedTimeMs = () =>
    elapsedBeforeSegmentMs +
    (paused || disposed || exceeded
      ? 0
      : Math.max(0, Date.now() - segmentStartedAt));

  const clearTimer = () => {
    if (timeoutId === undefined) return;
    clearTimeout(timeoutId);
    timeoutId = undefined;
  };

  const fire = () => {
    timeoutId = undefined;
    if (disposed || paused || exceeded) return;
    elapsedBeforeSegmentMs = getElapsedTimeMs();
    exceeded = true;
    onExceeded();
  };

  const schedule = () => {
    clearTimer();
    const remainingMs = Math.max(0, maxDurationMs - getElapsedTimeMs());
    timeoutId = setTimeout(fire, remainingMs);
  };

  const pause = () => {
    if (disposed || paused || exceeded) return;
    elapsedBeforeSegmentMs = getElapsedTimeMs();
    paused = true;
    clearTimer();
  };

  const resume = () => {
    if (disposed || !paused || exceeded) return;
    segmentStartedAt = Date.now();
    paused = false;
    schedule();
  };

  const dispose = () => {
    if (disposed) return;
    elapsedBeforeSegmentMs = getElapsedTimeMs();
    disposed = true;
    clearTimer();
  };

  schedule();

  return { getElapsedTimeMs, pause, resume, dispose };
}
