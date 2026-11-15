import { useEffect, useState } from "react";

/** Cadence while an Agent run is recorded running. */
export const RUNNING_POLL_MS = 5_000;
/** A visible idle view picks up changes from another tab or device within this. */
export const IDLE_POLL_MS = 30_000;
/** A failed first read retries once quickly, then at the idle cadence. */
export const FIRST_RETRY_MS = 2_000;

type Disabled = { enabled: false };
const DISABLED: Disabled = { enabled: false };

export type FindingHistorySource<T extends { enabled: true }> = {
  /** Resolves `null` when the read fails. */
  load: (findingId: string) => Promise<T | Disabled | null>;
  isRunning: (state: T) => boolean;
  /** Same-tab change signal. One arriving during a read queues a follow-up. */
  subscribe?: (listener: (findingId: string) => void) => () => void;
};

/**
 * Agent check history (retests, hunts) for one finding. `undefined` while
 * loading; a failed first read resolves to disabled, so no rollout-gated
 * action is offered, and retries until a read succeeds. A failed refresh keeps
 * the last good state.
 *
 * Reads never overlap, and the next poll is scheduled only after a read
 * settles: every 5s while running, every 30s while idle. A visible view also
 * refreshes on window focus, on becoming visible and on reconnecting, so a
 * check started in another tab or device appears without a reload. Hidden tabs
 * and disabled rollouts don't poll. Responses for a previously viewed finding
 * or after unmount are discarded.
 */
export function useFindingHistoryState<T extends { enabled: true }>(
  source: FindingHistorySource<T>,
  findingId: string | undefined,
): T | Disabled | undefined {
  const [loaded, setLoaded] = useState<{
    findingId: string;
    state: T | Disabled;
  } | null>(null);

  useEffect(() => {
    if (!findingId) return;
    let active = true;
    let inFlight = false;
    let readAgain = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let good: T | Disabled | undefined;
    let failures = 0;

    const hidden = () => document.visibilityState === "hidden";
    const stopTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };

    const read = async () => {
      inFlight = true;
      stopTimer();
      const next = await source.load(findingId);
      inFlight = false;
      if (!active) return;
      if (next) {
        good = next;
        failures = 0;
      } else {
        failures += 1;
      }
      const shown = good ?? DISABLED;
      setLoaded((prev) =>
        prev?.findingId === findingId && prev.state === shown
          ? prev
          : { findingId, state: shown },
      );
      if (readAgain) {
        readAgain = false;
        void read();
      } else {
        schedule();
      }
    };

    // Polls, focus, visibility and reconnects join a read already in flight.
    const refresh = () => {
      if (inFlight || hidden() || good?.enabled === false) return;
      void read();
    };

    const schedule = () => {
      if (hidden() || good?.enabled === false) return;
      const delay =
        good && source.isRunning(good)
          ? RUNNING_POLL_MS
          : !good && failures === 1
            ? FIRST_RETRY_MS
            : IDLE_POLL_MS;
      timer = setTimeout(refresh, delay);
    };

    const onVisibilityChange = () => {
      if (hidden()) stopTimer();
      else refresh();
    };

    void read();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribe = source.subscribe?.((changed) => {
      if (changed !== findingId) return;
      // The in-flight response may predate the change.
      if (inFlight) readAgain = true;
      else void read();
    });
    return () => {
      active = false;
      stopTimer();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribe?.();
    };
  }, [findingId, source]);

  return loaded && loaded.findingId === findingId ? loaded.state : undefined;
}
