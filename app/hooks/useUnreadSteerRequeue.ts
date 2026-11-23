import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCommittedRef } from "./useLatestRef";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

const MAX_WITHDRAW_RETRIES = 5;
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
 * visit to the chat (for example, from a closed tab) come back held, so
 * returning to a chat never sends an old message without the user's action.
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
  onRequeue: (
    chatId: string,
    steers: Array<{ text: string; timestamp: number }>,
    hold: boolean,
  ) => void;
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
    const visitStartedAt =
      visit.current.chatId === chatId ? visit.current.startedAt : Date.now();
    void (async () => {
      setInFlight((count) => count + 1);
      const restored: Array<{ text: string; timestamp: number }> = [];
      let failed = false;
      for (const [index, steer] of unread.entries()) {
        try {
          const result = await withdraw({ chatId, id: steer.id });
          if (result.outcome === "withdrawn")
            restored.push({ text: result.text, timestamp: steer.sentAt });
        } catch {
          // Still pending; a bounded retry runs even if nothing else changes.
          // Later steers wait too, so none is restored ahead of this one.
          for (const remaining of unread.slice(index))
            withdrawing.current.delete(remaining.id);
          failed = true;
          break;
        }
      }
      onRequeueRef.current(
        chatId,
        restored,
        restored.some((steer) => steer.timestamp < visitStartedAt),
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
