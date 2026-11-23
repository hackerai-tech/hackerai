import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCommittedRef } from "./useLatestRef";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

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

export type RestoredSteer = {
  text: string;
  timestamp: number;
  sentHere: boolean;
  /** Not sent during the user's current visit to this chat. */
  held: boolean;
};
const WITHDRAW_RETRY_BASE_MS = 1_000;

export type PendingAgentSteer = {
  id: string;
  text: string;
  runId: string;
  /** Browser send time, comparable with queued message timestamps. */
  sentAt: number;
};

/**
 * Pending steers for this chat. Once no run is active, each is withdrawn and
 * returned to the queue; the withdrawal races the run's claim atomically.
 * Saving a response that shows a steer deletes its row, so any row still
 * listed was never saved and is safe to queue again. Steers sent before this
 * visit to the chat, or from another tab or device, come back held, so a
 * returning user never has an old message sent without their action.
 */
export function useUnreadSteerRequeue({
  chatId,
  enabled,
  runActive,
  onRequeue,
}: {
  chatId: string;
  enabled: boolean;
  runActive: boolean;
  onRequeue: (chatId: string, steers: RestoredSteer[]) => void;
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
  const onRequeueRef = useCommittedRef(onRequeue);

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
    // Restore into the queue of the account that started this withdrawal,
    // even if the signed-in account changes before it completes.
    const requeue = onRequeueRef.current;
    void (async () => {
      setInFlight((count) => count + 1);
      const withdrawn: Array<
        Omit<RestoredSteer, "held"> & { fromStoppedRun: boolean }
      > = [];
      let failed = false;
      for (const [index, steer] of unread.entries()) {
        try {
          const result = await withdraw({ chatId, id: steer.id });
          if (result.outcome === "withdrawn")
            withdrawn.push({
              text: result.text,
              timestamp: steer.sentAt,
              sentHere: steersSentHere.has(steer.id),
              fromStoppedRun: stoppedRuns.has(steer.runId),
            });
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
      requeue(
        chatId,
        withdrawn.map(({ fromStoppedRun, ...steer }) => ({
          ...steer,
          held:
            fromStoppedRun ||
            !steer.sentHere ||
            steer.timestamp < visitStartedAt,
        })),
      );
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
  }, [chatId, enabled, onRequeueRef, pending, retryTick, runActive, withdraw]);

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
