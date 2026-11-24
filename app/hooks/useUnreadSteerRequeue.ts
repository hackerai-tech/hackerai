import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { markQueuedHere } from "./useServerMessageQueue";

const MAX_WITHDRAW_RETRIES = 5;

// Steers this tab sent. Their send times use this browser's clock, so only
// they can be ordered against the local queue or this visit's start.
const steersSentHere = new Set<string>();
export const rememberSteerSentHere = (steerId: string) => {
  steersSentHere.add(steerId);
};

// Runs the user stopped in this tab. Their unread steers come back held,
// whatever happens to page state while the withdrawal is in flight.
const stoppedRuns = new Set<string>();
export const rememberStoppedRun = (runId: string) => {
  stoppedRuns.add(runId);
};
export const wasRunStopped = (runId: string) => stoppedRuns.has(runId);

const WITHDRAW_RETRY_BASE_MS = 1_000;

export type PendingAgentSteer = {
  id: string;
  text: string;
  runId: string;
  /** Browser send time, comparable with queued message timestamps. */
  sentAt: number;
};

/**
 * Pending steers for this chat. Once no run is active, each is withdrawn: the
 * server moves it into the chat's queue in the same transaction that races
 * the run's claim. Saving a response that shows a steer settles its row, so
 * any row still listed was never saved and is safe to queue again. Only a
 * steer this tab sent during the current visit, to a run the user did not
 * stop, is sent again automatically; the rest wait for the user.
 */
export function useUnreadSteerRequeue({
  chatId,
  enabled,
  runActive,
}: {
  chatId: string;
  enabled: boolean;
  runActive: boolean;
}): {
  pendingSteers: PendingAgentSteer[];
  /** Queued messages must wait: unread steers go back ahead of them. */
  recovering: boolean;
} {
  const pending = useQuery(
    api.agentSteers.listPending,
    enabled ? { chatId } : "skip",
  );
  const withdraw = useMutation(api.agentSteers.withdraw);
  const withdrawing = useRef(new Set<string>());
  const [inFlight, setInFlight] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  // After repeated failures, stop holding the queue for steers still listed.
  const [gaveUp, setGaveUp] = useState(false);
  const retryAttempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const visit = useRef({ chatId, startedAt: 0 });

  useLayoutEffect(() => {
    visit.current = { chatId, startedAt: Date.now() };
    // Leaving the chat ends the visit, so anything restored afterward is
    // held. Layout cleanup runs before the DOM is removed, ahead of any
    // deferred passive cleanup that a completing withdrawal could outrun.
    return () => {
      visit.current = { chatId: "", startedAt: Infinity };
    };
  }, [chatId]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(retryTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!enabled || runActive || !pending?.length) return;
    const unread = pending.filter(
      (steer) => !withdrawing.current.has(steer.id),
    );
    if (!unread.length) return;
    for (const steer of unread) withdrawing.current.add(steer.id);
    void (async () => {
      setInFlight((count) => count + 1);
      const withdrawn: PendingAgentSteer[] = [];
      let failed = false;
      for (const [index, steer] of unread.entries()) {
        try {
          const result = await withdraw({ chatId, id: steer.id });
          if (result.outcome === "withdrawn") withdrawn.push(steer);
          // Its run still holds it; a later snapshot can try again.
          else withdrawing.current.delete(steer.id);
        } catch {
          // Still pending; a bounded retry runs even if nothing else changes.
          // Later steers wait too, so none is restored ahead of this one.
          for (const remaining of unread.slice(index))
            withdrawing.current.delete(remaining.id);
          failed = true;
          break;
        }
      }
      // Decide against the visit that is current now, after every await. If
      // the user moved to another chat, nobody is here to see it: hold it.
      const visitStartedAt =
        visit.current.chatId === chatId ? visit.current.startedAt : Infinity;
      for (const steer of withdrawn)
        if (
          steersSentHere.has(steer.id) &&
          !stoppedRuns.has(steer.runId) &&
          steer.sentAt >= visitStartedAt
        )
          markQueuedHere(steer.id);
      if (!failed) {
        retryAttempts.current = 0;
        setGaveUp(false);
      } else if (!mounted.current) {
        // A withdrawal that failed after unmount must not leave a timer.
      } else if (retryAttempts.current < MAX_WITHDRAW_RETRIES) {
        const delay = WITHDRAW_RETRY_BASE_MS * 2 ** retryAttempts.current++;
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(
          () => setRetryTick((tick) => tick + 1),
          delay,
        );
      } else {
        setGaveUp(true);
      }
      setInFlight((count) => count - 1);
    })();
  }, [chatId, enabled, pending, retryTick, runActive, withdraw]);

  return {
    pendingSteers: enabled ? (pending ?? []) : [],
    recovering:
      enabled &&
      !runActive &&
      (pending === undefined ||
        inFlight > 0 ||
        (pending.length > 0 && !gaveUp)),
  };
}
